// queryRows: the same resolve -> prune -> read pipeline a download uses, but
// the matched rows are handed back as objects instead of written to a file.
// It is what a search widget calls.
//
// Everything runs the production planner and engine against real parquet
// bytes; only the network is faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import './helpers/hyparquet-setup.js';
import { buildArea } from '@cngeo/spec';
import { queryRows, createPlanCache, download, memorySink } from '../src/index.js';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { buildScenes, scenesDataset, scenesHost, SCENES_URL } from './helpers/scenes-fixture.js';
import { squareWkb } from './helpers/fake-parquet-host.js';

const ALL = { spec: 'cng-filter/1.0', spatial: { mode: 'intersects' } };
const ids = (rows) => rows.map((r) => r.id);
const groupIds = (g) => [0, 1, 2].map((r) => `g${g}-r${r}`);

/** Covers longitudes 9..21: the squares of row groups 1 and 2. */
function middleArea() {
  return buildArea({
    name: 'middle',
    geometry: { type: 'Polygon', coordinates: [[[9, -1], [21, -1], [21, 2], [9, 2], [9, -1]]] },
    source: 'draw',
    features: [],
  });
}

test('rows come back as objects with decoded geometry, in file order', async () => {
  const host = scenesHost(buildScenes());
  const result = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch });
  assert.deepEqual(ids(result.rows), [0, 1, 2, 3].flatMap(groupIds));
  assert.deepEqual(Object.keys(result.rows[0]), ['id', 'n', 'big', 'datetime', 'geometry']);
  assert.deepEqual(result.rows[4].geometry, { type: 'Polygon', coordinates: [[[10, 0], [11, 0], [11, 1], [10, 1], [10, 0]]] });
  assert.equal(result.truncated, false);
});

test('onRows is called once per row group, in order, before the promise resolves', async () => {
  // Later reads finish FIRST, so order here is the engine's doing, not luck.
  const host = scenesHost(buildScenes(), { delayMs: (ordinal) => Math.max(0, 40 - ordinal * 8) });
  const calls = [];
  let resolved = false;
  const pending = queryRows(scenesDataset(), null, ALL, {
    fetch: host.fetch,
    onRows: (rows) => {
      assert.equal(resolved, false);
      calls.push(ids(rows));
    },
  }).then((r) => {
    resolved = true;
    return r;
  });
  const result = await pending;
  assert.deepEqual(calls, [0, 1, 2, 3].map(groupIds));
  assert.deepEqual(calls.flat(), ids(result.rows));
});

test('an async onRows is awaited before the next row group is delivered', async () => {
  const host = scenesHost(buildScenes());
  const events = [];
  await queryRows(scenesDataset(), null, ALL, {
    fetch: host.fetch,
    onRows: async (rows) => {
      events.push(`start ${rows[0].id}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end ${rows[0].id}`);
    },
  });
  assert.deepEqual(events.slice(0, 4), ['start g0-r0', 'end g0-r0', 'start g1-r0', 'end g1-r0']);
});

test('area + time + where are applied; columns.include projects', async () => {
  const host = scenesHost(buildScenes());
  const result = await queryRows(
    scenesDataset(),
    middleArea(),
    {
      ...ALL,
      time: { start: '2025-06-07T00:00:00Z', end: '2025-06-13T00:00:00Z', closed: '[)' },
      where: [{ col: 'n', op: '!=', value: 201 }],
      columns: { include: ['id', 'n'] },
    },
    { fetch: host.fetch },
  );
  // Area: groups 1 and 2. Time: 7th..12th -> g1-r1, g1-r2, g2-r0, g2-r1. Where drops n = 201.
  assert.deepEqual(ids(result.rows), ['g1-r1', 'g1-r2', 'g2-r0']);
  assert.deepEqual(Object.keys(result.rows[0]), ['id', 'n', 'geometry']);
});

