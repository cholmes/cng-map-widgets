// The plan cache: what planning a search LEARNS (which files a dataset is made
// of; each file's footer) kept for the next search.
//
// E14 measured why it matters: every estimate() or plan() started from
// nothing, so on Sentinel-2 each search re-fetched 13 listing documents and a
// 7.9 MB footer before reading a single row.
//
// Everything below runs the production planner against real parquet bytes;
// only the network is faked, so requests can be counted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/hyparquet-setup.js';
import { createPlanCache } from '../src/plan-cache.js';
import { planRequest } from '../src/estimate.js';
import { describeDataset } from '../src/query.js';
import { openParquetFile, readRows } from '../src/parquet-io.js';
import { buildParquet, rangeFetch } from './helpers/fake-parquet-host.js';

const LISTING = 'https://example.invalid/values.json';
const PART = (year) => `https://example.invalid/year=${year}/data.parquet`;

/** A two-part hive dataset behind one listing document, with every request logged. */
function host({ delayMs = 0 } = {}) {
  const files = new Map([[PART(2024), buildParquet({ groups: 3, rowsPerGroup: 4 })], [PART(2025), buildParquet({ groups: 2, rowsPerGroup: 4 })]]);
  const servers = new Map([...files].map(([url, bytes]) => [url, rangeFetch(bytes)]));
  const log = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const entry = { url: u, method: init.method ?? 'GET', range: init.headers?.get?.('Range') ?? null };
    log.push(entry);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (u === LISTING) return new Response(JSON.stringify([[2024], [2025]]), { status: 200 });
    const server = servers.get(u);
    if (!server) return new Response(null, { status: 404 });
    return server(url, init);
  };
  return {
    fetch,
    log,
    files,
    /** Replace a file's bytes, as a publisher rewriting a "live" part would. */
    replace(url, bytes) {
      files.set(url, bytes);
      servers.set(url, rangeFetch(bytes));
    },
    count: (pred) => log.filter(pred).length,
    listings: () => log.filter((e) => e.url === LISTING).length,
    footerReads: () => log.filter((e) => e.url !== LISTING).length,
    reset: () => log.splice(0),
  };
}

const dataset = {
  spec: 'cng-dataset/1.0',
  id: 'two-years',
  source: {
    kind: 'hive',
    glob: 'https://example.invalid/year=*/data.parquet',
    keys: [{ name: 'year', type: 'int32' }],
    enumeration: { kind: 'values', url: LISTING },
  },
};
const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };

test('a second plan with the same cache makes no listing and no footer requests', async () => {
  const h = host();
  const cache = createPlanCache();
  const first = await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  assert.equal(h.listings(), 1);
  assert.ok(h.footerReads() > 0);
  h.reset();
  const second = await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  assert.deepEqual(h.log, [], 'nothing went over the wire');
  assert.equal(second.selectedRowGroupsTotal, first.selectedRowGroupsTotal);
  assert.deepEqual(second.perPart.map((p) => p.part.url), [PART(2024), PART(2025)]);
  assert.deepEqual(cache.stats(), { partListings: 1, footers: 2, hits: 3, misses: 3 });
});

test('without a cache, a second plan repeats every request (unchanged behaviour)', async () => {
  const h = host();
  await planRequest(dataset, null, filter, { fetch: h.fetch });
  const once = h.log.length;
  await planRequest(dataset, null, filter, { fetch: h.fetch });
  assert.equal(h.log.length, once * 2);
  assert.equal(h.listings(), 2);
});

test('the planned request count reflects what a cache saved', async () => {
  const h = host();
  const cache = createPlanCache();
  const first = await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  const second = await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  // 1 listing + 2 footers were paid the first time and not the second.
  assert.equal(first.requests - second.requests, 3);
});

test('two concurrent plans share one listing and one footer read per file', async () => {
  const h = host({ delayMs: 5 });
  const cache = createPlanCache();
  await Promise.all([planRequest(dataset, null, filter, { fetch: h.fetch, cache }), planRequest(dataset, null, filter, { fetch: h.fetch, cache })]);
  const solo = host();
  await planRequest(dataset, null, filter, { fetch: solo.fetch });
  assert.equal(h.log.length, solo.log.length, 'as many requests as ONE uncached plan');
});

test('an entry older than maxAgeMs is not used', async () => {
  const h = host();
  let clock = 1_000;
  const cache = createPlanCache({ maxAgeMs: 60_000, now: () => clock });
  await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  clock += 59_000;
  h.reset();
  await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  assert.deepEqual(h.log, [], 'still fresh');
  clock += 2_000;
  await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  assert.equal(h.listings(), 1, 'stale: listed again');
  assert.ok(h.footerReads() > 0, 'stale: footers read again');
});

