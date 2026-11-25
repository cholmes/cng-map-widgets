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

// Something drawn by another control that belongs just above the stack (the
// imagery search's footprints) needs to know where the stack ends.
test('anchor() is the layer the stack sits just below', () => {
  assert.equal(new LayerManager(createFakeMap(), { renderers: renderers() }).anchor(), 'labels');
  assert.equal(new LayerManager(createFakeMap(), { renderers: renderers(), beforeId: null }).anchor(), undefined, 'on top of everything');
  assert.equal(new LayerManager(createFakeMap(), { renderers: renderers(), beforeId: 'nope' }).anchor(), undefined, 'a slot the style does not have');
});

// Found live by examples/imagery-search: deck.gl puts its layer group
// DIRECTLY below whatever `beforeId` names, and moves it back there on every
// update. Footprints placed "just under the labels" by another control were
// therefore covered by the first image added. They have to be the thing the
// stack is slotted under.
test('setTopLayers keeps another control\'s layers just above the stack, under the labels', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(vector('v'));
  await manager.add(raster('r'));
  map.addLayer({ id: 'guest--fill', type: 'fill' }, 'labels');
  map.addLayer({ id: 'guest--line', type: 'line' }, 'labels');
  manager.setTopLayers(['guest--fill', 'guest--line']);

  const order = map.order();
  assert.deepEqual(order.slice(order.indexOf('guest--fill'), order.indexOf('labels') + 1), ['guest--fill', 'guest--line', 'labels']);
  assert.ok(order.indexOf('cng-layer-v') < order.indexOf('guest--fill'), 'the stack is below the guests');
  // The raster, on top of the stack, is slotted under the LOWEST guest -- not under the labels.
  assert.equal(manager.deckLayers()[0].beforeId, 'guest--fill');
  assert.equal(manager.anchor(), 'labels', 'anchor() is still where stack and guests together end');

  // It holds through a reorder...
  manager.move('r', 0);
  const after = map.order();
  assert.deepEqual(after.slice(after.indexOf('guest--fill'), after.indexOf('labels') + 1), ['guest--fill', 'guest--line', 'labels']);
  assert.ok(after.indexOf('cng-layer-v') < after.indexOf('guest--fill'));
  assert.equal(manager.deckLayers()[0].beforeId, 'cng-layer-v');

  // ...and letting go puts the stack back under the labels.
  manager.setTopLayers([]);
  manager.move('r', 1);
  assert.equal(manager.deckLayers()[0].beforeId, 'labels');
});

// Two controls on one map each have layers of their own up there (the imagery
// search's footprints, the catalog search's extent). The second to declare
// must not undo the first.
test('setTopLayers is per owner: two controls each keep their layers above the stack', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(raster('r'));
  for (const id of ['a--fill', 'a--line', 'b--line']) map.addLayer({ id, type: 'line' }, 'labels');
  manager.setTopLayers(['a--fill', 'a--line'], 'a');
  manager.setTopLayers(['b--line'], 'b');
  const order = map.order();
  assert.deepEqual(order.slice(order.indexOf('a--fill'), order.indexOf('labels') + 1), ['a--fill', 'a--line', 'b--line', 'labels'], 'both sets, in the order their owners declared');
  assert.equal(manager.deckLayers()[0].beforeId, 'a--fill');
  // One owner letting go leaves the other's in place.
  manager.setTopLayers([], 'a');
  assert.equal(manager.deckLayers()[0].beforeId, 'b--line');
  manager.setTopLayers([], 'b');
  assert.equal(manager.deckLayers()[0].beforeId, 'labels');
});