test('the plan says what was pruned, and is announced before any row', async () => {
  const host = scenesHost(buildScenes());
  const order = [];
  const result = await queryRows(scenesDataset(), middleArea(), ALL, {
    fetch: host.fetch,
    onPlan: (plan) => order.push(['plan', plan.rowGroups.selected]),
    onRows: (rows) => order.push(['rows', rows.length]),
  });
  assert.deepEqual(order, [['plan', 2], ['rows', 3], ['rows', 3]]);
  assert.deepEqual(result.plan.files, { total: 1, selected: 1 });
  assert.deepEqual(result.plan.rowGroups, { total: 4, selected: 2 });
  const bboxStage = result.plan.prune.find((s) => s.stage === 'row-group-bbox');
  assert.equal(bboxStage.before, 4);
  assert.equal(bboxStage.after, 2);
  assert.equal(typeof result.plan.requests, 'number');
  assert.ok(Array.isArray(result.plan.warnings));
});

test("geometry: 'wkb' returns the raw bytes", async () => {
  const host = scenesHost(buildScenes());
  const result = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, geometry: 'wkb' });
  assert.ok(result.rows[0].geometry instanceof Uint8Array);
  assert.equal(result.rows[0].geometry[0], 1); // little-endian WKB
});

test("geometry: 'none' returns no geometry and, with a bbox covering, does not read it", async () => {
  const bytes = buildScenes();
  const withGeometry = scenesHost(bytes);
  await queryRows(scenesDataset(), middleArea(), { ...ALL, spatial: { mode: 'bbox' } }, { fetch: withGeometry.fetch });
  const host = scenesHost(bytes);
  const result = await queryRows(scenesDataset(), middleArea(), { ...ALL, spatial: { mode: 'bbox' } }, { fetch: host.fetch, geometry: 'none' });
  assert.deepEqual(ids(result.rows), [...groupIds(1), ...groupIds(2)]);
  assert.deepEqual(Object.keys(result.rows[0]), ['id', 'n', 'big', 'datetime']);
  const read = (h) => h.dataReads().reduce((sum, e) => sum + (e.end - e.start), 0);
  assert.ok(read(host) < read(withGeometry), `read ${read(host)} bytes without geometry, ${read(withGeometry)} with`);
});

test("geometry: 'none' with no area and no covering still returns every row", async () => {
  // The geometry is then never read at all -- which must not be mistaken for
  // "this row has no geometry, so it matches nothing".
  const host = scenesHost(buildScenes());
  const result = await queryRows(scenesDataset({ covering: false }), null, ALL, { fetch: host.fetch, geometry: 'none' });
  assert.equal(result.rows.length, 12);
  assert.equal('geometry' in result.rows[0], false);
});

