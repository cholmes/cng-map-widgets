import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imageryProfile } from '../src/imagery-profile.js';

// Three real imagery collections (fixtures/README.md), which disagree about
// nearly everything a search needs to know: where the item table is, how a
// scene's assets are encoded, which asset is the picture, how time is
// recorded, and whether there is a thumbnail. `imageryProfile` is where those
// differences are absorbed, so nothing downstream branches on a dataset.

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.collection.json`, import.meta.url), 'utf8'));

const URLS = {
  unosat: 'https://data.source.coop/portolan-mirrors/unosat/tropical-cyclones/2018/tc20180209ton/tc20180209ton-damage-sites/collection.json',
  naip: 'https://nthh.github.io/data-publications/naip/collection.json',
  oam: 'https://data.source.coop/geospatialjeff/oam-portolan/oam-cc-by-4-0/collection.json',
  s2: 'https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json',
};
const filter = (profile, column) => profile.filters.find((f) => f.column === column);

// --- NAIP: one `data` parquet, struct assets, no item_assets, no thumbnails ------

test('NAIP: the item table is its data parquet, read as a plain file', () => {
  const p = imageryProfile(fixture('naip'), { baseUrl: URLS.naip });
  assert.equal(p.id, 'naip');
  assert.equal(p.collectionUrl, URLS.naip);
  assert.equal(p.dataset.spec, 'cng-dataset/1.0');
  assert.deepEqual(p.dataset.source, { kind: 'parquet', url: 'https://data.source.coop/nthh/naip/stac/naip.parquet' });
  // No declared table: the file's own schema is the authority (extract-core infers it).
  assert.equal(p.dataset.table, undefined);
  assert.equal(p.dataset.attribution[0].text, 'USDA Farm Production and Conservation Business Center');
});

test('NAIP: time is `datetime`; the second table listed in table:columns is not mistaken for this one', () => {
  // NAIP's `table:columns` lists the quads table and then the overviews
  // table. Only the second has start_datetime/end_datetime.
  const p = imageryProfile(fixture('naip'), { baseUrl: URLS.naip });
  assert.deepEqual(p.table, { idColumn: 'id', geometryColumn: 'geometry', timeColumn: 'datetime' });
});

test('NAIP: the picture is the `image` asset, found in the struct type because there are no item_assets', () => {
  const p = imageryProfile(fixture('naip'), { baseUrl: URLS.naip });
  assert.equal(p.assets, 'struct');
  assert.equal(p.displayAsset, 'image');
  assert.equal(p.thumbnail, undefined);
});

test('NAIP: filters are gsd, state and year; a search reads the small struct assets', () => {
  const p = imageryProfile(fixture('naip'), { baseUrl: URLS.naip });
  assert.deepEqual(p.filters.map((f) => [f.column, f.kind, f.type]), [
    ['gsd', 'max', 'double'],
    ['naip:state', 'enum', 'string'],
    ['naip:year', 'range', 'int64'],
  ]);
  assert.equal(filter(p, 'naip:state').label, 'State');
  assert.deepEqual(p.searchColumns, ['id', 'datetime', 'bbox', 'geometry', 'gsd', 'naip:state', 'naip:year', 'assets']);
});

// --- OpenAerialMap: a collection-mirror file, no table:columns, start/end only ----

test('OpenAerialMap: the item table is its collection-mirror asset', () => {
  const p = imageryProfile(fixture('oam-cc-by-4-0'), { baseUrl: URLS.oam });
  assert.equal(p.dataset.source.kind, 'parquet');
  assert.ok(p.dataset.source.url.endsWith('/items.parquet'));
  assert.equal(p.attribution[0].license, 'CC-BY-4.0');
});

test('OpenAerialMap: with no table:columns, the STAC defaults are assumed, including the interval', () => {
  const p = imageryProfile(fixture('oam-cc-by-4-0'), { baseUrl: URLS.oam });
  assert.deepEqual(p.table, {
    idColumn: 'id',
    geometryColumn: 'geometry',
    timeColumn: 'datetime',
    timeInterval: { start: 'start_datetime', end: 'end_datetime' },
  });
  // Nothing says how `assets` is encoded; the file's schema will.
  assert.equal(p.assets, 'unknown');
  assert.equal(p.searchColumns.includes('assets'), false);
  assert.equal(p.columnsKnown, false);
});

test('OpenAerialMap: picture and thumbnail come from item_assets; filters from summaries', () => {
  const p = imageryProfile(fixture('oam-cc-by-4-0'), { baseUrl: URLS.oam });
  assert.equal(p.displayAsset, 'visual');
  assert.deepEqual(p.thumbnail, { asset: 'thumbnail' });
  assert.deepEqual(p.filters.map((f) => [f.column, f.kind, f.type]), [
    ['gsd', 'max', 'unknown'],
    ['oam:platform_type', 'enum', 'unknown'],
  ]);
  assert.deepEqual(filter(p, 'oam:platform_type').values, ['aircraft', 'balloon', 'kite', 'satellite', 'uav']);
  assert.equal(filter(p, 'oam:platform_type').label, 'Platform type');
});

// --- Sentinel-2: hive partitions, JSON assets, a thumbnail URL column -------------

test('Sentinel-2: the dataset is the collection itself, to be resolved into its partitions', () => {
  const p = imageryProfile(fixture('sentinel-2-c1-l2a'), { baseUrl: URLS.s2 });
  assert.deepEqual(p.dataset.source, { kind: 'portolan-collection', url: URLS.s2 });
  assert.equal(p.attribution[0].shareAlike, true);
  assert.deepEqual(p.table, { idColumn: 'id', geometryColumn: 'geometry', timeColumn: 'datetime' });
  assert.equal(p.columnsKnown, true);
});

test('Sentinel-2: assets are a JSON string and are NOT read by a search', () => {
  // E14: that column is 85% of the file, about 6.5 MB per row group.
  const p = imageryProfile(fixture('sentinel-2-c1-l2a'), { baseUrl: URLS.s2 });
  assert.equal(p.assets, 'json');
  assert.equal(p.searchColumns.includes('assets'), false);
  assert.equal(p.displayAsset, 'visual');
  assert.deepEqual(p.thumbnail, { column: 'thumbnail_url' });
  assert.ok(p.searchColumns.includes('thumbnail_url'));
});

test('Sentinel-2: cloud cover first, then platform and constellation -- not storage:platform', () => {
  const p = imageryProfile(fixture('sentinel-2-c1-l2a'), { baseUrl: URLS.s2 });
  assert.deepEqual(p.filters.map((f) => [f.column, f.kind, f.type]), [
    ['eo:cloud_cover', 'max', 'double'],
    ['platform', 'enum', 'string'],
    ['constellation', 'enum', 'string'],
  ]);
  assert.equal(filter(p, 'eo:cloud_cover').label, 'Cloud cover (%)');
});

// --- not imagery, overrides, bad input ---------------------------------------------

test('a collection with no scenes to search throws LAYER_UNSUPPORTED', () => {
  const collection = fixture('unosat-damage-sites');
  assert.throws(
    () => imageryProfile(collection, { baseUrl: URLS.unosat }),
    (e) => e.code === 'LAYER_UNSUPPORTED' && e.context.collection === collection.id && e.context.kinds.includes('pmtiles-vector'),
  );
});

test('overrides replace what was derived, and searchColumns follows them', () => {
  const assetHref = (scene) => `https://example.org/${scene.id}/TCI.tif`;
  const p = imageryProfile(fixture('sentinel-2-c1-l2a'), {
    baseUrl: URLS.s2,
    overrides: {
      displayAsset: 'red',
      filters: [{ column: 's2:snow_ice_percentage', label: 'Snow', kind: 'max', type: 'double' }],
      thumbnail: { column: 'preview_url' },
      assetHref,
    },
  });
  assert.equal(p.displayAsset, 'red');
  assert.equal(p.assetHref, assetHref);
  assert.deepEqual(p.filters.map((f) => f.column), ['s2:snow_ice_percentage']);
  assert.deepEqual(p.searchColumns, ['id', 'datetime', 'bbox', 'geometry', 's2:snow_ice_percentage', 'preview_url']);
});

test('at most six filters are offered', () => {
  const collection = fixture('sentinel-2-c1-l2a');
  collection['table:columns'] = [
    ...collection['table:columns'],
    ...['a:state', 'b:state', 'c:state', 'd:state', 'e:platform_type', 'f:year'].map((name) => ({ name, type: 'string' })),
  ];
  const p = imageryProfile(collection, { baseUrl: URLS.s2 });
  assert.equal(p.filters.length, 6);
  assert.equal(p.filters[0].column, 'eo:cloud_cover');
});

test('malformed table:columns members and summaries are ignored, not fatal', () => {
  const collection = fixture('sentinel-2-c1-l2a');
  collection['table:columns'] = [null, 'x', { type: 'string' }, ...collection['table:columns']];
  collection.summaries = 'nope';
  const p = imageryProfile(collection, { baseUrl: URLS.s2 });
  assert.equal(p.table.timeColumn, 'datetime');
  assert.equal(p.assets, 'json');
});