test('setTopLayers ignores a layer the map does not have (yet)', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(raster('r'));
  manager.setTopLayers(['not-there--fill', 'not-there--line']);
  assert.equal(manager.deckLayers()[0].beforeId, 'labels');
  // Once it exists, declaring it again takes effect.
  map.addLayer({ id: 'not-there--fill', type: 'fill' }, 'labels');
  manager.setTopLayers(['not-there--fill', 'not-there--line']);
  assert.equal(manager.deckLayers()[0].beforeId, 'not-there--fill');
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

// --- Found by the Phase 1 review, each first reproduced as a probe -----------

test('visibility and opacity set while a layer is still loading are applied when it is ready', async () => {
  const map = createFakeMap();
  const gate = deferred();
  const manager = new LayerManager(map, { renderers: { geojson: styleRenderer({ gate }) } });
  const pending = manager.add(vector('slow'), { opacity: 0.5 });
  manager.setVisible('slow', false);
  manager.setOpacity('slow', 0.3);
  gate.resolve();
  await pending;
  assert.equal(map.getLayoutProperty('cng-layer-slow', 'visibility'), 'none');
  assert.equal(map.getPaintProperty('cng-layer-slow', 'fill-opacity'), 0.3);
  assert.deepEqual([manager.get('slow').visible, manager.get('slow').opacity], [false, 0.3]);
});

test('add() before the map style has loaded waits for it instead of failing', async () => {
  const map = createFakeMap({ styleLoaded: false });
  const manager = new LayerManager(map, { renderers: renderers() });
  const pending = manager.add(vector('early'));
  await Promise.resolve();
  assert.equal(manager.get('early').status, 'loading');
  map.finishLoadingStyle();
  const entry = await pending;
  assert.equal(entry.status, 'ready');
  assert.deepEqual(map.ours(), ['cng-layer-early']);
});

test('two ids that reduce to the same map id are refused, not silently merged', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(vector('a b'));
  await assert.rejects(manager.add(vector('a/b')), (e) => e.code === 'LAYER_INVALID' && e.context.reason === 'duplicate' && /a b/.test(e.message));
  assert.deepEqual(manager.list().map((e) => e.id), ['a b']);
});

test('remove then re-add of the same id while the first is still loading keeps the second', async () => {
  const map = createFakeMap();
  const first = deferred();
  let calls = 0;
  // Like the real style renderers, this one skips what is already on the map
  // -- which is what lets a late, abandoned add "succeed" and then clean up
  // layers that now belong to someone else.
  const tolerant = ({ gate } = {}) => (ctx) => {
    const id = `cng-layer-${ctx.slug}`;
    return {
      async add() {
        if (gate) await gate.promise;
        if (!ctx.map.getSource(id)) ctx.map.addSource(id, { type: 'geojson' });
        if (!ctx.map.getLayer(id)) ctx.map.addLayer({ id, type: 'fill', source: id });
      },
      remove() {
        if (ctx.map.getLayer(id)) ctx.map.removeLayer(id);
        if (ctx.map.getSource(id)) ctx.map.removeSource(id);
      },
      setVisible() {},
      setOpacity() {},
      styleLayerIds: () => [id],
    };
  };
  // The first add waits on a gate; the second completes at once.
  const renderer = (ctx) => (calls++ === 0 ? tolerant({ gate: first })(ctx) : tolerant()(ctx));
  const manager = new LayerManager(map, { renderers: { geojson: renderer } });
  const one = manager.add(vector('sites'));
  manager.remove('sites');
  await manager.add(vector('sites'));
  first.resolve(); // the abandoned add finishes last
  await one;
  assert.deepEqual(manager.list().map((e) => [e.id, e.status]), [['sites', 'ready']]);
  assert.deepEqual(map.ours(), ['cng-layer-sites']);
  assert.deepEqual(map.sourceIds(), ['cng-layer-sites']);
});

test('a renderer can report a failure after it was ready: the entry becomes an error', async () => {
  const map = createFakeMap();
  let ctxOf;
  const manager = new LayerManager(map, {
    renderers: { cog: (ctx) => { ctxOf = ctx; return deckRenderer()(ctx); } },
  });
  const events = [];
  manager.on('change', (e) => events.push(e.type));
  const errors = [];
  manager.on('error', (e) => errors.push(e));
  await manager.add(raster('img'));
  assert.equal(overlayOf(map).props.layers.length, 1);

  ctxOf.fail(new Error('Metadata loading failed: 404'));
  const entry = manager.get('img');
  assert.equal(entry.status, 'error');
  assert.equal(entry.error.code, 'LAYER_LOAD_FAILED');
  assert.match(entry.error.message, /404/);
  assert.deepEqual(errors.map((e) => e.id), ['img']);
  assert.equal(events.at(-1), 'error');
  assert.deepEqual(overlayOf(map).props.layers, []); // nothing is drawn for a failed layer
});

