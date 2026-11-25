import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayerManager } from '../src/layer-manager.js';
import { createControlAdapter, applyPanelOrder } from '../src/layer-control-adapter.js';
import { createFakeMap } from './helpers/fake-map.js';

// The mapping between LayerManager (the truth, bottom-first) and the panel
// (opengeos' maplibre-gl-layer-control, which lists top-first and talks to
// non-MapLibre layers through a CustomLayerAdapter). Pure: no DOM.

const vector = (id, extra = {}) => ({ spec: 'cng-layer/1.0', id, kind: 'geojson', source: { data: { type: 'FeatureCollection', features: [] } }, ...extra });
const raster = (id) => ({ spec: 'cng-layer/1.0', id, kind: 'cog', source: { url: `https://example.org/${id}.tif` } });

const fakeRenderer = (ctx) => {
  const id = `cng-layer-${ctx.slug}`;
  return {
    async add() {
      ctx.map.addSource(id, { type: 'geojson' });
      ctx.map.addLayer({ id, type: 'fill', source: id });
    },
    remove() {
      ctx.map.removeLayer(id);
      ctx.map.removeSource(id);
    },
    setVisible() {},
    setOpacity() {},
    styleLayerIds: () => [id],
  };
};

async function setup(ids = ['a', 'b', 'c']) {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: { geojson: fakeRenderer, cog: fakeRenderer } });
  for (const id of ids) await manager.add(id === 'img' ? raster(id) : vector(id, { title: `Layer ${id.toUpperCase()}`, bbox: [0, 0, 1, 1] }));
  return { map, manager, adapter: createControlAdapter(manager) };
}

test('the adapter identifies itself and lists layers top-first', async () => {
  const { adapter } = await setup();
  assert.equal(adapter.type, 'cng');
  assert.deepEqual(adapter.getLayerIds(), ['c', 'b', 'a']);
});

test('layer state, name, symbol and bounds come from the manager', async () => {
  const { adapter, manager } = await setup(['a', 'img']);
  manager.setOpacity('a', 0.4);
  manager.setVisible('a', false);
  assert.deepEqual(adapter.getLayerState('a'), { visible: false, opacity: 0.4, name: 'Layer A' });
  assert.equal(adapter.getName('a'), 'Layer A');
  assert.equal(adapter.getSymbolType('a'), 'fill');
  assert.equal(adapter.getSymbolType('img'), 'raster');
  assert.deepEqual(adapter.getBounds('a'), [0, 0, 1, 1]);
  assert.equal(adapter.getBounds('img'), null);
  assert.equal(adapter.getLayerState('nope'), null);
  assert.equal(adapter.getName('nope'), 'nope');
});

test('visibility, opacity and removal go through the manager', async () => {
  const { adapter, manager } = await setup();
  adapter.setVisibility('a', false);
  adapter.setOpacity('a', 0.25);
  assert.deepEqual([manager.get('a').visible, manager.get('a').opacity], [false, 0.25]);
  adapter.removeLayer('b');
  assert.deepEqual(manager.list().map((e) => e.id), ['a', 'c']);
});

test('onLayerChange reports add and remove, and its unsubscribe stops it', async () => {
  const { adapter, manager } = await setup(['a']);
  const seen = [];
  const off = adapter.onLayerChange((event, id) => seen.push([event, id]));
  await manager.add(vector('b'));
  manager.setOpacity('b', 0.5); // not an add or a remove: not reported
  manager.remove('a');
  off();
  manager.remove('b');
  assert.deepEqual(seen, [['add', 'b'], ['remove', 'a']]);
});

test('applyPanelOrder makes the manager match the order the panel reports (top-first)', async () => {
  const { manager, map } = await setup();
  applyPanelOrder(manager, ['a', 'c', 'b']); // a on top
  assert.deepEqual(manager.list().map((e) => e.id), ['b', 'c', 'a']);
  assert.deepEqual(map.ours(), ['cng-layer-b', 'cng-layer-c', 'cng-layer-a']);
  applyPanelOrder(manager, ['c', 'b', 'a']); // back to the original
  assert.deepEqual(manager.list().map((e) => e.id), ['a', 'b', 'c']);
});

test('applyPanelOrder ignores ids it does not know, and layers the panel left out stay put relative to each other', async () => {
  const { manager } = await setup();
  applyPanelOrder(manager, ['Background', 'a', 'user-drawn-layer', 'c']); // b not mentioned
  const order = manager.list().map((e) => e.id);
  assert.ok(order.indexOf('a') > order.indexOf('c'), 'a is above c, as reported');
  assert.deepEqual([...order].sort(), ['a', 'b', 'c']);
});
