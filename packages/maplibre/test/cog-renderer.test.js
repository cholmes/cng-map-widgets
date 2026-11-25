import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LayerManager } from '../src/layer-manager.js';
import { cogRenderer } from '../src/renderers/cog.js';
import { DECK_REQUIRED_EXPORTS, setDeckModules, clearDeckModules } from '../src/deck-loader.js';
import { createFakeMap, fakeDeckModules } from './helpers/fake-map.js';

// The COG renderer through a real LayerManager, with deck.gl stubbed by a
// COGLayer that records the props it was built with. That the props DRAW is
// experiments/e12-deck-bundle's finding and examples/layers-demo's check.

const URL_A = 'https://example.org/a.tif';
const cog = (id = 'img', url = URL_A) => ({ spec: 'cng-layer/1.0', id, kind: 'cog', source: { url } });
const overlayLayers = (map) => map.controls.find((c) => c.props && 'layers' in c.props).props.layers;

beforeEach(() => {
  clearDeckModules();
  setDeckModules(fakeDeckModules(DECK_REQUIRED_EXPORTS));
});

test('contributes one COGLayer carrying the url, visibility, opacity and slot', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: { cog: cogRenderer } });
  const entry = await manager.add(cog(), { opacity: 0.6 });
  assert.equal(entry.status, 'ready');
  const [layer] = overlayLayers(map);
  assert.equal(layer.constructor.name, 'COGLayer');
  assert.equal(layer.props.id, 'cng-layer-img');
  assert.equal(layer.props.source, URL_A);
  assert.equal(layer.props.visible, true);
  assert.equal(layer.props.opacity, 0.6);
  assert.equal(layer.props.beforeId, 'labels');
});

// deck.gl diffs layers by id and props: a changed `source` reopens the file.
test('the layer id and source are the same on every rebuild', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: { cog: cogRenderer } });
  await manager.add(cog());
  const first = overlayLayers(map)[0];
  manager.setOpacity('img', 0.2);
  manager.setVisible('img', false);
  const second = overlayLayers(map)[0];
  assert.notEqual(second, first); // a fresh layer object, as deck.gl expects
  assert.equal(second.props.id, first.props.id);
  assert.equal(second.props.source, first.props.source);
  assert.deepEqual([second.props.opacity, second.props.visible], [0.2, false]);
});

test('a load failure of deck.gl rejects with DECK_LOAD_FAILED and leaves the entry in error', async () => {
  clearDeckModules();
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: { cog: cogRenderer }, loadDeck: async () => { const { CngError } = await import('@cngeo/spec'); throw new CngError('offline', 'DECK_LOAD_FAILED'); } });
  await assert.rejects(manager.add(cog()), (e) => e.code === 'DECK_LOAD_FAILED' && e.retryable === true);
  assert.equal(manager.get('img').status, 'error');
  assert.equal(manager.get('img').error.code, 'DECK_LOAD_FAILED');
});

test('a tile error is recorded as a note on the layer, not thrown', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: { cog: cogRenderer } });
  await manager.add(cog());
  overlayLayers(map)[0].props.onTileError(new Error('403 Forbidden'));
  assert.match(manager.get('img').note, /403 Forbidden/);
});
