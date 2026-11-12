import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder, DEFAULT_RANGE_GROUP_CONCURRENCY, DEFAULT_RANGE_MAX_CANDIDATE_GROUPS } from '../src/index.js';
import { setHyparquetModules, clearHyparquetModules } from '../src/cdn.js';

// Follow-up task 4, "range-mode query latency": `Geocoder#search()`'s
// range-mode path now resolves as soon as the first
// `DEFAULT_RANGE_GROUP_CONCURRENCY`-sized batch of candidate row groups
// has landed, finishing the rest (capped at
// `DEFAULT_RANGE_MAX_CANDIDATE_GROUPS`) in the background and emitting a
// further `'results'` event if that adds anything -- see
// `_searchRangeRowsFirstWave`/`_scheduleRangeCompletionWave` in
// geocoder.js. These exercise that end to end, with `openRangeIndex`
// faked (same seam `prominent-index.test.js` uses) to hand back a
// synthetic range handle directly, and the real `searchRangeIndex`
// running against a fake hyparquet (same seam `range-concurrency.test.js`
// uses) so every row group's own fetch is independently controllable.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(() => clearHyparquetModules());

const BBOX = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };

function baseManifest(extra = {}) {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 0,
    levels: [4],
    index: { url: './index.parquet', size: 999_999_999 }, // irrelevant: loadStrategy: 'range' is forced below
    boundaries: [],
    attribution: [],
    ...extra,
  };
}

/**
 * A synthetic range handle with `groupCount` row groups, each containing
 * exactly one row (`Place0`/`place0`/`F0`, `Place1`/`place1`/`F1`, ...),
 * every group's [min, max] deliberately wide open so any query prefix
 * candidates every group -- the point of these tests is the *fetch*
 * concurrency/cap/streaming, not row-group pruning (already covered by
 * range-pruning.test.js).
 */
function makeRangeFixture(groupCount) {
  const groups = [];
  const rowsByStart = {};
  for (let i = 0; i < groupCount; i++) {
    const rowStart = i * 10;
    groups.push({ rowStart, rowEnd: rowStart + 10, min: '', max: '￿' });
    // Distinct `country` per row (not the realistic "ZZZ" every row would
    // share in practice): keeps `applyDiversity`'s default
    // `maxPerGroup: 3`-per-(country, level) cap from collapsing these
    // fixture rows down to 3 regardless of how many row groups actually
    // got fetched -- diversity capping is covered on its own in
    // ranking.test.js/search-diversity.test.js, not the concern here.
    rowsByStart[rowStart] = [{ name: `Place${i}`, name_norm: `place${i}`, level: 4, country: `C${i}`, feature_id: `F${i}`, source: 'test-source', bbox: BBOX }];
  }
  const handle = { groups, file: {}, metadata: {}, featureIdColumn: 'feature_id', defaultSource: undefined };
  return { handle, rowsByStart };
}

/** Fake hyparquet whose parquetReadObjects yields a couple of microtasks
 *  before returning (so concurrent fetches actually overlap) and reads
 *  from `rowsByStart`. */
function fakeHyparquet(rowsByStart) {
  return {
    hyparquet: {
      parquetReadObjects: async ({ rowStart }) => {
        await Promise.resolve();
        await Promise.resolve();
        return rowsByStart[rowStart] ?? [];
      },
    },
    compressors: {},
  };
}

function makeGeocoder(handle, options = {}) {
  const deps = {
    loadManifest: async () => baseManifest(),
    openRangeIndex: async () => handle,
    loadFullIndex: async () => ({ rows: [], nameNorms: [] }), // never used: no prominent_index declared
  };
  return new Geocoder({ indexUrl: 'https://example.test/index.json', loadStrategy: 'range', __deps: deps, ...options });
}

