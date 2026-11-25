import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStyle, defaultVectorStyle, defaultGeojsonLayers, opacityPaint } from '../src/renderers/style-plan.js';

// Pure style arithmetic: turning a published MapLibre style into sources and
// layers that can sit in someone else's map without colliding, and scaling a
// layer's opacity from whatever the style gave it.

const STYLE_URL = 'https://data.source.coop/portolan-mirrors/unosat/tc/damage-sites/styles/default.json';

/** The real UNOSAT damage-sites style, as published. */
const unosatStyle = () => ({
  version: 8,
  name: 'Damage sites by Main_Damag',
  sources: { data: { type: 'vector', url: 'pmtiles://../tc20180209ton-damage-sites.pmtiles' } },
  layers: [
    {
      source: 'data',
      'source-layer': 'damage-sites',
      id: 'damage-sites-points',
      type: 'circle',
      paint: {
        'circle-color': ['match', ['to-string', ['get', 'Main_Damag']], 'Possible Damage', '#fdcc8a', 'Damaged', '#ef6548', '#bdbdbd'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 4, 14, 5.5, 16, 7],
        'circle-stroke-color': '#333333',
        'circle-stroke-width': 0.6,
      },
    },
  ],
});

test('ids are namespaced and the pmtiles url is made absolute against the style file', () => {
  const plan = planStyle({ slug: 'x', styleJson: unosatStyle(), styleUrl: STYLE_URL });
  assert.deepEqual(Object.keys(plan.sources), ['cng-layer-x--data']);
  assert.equal(plan.sources['cng-layer-x--data'].url, 'pmtiles://https://data.source.coop/portolan-mirrors/unosat/tc/damage-sites/tc20180209ton-damage-sites.pmtiles');
  assert.equal(plan.layers.length, 1);
  assert.equal(plan.layers[0].id, 'cng-layer-x--damage-sites-points');
  assert.equal(plan.layers[0].source, 'cng-layer-x--data');
  assert.equal(plan.layers[0]['source-layer'], 'damage-sites');
  assert.deepEqual(plan.layers[0].paint['circle-color'][0], 'match'); // the published expression survives
  assert.equal(plan.note, undefined);
});

test('the input style is not modified', () => {
  const style = unosatStyle();
  planStyle({ slug: 'x', styleJson: style, styleUrl: STYLE_URL });
  assert.deepEqual(style, unosatStyle());
});

// Review Focus 2: every Portolan style names its source `data`.
test('two layers whose styles use the same source and layer ids do not collide', () => {
  const a = planStyle({ slug: 'a', styleJson: unosatStyle(), styleUrl: STYLE_URL });
  const b = planStyle({ slug: 'b', styleJson: unosatStyle(), styleUrl: STYLE_URL });
  const ids = (p) => [...Object.keys(p.sources), ...p.layers.map((l) => l.id)];
  assert.deepEqual(ids(a).filter((id) => ids(b).includes(id)), []);
});

