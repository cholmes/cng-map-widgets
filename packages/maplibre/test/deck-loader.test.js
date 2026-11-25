import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECK_BUNDLE_URL,
  DECK_REQUIRED_EXPORTS,
  APPROX_BYTES,
  loadDeck,
  setDeckModules,
  clearDeckModules,
  deckSupport,
} from '../src/deck-loader.js';

// The loader is the only way @cngeo/maplibre reaches deck.gl. Most of these
// tests pin its seam with a stand-in module object and an injected importer.
// The last one imports the real committed bundle (it evaluates fine in Node;
// only DRAWING needs a browser) to tie it to DECK_REQUIRED_EXPORTS.

const full = () =>
  Object.fromEntries(
    DECK_REQUIRED_EXPORTS.map((k) => [k, k === 'VERSIONS' ? { deck: '9.4.2', raster: '0.10.0' } : {}]),
  );

beforeEach(() => clearDeckModules());

test('the bundle URL points at the committed vendor file', () => {
  assert.match(DECK_BUNDLE_URL, /\/packages\/maplibre\/vendor\/deck-stack\.js$/);
  assert.equal(typeof APPROX_BYTES.deck, 'number');
});

test('injected modules are returned as-is', async () => {
  const mods = full();
  setDeckModules(mods);
  assert.equal(await loadDeck(), mods);
});

test('an injected set missing an export is refused, naming it', () => {
  const mods = full();
  delete mods.COGSource;
  assert.throws(
    () => setDeckModules(mods),
    (e) => e.code === 'DECK_MODULES_INVALID' && e.retryable === false && e.context.missing.includes('COGSource'),
  );
});

test('concurrent loads share one import', async () => {
  let calls = 0;
  const mods = full();
  const importer = async () => {
    calls++;
    return mods;
  };
  const [a, b] = await Promise.all([loadDeck({ importer }), loadDeck({ importer })]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('the importer is handed the bundle URL', async () => {
  let seen;
  const mods = full();
  await loadDeck({
    importer: async (url) => {
      seen = url;
      return mods;
    },
  });
  assert.equal(seen, DECK_BUNDLE_URL);
});

test('a failed load rejects retryably and is not cached', async () => {
  let calls = 0;
  const mods = full();
  const importer = async () => {
    if (++calls === 1) throw new Error('offline');
    return mods;
  };
  await assert.rejects(loadDeck({ importer }), (e) => e.code === 'DECK_LOAD_FAILED' && e.retryable === true);
  assert.equal(await loadDeck({ importer }), mods);
  assert.equal(calls, 2);
});

test('a loaded bundle missing an export is refused', async () => {
  const mods = full();
  delete mods.RasterLayer;
  await assert.rejects(
    loadDeck({ importer: async () => mods }),
    (e) => e.code === 'DECK_MODULES_INVALID' && e.context.missing.includes('RasterLayer'),
  );
});

test('clearDeckModules drops both an injection and a cached load', async () => {
  const first = full();
  const second = full();
  await loadDeck({ importer: async () => first });
  clearDeckModules();
  assert.equal(await loadDeck({ importer: async () => second }), second);
});

test('deckSupport reports WebGL2 and norm16', () => {
  const gl = { getExtension: (n) => (n === 'EXT_texture_norm16' ? {} : null) };
  assert.deepEqual(deckSupport({ getContext: (t) => (t === 'webgl2' ? gl : null) }), { webgl2: true, norm16: true });
  const glNo16 = { getExtension: () => null };
  assert.deepEqual(deckSupport({ getContext: (t) => (t === 'webgl2' ? glNo16 : null) }), { webgl2: true, norm16: false });
  assert.deepEqual(deckSupport({ getContext: () => null }), { webgl2: false, norm16: false });
});

test('deckSupport with no canvas and no document reports no support', () => {
  assert.deepEqual(deckSupport(), { webgl2: false, norm16: false });
});

// A browser allows only a handful of live WebGL contexts per page. A probe
// that opened one per call and never released it eventually took the MAP's
// context away: 40 calls blanked the whole map, with nothing in the console.
test('deckSupport() probes once, and releases the context it opened', () => {
  let canvases = 0;
  let lost = 0;
  const gl = {
    getExtension: (name) => {
      if (name === 'EXT_texture_norm16') return {};
      if (name === 'WEBGL_lose_context') return { loseContext: () => lost++ };
      return null;
    },
  };
  globalThis.document = {
    createElement: () => {
      canvases++;
      return { getContext: (t) => (t === 'webgl2' ? gl : null) };
    },
  };
  try {
    clearDeckModules(); // also forgets a remembered probe
    const first = deckSupport();
    const second = deckSupport();
    assert.deepEqual(first, { webgl2: true, norm16: true });
    assert.deepEqual(second, first);
    assert.equal(canvases, 1, 'the no-argument probe is remembered');
    assert.equal(lost, 1, 'the probe context is released');
  } finally {
    delete globalThis.document;
    clearDeckModules();
  }
});

// Injecting after a load has begun would leave two deck.gl copies on the
// page: callers already holding the bundle keep it, later callers get the
// injected set. That is the silent no-draw failure this module exists to
// prevent, so it is refused.
test('setDeckModules after a load has started is refused', async () => {
  const bundle = full();
  const pending = loadDeck({ importer: async () => bundle });
  assert.throws(
    () => setDeckModules(full()),
    (e) => e.code === 'DECK_MODULES_INVALID' && e.context.reason === 'already-loading',
  );
  assert.equal(await pending, bundle);
  assert.throws(() => setDeckModules(full()), (e) => e.code === 'DECK_MODULES_INVALID');
});

test('setDeckModules is allowed again after a failed load', async () => {
  await assert.rejects(loadDeck({ importer: async () => { throw new Error('offline'); } }));
  const mods = full();
  setDeckModules(mods);
  assert.equal(await loadDeck(), mods);
});

test('clearDeckModules during a load does not let the stale load become current', async () => {
  let release;
  const stale = full();
  const fresh = full();
  const pending = loadDeck({ importer: () => new Promise((resolve) => { release = () => resolve(stale); }) });
  clearDeckModules();
  const next = loadDeck({ importer: async () => fresh });
  release();
  assert.equal(await pending, stale);
  assert.equal(await next, fresh);
  assert.equal(await loadDeck({ importer: async () => full() }), fresh, 'the newer load stays cached');
});

// The committed bundle and DECK_REQUIRED_EXPORTS must agree, and the bundle
// must be the one built from the versions pinned in package.json. Without
// this, adding a required name and forgetting to rebuild passes every other
// test while every real load throws DECK_MODULES_INVALID.
test('the committed bundle loads through the default importer and matches the pins', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const mods = await loadDeck();
  for (const name of DECK_REQUIRED_EXPORTS) assert.ok(mods[name] != null, `bundle exports ${name}`);
  assert.equal(mods.VERSIONS.deck, pkg.devDependencies['@deck.gl/core']);
  assert.equal(mods.VERSIONS.luma, pkg.devDependencies['@luma.gl/core']);
  assert.equal(mods.VERSIONS.raster, pkg.devDependencies['@developmentseed/deck.gl-raster']);
});