// A renderer whose deck.gl layers change on their own -- a timeline, whose
// layers follow its selection -- has to be able to say "describe me again".
test('ctx.redraw() hands the renderer\'s current deck layers to the overlay again', async () => {
  const map = createFakeMap();
  let ctxOf;
  let colour = 'red';
  const manager = new LayerManager(map, {
    renderers: {
      cog: (ctx) => {
        ctxOf = ctx;
        return { ...deckRenderer()(ctx), deckLayers: (state, beforeId) => [{ id: `cng-layer-${ctx.slug}`, beforeId, colour }] };
      },
    },
  });
  await manager.add(raster('img'));
  assert.equal(overlayOf(map).props.layers[0].colour, 'red');
  colour = 'blue';
  ctxOf.redraw();
  assert.equal(overlayOf(map).props.layers[0].colour, 'blue');
  manager.remove('img');
  ctxOf.redraw(); // after removal: nothing, and no throw
  assert.deepEqual(overlayOf(map).props.layers, []);
});

test('handle(id) is what a renderer offers a control to drive it; null when it offers nothing', async () => {
  const session = { setSelection() {} };
  const manager = new LayerManager(createFakeMap(), {
    renderers: { ...renderers(), cog: (ctx) => ({ ...deckRenderer()(ctx), handle: () => session }) },
  });
  await manager.add(raster('img'));
  await manager.add(vector('plain'));
  assert.equal(manager.handle('img'), session);
  assert.equal(manager.handle('plain'), null);
  assert.equal(manager.handle('nope'), null);
});

test('a note from a renderer is announced, so a panel can show it at once', async () => {
  let ctxOf;
  const manager = new LayerManager(createFakeMap(), { renderers: { geojson: (ctx) => { ctxOf = ctx; return styleRenderer()(ctx); } } });
  await manager.add(vector('a'));
  const events = [];
  manager.on('change', (e) => events.push([e.type, e.id]));
  ctxOf.note('Some of this image could not be loaded');
  assert.deepEqual(events, [['note', 'a']]);
  assert.equal(manager.get('a').note, 'Some of this image could not be loaded');
});

test('attribution() lists what must be credited for the layers currently shown', async () => {
  const manager = new LayerManager(createFakeMap(), { renderers: renderers() });
  const credit = (text, license, shareAlike = false) => [{ text, license, shareAlike, share_alike: shareAlike }];
  await manager.add(vector('a', { attribution: credit('Parishes of Jamaica', 'CC-BY-4.0') }));
  await manager.add(raster('img', { attribution: credit('Sentinel-2', 'CC-BY-SA-3.0-IGO', true) }));
  await manager.add(vector('none'));
  assert.deepEqual(manager.attribution().map((a) => [a.id, a.text, a.license, a.shareAlike]), [
    ['a', 'Parishes of Jamaica', 'CC-BY-4.0', false],
    ['img', 'Sentinel-2', 'CC-BY-SA-3.0-IGO', true],
  ]);
  manager.setVisible('img', false);
  assert.deepEqual(manager.attribution().map((a) => a.id), ['a']); // a hidden layer needs no credit
  assert.deepEqual(manager.attribution({ deckOnly: true }).map((a) => a.id), []);
  manager.setVisible('img', true);
  assert.deepEqual(manager.attribution({ deckOnly: true }).map((a) => a.id), ['img']);
});

test('when the basemap style is replaced the overlay is emptied before the stack is rebuilt', async () => {
  const map = createFakeMap();
  const manager = new LayerManager(map, { renderers: renderers() });
  await manager.add(vector('low'));
  await manager.add(raster('img'));
  // deck.gl re-adds its layer groups the moment the style loads; a group slotted
  // under a style layer that is not back yet is a console error.
  let seenDuringStyleLoad;
  map.on('style.load', () => { seenDuringStyleLoad = overlayOf(map).props.layers.length; });
  map.simulateSetStyle();
  assert.equal(seenDuringStyleLoad, 0);
  await manager.settled();
  assert.equal(overlayOf(map).props.layers.length, 1);
});

test('a layer removed while the stack is being rebuilt is not put back', async () => {
  const map = createFakeMap();
  const gate = deferred();
  let adds = 0;
  // The first add is immediate; the re-add after setStyle waits on a gate.
  const slowSecond = (ctx) => {
    const inner = styleRenderer()(ctx);
    return { ...inner, async add(state) { if (adds++ > 0) await gate.promise; return inner.add(state); } };
  };
  const manager = new LayerManager(map, { renderers: { geojson: slowSecond } });
  await manager.add(vector('a'));
  map.simulateSetStyle();
  manager.remove('a');
  gate.resolve();
  await manager.settled();
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(map.ours(), []);
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
