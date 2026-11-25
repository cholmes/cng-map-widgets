// PMTiles as a timeline chunk format, against stand-ins for deck.gl and the
// pmtiles library. What reaches the screen is examples/timeline-firms'
// verifier's job; this pins what the format asks of both libraries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCngError } from '@cngeo/spec';
import { pmtilesChunkFormat, describePmtilesChunk, ByteLru } from '../src/timeline/pmtiles-chunk-format.js';

const fields = (...names) => Object.fromEntries(names.map((n) => [n, 'Number']));
const METADATA = {
  vector_layers: [
    { id: 'aggregate', minzoom: 0, maxzoom: 9, fields: fields('a5_cell', 'count', 'count_20240101', 'count_20240102', 'count_20240103') },
    { id: 'features', minzoom: 10, maxzoom: 12, fields: fields('day', 'frp') },
  ],
};
const CHUNK = { id: '2024', start: '20240101', end: '20241231', unit: 'day', format: 'pmtiles', url: 'https://data.invalid/fire-2024.pmtiles', priority: 0 };
const cellFeature = (id, counts) => ({ type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [[[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4], [0.1, 0.1]]] }, properties: { layerName: 'aggregate', a5_cell: id, ...counts } });
const pointFeature = (day) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [0.5, 0.5] }, properties: { layerName: 'features', day, frp: 12 } });

function fakes({ metadata = METADATA, tiles = {} } = {}) {
  const log = { sources: [], metadata: 0, header: 0, zxy: [], parsed: 0 };
  class FetchSource {
    constructor(url) {
      this.url = url;
      this.chromeWindowsNoCache = false;
      log.sources.push(this);
    }
  }
  class PMTiles {
    constructor(source) {
      this.source = source;
    }
    async getMetadata() {
      log.metadata += 1;
      return metadata;
    }
    async getHeader() {
      log.header += 1;
      return { minZoom: 0, maxZoom: 12 };
    }
    async getZxy(z, x, y) {
      log.zxy.push(`${z}/${x}/${y}`);
      const features = tiles[`${z}/${x}/${y}`];
      return features ? { data: new Uint8Array(100).buffer, features } : undefined;
    }
  }
  class Layer {
    constructor(props) {
      this.props = props;
    }
  }
  class DataFilterExtension {
    constructor(options) {
      this.options = options;
    }
  }
  const deck = {
    MVTLayer: class MVTLayer extends Layer {},
    GeoJsonLayer: class GeoJsonLayer extends Layer {},
    DataFilterExtension,
    MVTLoader: {
      // The real loader's defaults. Called directly (not through loaders.gl's
      // `load`), nothing merges these in for us.
      options: { mvt: { shape: 'geojson', coordinates: 'local', layerProperty: 'layerName' } },
      // The stand-in "parses" by looking the tile up again: the bytes are opaque here.
      parse: async (data, options) => {
        log.parsed += 1;
        log.parseOptions = options;
        assert.equal(options.worker, false);
        return log.nextFeatures;
      },
    },
  };
  // getZxy stashes what "parsing" its bytes should give.
  const original = PMTiles.prototype.getZxy;
  PMTiles.prototype.getZxy = async function getZxy(z, x, y, signal) {
    const out = await original.call(this, z, x, y, signal);
    log.nextFeatures = out?.features ?? [];
    return out;
  };
  return { log, deck, loadDeck: async () => deck, loadPmtiles: async () => ({ PMTiles, FetchSource }) };
}

function make(options = {}, fakeOptions = {}) {
  const f = fakes(fakeOptions);
  const format = pmtilesChunkFormat({
    aggregate: { layer: 'aggregate', idProperty: 'a5_cell' },
    points: { layer: 'features', property: 'day' },
    stops: [[1, '#2c3d5a'], [5, '#3f6d8f']],
    idPrefix: 'cng-layer-fires',
    loadDeck: f.loadDeck,
    loadPmtiles: f.loadPmtiles,
    ...options,
  });
  return { ...f, format };
}

async function mounted(options, fakeOptions) {
  const m = make(options, fakeOptions);
  const info = await m.format.open(CHUNK, {});
  const calls = { changed: 0, settled: [] };
  const mount = m.format.mount({ chunk: CHUNK, info, changed: () => { calls.changed += 1; }, settled: (on = true) => calls.settled.push(on) });
  return { ...m, info, mount, calls };
}
const DAYS = (from, to) => ({ unit: 'day', ranges: [[from, to]] });

