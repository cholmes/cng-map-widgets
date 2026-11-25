// A timeline as ONE entry in the layer manager: the renderer for
// `kind: 'timeline'`, against the real `@cngeo/timeline` and a stand-in chunk
// format. What reaches the screen is examples/timeline-firms' verifier's job.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as timeline from '@cngeo/timeline';
import { LayerManager } from '../src/layer-manager.js';
import { DECK_REQUIRED_EXPORTS, setDeckModules, clearDeckModules } from '../src/deck-loader.js';
import { setTimelineModules, clearTimelineModules } from '../src/timeline-loader.js';
import { registerChunkFormat } from '../src/timeline/timeline-renderer.js';
import '../src/index.js'; // registers the built-in renderers, `timeline` among them
import { createFakeMap, fakeDeckModules } from './helpers/fake-map.js';

const records = new Map(); // chunk id -> what its mount was asked
let failing = new Set();

registerChunkFormat('stand-in', ({ slug }) => ({
  async open(chunk) {
    if (failing.has(chunk.id)) throw new Error(`HTTP 404 for ${chunk.url}`);
    return {};
  },
  mount(ctx) {
    const record = { id: ctx.chunk.id, window: null, destroyed: false, viewport: undefined, refreshed: 0 };
    records.set(ctx.chunk.id, record);
    ctx.settled(true);
    return {
      setWindow: (w) => { record.window = w; },
      histogram: (viewport) => { record.viewport = viewport; return { [ctx.chunk.end]: 7 }; },
      freeze() {},
      destroy: () => { record.destroyed = true; },
      layers: (state, beforeId) => (record.destroyed ? [] : [{ id: `cng-layer-${slug}--${ctx.chunk.id}`, window: record.window, visible: state.visible, opacity: state.opacity, beforeId }]),
      refresh: () => { record.refreshed += 1; },
      tiles: () => ({ selected: 4, loaded: 3, errors: 0 }),
    };
  },
}));

beforeEach(() => {
  clearDeckModules();
  setDeckModules(fakeDeckModules(DECK_REQUIRED_EXPORTS));
  clearTimelineModules();
  setTimelineModules(timeline);
  records.clear();
  failing = new Set();
});

