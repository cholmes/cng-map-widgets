import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LayerManager } from '../src/layer-manager.js';
import { pmtilesVectorRenderer } from '../src/renderers/pmtiles-vector.js';
import { geojsonRenderer } from '../src/renderers/geojson.js';
import { setPmtilesModules, clearPmtilesModules, PMTILES_CDN } from '../src/pmtiles-loader.js';
import { createFakeMap } from './helpers/fake-map.js';

// The two style-layer renderers, driven through a real LayerManager over the
// fake map, with the network (the style file) and the pmtiles library stubbed.

const PMTILES_URL = 'https://example.org/data/sites.pmtiles';
const STYLE_URL = 'https://example.org/data/styles/default.json';

const style = () => ({
  version: 8,
  sources: { data: { type: 'vector', url: 'pmtiles://../sites.pmtiles' } },
  layers: [
    { id: 'area', type: 'fill', source: 'data', 'source-layer': 'sites', paint: { 'fill-opacity': 0.5 } },
    { id: 'points', type: 'circle', source: 'data', 'source-layer': 'sites', paint: { 'circle-color': '#ef6548' } },
  ],
});

const spec = (extra = {}) => ({
  spec: 'cng-layer/1.0',
  id: 'sites',
  kind: 'pmtiles-vector',
  source: { url: PMTILES_URL, layers: ['sites'], style: { url: STYLE_URL } },
  ...extra,
});

let fetched;
let registered;
let archive;
const realFetch = globalThis.fetch;

/** Stub the style fetch. `respond(url)` returns `{ status, body }`; body may be a string. */
function stubFetch(respond) {
  fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const { status = 200, body } = respond(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return typeof body === 'string' ? JSON.parse(body) : body;
      },
    };
  };
}

beforeEach(() => {
  registered = [];
  clearPmtilesModules();
  setPmtilesModules({
    Protocol: class {
      constructor() {
        this.tile = () => {};
        this.archives = new Map();
      }
      add(archive) {
        this.archives.set(archive.url, archive);
      }
      get(url) {
        return this.archives.get(url);
      }
    },
    PMTiles: class {
      constructor(url) {
        this.url = url;
      }
      async getHeader() {
        if (archive.headerError) throw archive.headerError;
        return { tileType: archive.tileType };
      }
      async getMetadata() {
        return archive.metadata;
      }
    },
  });
  // What the stubbed archive says about itself; a test overrides fields.
  archive = {
    tileType: 1, // MVT
    headerError: null,
    metadata: { vector_layers: [{ id: 'sites' }], tilestats: { layers: [{ layer: 'sites', geometry: 'Point' }] } },
  };
  stubFetch(() => ({ body: style() }));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearPmtilesModules();
});

const manager = (map) =>
  new LayerManager(map, {
    renderers: { 'pmtiles-vector': pmtilesVectorRenderer, geojson: geojsonRenderer },
    addProtocol: (name, handler) => registered.push([name, typeof handler]),
  });

test('the pmtiles library is pinned to an exact version', () => {
  assert.equal(PMTILES_CDN, 'https://cdn.jsdelivr.net/npm/pmtiles@4.5.0/+esm');
});

test("pmtiles-vector adds the style's sources and layers, namespaced, under the labels", async () => {
  const map = createFakeMap();
  const entry = await manager(map).add(spec());
  assert.equal(entry.status, 'ready');
  assert.equal(entry.note, undefined);
  assert.deepEqual(fetched, [STYLE_URL]);
  assert.deepEqual(map.sourceIds(), ['cng-layer-sites--data']);
  assert.equal(map.getSource('cng-layer-sites--data').url, `pmtiles://${PMTILES_URL}`);
  assert.deepEqual(map.order(), ['background', 'water', 'cng-layer-sites--area', 'cng-layer-sites--points', 'labels']);
  assert.equal(map.getPaintProperty('cng-layer-sites--points', 'circle-color'), '#ef6548');
});

test('the pmtiles:// protocol is registered through the addProtocol it was given', async () => {
  await manager(createFakeMap()).add(spec());
  assert.deepEqual(registered, [['pmtiles', 'function']]);
});

test('with no addProtocol available, the layer is refused with a message saying what to pass', async () => {
  const m = new LayerManager(createFakeMap(), { renderers: { 'pmtiles-vector': pmtilesVectorRenderer }, addProtocol: null });
  await assert.rejects(m.add(spec()), (e) => e.code === 'LAYER_UNSUPPORTED' && /addProtocol/.test(e.message));
});