// --- open --------------------------------------------------------------------------------------------

test('open() reads the archive once, with Chrome\'s range-read lock avoided, and says what it found', async () => {
  const { format, log } = make();
  const info = await format.open(CHUNK, {});
  assert.equal(log.sources.length, 1);
  assert.equal(log.sources[0].url, CHUNK.url);
  assert.equal(log.sources[0].chromeWindowsNoCache, true, 'or Chrome serialises every range read of the archive behind one cache lock');
  assert.deepEqual([log.metadata, log.header], [1, 1]);
  assert.equal(info.unit, 'day');
  assert.deepEqual([...info.columns], ['20240101', '20240102', '20240103']);
  assert.deepEqual([info.minZoom, info.maxZoom], [0, 12]);
  assert.deepEqual(info.aggregateZooms, [0, 9]);
  assert.equal(info.pointsMinZoom, 10);
});

test('an archive whose buckets are not what the descriptor says is refused, naming both', async () => {
  const { format } = make();
  await assert.rejects(format.open({ ...CHUNK, unit: 'month' }, {}), (e) => isCngError(e) && e.code === 'TIMELINE_INVALID' && /month/.test(e.message) && /day/.test(e.message) && e.context.chunk === '2024');
});

test('zoom ranges can be said when the archive does not say', async () => {
  const bare = { vector_layers: [{ id: 'aggregate', fields: fields('count_20240101') }, { id: 'features', fields: fields('day') }] };
  const { format } = make({ aggregate: { layer: 'aggregate', maxzoom: 7 }, points: { layer: 'features', property: 'day', minzoom: 8 } }, { metadata: bare });
  const info = await format.open(CHUNK, {});
  assert.deepEqual(info.aggregateZooms, [0, 7]);
  assert.equal(info.pointsMinZoom, 8);
});

test('an archive with no points layer simply has no points', async () => {
  const only = { vector_layers: [METADATA.vector_layers[0]] };
  const { format } = make({}, { metadata: only });
  const info = await format.open(CHUNK, {});
  assert.equal(info.pointsMinZoom, Infinity);
  assert.deepEqual(info.aggregateZooms, [0, 9]);
});

// --- layers ---------------------------------------------------------------------------------------------

test('a mount is one MVTLayer, set up the way that was measured to work', async () => {
  const { mount, deck } = await mounted();
  const [layer] = mount.layers({ visible: true, opacity: 1 }, 'labels');
  assert.ok(layer instanceof deck.MVTLayer);
  const p = layer.props;
  assert.equal(p.id, 'cng-layer-fires--2024');
  assert.equal(p.data, '{z}/{x}/{y}');
  assert.equal(p.binary, false);
  assert.equal(p.beforeId, 'labels');
  assert.equal(p.refinementStrategy, 'no-overlap', 'translucent parent and child tiles must never show together');
  assert.deepEqual(p.loadOptions, { worker: false }, 'the bundle carries no loader worker');
  assert.ok(Math.abs(p.tileSize - 512 * Math.SQRT2) < 1e-9, 'so deck.gl asks for floor(zoom) tiles, as MapLibre does');
  assert.deepEqual([p.minZoom, p.maxZoom], [0, 12]);
  assert.equal(typeof p.fetch, 'function');
  assert.equal(mount.layers({ visible: true, opacity: 1 }, 'labels')[0].props.fetch, p.fetch, 'the same fetch each time: a new one would refetch every tile');
});

test('loaded but not drawing: tiles are fetched and nothing is painted', async () => {
  const { mount } = await mounted();
  const [layer] = mount.layers({ visible: true, opacity: 1 });
  assert.equal(layer.props.renderSubLayers({ id: 't', data: { cells: [cellFeature(1, { count_20240101: 9 })], points: [] }, tile: { index: { z: 5 } } }), null);
  assert.equal(layer.props.pickable, false);
});