test('an already-absolute pmtiles url and plain tile urls are handled', () => {
  const plan = planStyle({
    slug: 'x',
    styleUrl: STYLE_URL,
    styleJson: {
      version: 8,
      sources: {
        abs: { type: 'vector', url: 'pmtiles://https://example.org/t.pmtiles' },
        tiles: { type: 'vector', tiles: ['../tiles/{z}/{x}/{y}.pbf'] },
        geo: { type: 'geojson', data: './points.geojson' },
        inline: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [],
    },
  });
  assert.equal(plan.sources['cng-layer-x--abs'].url, 'pmtiles://https://example.org/t.pmtiles');
  assert.deepEqual(plan.sources['cng-layer-x--tiles'].tiles, ['https://data.source.coop/portolan-mirrors/unosat/tc/damage-sites/tiles/{z}/{x}/{y}.pbf']);
  assert.equal(plan.sources['cng-layer-x--geo'].data, 'https://data.source.coop/portolan-mirrors/unosat/tc/damage-sites/styles/points.geojson');
  assert.deepEqual(plan.sources['cng-layer-x--inline'].data, { type: 'FeatureCollection', features: [] });
});

// Found live (carto-open-catalogs' Jamaica parishes, 2026-11-25): a published
// style gives its archive as a bare relative path, with no `pmtiles://`.
// MapLibre then fetches the archive itself as TileJSON and fails with
// `Unexpected token 'P', "PMTiles"... is not valid JSON`.
test('a .pmtiles source url with no pmtiles:// scheme is still read as PMTiles', () => {
  const plan = planStyle({
    slug: 'x',
    styleUrl: 'https://storage.googleapis.com/carto-open-catalogs/ocha-cod-jamaica/main/parishes/styles/default.json',
    styleJson: {
      version: 8,
      sources: {
        data: { type: 'vector', url: '../parishes.pmtiles' },
        absolute: { type: 'vector', url: 'https://example.org/t.pmtiles?v=2' },
        tilejson: { type: 'vector', url: './tiles.json' },
      },
      layers: [],
    },
  });
  assert.equal(plan.sources['cng-layer-x--data'].url, 'pmtiles://https://storage.googleapis.com/carto-open-catalogs/ocha-cod-jamaica/main/parishes/parishes.pmtiles');
  assert.equal(plan.sources['cng-layer-x--absolute'].url, 'pmtiles://https://example.org/t.pmtiles?v=2');
  // A real TileJSON url is left as one.
  assert.equal(plan.sources['cng-layer-x--tilejson'].url, 'https://storage.googleapis.com/carto-open-catalogs/ocha-cod-jamaica/main/parishes/styles/tiles.json');
});

test('a layer naming a missing source is dropped, with a note', () => {
  const style = unosatStyle();
  style.layers.push({ id: 'orphan', type: 'line', source: 'nope' });
  const plan = planStyle({ slug: 'x', styleJson: style, styleUrl: STYLE_URL });
  assert.deepEqual(plan.layers.map((l) => l.id), ['cng-layer-x--damage-sites-points']);
  assert.match(plan.note, /orphan/);
});

test('a background layer is dropped: a data layer must not paint over the map', () => {
  const style = unosatStyle();
  style.layers.unshift({ id: 'bg', type: 'background', paint: { 'background-color': '#fff' } });
  const plan = planStyle({ slug: 'x', styleJson: style, styleUrl: STYLE_URL });
  assert.deepEqual(plan.layers.map((l) => l.id), ['cng-layer-x--damage-sites-points']);
  assert.match(plan.note, /background/);
});

test('something that is not a style document is refused', () => {
  assert.throws(() => planStyle({ slug: 'x', styleJson: { hello: 'world' }, styleUrl: STYLE_URL }), /not a MapLibre style/);
  assert.throws(() => planStyle({ slug: 'x', styleJson: null, styleUrl: STYLE_URL }), /not a MapLibre style/);
});

test('opacityPaint: a number is multiplied', () => {
  assert.deepEqual(opacityPaint({ type: 'fill', paint: { 'fill-opacity': 0.5 } }, 0.5), { 'fill-opacity': 0.25 });
});

test('opacityPaint: an absent opacity means 1', () => {
  assert.deepEqual(opacityPaint({ type: 'line', paint: {} }, 0.4), { 'line-opacity': 0.4 });
  assert.deepEqual(opacityPaint({ type: 'line' }, 0.4), { 'line-opacity': 0.4 });
});

test('opacityPaint: a circle scales its fill and its stroke', () => {
  assert.deepEqual(opacityPaint({ type: 'circle', paint: { 'circle-stroke-opacity': 0.8 } }, 0.5), { 'circle-opacity': 0.5, 'circle-stroke-opacity': 0.4 });
});

test('opacityPaint: a data expression is wrapped in a multiplication', () => {
  const expr = ['case', ['has', 'faded'], 0.2, 1];
  assert.deepEqual(opacityPaint({ type: 'fill', paint: { 'fill-opacity': expr } }, 0.5), { 'fill-opacity': ['*', expr, 0.5] });
});

// A zoom expression must stay the OUTERMOST expression, or MapLibre rejects the style.
test('opacityPaint: a zoom interpolation has its outputs scaled, not wrapped', () => {
  const expr = ['interpolate', ['linear'], ['zoom'], 4, 0.2, 10, 1];
  assert.deepEqual(opacityPaint({ type: 'fill', paint: { 'fill-opacity': expr } }, 0.5), {
    'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.1, 10, 0.5],
  });
  const step = ['step', ['zoom'], 0, 8, 1];
  assert.deepEqual(opacityPaint({ type: 'line', paint: { 'line-opacity': step } }, 0.5), { 'line-opacity': ['step', ['zoom'], 0, 8, 0.5] });
});

test('opacityPaint: factor 1 restores exactly what the style had', () => {
  const expr = ['interpolate', ['linear'], ['zoom'], 4, 0.2, 10, 1];
  assert.deepEqual(opacityPaint({ type: 'fill', paint: { 'fill-opacity': expr } }, 1), { 'fill-opacity': expr });
  assert.deepEqual(opacityPaint({ type: 'symbol', paint: {} }, 1), { 'text-opacity': 1, 'icon-opacity': 1 });
});

test('opacityPaint: a layer type with no opacity property gives nothing to set', () => {
  assert.deepEqual(opacityPaint({ type: 'sky' }, 0.5), {});
});

test('defaultVectorStyle: polygons get fill + line, lines a line, points a circle', () => {
  const plan = defaultVectorStyle({
    slug: 'x',
    url: 'https://example.org/t.pmtiles',
    vectorLayers: [
      { id: 'parcels', geometry: 'Polygon' },
      { id: 'roads', geometry: 'LineString' },
      { id: 'sites', geometry: 'Point' },
    ],
  });
  assert.deepEqual(plan.sources, { 'cng-layer-x--data': { type: 'vector', url: 'pmtiles://https://example.org/t.pmtiles' } });
  assert.deepEqual(plan.layers.map((l) => [l.id, l.type, l['source-layer']]), [
    ['cng-layer-x--parcels-fill', 'fill', 'parcels'],
    ['cng-layer-x--parcels-line', 'line', 'parcels'],
    ['cng-layer-x--roads-line', 'line', 'roads'],
    ['cng-layer-x--sites-circle', 'circle', 'sites'],
  ]);
  assert.ok(plan.layers.every((l) => l.source === 'cng-layer-x--data'));
});

test('defaultVectorStyle: an unknown geometry gets all three, each filtered to its own geometry type', () => {
  const plan = defaultVectorStyle({ slug: 'x', url: 'https://example.org/t.pmtiles', vectorLayers: [{ id: 'mystery' }] });
  assert.deepEqual(plan.layers.map((l) => l.type), ['fill', 'line', 'circle']);
  assert.ok(plan.layers.every((l) => Array.isArray(l.filter)));
});

test('defaultGeojsonLayers: fill, line and circle over one source', () => {
  const layers = defaultGeojsonLayers({ slug: 'x', source: 'cng-layer-x--data' });
  assert.deepEqual(layers.map((l) => [l.id, l.type]), [['cng-layer-x--fill', 'fill'], ['cng-layer-x--line', 'line'], ['cng-layer-x--circle', 'circle']]);
  assert.ok(layers.every((l) => l.source === 'cng-layer-x--data' && !('source-layer' in l)));
});
