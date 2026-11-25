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

// The loader is the only way @cngeo/maplibre reaches deck.gl. These tests
// pin its seam with a stand-in module object and an injected importer: no
// real bundle is loaded, because the bundle needs a browser.

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