test('drawing: cells are coloured by the sum of the window\'s columns', async () => {
  const { mount, deck } = await mounted();
  mount.setWindow(DAYS('20240101', '20240102'));
  const [layer] = mount.layers({ visible: true, opacity: 0.5 });
  const cells = [cellFeature(1, { count_20240101: 3, count_20240102: 4, count_20240103: 100 }), cellFeature(2, { count_20240103: 50 })];
  const subs = layer.props.renderSubLayers({ id: 't', data: { cells, points: [] }, tile: { index: { z: 5 } } });
  assert.equal(subs.length, 1);
  const sub = subs[0];
  assert.ok(sub instanceof deck.GeoJsonLayer);
  assert.equal(sub.props.data, cells, 'the same array: only colours are rebuilt on a change of window');
  assert.deepEqual(sub.props.getFillColor(cells[0]), [0x3f, 0x6d, 0x8f, 255], '3 + 4 = 7');
  assert.deepEqual(sub.props.getFillColor(cells[1]), [0, 0, 0, 0], 'nothing in the window: transparent');
  assert.ok(sub.props.opacity > 0 && sub.props.opacity < 0.5, 'the layer panel\'s opacity is applied');
});

test('moving the window changes the update trigger and nothing that would refetch', async () => {
  const { mount } = await mounted();
  mount.setWindow(DAYS('20240101', '20240102'));
  const a = mount.layers({ visible: true, opacity: 1 })[0].props;
  mount.setWindow(DAYS('20240102', '20240103'));
  const b = mount.layers({ visible: true, opacity: 1 })[0].props;
  assert.notEqual(a.updateTriggers.getFillColor, b.updateTriggers.getFillColor);
  assert.equal(a.fetch, b.fetch);
  assert.equal(a.id, b.id);
  assert.equal(a.data, b.data);
});

test('points are filtered to the window on the GPU, and only above their zoom', async () => {
  const { mount, deck } = await mounted();
  mount.setWindow(DAYS('20240102', '20240105'));
  const [layer] = mount.layers({ visible: true, opacity: 1 });
  const points = [pointFeature(20240103)];
  const high = layer.props.renderSubLayers({ id: 't', data: { cells: [], points }, tile: { index: { z: 11 } } });
  assert.equal(high.length, 1);
  const sub = high[0].props;
  assert.ok(sub.extensions.some((e) => e instanceof deck.DataFilterExtension));
  const day = (d) => Date.UTC(2024, 0, d) / 86400000;
  assert.deepEqual(sub.filterRange, [day(2), day(5)]);
  assert.equal(sub.getFilterValue(points[0]), day(3));
  assert.equal(sub.pointType, 'circle');
  assert.equal(layer.props.renderSubLayers({ id: 't', data: { cells: [], points: [] }, tile: { index: { z: 11 } } }), null, 'an empty tile draws nothing');
});

// A LayerSpec's source is plain data, so a point's colour has to be sayable
// without a function: a property and the colour each value of it reaches.
test('a point\'s colour can be data: a property and stops', async () => {
  const { mount } = await mounted({ points: { layer: 'features', property: 'day', color: { property: 'frp', stops: [[0, '#4a5bd4'], [10, '#39a0a8'], [50, [201, 207, 74]]] } } });
  mount.setWindow(DAYS('20240102', '20240105'));
  const [layer] = mount.layers({ visible: true, opacity: 1 });
  const [sub] = layer.props.renderSubLayers({ id: 't', data: { cells: [], points: [pointFeature(20240103)] }, tile: { index: { z: 11 } } });
  const colour = sub.props.getFillColor;
  assert.deepEqual(colour({ properties: { frp: 12 } }), [0x39, 0xa0, 0xa8, 235]);
  assert.deepEqual(colour({ properties: { frp: 900 } }), [201, 207, 74, 235]);
  assert.deepEqual(colour({ properties: {} }), [0x4a, 0x5b, 0xd4, 235], 'no value: the first stop');
  assert.equal(colour({ properties: { frp: 12 } }), colour({ properties: { frp: 13 } }), 'the same array back: nothing allocated per point');
});

// Review, Important 3. deck.gl does not load an invisible layer at all, so a
// hidden timeline stopped fetching and the track then reported zeros as
// loaded fact. The layer stays in deck.gl's eyes visible, and paints nothing.
test('a hidden layer still loads its tiles, and paints nothing', async () => {
  const { mount } = await mounted();
  mount.setWindow(DAYS('20240101', '20240102'));
  const hidden = mount.layers({ visible: false, opacity: 1 })[0].props;
  assert.notEqual(hidden.visible, false, 'or deck.gl fetches nothing for it');
  const tile = { id: 't', data: { cells: [cellFeature(1, { count_20240101: 9 })], points: [] }, tile: { index: { z: 5 } } };
  assert.equal(hidden.renderSubLayers(tile), null);
  const shown = mount.layers({ visible: true, opacity: 1 })[0].props;
  assert.notEqual(shown.renderSubLayers(tile), null);
});