test('each cached open carries its own signal: aborting one does not abort another', async () => {
  const h = host();
  const cache = createPlanCache();
  await openParquetFile(PART(2024), h.fetch, { cache });
  const stop = new AbortController();
  const a = await openParquetFile(PART(2024), h.fetch, { cache, signal: stop.signal });
  const b = await openParquetFile(PART(2024), h.fetch, { cache });
  assert.notEqual(a.file, b.file, 'each open gets its own buffer');
  assert.equal(a.metadata, b.metadata, 'and the one cached footer');
  stop.abort();
  await assert.rejects(readRows(a, { rowStart: 0, rowEnd: 4, columns: ['id'] }), (e) => e.code === 'CANCELLED');
  const rows = await readRows(b, { rowStart: 0, rowEnd: 4, columns: ['id'] });
  assert.equal(rows.length, 4);
});

test('a caller that aborts while a shared footer read is in flight is cancelled; the read still completes for others', async () => {
  const h = host({ delayMs: 15 });
  const cache = createPlanCache();
  const stop = new AbortController();
  const impatient = openParquetFile(PART(2024), h.fetch, { cache, signal: stop.signal });
  const patient = openParquetFile(PART(2024), h.fetch, { cache });
  stop.abort();
  await assert.rejects(impatient, (e) => e.code === 'CANCELLED');
  const handle = await patient;
  assert.equal(handle.rowGroups.length, 3);
  // ...and it is cached: the next open is free.
  h.reset();
  await openParquetFile(PART(2024), h.fetch, { cache });
  assert.deepEqual(h.log, []);
});

test('a failed footer read is not cached', async () => {
  const h = host();
  const cache = createPlanCache();
  await assert.rejects(openParquetFile('https://example.invalid/missing.parquet', h.fetch, { cache }));
  h.reset();
  await assert.rejects(openParquetFile('https://example.invalid/missing.parquet', h.fetch, { cache }));
  assert.ok(h.log.length > 0, 'it tried again');
  assert.equal(cache.stats().footers, 0);
});

test('evict() and clear() make the next plan read again', async () => {
  const h = host();
  const cache = createPlanCache();
  await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  cache.evict(PART(2024));
  h.reset();
  await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  assert.equal(h.listings(), 0);
  assert.ok(h.log.every((e) => e.url === PART(2024)), 'only the evicted file was read');
  assert.ok(h.log.length > 0);
  cache.clear();
  h.reset();
  await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  assert.equal(h.listings(), 1);
});

// --- describeDataset: what a search widget asks before its first search -----------

test('describeDataset lists a partitioned dataset once and reads no footer', async () => {
  const h = host();
  const cache = createPlanCache();
  const described = await describeDataset(dataset, { fetch: h.fetch, cache });
  assert.equal(described.parts, 2);
  assert.equal(described.columns, null, 'no footer was read, so the real columns are not known');
  assert.equal(described.dataset.source.kind, 'hive');
  assert.equal(h.listings(), 1);
  assert.equal(h.footerReads(), 0);
  // The listing is now in the cache: a plan does not list again.
  await planRequest(dataset, null, filter, { fetch: h.fetch, cache });
  assert.equal(h.listings(), 1);
});

test('describeDataset reads the one footer of a single-file dataset and reports its real columns', async () => {
  const h = host();
  const cache = createPlanCache();
  const single = { spec: 'cng-dataset/1.0', id: 'one', source: { kind: 'parquet', url: PART(2024) } };
  const described = await describeDataset(single, { fetch: h.fetch, cache });
  assert.equal(described.parts, 1);
  assert.deepEqual(described.columns, [
    { name: 'id', struct: false },
    { name: 'n', struct: false },
    { name: 'cat', struct: false },
    { name: 'geometry', struct: false },
  ]);
  assert.equal(described.table.geometryColumn, 'geometry');
  // ...and that footer is the one a plan then uses.
  h.reset();
  await planRequest(single, null, filter, { fetch: h.fetch, cache });
  assert.deepEqual(h.log, []);
});

test('describeDataset with schema: false never reads a footer', async () => {
  const h = host();
  const single = { spec: 'cng-dataset/1.0', id: 'one', source: { kind: 'parquet', url: PART(2024) } };
  const described = await describeDataset(single, { fetch: h.fetch, cache: createPlanCache(), schema: false });
  assert.equal(described.columns, null);
  assert.deepEqual(h.log, []);
});
