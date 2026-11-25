import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LayerManager } from '../src/layer-manager.js';
import { DECK_REQUIRED_EXPORTS, setDeckModules, clearDeckModules } from '../src/deck-loader.js';
import { createFakeMap, fakeDeckModules } from './helpers/fake-map.js';

// The manager's contract, against a fake map and two test-only renderers:
// one that adds a MapLibre style layer, one that contributes a deck.gl layer.
// The real renderers have their own tests; whether pixels appear is
// examples/layers-demo/verify.mjs's job.

beforeEach(() => {
  clearDeckModules();
  setDeckModules(fakeDeckModules(DECK_REQUIRED_EXPORTS));
});

const vector = (id, extra = {}) => ({ spec: 'cng-layer/1.0', id, kind: 'geojson', source: { data: { type: 'FeatureCollection', features: [] } }, ...extra });
const raster = (id, extra = {}) => ({ spec: 'cng-layer/1.0', id, kind: 'cog', source: { url: `https://example.org/${id}.tif` }, ...extra });

/** A style-layer renderer: one source, one fill layer, both named `cng-layer-<slug>`. */
function styleRenderer({ gate, fail } = {}) {
  return (ctx) => {
    const id = `cng-layer-${ctx.slug}`;
    return {
      async add(state) {
        if (gate) await gate.promise;
        if (fail) throw new Error(fail);
        ctx.map.addSource(id, { type: 'geojson' });
        ctx.map.addLayer({ id, type: 'fill', source: id, paint: { 'fill-opacity': state.opacity }, layout: { visibility: state.visible ? 'visible' : 'none' } });
      },
      remove() {
        if (ctx.map.getLayer(id)) ctx.map.removeLayer(id);
        if (ctx.map.getSource(id)) ctx.map.removeSource(id);
      },
      setVisible: (v) => ctx.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none'),
      setOpacity: (o) => ctx.map.setPaintProperty(id, 'fill-opacity', o),
      styleLayerIds: () => [id],
    };
  };
}

/** A deck renderer: contributes one plain object standing in for a deck.gl layer. */
const deckRenderer = () => (ctx) => ({
  async add() {
    await ctx.deck();
  },
  remove() {},
  setVisible() {},
  setOpacity() {},
  deckLayers: (state, beforeId) => [{ id: `cng-layer-${ctx.slug}`, beforeId, visible: state.visible, opacity: state.opacity }],
});

const renderers = (overrides = {}) => ({ geojson: styleRenderer(), cog: deckRenderer(), ...overrides });
const overlayOf = (map) => map.controls.find((c) => c.props && 'layers' in c.props);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('add validates, renders, and lists bottom-first under the labels', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  const a = await manager.add(vector('a', { title: 'Layer A' }));
  await manager.add(vector('b'));
  assert.equal(a.status, 'ready');
  assert.equal(a.title, 'Layer A');
  assert.deepEqual(manager.list().map((e) => e.id), ['a', 'b']);
  assert.deepEqual(map.order(), ['background', 'water', 'cng-layer-a', 'cng-layer-b', 'labels']);
});

test('list() and get() return copies, not the live entries', async () => {
  const manager = new LayerManager(createFakeMap(), { renderers: renderers() });
  await manager.add(vector('a'));
  manager.list()[0].visible = false;
  manager.get('a').opacity = 0;
  assert.equal(manager.get('a').visible, true);
  assert.equal(manager.get('a').opacity, 1);
  assert.equal(manager.get('nope'), null);
});

test('an invalid spec is refused before anything is drawn', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await assert.rejects(manager.add({ spec: 'cng-layer/1.0', id: 'x', kind: 'cog', source: {} }), (e) => e.code === 'LAYER_INVALID');
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(map.ours(), []);
});

test('a duplicate id is refused', async () => {
  const manager = new LayerManager(createFakeMap(), { renderers: renderers() });
  await manager.add(vector('a'));
  await assert.rejects(manager.add(vector('a')), (e) => e.code === 'LAYER_INVALID' && e.context.reason === 'duplicate');
  assert.equal(manager.list().length, 1);
});