// Review Focus 3.
test('a 404 style falls back to a default style and says so', async () => {
  stubFetch(() => ({ status: 404, body: 'Not Found' }));
  const map = createFakeMap();
  const entry = await manager(map).add(spec());
  assert.equal(entry.status, 'ready');
  assert.match(entry.note, /style/i);
  assert.match(entry.note, /404/);
  // The archive says this layer is points, so the default is a circle layer.
  assert.deepEqual(map.ours(), ['cng-layer-sites--sites-circle']);
  assert.equal(map.getSource('cng-layer-sites--data').url, `pmtiles://${PMTILES_URL}`);
});

test('an HTML error page instead of JSON falls back the same way', async () => {
  stubFetch(() => ({ status: 200, body: '<!doctype html><title>Oops</title>' }));
  const map = createFakeMap();
  const entry = await manager(map).add(spec());
  assert.equal(entry.status, 'ready');
  assert.match(entry.note, /style/i);
  assert.deepEqual(map.ours(), ['cng-layer-sites--sites-circle']);
});

test('a style whose layers all name a missing source falls back too', async () => {
  stubFetch(() => ({ body: { version: 8, sources: {}, layers: [{ id: 'orphan', type: 'line', source: 'nope' }] } }));
  const map = createFakeMap();
  const entry = await manager(map).add(spec());
  assert.match(entry.note, /style/i);
  assert.deepEqual(map.ours(), ['cng-layer-sites--sites-circle']);
});

test('no style at all: a default style, and no note (nothing went wrong)', async () => {
  const map = createFakeMap();
  const entry = await manager(map).add(spec({ source: { url: PMTILES_URL, layers: ['sites'] } }));
  assert.equal(entry.note, undefined);
  assert.deepEqual(fetched, []);
  assert.deepEqual(map.ours(), ['cng-layer-sites--sites-circle']);
});

// Found by the Phase 1 review, live: a 404 .pmtiles came back `ready`, with an
// orphan source and no layers.
test('an archive that cannot be read is an error, and nothing is left on the map', async () => {
  archive.headerError = new Error('Bad response code: 404');
  const map = createFakeMap();
  const m = manager(map);
  await assert.rejects(m.add(spec()), (e) => e.code === 'LAYER_LOAD_FAILED' && e.retryable === true && /404/.test(e.message));
  assert.equal(m.get('sites').status, 'error');
  assert.deepEqual(map.ours(), []);
  assert.deepEqual(map.sourceIds(), []);
  assert.deepEqual(fetched, [], 'the style is not fetched for an archive that is not there');
});

test('a PMTiles archive of raster tiles is refused as unsupported, not drawn as nothing', async () => {
  archive.tileType = 2; // PNG
  archive.metadata = {};
  const map = createFakeMap();
  const m = manager(map);
  await assert.rejects(m.add(spec({ source: { url: PMTILES_URL, layers: [] } })), (e) => e.code === 'LAYER_UNSUPPORTED' && /raster/i.test(e.message));
  assert.deepEqual(map.ours(), []);
  assert.deepEqual(map.sourceIds(), []);
});

test('no layer names in the spec and none in the archive: refused, not an empty "ready" layer', async () => {
  archive.metadata = {};
  const map = createFakeMap();
  const m = manager(map);
  await assert.rejects(m.add(spec({ source: { url: PMTILES_URL, layers: [] } })), (e) => e.code === 'LAYER_UNSUPPORTED' && /vector layers/i.test(e.message));
  assert.deepEqual(map.sourceIds(), []);
});

test('layer names are discovered from the archive when the spec gives none', async () => {
  const map = createFakeMap();
  const entry = await manager(map).add(spec({ source: { url: PMTILES_URL, layers: [] } }));
  assert.equal(entry.status, 'ready');
  assert.deepEqual(map.ours(), ['cng-layer-sites--sites-circle']);
});

// "Attribution and share-alike are always displayed." A MapLibre source's
// `attribution` is what MapLibre's own attribution control shows -- as HTML.
test("a layer's credit is put on its MapLibre sources, escaped", async () => {
  const map = createFakeMap();
  await manager(map).add(
    spec({ attribution: [{ text: 'OCHA <b>Jamaica</b>', license: 'CC-BY-SA-4.0', url: 'https://example.org/licence', shareAlike: true, share_alike: true }] }),
  );
  const html = map.getSource('cng-layer-sites--data').attribution;
  assert.match(html, /OCHA &lt;b&gt;Jamaica&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /href="https:\/\/example\.org\/licence"/);
  assert.match(html, /CC-BY-SA-4\.0/);
  assert.match(html, /share-alike/i);
});