// Review, Important 2. deck.gl keeps a tile's sublayers until a compared prop
// of the tile layer changes. Opacity lived only in a closure, so the panel's
// slider did nothing until the selection next moved.
test('a change of opacity or of visibility is a change deck.gl can see', async () => {
  const { mount } = await mounted();
  mount.setWindow(DAYS('20240101', '20240102'));
  const key = (state) => JSON.stringify(mount.layers(state)[0].props.updateTriggers);
  const full = key({ visible: true, opacity: 1 });
  assert.notEqual(key({ visible: true, opacity: 0.2 }), full);
  assert.notEqual(key({ visible: false, opacity: 1 }), full);
  assert.equal(key({ visible: true, opacity: 1 }), full, 'and nothing changes when nothing did');
  const [sub] = mount.layers({ visible: true, opacity: 0.2 })[0].props.renderSubLayers({ id: 't', data: { cells: [cellFeature(1, { count_20240101: 9 })], points: [] }, tile: { index: { z: 5 } } });
  assert.ok(Math.abs(sub.props.opacity - 0.74 * 0.2) < 1e-9);
});

// Review, Important 3 (second half). deck.gl says when a view has finished
// loading and never when one starts; the fetch itself is that signal.
test('the first tile request of a burst says "loading"; the view finishing says "loaded"', async () => {
  const features = [cellFeature(1, { count_20240101: 3 })];
  const { mount, calls } = await mounted({}, { tiles: { '5/1/2': features, '5/1/3': features } });
  const { fetch, onViewportLoad } = mount.layers({ visible: true, opacity: 1 })[0].props;
  const a = fetch('5/1/2', { loadOptions: {} });
  const b = fetch('5/1/3', { loadOptions: {} });
  assert.deepEqual(calls.settled, [false], 'once for the burst');
  await Promise.all([a, b]);
  onViewportLoad();
  assert.deepEqual(calls.settled, [false, true]);
  await fetch('5/1/2', { loadOptions: {} });
  assert.deepEqual(calls.settled, [false, true, false]);
});

// Review, Important 4. Leaving a chunk and coming back -- out to months and
// in again -- reopened the archive and refetched every tile: 9 requests and
// 6.8 s, the same as the first visit.
test('coming back to a chunk reads nothing again: its archive and its tile bytes were kept', async () => {
  const features = [cellFeature(1, { count_20240101: 3 })];
  const m = make({}, { tiles: { '5/1/2': features } });
  const ctx = (info) => ({ chunk: CHUNK, info, changed() {}, settled() {} });
  const first = m.format.mount(ctx(await m.format.open(CHUNK, {})));
  await first.layers({ visible: true, opacity: 1 })[0].props.fetch('5/1/2', { loadOptions: {} });
  first.destroy();
  const second = m.format.mount(ctx(await m.format.open(CHUNK, {})));
  await second.layers({ visible: true, opacity: 1 })[0].props.fetch('5/1/2', { loadOptions: {} });
  assert.deepEqual([m.log.metadata, m.log.header], [1, 1], 'the archive was opened once');
  assert.equal(m.log.sources.length, 1);
  assert.deepEqual(m.log.zxy, ['5/1/2'], 'the tile was fetched once');
  // ...until the format itself is closed.
  m.format.close();
  await m.format.open(CHUNK, {});
  assert.deepEqual([m.log.metadata, m.log.header], [2, 2]);
});

test('an archive that could not be opened is not remembered as one that could not', async () => {
  const m = make();
  let fail = true;
  const real = m.loadPmtiles;
  const format = pmtilesChunkFormat({
    aggregate: { layer: 'aggregate' },
    loadDeck: m.loadDeck,
    loadPmtiles: async () => {
      const pm = await real();
      return { ...pm, PMTiles: class extends pm.PMTiles { async getMetadata() { if (fail) throw new Error('HTTP 520'); return super.getMetadata(); } } };
    },
  });
  await assert.rejects(format.open(CHUNK, {}), /520/);
  fail = false;
  assert.equal((await format.open(CHUNK, {})).unit, 'day');
});

