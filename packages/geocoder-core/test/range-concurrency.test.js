import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchRangeIndex, DEFAULT_RANGE_GROUP_CONCURRENCY, DEFAULT_RANGE_MAX_CANDIDATE_GROUPS } from '../src/index.js';
import { setHyparquetModules, clearHyparquetModules } from '../src/cdn.js';

// Follow-up task 4, "range-mode query latency". Measured live against the
// published Overture index (see geocoder.js/index-loader.js's doc
// comments for the before/after numbers): `searchRangeIndex` fetched its
// candidate row groups sequentially, one `await` at a time, so a
// low-selectivity prefix spanning N candidate groups paid N sequential
// HTTP round trips. These tests pin down the two fixes with a fake
// hyparquet whose `parquetReadObjects` tracks concurrency/order directly,
// rather than timing a real network call.

afterEach(() => clearHyparquetModules());

function makeGroups(count, rowsPerGroup = 10) {
  const groups = [];
  for (let i = 0; i < count; i++) {
    groups.push({ rowStart: i * rowsPerGroup, rowEnd: (i + 1) * rowsPerGroup, min: 'prefix', max: 'prefixzz' });
  }
  return groups;
}

/** A fake hyparquet whose parquetReadObjects tracks how many calls are
 *  concurrently in flight at once (`maxConcurrent`), and returns exactly
 *  one matching row per group after an artificial microtask delay (so
 *  overlapping calls actually have a chance to overlap). */
function trackingHyparquet() {
  let inFlight = 0;
  let maxConcurrent = 0;
  const calls = [];
  return {
    maxConcurrent: () => maxConcurrent,
    calls,
    mods: {
      hyparquet: {
        parquetReadObjects: async ({ rowStart }) => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          calls.push(rowStart);
          // Yield a couple of microtasks so concurrent callers actually overlap.
          await Promise.resolve();
          await Promise.resolve();
          inFlight -= 1;
          return [{ name: `row-${rowStart}`, name_norm: `prefix-${rowStart}`, feature_id: `f${rowStart}` }];
        },
      },
      compressors: {},
    },
  };
}

test('searchRangeIndex: fetches candidate groups with bounded concurrency, not sequentially', async () => {
  const tracker = trackingHyparquet();
  setHyparquetModules(tracker.mods);

  const groupCount = 12;
  const handle = {
    groups: makeGroups(groupCount),
    file: {},
    metadata: {},
    featureIdColumn: 'feature_id',
    defaultSource: undefined,
  };

  const rows = await searchRangeIndex(handle, 'prefix', { concurrency: 5 });
  assert.equal(rows.length, groupCount, 'every candidate group contributed its one matching row');
  assert.ok(tracker.maxConcurrent() > 1, `expected overlapping fetches, saw max concurrency ${tracker.maxConcurrent()}`);
  assert.ok(tracker.maxConcurrent() <= 5, `concurrency must stay bounded at the configured limit, saw ${tracker.maxConcurrent()}`);
});

test('searchRangeIndex: default concurrency is DEFAULT_RANGE_GROUP_CONCURRENCY when unspecified', async () => {
  const tracker = trackingHyparquet();
  setHyparquetModules(tracker.mods);
  const handle = { groups: makeGroups(20), file: {}, metadata: {}, featureIdColumn: 'feature_id', defaultSource: undefined };

  await searchRangeIndex(handle, 'prefix');
  assert.ok(tracker.maxConcurrent() <= DEFAULT_RANGE_GROUP_CONCURRENCY);
  assert.ok(tracker.maxConcurrent() > 1);
});

test('searchRangeIndex: a candidate set within maxGroups is never truncated', async () => {
  const tracker = trackingHyparquet();
  setHyparquetModules(tracker.mods);
  const handle = { groups: makeGroups(5), file: {}, metadata: {}, featureIdColumn: 'feature_id', defaultSource: undefined };

  const rows = await searchRangeIndex(handle, 'prefix', { maxGroups: 24 });
  assert.equal(rows.length, 5);
  assert.equal(rows.truncated, undefined);
});

test('searchRangeIndex: a candidate set beyond maxGroups is capped and marked truncated, never over-fetching', async () => {
  const tracker = trackingHyparquet();
  setHyparquetModules(tracker.mods);
  const handle = { groups: makeGroups(37), file: {}, metadata: {}, featureIdColumn: 'feature_id', defaultSource: undefined };

  const rows = await searchRangeIndex(handle, 'prefix', { maxGroups: 24, concurrency: 5 });
  assert.equal(rows.length, 24, 'only the first 24 (capped) candidate groups were fetched');
  assert.equal(rows.truncated, true);
  assert.equal(tracker.calls.length, 24, 'the remaining 13 candidate groups were never requested at all');
  // "first by sort order" -- the groups actually fetched are groups 0..23
  // (ascending row-group/name_norm order), not an arbitrary subset.
  const fetchedStarts = tracker.calls.slice().sort((a, b) => a - b);
  assert.deepEqual(fetchedStarts, makeGroups(24).map((g) => g.rowStart));
});

test('searchRangeIndex: default cap is DEFAULT_RANGE_MAX_CANDIDATE_GROUPS when unspecified', async () => {
  const tracker = trackingHyparquet();
  setHyparquetModules(tracker.mods);
  const handle = { groups: makeGroups(DEFAULT_RANGE_MAX_CANDIDATE_GROUPS + 1), file: {}, metadata: {}, featureIdColumn: 'feature_id', defaultSource: undefined };

  const rows = await searchRangeIndex(handle, 'prefix');
  assert.equal(rows.length, DEFAULT_RANGE_MAX_CANDIDATE_GROUPS);
  assert.equal(rows.truncated, true);
});

test('searchRangeIndex: onBatch reports cumulative rows and progress info after every completed group', async () => {
  const tracker = trackingHyparquet();
  setHyparquetModules(tracker.mods);
  const handle = { groups: makeGroups(6), file: {}, metadata: {}, featureIdColumn: 'feature_id', defaultSource: undefined };

  const batches = [];
  const rows = await searchRangeIndex(handle, 'prefix', {
    concurrency: 3,
    onBatch: (rowsSoFar, info) => batches.push({ count: rowsSoFar.length, ...info }),
  });

  assert.equal(batches.length, 6, 'one onBatch call per completed group');
  assert.equal(batches[batches.length - 1].completed, 6);
  assert.equal(batches[batches.length - 1].total, 6);
  assert.equal(batches[batches.length - 1].count, rows.length, 'the last batch\'s cumulative rows match the final return value\'s length');
  // Monotonically non-decreasing: cumulative rows only ever grow.
  for (let i = 1; i < batches.length; i++) assert.ok(batches[i].count >= batches[i - 1].count);
  assert.ok(batches.every((b) => b.truncated === false));
});

test('searchRangeIndex: a zero-candidate query never calls onBatch and resolves to an empty array', async () => {
  const tracker = trackingHyparquet();
  setHyparquetModules(tracker.mods);
  const handle = { groups: [{ rowStart: 0, rowEnd: 10, min: 'aaa', max: 'bbb' }], file: {}, metadata: {}, featureIdColumn: 'feature_id', defaultSource: undefined };

  let calls = 0;
  const rows = await searchRangeIndex(handle, 'zzz-no-match', { onBatch: () => { calls += 1; } });
  assert.deepEqual(rows, []);
  assert.equal(calls, 0);
});