const chunk = (id, start, end, extra = {}) => ({ id, start, end, unit: 'day', format: 'stand-in', url: `https://data.invalid/${id}.bin`, ...extra });
const CHUNKS = [chunk('2023', '20230101', '20231231'), chunk('2024', '20240101', '20241210'), chunk('week', '20241204', '20241210', { priority: 1 })];
const spec = (source = {}) => ({ spec: 'cng-layer/1.0', id: 'fires', title: 'Fires', kind: 'timeline', source: { chunks: CHUNKS, ...source }, attribution: [{ text: 'NASA FIRMS' }] });
const overlayOf = (map) => map.controls.find((c) => c.props && 'layers' in c.props);
const settle = async (ms = 0) => {
  await new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function make() {
  const map = createFakeMap();
  map.getBounds = () => ({ getWest: () => -10, getSouth: () => -5, getEast: () => 10, getNorth: () => 5 });
  map.getZoom = () => 4.6;
  return { map, manager: new LayerManager(map) };
}

test('a timeline is one entry; its session is the handle; it opens on the last days of the record', async () => {
  const { manager } = make();
  const entry = await manager.add(spec());
  assert.equal(entry.kind, 'timeline');
  assert.equal(entry.status, 'ready');
  assert.equal(manager.list().length, 1);
  const session = manager.handle('fires');
  assert.ok(session);
  assert.deepEqual(session.state.selection, { from: '20241206', to: '20241210' }, 'the last five days');
  assert.deepEqual(session.state.view, { from: '20240902', to: '20241210' }, 'the last hundred');
  assert.equal(session.title, 'Fires');
  await settle();
  assert.deepEqual(session.state.loaded, ['2024', 'week']);
  assert.deepEqual(session.state.drawing, ['week']);
  session.destroy();
});

test('how it opens can be said', async () => {
  const { manager } = make();
  await manager.add(spec({ open: { selectDays: 2, viewDays: 30 } }));
  const session = manager.handle('fires');
  assert.deepEqual(session.state.selection, { from: '20241209', to: '20241210' });
  assert.deepEqual(session.state.view, { from: '20241111', to: '20241210' });
});

test('every mounted chunk contributes its deck.gl layers, bottom first, and a change redraws them', async () => {
  const { map, manager } = make();
  await manager.add(spec());
  await settle();
  const layers = () => overlayOf(map).props.layers;
  assert.deepEqual(layers().map((l) => l.id), ['cng-layer-fires--2024', 'cng-layer-fires--week']);
  assert.equal(layers()[0].window, null);
  assert.deepEqual(layers()[1].window.ranges, [['20241206', '20241210']]);
  assert.equal(layers()[0].beforeId, 'labels');
  manager.handle('fires').setSelection({ from: '20241101', to: '20241105' });
  assert.deepEqual(layers()[0].window.ranges, [['20241101', '20241105']], 'redrawn without being asked');
  assert.equal(layers()[1].window, null);
});

test('hiding the layer and changing its opacity reach every chunk', async () => {
  const { map, manager } = make();
  await manager.add(spec());
  await settle();
  manager.setVisible('fires', false);
  assert.deepEqual(overlayOf(map).props.layers.map((l) => l.visible), [false, false]);
  manager.setVisible('fires', true);
  manager.setOpacity('fires', 0.4);
  assert.deepEqual(overlayOf(map).props.layers.map((l) => l.opacity), [0.4, 0.4]);
});

test('the map\'s view is what the histogram is of', async () => {
  const { map, manager } = make();
  await manager.add(spec());
  await settle(260);
  assert.deepEqual(records.get('week').viewport, { bbox: [-10, -5, 10, 5], zoom: 4.6 });
  const session = manager.handle('fires');
  assert.deepEqual(session.state.histogram, { 20241210: 7 }, 'the week owns that day; the year\'s copy is not added to it');
  map.getZoom = () => 7;
  const before = records.get('week').refreshed;
  map.fire('moveend');
  await settle(260);
  assert.equal(records.get('week').viewport.zoom, 7);
  assert.ok(records.get('week').refreshed > before, 'each chunk is asked whether this view has loaded');
  assert.deepEqual(session.tiles(), { selected: 8, loaded: 6, errors: 0 });
});

test('a chunk that will not load is a note on the layer, not a failed layer', async () => {
  failing = new Set(['2024']);
  const { manager } = make();
  await manager.add(spec());
  await settle();
  const entry = manager.get('fires');
  assert.equal(entry.status, 'ready');
  assert.match(entry.note, /2024/);
  assert.match(entry.note, /404/);
  // Tried again and it works: the note goes.
  failing = new Set();
  manager.handle('fires').retry('2024');
  await settle();
  assert.ok(!manager.get('fires').note);
});

test('when nothing at all can be loaded the layer has failed', async () => {
  failing = new Set(['2023', '2024', 'week']);
  const { manager } = make();
  await manager.add(spec());
  await settle();
  const entry = manager.get('fires');
  assert.equal(entry.status, 'error');
  assert.equal(entry.error.code, 'LAYER_LOAD_FAILED');
});

test('a format nobody registered is said at once, by name', async () => {
  const { manager } = make();
  await manager.add(spec({ chunks: [chunk('x', '20240101', '20240201', { format: 'geoparquet' })] }));
  await settle();
  assert.equal(manager.get('fires').status, 'error');
  assert.match(manager.get('fires').error.message, /geoparquet/);
});

test('it survives the basemap being replaced: the same session, its layers put back', async () => {
  const { map, manager } = make();
  await manager.add(spec());
  await settle();
  const session = manager.handle('fires');
  map.simulateSetStyle();
  map.finishLoadingStyle();
  await settle();
  assert.equal(manager.handle('fires'), session);
  assert.deepEqual(overlayOf(map).props.layers.map((l) => l.id), ['cng-layer-fires--2024', 'cng-layer-fires--week']);
  assert.equal(records.get('week').destroyed, false);
});

test('removing the layer destroys the session and leaves nothing on the map', async () => {
  const { map, manager } = make();
  const listening = map.listenerCount('moveend');
  await manager.add(spec());
  await settle();
  const session = manager.handle('fires');
  const events = [];
  session.on('change', () => events.push(1));
  manager.remove('fires');
  assert.equal(manager.handle('fires'), null);
  assert.deepEqual(overlayOf(map).props.layers, []);
  assert.equal(records.get('week').destroyed && records.get('2024').destroyed, true);
  assert.equal(map.listenerCount('moveend'), listening);
  const seen = events.length;
  session.setSelection({ from: '20241101', to: '20241105' });
  map.fire('moveend');
  await settle(260);
  assert.equal(events.length, seen, 'nothing more is said');
});

test('a bad chunk list fails the add, with the timeline\'s own error', async () => {
  const { manager } = make();
  await assert.rejects(manager.add(spec({ chunks: [chunk('a', '20240201', '20240101')] })), (e) => e.code === 'TIMELINE_INVALID' || e.cause?.code === 'TIMELINE_INVALID');
});