// An archive may declare its axis and list no bucket columns at all (its
// `vector_layers` fields are optional). An empty list is "did not say", not
// "has none": read as none, the map drew nothing while the track counted.
test('an archive that declares an axis but lists no columns still draws', async () => {
  const declared = { 'cng:timeline': { unit: 'day', min: '20240101', max: '20241231' }, vector_layers: [{ id: 'aggregate', minzoom: 0, maxzoom: 9, fields: {} }] };
  const { mount, info } = await mounted({ aggregate: { layer: 'aggregate' }, points: undefined }, { metadata: declared });
  assert.equal(info.columns, null);
  mount.setWindow(DAYS('20240101', '20240102'));
  const cells = [cellFeature(1, { count_20240101: 3, count_20240102: 4 })];
  const [sub] = mount.layers({ visible: true, opacity: 1 })[0].props.renderSubLayers({ id: 't', data: { cells, points: [] }, tile: { index: { z: 5 } } });
  assert.deepEqual(sub.props.getFillColor(cells[0]), [0x3f, 0x6d, 0x8f, 255]);
});

test('a frozen layer keeps what it showed', async () => {
  const { mount } = await mounted();
  mount.setWindow(DAYS('20240101', '20240102'));
  const before = mount.layers({ visible: true, opacity: 1 })[0].props.updateTriggers.getFillColor;
  mount.freeze();
  const frozen = mount.layers({ visible: true, opacity: 1 })[0].props;
  assert.equal(frozen.updateTriggers.getFillColor, before);
  assert.ok(frozen.maxRequests <= 4, 'on its way out: it must not starve its successor');
  assert.notEqual(frozen.renderSubLayers({ id: 't', data: { cells: [cellFeature(1, { count_20240101: 9 })], points: [] }, tile: { index: { z: 5 } } }), null, 'still painting');
});

// --- tiles ----------------------------------------------------------------------------------------------

test('a tile is fetched from the archive once, parsed without a worker, and split by source layer', async () => {
  const features = [cellFeature(1, { count_20240101: 3 }), pointFeature(20240101), cellFeature(2, { count_20240102: 1 })];
  const { mount, log } = await mounted({}, { tiles: { '5/1/2': features } });
  const { fetch } = mount.layers({ visible: true, opacity: 1 })[0].props;
  // What deck.gl passes for a non-binary MVT layer: no shape, no layer property.
  const out = await fetch('5/1/2', { loadOptions: { mimeType: 'application/x-protobuf', mvt: { coordinates: 'local', tileIndex: { x: 1, y: 2, z: 5 } }, gis: {} }, signal: undefined });
  assert.deepEqual(out.cells.map((f) => f.properties.a5_cell), [1, 2]);
  assert.equal(out.points.length, 1);
  // Found live: without the loader's own defaults the parser has no output
  // shape ("undefined shape") and features carry no `layerName` to split by.
  assert.deepEqual(log.parseOptions.mvt, { shape: 'geojson', coordinates: 'local', layerProperty: 'layerName', tileIndex: { x: 1, y: 2, z: 5 } });
  assert.deepEqual(log.zxy, ['5/1/2']);
  await fetch('5/1/2', { loadOptions: {} });
  assert.deepEqual(log.zxy, ['5/1/2'], 'the bytes were kept: no second request');
  assert.equal(log.parsed, 2);
  assert.equal(await fetch('5/9/9', { loadOptions: {} }), null, 'no tile there: empty, not an error');
});

// Found live: the bundled parser hands back a TABLE (`{ shape, features }`),
// not a bare array. Read only as an array, every tile was empty: tiles
// loaded, nothing drew, and the histogram said zero.
test('a parsed tile may be a table of features rather than an array', async () => {
  const features = [cellFeature(1, { count_20240101: 3 }), pointFeature(20240101)];
  const m = await mounted({}, { tiles: { '5/1/2': features } });
  m.deck.MVTLoader.parse = async () => ({ shape: 'geojson-table', type: 'FeatureCollection', features });
  const { fetch } = m.mount.layers({ visible: true, opacity: 1 })[0].props;
  const out = await fetch('5/1/2', { loadOptions: {} });
  assert.equal(out.cells.length, 1);
  assert.equal(out.points.length, 1);
});