test('search(): a candidate set within the concurrency batch resolves in one wave, no background completion', async () => {
  const { handle, rowsByStart } = makeRangeFixture(3); // <= DEFAULT_RANGE_GROUP_CONCURRENCY
  setHyparquetModules(fakeHyparquet(rowsByStart));
  const geocoder = makeGeocoder(handle, { limit: 20 });
  await geocoder.load();

  const events = [];
  geocoder.on('results', (p) => events.push(p));
  const results = await geocoder.search('place');

  assert.equal(results.length, 3);
  assert.equal(results.truncated, undefined);
  await delay(20); // give any (unexpected) background wave a chance to fire
  assert.equal(events.length, 1, 'no second wave when the first wave already covered every candidate group');
  assert.equal(events[0].wave, 'final');
});

test('search(): a candidate set beyond the concurrency batch resolves fast with a partial first wave, then grows via a background completion wave', async () => {
  const groupCount = DEFAULT_RANGE_GROUP_CONCURRENCY + 7; // forces a completion wave
  const { handle, rowsByStart } = makeRangeFixture(groupCount);
  setHyparquetModules(fakeHyparquet(rowsByStart));
  const geocoder = makeGeocoder(handle, { limit: 50 });
  await geocoder.load();

  const events = [];
  geocoder.on('results', (p) => events.push(p));
  const firstResults = await geocoder.search('place');

  assert.ok(firstResults.length < groupCount, 'the first wave only has whichever groups finished first, not every candidate group yet');
  assert.ok(firstResults.length > 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].wave, 'final', 'range-mode progressive waves are tagged "final" throughout -- it is the main index answering, just not finished yet');

  await delay(50); // let the background completion wave finish fetching the rest and re-emit
  assert.equal(events.length, 2, 'a completion wave must follow once every candidate group is in, since it adds rows');
  assert.equal(events[1].results.length, groupCount, 'the completion wave carries every candidate group\'s row');
  const allIds = new Set(events[1].results.map((r) => r.featureId));
  assert.equal(allIds.size, groupCount);
});

test('search(): a candidate set beyond the cap is truncated -- only the first DEFAULT_RANGE_MAX_CANDIDATE_GROUPS groups are ever fetched, marked on both waves', async () => {
  const groupCount = DEFAULT_RANGE_MAX_CANDIDATE_GROUPS + 10;
  const { handle, rowsByStart } = makeRangeFixture(groupCount);
  setHyparquetModules(fakeHyparquet(rowsByStart));
  const geocoder = makeGeocoder(handle, { limit: 100 });
  await geocoder.load();

  const events = [];
  geocoder.on('results', (p) => events.push(p));
  const firstResults = await geocoder.search('place');
  assert.equal(firstResults.truncated, true, 'the cap status is known up front, so even the fast first wave already reports it');

  await delay(60);
  assert.equal(events.length, 2);
  assert.equal(events[1].results.length, DEFAULT_RANGE_MAX_CANDIDATE_GROUPS, 'exactly the capped number of groups\' rows, never more');
  assert.equal(events[1].results.truncated, true);
});

test('search(): a later search() supersedes an in-flight range completion wave for an earlier query', async () => {
  const groupCount = DEFAULT_RANGE_GROUP_CONCURRENCY + 7;
  const { handle, rowsByStart } = makeRangeFixture(groupCount);
  setHyparquetModules(fakeHyparquet(rowsByStart));
  const geocoder = makeGeocoder(handle, { limit: 50 });
  await geocoder.load();

  const events = [];
  geocoder.on('results', (p) => events.push(p));
  await geocoder.search('place'); // first wave only; its completion wave is still in flight
  await geocoder.search('place'); // supersedes it immediately

  await delay(80); // long enough for both queries' completion waves to have settled
  // Each search() call gets exactly one first-wave emission; the first
  // call's completion wave must never land (superseded), so there are at
  // most 3 emissions total (1 + 1 + at most 1 from the second call's own
  // completion wave), never 4.
  assert.ok(events.length <= 3, `expected at most 3 'results' emissions, got ${events.length}`);
});
