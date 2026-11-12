import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder } from '../src/index.js';

// Exercises Geocoder#select()'s real control flow -- resolution
// selection, event ordering, and the progressive-upgrade cancellation
// rule -- WITHOUT touching geocoder-core's hyparquet/CDN dependency.
//
// Why fakes, not the real thing: hyparquet is loaded via a pinned
// `https:` CDN URL (design doc §4.2, see cdn.js), and Node's default ESM
// loader refuses to `import()` an `https:` URL at all
// (ERR_UNSUPPORTED_ESM_URL_SCHEME) -- confirmed directly against this
// repo's pinned hyparquet@1.33.0 while building this fix. That makes
// `load()`/`select()` fundamentally untestable end-to-end under
// `node --test`, in browser or not: it is a property of Node's module
// loader, not a mocking gap. `Geocoder`'s constructor accepts an
// undocumented `__deps` override (see geocoder.js) for exactly this: the
// production code path is unchanged, but a test can substitute fakes for
// the two calls that would otherwise need the network + hyparquet, and
// get real coverage of everything else `select()` does.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function squarePolygon(n) {
  // A closed ring with `n` vertices (>=4), distinct per call site only in
  // vertex count -- enough to tell "before upgrade" and "after upgrade"
  // apart by `vertexCount.filter` without needing real geometry.
  const ring = [];
  for (let i = 0; i < n - 1; i++) {
    const t = (i / (n - 1)) * 2 * Math.PI;
    ring.push([Math.cos(t), Math.sin(t)]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

function makeManifest({ withDisplay }) {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 1,
    levels: [0],
    index: { url: './index.parquet', size: 100 },
    boundaries: [
      {
        level: 0,
        feature_id_column: 'feature_id',
        geometry_column: 'geometry',
        full: { url: './adm0-full.parquet' },
        ...(withDisplay ? { display: { url: './adm0-display.parquet' } } : {}),
      },
    ],
    attribution: [{ text: 'Test attribution', license: 'CC0-1.0', share_alike: false }],
  };
}

/**
 * @param {{ manifest: object, resolveDelayMs?: number, simplifyDelayMs?: number }} opts
 */
function makeDeps({ manifest, resolveDelayMs = 1, simplifyDelayMs = 1 }) {
  return {
    loadManifest: async () => manifest,
    loadFullIndex: async () => ({ rows: [], nameNorms: [] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
    async resolveGeometry(result, boundaryUrl, catalogVersion, fetchImpl, onVersionSkew, onWarning, options = {}) {
      await delay(resolveDelayMs);
      options.signal?.throwIfAborted();
      const isFull = boundaryUrl.includes('full');
      return { geometry: squarePolygon(isFull ? 9 : 5), bbox: [0, 0, 1, 1] };
    },
    async simplifyToVertexCeilingAsync(geometry, options = {}) {
      await delay(simplifyDelayMs);
      options.signal?.throwIfAborted();
      let n = 0;
      for (const ring of geometry.coordinates) n += ring.length;
      return {
        geometry,
        method: 'none',
        toleranceDeg: 0,
        inputVertices: n,
        outputVertices: n,
        areaDeltaRatio: 0,
        degradedToBbox: false,
      };
    },
  };
}

const RESULT_A = { featureId: 'A', name: 'Alpha', level: 0, country: 'ZZZ', bbox: [0, 0, 1, 1] };
const RESULT_B = { featureId: 'B', name: 'Beta', level: 0, country: 'ZZZ', bbox: [0, 0, 1, 1] };

/**
 * Deps for the "interim/cheap filter" routing tests below (fix history:
 * "Canada ADM0 select() blocks the main thread for ~24s"): unlike
 * `makeDeps()`, the boundary fetch returns a geometry big enough
 * (`vertexCount`) to trip `buildArea`'s `maxSyncInputVertices` guard --
 * geocoder-core's default filterVertexCeiling is 10,000, so anything over
 * @cnmw/spec's `MAX_SYNC_SIMPLIFY_VERTICES` (1,500) but under 10,000 is
 * enough to force a real (non-early-return) attempt that the guard then
 * intercepts. `simplifyToVertexCeilingAsync` here is a *working* fake
 * (not the always-'none' one `makeDeps` uses): it actually reports a
 * smaller output, so a test can tell "upgraded for real" apart from "no
 * upgrade happened" by `vertexCount.filter` changing.
 * @param {{ manifest: object, vertexCount: number, resolveDelayMs?: number, simplifyDelayMs?: number }} opts
 */
function makeOversizedDeps({ manifest, vertexCount, resolveDelayMs = 1, simplifyDelayMs = 1 }) {
  return {
    loadManifest: async () => manifest,
    loadFullIndex: async () => ({ rows: [], nameNorms: [] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
    async resolveGeometry(result, boundaryUrl, catalogVersion, fetchImpl, onVersionSkew, onWarning, options = {}) {
      await delay(resolveDelayMs);
      options.signal?.throwIfAborted();
      return { geometry: squarePolygon(vertexCount), bbox: [0, 0, 1, 1] };
    },
    async simplifyToVertexCeilingAsync(geometry, options = {}) {
      await delay(simplifyDelayMs);
      options.signal?.throwIfAborted();
      return {
        geometry,
        method: 'visvalingam',
        toleranceDeg: 0.001,
        inputVertices: vertexCount,
        outputVertices: 7, // distinguishable from both the input size and squarePolygon(9)'s fake-"full" marker
        areaDeltaRatio: 0.001,
        degradedToBbox: false,
      };
    },
  };
}

test('select(): defaults to display resolution, no background upgrade', async () => {
  const deps = makeDeps({ manifest: makeManifest({ withDisplay: true }) });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const upgrades = [];
  geocoder.on('area:upgraded', (p) => upgrades.push(p));

  const area = await geocoder.select(RESULT_A);
  assert.equal(area.provenance.resolution, 'display');
  assert.equal(area.provenance.pendingUpgrade, false);

  await delay(20);
  assert.equal(upgrades.length, 0, 'display resolution must not trigger a background upgrade');
});

test('select({ resolution: "full" }): resolves with full geometry, no background upgrade', async () => {
  const deps = makeDeps({ manifest: makeManifest({ withDisplay: true }) });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const upgrades = [];
  geocoder.on('area:upgraded', (p) => upgrades.push(p));

  const area = await geocoder.select(RESULT_A, { resolution: 'full' });
  assert.equal(area.provenance.resolution, 'full');
  assert.equal(area.provenance.pendingUpgrade, false);
  assert.equal(area.vertexCount.display, 9); // the "full"-flavored fake geometry

  await delay(20);
  assert.equal(upgrades.length, 0);
});

test('select({ resolution: "both" }) with no display file falls back to full, no background upgrade', async () => {
  const deps = makeDeps({ manifest: makeManifest({ withDisplay: false }) });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const events = [];
  geocoder.on('select', (p) => events.push(p));
  geocoder.on('area:upgraded', (p) => events.push(p));

  const area = await geocoder.select(RESULT_A, { resolution: 'both' });
  assert.equal(area.provenance.resolution, 'full');
  assert.equal(area.provenance.pendingUpgrade, false);

  await delay(20);
  assert.equal(events.length, 1, 'no manifest display file: must behave exactly like resolution "full", with no later upgrade event');
});

test('select({ resolution: "both" }): emits "select" before "area:upgraded", upgrades filterGeometry, leaves display geometry alone', async () => {
  const deps = makeDeps({ manifest: makeManifest({ withDisplay: true }), resolveDelayMs: 10, simplifyDelayMs: 10 });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const order = [];
  geocoder.on('select', (p) => order.push({ event: 'select', ...p }));
  geocoder.on('area:upgraded', (p) => order.push({ event: 'area:upgraded', ...p }));

  const initialArea = await geocoder.select(RESULT_A, { resolution: 'both' });
  assert.equal(order.length, 1, "'select' must have already fired by the time select() resolves");
  assert.equal(order[0].event, 'select');
  assert.equal(initialArea.provenance.resolution, 'both');
  assert.equal(initialArea.provenance.pendingUpgrade, true);
  const initialFilterVertices = initialArea.vertexCount.filter;

  await delay(100); // let the background upgrade finish

  assert.equal(order.length, 2, "'area:upgraded' must fire exactly once after 'select'");
  assert.equal(order[1].event, 'area:upgraded');
  const upgraded = order[1].area;

  // Display geometry is untouched by the upgrade.
  assert.equal(upgraded.geometry, initialArea.geometry);
  assert.deepEqual(upgraded.bbox, initialArea.bbox);
  assert.equal(upgraded.vertexCount.display, initialArea.vertexCount.display);

  // filterGeometry/vertexCount.filter reflect the full-resolution fetch (9 vertices > the display-derived 5).
  assert.equal(upgraded.vertexCount.filter, 9);
  assert.notEqual(upgraded.vertexCount.filter, initialFilterVertices);
  assert.equal(upgraded.provenance.resolution, 'full');
  assert.equal(upgraded.provenance.pendingUpgrade, false);
  assert.ok(upgraded.provenance.simplification);
});

test('select(): a second select() supersedes the first\'s pending background upgrade', async () => {
  const deps = makeDeps({ manifest: makeManifest({ withDisplay: true }), resolveDelayMs: 15, simplifyDelayMs: 10 });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const upgradedFor = [];
  const errors = [];
  geocoder.on('area:upgraded', (p) => upgradedFor.push(p.result.featureId));
  geocoder.on('error', (e) => errors.push(e));

  await geocoder.select(RESULT_A, { resolution: 'both' }); // kicks off A's background upgrade (not yet finished)
  await geocoder.select(RESULT_B, { resolution: 'both' }); // must supersede A's upgrade before it completes

  await delay(150); // let both background tasks settle

  assert.deepEqual(upgradedFor, ['B'], "only the superseding (second) selection's upgrade should ever fire");
  assert.equal(errors.length, 0, 'a superseded upgrade is silently dropped, not surfaced as an error');
});

test('select({ resolution: "display" }) on an oversized geometry: synchronous build degrades filterGeometry to bbox, then a filter-only background upgrade fills it in', async () => {
  const deps = makeOversizedDeps({ manifest: makeManifest({ withDisplay: true }), vertexCount: 15000 });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const order = [];
  geocoder.on('select', (p) => order.push({ event: 'select', ...p }));
  geocoder.on('area:upgraded', (p) => order.push({ event: 'area:upgraded', ...p }));

  const initialArea = await geocoder.select(RESULT_A, { resolution: 'display' });
  assert.equal(order.length, 1);
  assert.equal(initialArea.provenance.resolution, 'display');
  // The vertex-count guard tripped synchronously (15,000 input vertices
  // -- over the default filterVertexCeiling of 10,000, so no early
  // return, but also well over MAX_SYNC_SIMPLIFY_VERTICES): filterGeometry
  // degrades to bbox-only immediately rather than ever running the
  // O(m^2) sync search.
  assert.equal(initialArea.filterGeometry, null);
  assert.equal(initialArea.vertexCount.filter, 0);
  assert.equal(initialArea.provenance.simplification.degradedToBbox, true);
  // 'display' resolution still gets a background upgrade when this
  // happens -- see geocoder.js's `kickFilterOnlyUpgradeIfNeeded` -- so a
  // consumer never permanently loses a real filterGeometry just because
  // it picked the default resolution.
  assert.equal(initialArea.provenance.pendingUpgrade, true);

  await delay(50); // let the filter-only background upgrade finish

  assert.equal(order.length, 2, "'area:upgraded' must fire exactly once after 'select'");
  assert.equal(order[1].event, 'area:upgraded');
  const upgraded = order[1].area;
  assert.notEqual(upgraded.filterGeometry, null);
  assert.equal(upgraded.vertexCount.filter, 7);
  assert.equal(upgraded.provenance.pendingUpgrade, false);
  // Display geometry (and its resolution/variant) is untouched by a
  // filter-only upgrade -- no full-resolution file was ever fetched.
  assert.equal(upgraded.geometry, initialArea.geometry);
  assert.equal(upgraded.provenance.resolution, 'display');
});

test('select({ resolution: "display" }) on a small geometry: no guard, no background upgrade (unchanged behavior)', async () => {
  const deps = makeOversizedDeps({ manifest: makeManifest({ withDisplay: true }), vertexCount: 50 });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const upgrades = [];
  geocoder.on('area:upgraded', (p) => upgrades.push(p));

  const area = await geocoder.select(RESULT_A, { resolution: 'display' });
  assert.notEqual(area.filterGeometry, null);
  assert.equal(area.provenance.pendingUpgrade, false);

  await delay(30);
  assert.equal(upgrades.length, 0, 'a small geometry must not trigger any background upgrade');
});

test('select({ resolution: "full" }) on an oversized geometry: synchronous build degrades filterGeometry to bbox, then a filter-only background upgrade fills it in', async () => {
  const deps = makeOversizedDeps({ manifest: makeManifest({ withDisplay: true }), vertexCount: 15000 });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const order = [];
  geocoder.on('select', (p) => order.push({ event: 'select', ...p }));
  geocoder.on('area:upgraded', (p) => order.push({ event: 'area:upgraded', ...p }));

  const initialArea = await geocoder.select(RESULT_A, { resolution: 'full' });
  assert.equal(initialArea.provenance.resolution, 'full');
  assert.equal(initialArea.filterGeometry, null);
  assert.equal(initialArea.provenance.pendingUpgrade, true);

  await delay(50);

  assert.equal(order.length, 2);
  const upgraded = order[1].area;
  assert.notEqual(upgraded.filterGeometry, null);
  assert.equal(upgraded.vertexCount.filter, 7);
  assert.equal(upgraded.provenance.pendingUpgrade, false);
  assert.equal(upgraded.provenance.resolution, 'full'); // _runFilterOnlyUpgrade never touches `resolution`
});

test('select(): a second select() supersedes a pending filter-only background upgrade too', async () => {
  const deps = makeOversizedDeps({ manifest: makeManifest({ withDisplay: true }), vertexCount: 15000, simplifyDelayMs: 15 });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const upgradedFor = [];
  const errors = [];
  geocoder.on('area:upgraded', (p) => upgradedFor.push(p.result.featureId));
  geocoder.on('error', (e) => errors.push(e));

  await geocoder.select(RESULT_A, { resolution: 'display' }); // kicks off A's filter-only upgrade (not yet finished)
  await geocoder.select(RESULT_B, { resolution: 'display' }); // must supersede A's upgrade before it completes

  await delay(100);

  assert.deepEqual(upgradedFor, ['B']);
  assert.equal(errors.length, 0);
});

test('select(): close() cancels a pending background upgrade', async () => {
  const deps = makeDeps({ manifest: makeManifest({ withDisplay: true }), resolveDelayMs: 15, simplifyDelayMs: 10 });
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
  const upgrades = [];
  const errors = [];
  geocoder.on('area:upgraded', (p) => upgrades.push(p));
  geocoder.on('error', (e) => errors.push(e));

  await geocoder.select(RESULT_A, { resolution: 'both' });
  geocoder.close();

  await delay(80);
  assert.equal(upgrades.length, 0);
  assert.equal(errors.length, 0);
});
