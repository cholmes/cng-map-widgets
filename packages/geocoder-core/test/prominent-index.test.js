import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder } from '../src/index.js';

// Two-wave search (manifest contract addition `prominent_index`, task 3)
// and the Geocoder-level wiring for footer prefetch / handle-cache reuse
// (manifest contract addition `footer_bytes`, task 2). Same fake-`__deps`
// strategy as select.test.js: `load()`/`select()` can only run end to end
// against a real network + a real `import()` of hyparquet's pinned
// `https:` CDN URL, which `node --test` cannot do, so these exercise the
// real control flow (load() resolving early, search()'s two-wave
// emission, the handleCache/footerBytes actually passed to
// resolveGeometry) against fakes for the two calls that need the network.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function row({ featureId, name, nameNorm, level = 4, country = 'ZZZ' }) {
  return {
    name,
    name_norm: nameNorm,
    level,
    country,
    feature_id: featureId,
    source: 'test-source',
    bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
  };
}

function fullIndexFromRows(rows) {
  const sorted = [...rows].sort((a, b) => (a.name_norm < b.name_norm ? -1 : a.name_norm > b.name_norm ? 1 : 0));
  return { rows: sorted, nameNorms: sorted.map((r) => r.name_norm) };
}

function baseManifest(extra = {}) {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 2,
    levels: [4],
    // Both sizes declared, deliberately different: `footer_metadata_bytes`
    // (the thrift footer alone) must win over `footer_bytes` (footer +
    // page index) as the initialFetchSize hyparquet actually gets --
    // hyparquet has no sub-chunk read and never touches the page-index
    // bodies, so `footer_bytes` would just over-fetch for it.
    index: { url: './index.parquet', size: 100, footer_bytes: 9999, footer_metadata_bytes: 3333 },
    boundaries: [
      {
        level: 4,
        feature_id_column: 'feature_id',
        geometry_column: 'geometry',
        full: { url: './adm4-full.parquet', footer_bytes: 9999, footer_metadata_bytes: 1111 },
        display: { url: './adm4-display.parquet', footer_bytes: 9999, footer_metadata_bytes: 2222 },
      },
    ],
    attribution: [],
    ...extra,
  };
}

const RESULT_A = { featureId: 'A', name: 'Alpha', level: 4, country: 'ZZZ', bbox: [0, 0, 1, 1] };
const RESULT_B = { featureId: 'B', name: 'Beta', level: 4, country: 'ZZZ', bbox: [0, 0, 1, 1] };

// --- Handle cache + footer_bytes wiring (task 2) ---------------------------