// Phase 2 review, I8: the same zero-rows failure, by another door. A
// STAC-GeoParquet `bbox` is often a LIST `[w, s, e, n]` (Sentinel-2's is). A
// group named `bbox` is inferred as a struct covering, read, and yields no
// box for any row -- and with the geometry not read either, every row was
// dropped as "has no geometry".
test("geometry: 'none' on a table whose bbox is a list, with no area, returns every row", async () => {
  const str = (name) => ({ name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' });
  const columns = [
    str('id'),
    [{ name: 'bbox', repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 }, { name: 'list', repetition_type: 'REPEATED', num_children: 1 }, { name: 'element', type: 'DOUBLE', repetition_type: 'OPTIONAL' }],
    { name: 'geometry', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' },
  ];
  const rows = [0, 1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, bbox: [i, 0, i + 1, 1], geometry: squareWkb(i, 0, 1) }));
  const bytes = new Uint8Array(parquetWriteBuffer({
    columnData: ['id', 'bbox', 'geometry'].map((name) => ({ name, data: rows.map((r) => r[name]) })),
    schema: [{ name: 'schema', num_children: columns.length }, ...columns.flat()],
    rowGroupSize: 3,
  }));
  const host = scenesHost(bytes);
  const dataset = { spec: 'cng-dataset/1.0', id: 'list-bbox', source: { kind: 'parquet', url: SCENES_URL } };
  const none = await queryRows(dataset, null, ALL, { fetch: host.fetch, geometry: 'none' });
  assert.deepEqual(ids(none.rows), ['s0', 's1', 's2', 's3', 's4', 's5']);
  // ...and with the geometry, nothing changed.
  const full = await queryRows(dataset, null, ALL, { fetch: host.fetch });
  assert.equal(full.rows.length, 6);
  assert.equal(full.rows[0].geometry.type, 'Polygon');
});

// Found reading the Portolan registry index: 7,049 of 17,585 rows came back.
// The rest -- every catalog, every non-spatial table -- have no geometry and
// no bbox, and a row with neither was dropped as "can never match a spatial
// filter" even when there was no spatial filter to match.
test('with no area, rows that have no geometry are returned; with one, they are not', async () => {
  const str = (name) => ({ name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' });
  const dbl = (name) => ({ name, type: 'DOUBLE', repetition_type: 'OPTIONAL' });
  const columns = [str('id'), [{ name: 'bbox', repetition_type: 'OPTIONAL', num_children: 4 }, dbl('xmin'), dbl('ymin'), dbl('xmax'), dbl('ymax')], { name: 'geometry', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' }];
  // Even rows are spatial; odd rows are tables: no bbox, no geometry.
  const rows = [0, 1, 2, 3, 4, 5].map((i) => (i % 2 ? { id: `table-${i}`, bbox: null, geometry: null } : { id: `map-${i}`, bbox: { xmin: i * 10, ymin: 0, xmax: i * 10 + 1, ymax: 1 }, geometry: squareWkb(i * 10, 0, 1) }));
  const bytes = new Uint8Array(parquetWriteBuffer({
    columnData: ['id', 'bbox', 'geometry'].map((name) => ({ name, data: rows.map((r) => r[name]) })),
    schema: [{ name: 'schema', num_children: columns.length }, ...columns.flat()],
    rowGroupSize: 3,
  }));
  const host = scenesHost(bytes);
  const dataset = { spec: 'cng-dataset/1.0', id: 'mixed', source: { kind: 'parquet', url: SCENES_URL } };
  const everything = await queryRows(dataset, null, { ...ALL, columns: { include: ['id'], includeBbox: true } }, { fetch: host.fetch, geometry: 'none' });
  assert.deepEqual(ids(everything.rows), ['map-0', 'table-1', 'map-2', 'table-3', 'map-4', 'table-5']);
  assert.equal(everything.rows[1].bbox, null);
  const withGeometry = await queryRows(dataset, null, ALL, { fetch: host.fetch });
  assert.equal(withGeometry.rows.length, 6);
  assert.equal(withGeometry.rows[1].geometry, null);
  // An area is a spatial filter: a row with no place cannot be in it.
  const area = buildArea({ name: 'west', geometry: { type: 'Polygon', coordinates: [[[-1, -1], [25, -1], [25, 2], [-1, 2], [-1, -1]]] }, source: 'draw', features: [] });
  assert.deepEqual(ids((await queryRows(dataset, area, ALL, { fetch: host.fetch })).rows), ['map-0', 'map-2']);
});

test('limit truncates and reports it', async () => {
  const host = scenesHost(buildScenes());
  const cut = await queryRows(scenesDataset(), null, { ...ALL, limit: 5 }, { fetch: host.fetch });
  assert.deepEqual(ids(cut.rows), ['g0-r0', 'g0-r1', 'g0-r2', 'g1-r0', 'g1-r1']);
  assert.equal(cut.truncated, true);
  const roomy = await queryRows(scenesDataset(), null, { ...ALL, limit: 100 }, { fetch: host.fetch });
  assert.equal(roomy.rows.length, 12);
  assert.equal(roomy.truncated, false);
});

test('an INT64 column comes back as a number, and a row serializes', async () => {
  const host = scenesHost(buildScenes());
  const { rows } = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch });
  assert.equal(rows[0].big, 5_000_000_000);
  assert.equal(typeof rows[0].big, 'number');
  assert.doesNotThrow(() => JSON.stringify(rows));
});

test('aborting rejects with CANCELLED and stops reading', async () => {
  const host = scenesHost(buildScenes(), { delayMs: () => 10 });
  const stop = new AbortController();
  const seen = [];
  const pending = queryRows(scenesDataset(), null, ALL, {
    fetch: host.fetch,
    signal: stop.signal,
    maxConcurrentRequests: 1,
    onRows: (rows) => {
      seen.push(...ids(rows));
      stop.abort();
    },
  });
  await assert.rejects(pending, (e) => e.code === 'CANCELLED');
  assert.deepEqual(seen, groupIds(0));
  const readsAtAbort = host.dataReads().length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(host.dataReads().length, readsAtAbort, 'no read started after the abort settled');
  assert.ok(readsAtAbort < 4, `${readsAtAbort} of 4 row groups were read`);
});

test('an already-aborted signal rejects with CANCELLED without a request', async () => {
  const host = scenesHost(buildScenes());
  await assert.rejects(queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, signal: AbortSignal.abort() }), (e) => e.code === 'CANCELLED');
  assert.equal(host.dataReads().length, 0);
});

// --- with a plan cache -----------------------------------------------------------

test('with a cache, a second query reads rows and nothing else', async () => {
  const host = scenesHost(buildScenes());
  const cache = createPlanCache();
  await queryRows(scenesDataset(), middleArea(), ALL, { fetch: host.fetch, cache });
  host.reset();
  const again = await queryRows(scenesDataset(), middleArea(), ALL, { fetch: host.fetch, cache });
  assert.equal(again.rows.length, 6);
  assert.equal(host.log.length, 2, 'two row-group reads; no HEAD, no footer');
  assert.equal(host.log.length, host.dataReads().length);
});

// Review Focus 5: Sentinel-2's "live" parts are rewritten as scenes arrive. A
// footer cached before the rewrite describes offsets that no longer exist.
test('a file rewritten after it was planned is noticed and re-planned once', async () => {
  const host = scenesHost(buildScenes());
  const cache = createPlanCache();
  await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  host.replace(buildScenes({ groups: 6, tag: 'new-' }));
  const result = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  assert.equal(result.rows.length, 18);
  assert.ok(result.rows.every((r) => r.id.startsWith('new-')), 'no row decoded against the old footer');
  // ...and the cache now holds the new footer: the next query is clean.
  host.reset();
  const third = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  assert.equal(third.rows.length, 18);
  assert.equal(host.log.length, host.dataReads().length);
});

test('a file that keeps changing fails with a retryable error rather than looping', async () => {
  const cache = createPlanCache();
  const first = scenesHost(buildScenes());
  await queryRows(scenesDataset(), null, ALL, { fetch: first.fetch, cache });
  // A server whose range responses always report a different total size than
  // any footer just read: every plan looks stale.
  let n = 0;
  const shifting = scenesHost(buildScenes());
  const fetch = async (url, init = {}) => {
    const res = await shifting.fetch(url, init);
    const range = res.headers.get('content-range');
    const asked = shifting.log.at(-1);
    // Honest about the size when it is asked for (the one-byte probe) and for
    // the footer; it is the ROW reads that then disagree, every time.
    if (!range || asked.end >= shifting.bytes.byteLength || asked.end - asked.start <= 1) return res;
    const headers = new Headers(res.headers);
    headers.set('content-range', range.replace(/\/\d+$/, `/${999_000 + n++}`));
    return new Response(await res.arrayBuffer(), { status: 206, headers });
  };
  await assert.rejects(queryRows(scenesDataset(), null, ALL, { fetch, cache }), (e) => {
    assert.equal(e.code, 'DATASET_UNRESOLVED');
    assert.equal(e.retryable, true);
    assert.equal(e.context.reason, 'file-changed');
    assert.equal(e.context.url, SCENES_URL);
    return true;
  });
});

// --- downloads are untouched ------------------------------------------------------

// The engine gained a second way to hand rows over. This is a GeoJSON download
// of the same fixture, hashed BEFORE that change was made.
test('download() through the same engine is unchanged, byte for byte', async () => {
  const host = scenesHost(buildScenes());
  const sink = memorySink();
  const filter = {
    spec: 'cng-filter/1.0',
    spatial: { mode: 'bbox' },
    time: { start: '2025-06-06T00:00:00Z', end: '2025-06-18T00:00:00Z', closed: '[)' },
    where: [{ col: 'n', op: '>=', value: 101 }],
  };
  const handle = download(scenesDataset(), null, filter, { spec: 'cng-output/1.0', format: 'geojson' }, { sink, fetch: host.fetch });
  const result = await handle.result;
  const bytes = Buffer.concat(sink.chunks.map((c) => Buffer.from(c)));
  assert.equal(result.rows, 7);
  assert.equal(bytes.length, 1442);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '057a3f5373433a9b210da05eb852fb6881009a4dfa7a3122b483f2c179e3444e');
});