test('table and unsupported kinds are refused, and so is a kind with no renderer', async () => {
  const manager = new LayerManager(createFakeMap(), { renderers: { geojson: styleRenderer() } });
  const table = { spec: 'cng-layer/1.0', id: 't', kind: 'table', source: { url: 'https://example.org/t.parquet' } };
  const unsupported = { spec: 'cng-layer/1.0', id: 'u', kind: 'unsupported', source: { reason: 'Zarr data: not drawable here yet.', assetTypes: [] } };
  await assert.rejects(manager.add(table), (e) => e.code === 'LAYER_UNSUPPORTED' && e.context.kind === 'table');
  await assert.rejects(manager.add(unsupported), (e) => e.code === 'LAYER_UNSUPPORTED' && /Zarr/.test(e.message));
  await assert.rejects(manager.add(raster('r')), (e) => e.code === 'LAYER_UNSUPPORTED' && e.context.kind === 'cog');
  assert.deepEqual(manager.list(), []);
});

test('setVisible and setOpacity reach the renderer and emit change', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(vector('a'));
  const events = [];
  manager.on('change', (e) => events.push(e));
  manager.setVisible('a', false);
  manager.setOpacity('a', 0.4);
  assert.equal(map.getLayoutProperty('cng-layer-a', 'visibility'), 'none');
  assert.equal(map.getPaintProperty('cng-layer-a', 'fill-opacity'), 0.4);
  assert.deepEqual(events.map((e) => [e.type, e.id]), [['visible', 'a'], ['opacity', 'a']]);
  assert.deepEqual([manager.get('a').visible, manager.get('a').opacity], [false, 0.4]);
});

test('opacity is clamped to 0..1, and a non-number is ignored', async () => {
  const manager = new LayerManager(createFakeMap(), { renderers: renderers() });
  await manager.add(vector('a'));
  manager.setOpacity('a', 7);
  assert.equal(manager.get('a').opacity, 1);
  manager.setOpacity('a', -2);
  assert.equal(manager.get('a').opacity, 0);
  manager.setOpacity('a', NaN);
  assert.equal(manager.get('a').opacity, 0);
});

test('initial visibility, opacity and index are honoured', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(vector('a'));
  await manager.add(vector('b'), { visible: false, opacity: 0.25, index: 0 });
  assert.deepEqual(manager.list().map((e) => e.id), ['b', 'a']);
  assert.equal(map.getLayoutProperty('cng-layer-b', 'visibility'), 'none');
  assert.equal(map.getPaintProperty('cng-layer-b', 'fill-opacity'), 0.25);
  assert.deepEqual(map.ours(), ['cng-layer-b', 'cng-layer-a']);
});

test('move reorders style layers on the map', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  for (const id of ['a', 'b', 'c']) await manager.add(vector(id));
  manager.move('a', 2);
  assert.deepEqual(manager.list().map((e) => e.id), ['b', 'c', 'a']);
  assert.deepEqual(map.order(), ['background', 'water', 'cng-layer-b', 'cng-layer-c', 'cng-layer-a', 'labels']);
  manager.move('a', 0);
  assert.deepEqual(map.ours(), ['cng-layer-a', 'cng-layer-b', 'cng-layer-c']);
  manager.move('b', 99); // past the end clamps to the top
  assert.deepEqual(manager.list().map((e) => e.id), ['a', 'c', 'b']);
});

// Review Focus 4.
test('a raster between two vector layers is slotted just below the upper vector', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(vector('low'));
  await manager.add(raster('img'));
  await manager.add(vector('high'));
  const overlay = overlayOf(map);
  assert.equal(overlay.props.interleaved, true);
  assert.deepEqual(overlay.props.layers.map((l) => [l.id, l.beforeId]), [['cng-layer-img', 'cng-layer-high']]);

  manager.move('img', 2); // to the top: now only the labels are above it
  assert.deepEqual(overlayOf(map).props.layers.map((l) => l.beforeId), ['labels']);

  manager.move('img', 0); // to the bottom: below the lowest vector
  assert.deepEqual(overlayOf(map).props.layers.map((l) => l.beforeId), ['cng-layer-low']);
});

test('adjacent deck layers keep list order in the overlay, and share a slot', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(raster('one'));
  await manager.add(raster('two'));
  assert.deepEqual(overlayOf(map).props.layers.map((l) => [l.id, l.beforeId]), [['cng-layer-one', 'labels'], ['cng-layer-two', 'labels']]);
  manager.move('one', 1);
  assert.deepEqual(overlayOf(map).props.layers.map((l) => l.id), ['cng-layer-two', 'cng-layer-one']);
});

test('deck layers carry visibility and opacity', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(raster('img'));
  manager.setVisible('img', false);
  manager.setOpacity('img', 0.5);
  assert.deepEqual(overlayOf(map).props.layers.map((l) => [l.visible, l.opacity]), [[false, 0.5]]);
});