test('Geocoder#select(): the same handleCache instance is threaded into every resolveGeometry call, across multiple selects', async () => {
  const seenCaches = [];
  const deps = {
    loadManifest: async () => baseManifest(),
    loadFullIndex: async () => ({ rows: [], nameNorms: [] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
    async resolveGeometry(result, boundaryUrl, catalogVersion, fetchImpl, onVersionSkew, onWarning, options = {}) {
      seenCaches.push(options.handleCache);
      return { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, bbox: [0, 0, 1, 1] };
    },
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/index.json', __deps: deps });

  await geocoder.select(RESULT_A);
  await geocoder.select(RESULT_B);

  assert.equal(seenCaches.length, 2);
  assert.ok(seenCaches[0] instanceof Map, 'a Map must be passed as the handle cache');
  assert.equal(seenCaches[0], seenCaches[1], 'the exact same cache instance must be reused across selects on one Geocoder');
});

test('Geocoder#select(): threads footer_metadata_bytes (preferred over footer_bytes) for the boundary flavor actually fetched', async () => {
  const seenFooterBytes = [];
  const deps = {
    loadManifest: async () => baseManifest(),
    loadFullIndex: async () => ({ rows: [], nameNorms: [] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
    async resolveGeometry(result, boundaryUrl, catalogVersion, fetchImpl, onVersionSkew, onWarning, options = {}) {
      seenFooterBytes.push(options.footerBytes);
      return { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, bbox: [0, 0, 1, 1] };
    },
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/index.json', __deps: deps });

  await geocoder.select(RESULT_A, { resolution: 'display' });
  await geocoder.select(RESULT_A, { resolution: 'full' });

  // The manifest declares footer_bytes: 9999 on both flavors (a decoy) and
  // footer_metadata_bytes 2222/1111 -- the latter must be what's threaded
  // through, not the former.
  assert.deepEqual(seenFooterBytes, [2222, 1111], 'display footer_metadata_bytes (2222) then full footer_metadata_bytes (1111) -- never the 9999 decoy');
});

test('Geocoder: falls back to footer_bytes when footer_metadata_bytes is absent (an older manifest)', async () => {
  const manifest = baseManifest();
  manifest.boundaries[0].full = { url: './adm4-full.parquet', footer_bytes: 4444 }; // no footer_metadata_bytes at all
  const seenFooterBytes = [];
  const deps = {
    loadManifest: async () => manifest,
    loadFullIndex: async () => ({ rows: [], nameNorms: [] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
    async resolveGeometry(result, boundaryUrl, catalogVersion, fetchImpl, onVersionSkew, onWarning, options = {}) {
      seenFooterBytes.push(options.footerBytes);
      return { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, bbox: [0, 0, 1, 1] };
    },
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/index.json', __deps: deps });
  await geocoder.select(RESULT_A, { resolution: 'full' });
  assert.deepEqual(seenFooterBytes, [4444]);
});

test('Geocoder#load(): schedules a background footer prefetch that opens each declared boundary file, display before full, using the manifest\'s footer_bytes', async () => {
  const opened = [];
  const deps = {
    loadManifest: async () => baseManifest(),
    loadFullIndex: async () => ({ rows: [], nameNorms: [] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
    resolveGeometry: async () => ({ geometry: null, bbox: undefined }),
    openBoundaryFile: async (url, fetchImpl, signal, footerBytes) => {
      opened.push({ url, footerBytes });
      return { url, file: {}, metadata: {}, catalogVersion: 'cv1' };
    },
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/index.json', __deps: deps });

  await geocoder.load();
  await delay(50); // let the setTimeout-scheduled prefetch steps run (no requestIdleCallback under node --test)

  assert.equal(opened.length, 2, `expected both declared boundary files prefetched, got ${JSON.stringify(opened)}`);
  assert.ok(opened[0].url.includes('adm4-display'), 'display is prefetched first');
  assert.equal(opened[0].footerBytes, 2222);
  assert.ok(opened[1].url.includes('adm4-full'), 'full is prefetched second');
  assert.equal(opened[1].footerBytes, 1111);
});

test('Geocoder#load(): footer prefetch runs only once per instance, even across repeated load() calls', async () => {
  let openCalls = 0;
  const deps = {
    loadManifest: async () => baseManifest(),
    loadFullIndex: async () => ({ rows: [], nameNorms: [] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
    resolveGeometry: async () => ({ geometry: null, bbox: undefined }),
    openBoundaryFile: async (url) => {
      openCalls++;
      return { url, file: {}, metadata: {}, catalogVersion: 'cv1' };
    },
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/index.json', __deps: deps });

  await geocoder.load();
  await geocoder.load(); // idempotent: load() returns the cached promise, _doLoad never runs twice
  await delay(50);

  assert.equal(openCalls, 2, 'exactly the 2 declared boundary files, not 4 -- the prefetch itself only ever runs once');
});

// --- Two-wave search (task 3) ----------------------------------------------

test('Geocoder#load(): with no prominent_index declared, info.prominent is undefined (unchanged behavior)', async () => {
  const deps = {
    loadManifest: async () => baseManifest(),
    loadFullIndex: async () => fullIndexFromRows([row({ featureId: 'A', name: 'Alpha', nameNorm: 'alpha' })]),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/index.json', __deps: deps, loadStrategy: 'full' });
  const info = await geocoder.load();
  assert.equal(info.prominent, undefined);
});

test('Geocoder#load(): resolves as soon as the prominent index is ready, without waiting for a slow main index; search() answers wave 1 from it immediately', async () => {
  let resolveMain;
  const mainPromise = new Promise((resolve) => { resolveMain = resolve; });
  const prominentRows = fullIndexFromRows([row({ featureId: 'BAG', name: 'Bag', nameNorm: 'bag' })]);

  const deps = {
    // `row_count`, not `rows` -- the field name the shipped Overture
    // staging manifest actually uses (matching every other per-file
    // entry's own field name, `boundaries[].full`/`.display` included).
    loadManifest: async () => baseManifest({ prominent_index: { url: './prominent.parquet', row_count: 1, size: 1000 } }),
    loadFullIndex: async (url) => (url.includes('prominent') ? prominentRows : mainPromise),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/index.json', __deps: deps, loadStrategy: 'full' });

  // If load() incorrectly waited on the (never-resolving-yet) main index,
  // this would hang until the test runner's own timeout -- the absence of
  // a timeout IS the assertion that the prominent wave alone unblocked it.
  const info = await geocoder.load();
  assert.equal(geocoder.state, 'ready');
  assert.deepEqual(info.prominent, { rows: 1, bytes: 1000, ready: true }, 'row_count must be read into info.prominent.rows');

  const events = [];
  geocoder.on('results', (p) => events.push(p));
  const wave1 = await geocoder.search('ba');
  assert.deepEqual(wave1.map((r) => r.featureId), ['BAG']);
  assert.equal(events.length, 1);
  assert.equal(events[0].wave, 'prominent', 'the main index is not ready yet: this must be tagged as the fast, incomplete wave');

  resolveMain(fullIndexFromRows([
    row({ featureId: 'BAG', name: 'Bag', nameNorm: 'bag' }),
    row({ featureId: 'BAGHDAD', name: 'Baghdad', nameNorm: 'baghdad' }),
  ]));
  await delay(30); // let index:upgraded + the second wave's search run

  assert.equal(events.length, 2, 'a final wave must follow once the main index is ready, since it adds a row');
  assert.equal(events[1].wave, 'final');
  assert.deepEqual(events[1].results.map((r) => r.featureId).sort(), ['BAG', 'BAGHDAD']);
});

test('Geocoder#search(): a final wave that adds no new rows over the prominent wave is never re-emitted', async () => {
  let resolveMain;
  const mainPromise = new Promise((resolve) => { resolveMain = resolve; });
  const onlyBag = fullIndexFromRows([row({ featureId: 'BAG', name: 'Bag', nameNorm: 'bag' })]);

  const deps = {
    loadManifest: async () => baseManifest({ prominent_index: { url: './prominent.parquet', rows: 1, size: 1000 } }),
    loadFullIndex: async (url) => (url.includes('prominent') ? onlyBag : mainPromise),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/index.json', __deps: deps, loadStrategy: 'full' });
  await geocoder.load();

  const events = [];
  geocoder.on('results', (p) => events.push(p));
  await geocoder.search('ba');
  assert.equal(events.length, 1);

  // The main index turns out to carry exactly the same single row --
  // re-ranking it changes nothing a caller would see.
  resolveMain(onlyBag);
  await delay(30);

  assert.equal(events.length, 1, 'no second "results" emission when the final wave adds nothing new');
});

test('Geocoder#search(): a later search() supersedes an in-flight second wave for an earlier query', async () => {
  let resolveMain;
  const mainPromise = new Promise((resolve) => { resolveMain = resolve; });
  const prominentRows = fullIndexFromRows([
    row({ featureId: 'BAG', name: 'Bag', nameNorm: 'bag' }),
    row({ featureId: 'BAZ', name: 'Baz', nameNorm: 'baz' }),
  ]);

  const deps = {
    loadManifest: async () => baseManifest({ prominent_index: { url: './prominent.parquet', rows: 2, size: 1000 } }),
    loadFullIndex: async (url) => (url.includes('prominent') ? prominentRows : mainPromise),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/index.json', __deps: deps, loadStrategy: 'full' });
  await geocoder.load();

  const events = [];
  geocoder.on('results', (p) => events.push(p));
  await geocoder.search('ba'); // wave 1 for "ba": superseded before its final wave ever lands
  await geocoder.search('baz'); // a newer query bumps the generation counter

  resolveMain(fullIndexFromRows([
    row({ featureId: 'BAG', name: 'Bag', nameNorm: 'bag' }),
    row({ featureId: 'BAGHDAD', name: 'Baghdad', nameNorm: 'baghdad' }),
    row({ featureId: 'BAZ', name: 'Baz', nameNorm: 'baz' }),
  ]));
  await delay(30);

  // "ba"'s final wave must never have fired (its generation was superseded
  // by "baz"); "baz" has nothing new to add over its own prominent-wave
  // answer, so it gets no final wave either. Either way, nothing beyond
  // the two first-wave emissions should exist.
  assert.equal(events.length, 2, `expected exactly the two first-wave emissions, got ${JSON.stringify(events.map((e) => [e.query, e.wave]))}`);
});