test('tiles feed the histogram: cells below the points zoom, points above it', async () => {
  const { mount, calls } = await mounted();
  const { onTileLoad, onViewportLoad, onTileUnload } = mount.layers({ visible: true, opacity: 1 })[0].props;
  const bbox = { west: 0, east: 10, north: 10, south: 0 };
  onTileLoad({ id: '5-0-0', index: { z: 5 }, bbox, content: { cells: [cellFeature(1, { count_20240101: 3, count_20240102: 4 })], points: [] } });
  onTileLoad({ id: '11-0-0', index: { z: 11 }, bbox, content: { cells: [], points: [pointFeature(20240102), pointFeature(20240102)] } });
  assert.equal(calls.changed, 2);
  onViewportLoad();
  assert.deepEqual(calls.settled, [true]);
  const view = [-1, -1, 11, 11];
  assert.deepEqual(mount.histogram({ bbox: view, zoom: 5.4 }), { 20240101: 3, 20240102: 4 });
  assert.deepEqual(mount.histogram({ bbox: view, zoom: 11.2 }), { 20240102: 2 });
  assert.deepEqual(mount.histogram({ bbox: [50, 50, 60, 60], zoom: 5 }), {});
  onTileUnload({ id: '5-0-0' });
  assert.deepEqual(mount.histogram({ bbox: view, zoom: 5 }), {});
  assert.deepEqual(mount.histogram(null), {}, 'no viewport yet: nothing, not a throw');
});

test('destroy() lets go of the parsed tiles; the bytes stay in the cache for a return', async () => {
  const features = [cellFeature(1, { count_20240101: 3 })];
  const { mount, calls } = await mounted({}, { tiles: { '5/1/2': features } });
  const { fetch, onTileLoad } = mount.layers({ visible: true, opacity: 1 })[0].props;
  await fetch('5/1/2', { loadOptions: {} });
  onTileLoad({ id: '5-1-2', index: { z: 5 }, bbox: { west: 0, east: 10, north: 10, south: 0 }, content: { cells: features, points: [] } });
  mount.destroy();
  assert.deepEqual(mount.layers({ visible: true, opacity: 1 }), []);
  assert.deepEqual(mount.histogram({ bbox: [-1, -1, 11, 11], zoom: 5 }), {});
  const said = calls.settled.length;
  await fetch('5/1/2', { loadOptions: {} }); // deck.gl may still be mid-request
  assert.equal(calls.settled.length, said, 'a destroyed mount says nothing more');
});

// --- describing an archive ----------------------------------------------------------------------------------

test('describePmtilesChunk: a descriptor\'s unit and dates, from what the archive itself declares', async () => {
  const declared = { ...METADATA, 'firms:timeline': JSON.stringify({ unit: 'day', min: '20261118', max: '20261125', buckets: 8 }) };
  const a = fakes({ metadata: declared });
  assert.deepEqual(await describePmtilesChunk('https://data.invalid/fire-latest.pmtiles', { loadPmtiles: a.loadPmtiles }), { unit: 'day', start: '20261118', end: '20261125', url: 'https://data.invalid/fire-latest.pmtiles', format: 'pmtiles' });
  // A monthly archive covers its months whole: the record below ends in September, not today.
  const monthly = { vector_layers: [{ id: 'aggregate', fields: fields('count_200011', 'count_202609') }], 'firms:timeline': { unit: 'month', min: '200011', max: '202609' } };
  const b = fakes({ metadata: monthly });
  assert.deepEqual(await describePmtilesChunk('https://data.invalid/alltime.pmtiles', { loadPmtiles: b.loadPmtiles }), { unit: 'month', start: '20001101', end: '20260930', url: 'https://data.invalid/alltime.pmtiles', format: 'pmtiles' });
  const none = fakes({ metadata: {} });
  await assert.rejects(describePmtilesChunk('https://data.invalid/x.pmtiles', { loadPmtiles: none.loadPmtiles }), (e) => e.code === 'TIMELINE_INVALID');
});

// --- the byte cache ----------------------------------------------------------------------------------------

test('ByteLru keeps the most recently used bytes within its budget', () => {
  const lru = new ByteLru(250);
  const bytes = (n) => new Uint8Array(n).buffer;
  lru.set('a', bytes(100));
  lru.set('b', bytes(100));
  assert.ok(lru.get('a'), 'a hit moves it to the newest end');
  lru.set('c', bytes(100));
  assert.equal(lru.get('b'), undefined, 'the least recently used went');
  assert.ok(lru.get('a') && lru.get('c'));
  assert.equal(lru.used, 200);
  lru.set('huge', bytes(1000));
  assert.equal(lru.get('huge'), undefined, 'bigger than the whole budget: not kept');
  lru.dropPrefix('a');
  assert.equal(lru.get('a'), undefined);
  assert.equal(lru.used, 100);
});