test('deckLayers() reports what was last handed to the overlay', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  assert.deepEqual(manager.deckLayers(), []); // before any deck layer: no overlay, nothing
  await manager.add(vector('low'));
  await manager.add(raster('img'));
  assert.deepEqual(manager.deckLayers(), overlayOf(map).props.layers);
  assert.notEqual(manager.deckLayers(), overlayOf(map).props.layers); // a copy of the list
  manager.remove('img');
  assert.deepEqual(manager.deckLayers(), []);
});

test('beforeId: null puts the stack above everything, labels included', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers(), beforeId: null });
  await manager.add(vector('a'));
  await manager.add(raster('img'));
  assert.deepEqual(map.order(), ['background', 'water', 'labels', 'cng-layer-a']);
  assert.equal(overlayOf(map).props.layers[0].beforeId, undefined);
});

// Review Focus 1.
test('remove while loading leaves nothing on the map and raises no error', async () => {
  const map = createFakeMap();
  const gate = deferred();
  const manager = new LayerManager(map, { renderers: { geojson: styleRenderer({ gate }) } });
  const errors = [];
  manager.on('error', (e) => errors.push(e));
  const pending = manager.add(vector('slow'));
  assert.equal(manager.get('slow').status, 'loading');
  manager.remove('slow');
  gate.resolve();
  await pending; // resolves; a removal is not a failure
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(map.ours(), []);
  assert.deepEqual(map.sourceIds(), []);
  assert.deepEqual(errors, []);
});

test('a renderer failure keeps the entry with status error, emits error, and rejects', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: { geojson: styleRenderer({ fail: 'tiles are gone' }) } });
  const errors = [];
  manager.on('error', (e) => errors.push(e));
  await assert.rejects(manager.add(vector('bad')), (e) => e.code === 'LAYER_LOAD_FAILED' && /tiles are gone/.test(e.message));
  const entry = manager.get('bad');
  assert.equal(entry.status, 'error');
  assert.equal(entry.error.code, 'LAYER_LOAD_FAILED');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 'bad');
  manager.remove('bad'); // and it can still be removed
  assert.deepEqual(manager.list(), []);
});

test('remove takes the layer off the map and re-slots what is left', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(vector('low'));
  await manager.add(raster('img'));
  await manager.add(vector('high'));
  manager.remove('high');
  assert.deepEqual(map.ours(), ['cng-layer-low']);
  assert.deepEqual(overlayOf(map).props.layers.map((l) => l.beforeId), ['labels']);
  manager.remove('nope'); // unknown ids are ignored
});

// Review Focus 5.
test('after the basemap style is replaced the stack is rebuilt in the same order and state', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(vector('low'), { opacity: 0.3 });
  await manager.add(raster('img'));
  await manager.add(vector('high'), { visible: false });
  map.simulateSetStyle();
  await manager.settled();
  assert.deepEqual(map.order(), ['background', 'water', 'cng-layer-low', 'cng-layer-high', 'labels']);
  assert.equal(map.getPaintProperty('cng-layer-low', 'fill-opacity'), 0.3);
  assert.equal(map.getLayoutProperty('cng-layer-high', 'visibility'), 'none');
  assert.deepEqual(overlayOf(map).props.layers.map((l) => [l.id, l.beforeId]), [['cng-layer-img', 'cng-layer-high']]);
  assert.deepEqual(manager.list().map((e) => [e.id, e.status]), [['low', 'ready'], ['img', 'ready'], ['high', 'ready']]);
});

test('change events name what happened; an unsubscribe stops them', async () => {
  const manager = new LayerManager(createFakeMap(), { renderers: renderers() });
  const events = [];
  const off = manager.on('change', (e) => events.push(e.type));
  await manager.add(vector('a'));
  await manager.add(vector('b'));
  manager.move('a', 1);
  manager.remove('b');
  off();
  manager.remove('a');
  assert.deepEqual(events, ['add', 'ready', 'add', 'ready', 'move', 'remove']);
});

test('destroy removes every layer, the overlay, and its map listeners', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(vector('a'));
  await manager.add(raster('img'));
  manager.destroy();
  assert.deepEqual(map.ours(), []);
  assert.deepEqual(map.sourceIds(), []);
  assert.equal(overlayOf(map), undefined);
  assert.equal(map.listenerCount('style.load'), 0);
  await assert.rejects(manager.add(vector('late')), (e) => e.code === 'LAYER_INVALID' && e.context.reason === 'destroyed');
});