test('a geojson layer carries its credit too; a layer with none sets no attribution', async () => {
  const map = createFakeMap();
  const m = manager(map);
  const data = { type: 'FeatureCollection', features: [] };
  await m.add({ spec: 'cng-layer/1.0', id: 'aoi', kind: 'geojson', source: { data }, attribution: [{ text: 'Me', license: 'CC0-1.0' }] });
  await m.add({ spec: 'cng-layer/1.0', id: 'plain', kind: 'geojson', source: { data } });
  assert.match(map.getSource('cng-layer-aoi--data').attribution, /Me/);
  assert.equal('attribution' in map.getSource('cng-layer-plain--data'), false);
});

test('setOpacity scales each layer from its own base opacity', async () => {
  const map = createFakeMap();
  const m = manager(map);
  await m.add(spec());
  m.setOpacity('sites', 0.5);
  assert.equal(map.getPaintProperty('cng-layer-sites--area', 'fill-opacity'), 0.25);
  assert.equal(map.getPaintProperty('cng-layer-sites--points', 'circle-opacity'), 0.5);
  assert.equal(map.getPaintProperty('cng-layer-sites--points', 'circle-stroke-opacity'), 0.5);
  m.setOpacity('sites', 1);
  assert.equal(map.getPaintProperty('cng-layer-sites--area', 'fill-opacity'), 0.5);
});

test('an initial opacity and hidden state are applied as the layers are added', async () => {
  const map = createFakeMap();
  await manager(map).add(spec(), { opacity: 0.5, visible: false });
  assert.equal(map.getPaintProperty('cng-layer-sites--area', 'fill-opacity'), 0.25);
  assert.equal(map.getLayoutProperty('cng-layer-sites--area', 'visibility'), 'none');
  assert.equal(map.getLayoutProperty('cng-layer-sites--points', 'visibility'), 'none');
});

test('setVisible sets layout visibility on every layer', async () => {
  const map = createFakeMap();
  const m = manager(map);
  await m.add(spec());
  m.setVisible('sites', false);
  assert.deepEqual(['area', 'points'].map((l) => map.getLayoutProperty(`cng-layer-sites--${l}`, 'visibility')), ['none', 'none']);
  m.setVisible('sites', true);
  assert.deepEqual(['area', 'points'].map((l) => map.getLayoutProperty(`cng-layer-sites--${l}`, 'visibility')), ['visible', 'visible']);
});

test('remove takes away every layer, then every source', async () => {
  const map = createFakeMap();
  const m = manager(map);
  await m.add(spec());
  m.remove('sites');
  assert.deepEqual(map.ours(), []);
  assert.deepEqual(map.sourceIds(), []);
});

// Review Focus 2, end to end.
test('two collections with identical style ids sit side by side', async () => {
  const map = createFakeMap();
  const m = manager(map);
  await m.add(spec());
  await m.add(spec({ id: 'other' }));
  assert.deepEqual(map.sourceIds(), ['cng-layer-sites--data', 'cng-layer-other--data']);
  m.setOpacity('other', 0.5);
  assert.equal(map.getPaintProperty('cng-layer-sites--area', 'fill-opacity'), 0.5); // untouched
  assert.equal(map.getPaintProperty('cng-layer-other--area', 'fill-opacity'), 0.25);
});

test('after a basemap change the style is not fetched again', async () => {
  const map = createFakeMap();
  const m = manager(map);
  await m.add(spec());
  map.simulateSetStyle();
  await m.settled();
  assert.deepEqual(fetched, [STYLE_URL]);
  assert.deepEqual(map.ours(), ['cng-layer-sites--area', 'cng-layer-sites--points']);
});

test('geojson: inline data draws with a default style by geometry type', async () => {
  const map = createFakeMap();
  const data = { type: 'FeatureCollection', features: [] };
  const m = manager(map);
  await m.add({ spec: 'cng-layer/1.0', id: 'aoi', kind: 'geojson', source: { data } });
  assert.deepEqual(map.getSource('cng-layer-aoi--data'), { type: 'geojson', data });
  assert.deepEqual(map.ours(), ['cng-layer-aoi--fill', 'cng-layer-aoi--line', 'cng-layer-aoi--circle']);
  m.setOpacity('aoi', 0.5);
  assert.equal(map.getPaintProperty('cng-layer-aoi--line', 'line-opacity'), 0.5);
  m.remove('aoi');
  assert.deepEqual(map.ours(), []);
  assert.deepEqual(map.sourceIds(), []);
});

test('geojson: a url is handed to MapLibre as the source data', async () => {
  const map = createFakeMap();
  await manager(map).add({ spec: 'cng-layer/1.0', id: 'remote', kind: 'geojson', source: { url: 'https://example.org/a.geojson' } });
  assert.equal(map.getSource('cng-layer-remote--data').data, 'https://example.org/a.geojson');
});
