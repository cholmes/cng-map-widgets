import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLayerSpec } from '@cngeo/spec';
import { layersFromCollection } from '../src/layers-from-collection.js';

// Six of these collections are REAL documents, saved verbatim on
// 2026-11-25 (see fixtures/README.md). Each one stands for a way a
// published collection says "this is how to show me".

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.collection.json`, import.meta.url), 'utf8'));

const URLS = {
  unosat: 'https://data.source.coop/portolan-mirrors/unosat/tropical-cyclones/2018/tc20180209ton/tc20180209ton-damage-sites/collection.json',
  worldpop: 'https://storage.googleapis.com/carto-open-catalogs/worldpop-jamaica/main/children-5-9/collection.json',
  naip: 'https://nthh.github.io/data-publications/naip/collection.json',
  oam: 'https://data.source.coop/geospatialjeff/oam-portolan/oam-cc-by-4-0/collection.json',
  s2: 'https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json',
  gmw: 'https://data.source.coop/portolan-mirrors/global-mangrove-watch/country-statistics/country-change/collection.json',
};

/** Every spec this function returns must already be a valid, normalised LayerSpec. */
function layers(collection, baseUrl) {
  const out = layersFromCollection(collection, { baseUrl });
  for (const spec of out) assert.deepEqual(validateLayerSpec(spec), spec);
  return out;
}

test('styled PMTiles (UNOSAT): one pmtiles-vector layer with its default style', () => {
  const out = layers(fixture('unosat-damage-sites'), URLS.unosat);
  assert.equal(out.length, 1);
  const [spec] = out;
  assert.equal(spec.kind, 'pmtiles-vector');
  assert.equal(spec.id, 'tropical-cyclones/2018/tc20180209ton/tc20180209ton-damage-sites');
  assert.equal(spec.title, 'Damage sites: Tropical cyclone, Tonga, 9 February 2018 (TC20180209TON)');
  assert.equal(
    spec.source.url,
    'https://data.source.coop/portolan-mirrors/unosat/tropical-cyclones/2018/tc20180209ton/tc20180209ton-damage-sites/tc20180209ton-damage-sites.pmtiles',
  );
  assert.deepEqual(spec.source.layers, ['damage-sites']);
  assert.equal(
    spec.source.style.url,
    'https://data.source.coop/portolan-mirrors/unosat/tropical-cyclones/2018/tc20180209ton/tc20180209ton-damage-sites/styles/default.json',
  );
  assert.ok(Math.abs(spec.bbox[0] - -175.186) < 0.001);
  assert.deepEqual(spec.temporal, ['2018-03-15T00:00:00Z', '2018-03-15T23:59:59Z']);
  assert.equal(spec.attribution[0].license, 'CC-BY-4.0');
  assert.equal(spec.attribution[0].shareAlike, false);
  assert.equal(spec.attribution[0].share_alike, false);
  assert.match(spec.thumbnail, /tc20180209ton-damage-sites\.thumb\.jpg$/);
});

test('a single COG (WorldPop): one cog layer; the non-COG source TIFF is ignored', () => {
  const out = layers(fixture('worldpop-jamaica-children-5-9'), URLS.worldpop);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'cog');
  assert.equal(out[0].id, 'children-5-9');
  assert.equal(out[0].source.url, 'https://storage.googleapis.com/carto-open-catalogs/worldpop-jamaica/main/children-5-9/children-5-9.tif');
});

test('NAIP: the scenes table, then its national overview COG', () => {
  const out = layers(fixture('naip'), URLS.naip);
  assert.deepEqual(out.map((s) => s.kind), ['scenes', 'cog']);
  assert.equal(out[0].id, 'naip');
  // Two STAC parquet assets exist; `quads` is the item table (table:columns names it).
  assert.deepEqual(out[0].source.items, { kind: 'parquet', url: 'https://data.source.coop/nthh/naip/stac/naip.parquet' });
  assert.equal(out[0].source.collectionUrl, URLS.naip);
  assert.equal(out[1].id, 'naip:overview_national');
  assert.equal(out[1].source.url, 'https://data.source.coop/nthh/naip/overviews/national-latest.tif');
});

test('OpenAerialMap: scenes from the collection-mirror asset, drawn from `visual`', () => {
  const out = layers(fixture('oam-cc-by-4-0'), URLS.oam);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'scenes');
  assert.deepEqual(out[0].source.items, { kind: 'parquet', url: 'https://data.source.coop/geospatialjeff/oam-portolan/oam-cc-by-4-0/items.parquet' });
  // Its `visual` asset has role `data` only -- found by key, not by role.
  assert.equal(out[0].source.displayAsset, 'visual');
});

test('Sentinel-2: scenes from hive partitions, no items asset, share-alike', () => {
  const out = layers(fixture('sentinel-2-c1-l2a'), URLS.s2);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'scenes');
  assert.deepEqual(out[0].source.items, { kind: 'partitioned' });
  assert.equal(out[0].source.displayAsset, 'visual');
  assert.equal(out[0].attribution[0].shareAlike, true);
  assert.equal(out[0].attribution[0].share_alike, true);
});

test('a table with no geometry (Global Mangrove Watch statistics): described, not drawable', () => {
  const out = layers(fixture('gmw-country-change'), URLS.gmw);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'table');
  assert.match(out[0].source.url, /gmw-v4112-country-change\.parquet$/);
});

test('nothing drawable (Zarr only): one unsupported layer that says what it found', () => {
  const out = layers(
    { type: 'Collection', id: 'cube', assets: { data: { href: './cube.zarr', type: 'application/vnd+zarr', roles: ['data'] } } },
    'https://example.org/cube/collection.json',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'unsupported');
  assert.deepEqual(out[0].source.assetTypes, ['application/vnd+zarr']);
  assert.match(out[0].source.reason, /zarr/i);
});

test('spatial GeoParquet with no tiles: unsupported, and the reason says so', () => {
  const out = layers(
    {
      type: 'Collection',
      id: 'big',
      'table:columns': [{ name: 'geometry', type: 'binary' }, { name: 'name', type: 'string' }],
      assets: { data: { href: './big.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] } },
    },
    'https://example.org/big/collection.json',
  );
  assert.equal(out[0].kind, 'unsupported');
  assert.match(out[0].source.reason, /tiles/i);
});

test('with two styles, the one carrying the `default` role wins', () => {
  const out = layers(
    {
      type: 'Collection',
      id: 'two-styles',
      'pmtiles:layers': ['a'],
      links: [{ rel: 'pmtiles', href: './t.pmtiles', type: 'application/vnd.pmtiles', 'pmtiles:layers': ['a'] }],
      assets: {
        first: { href: './styles/first.json', type: 'application/vnd.mapbox.style+json', roles: ['style'] },
        second: { href: './styles/second.json', type: 'application/vnd.mapbox.style+json', roles: ['style', 'default'] },
      },
    },
    'https://example.org/x/collection.json',
  );
  assert.equal(out[0].source.style.url, 'https://example.org/x/styles/second.json');
});

test('two styles and no default: no style is chosen for you', () => {
  const out = layers(
    {
      type: 'Collection',
      id: 'two-styles',
      links: [{ rel: 'pmtiles', href: './t.pmtiles', type: 'application/vnd.pmtiles', 'pmtiles:layers': ['a'] }],
      assets: {
        first: { href: './styles/first.json', roles: ['style'] },
        second: { href: './styles/second.json', roles: ['style'] },
      },
    },
    'https://example.org/x/collection.json',
  );
  assert.equal(out[0].source.style, undefined);
});

test('a PMTiles asset with no rel:pmtiles link still gives a pmtiles-vector layer', () => {
  const out = layers(
    {
      type: 'Collection',
      id: 'asset-only',
      'pmtiles:layers': ['parcels', 'labels'],
      assets: { tiles: { href: './tiles.pmtiles', type: 'application/vnd.pmtiles', roles: ['visual'] } },
    },
    'https://example.org/p/collection.json',
  );
  assert.equal(out[0].kind, 'pmtiles-vector');
  assert.equal(out[0].source.url, 'https://example.org/p/tiles.pmtiles');
  assert.deepEqual(out[0].source.layers, ['parcels', 'labels']);
});

test('a missing extent leaves bbox and temporal off instead of inventing them', () => {
  const out = layers(fixture('worldpop-jamaica-children-5-9'), URLS.worldpop);
  const noExtent = layers({ ...fixture('worldpop-jamaica-children-5-9'), extent: undefined }, URLS.worldpop);
  assert.ok(Array.isArray(out[0].bbox));
  assert.equal(noExtent[0].bbox, undefined);
  assert.equal(noExtent[0].temporal, undefined);
});

// A catalog search runs this over thousands of collections. It must not be
// possible for one odd document to throw.
test('assets that are only reachable as s3:// give an unsupported layer that says so', () => {
  for (const assets of [
    { tiles: { href: 's3://bucket/t.pmtiles', type: 'application/vnd.pmtiles', roles: ['visual'] } },
    { cog: { href: 's3://bucket/a.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] } },
    { items: { href: 's3://bucket/items.parquet', type: 'application/vnd.apache.parquet', roles: ['collection-mirror'] } },
    { data: { href: 's3://bucket/d.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] } },
  ]) {
    const out = layers({ type: 'Collection', id: 'remote', assets }, 'https://example.org/c/collection.json');
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'unsupported');
    assert.match(out[0].source.reason, /http/i);
    assert.match(out[0].source.reason, /s3:\/\/bucket/);
  }
});

test('a missing or relative baseUrl is refused up front, naming the field', () => {
  assert.throws(() => layersFromCollection(fixture('naip')), (e) => e.code === 'LAYER_INVALID' && e.context.field === 'baseUrl');
  assert.throws(() => layersFromCollection(fixture('naip'), { baseUrl: './collection.json' }), (e) => e.code === 'LAYER_INVALID' && e.context.field === 'baseUrl');
});

test('malformed members are tolerated: the collection is still described', () => {
  const base = 'https://example.org/c/collection.json';
  const cog = { cog: { href: './a.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] } };
  for (const odd of [
    { links: { rel: 'pmtiles' } },
    { 'pmtiles:layers': 'roads', links: [{ rel: 'pmtiles', href: './t.pmtiles' }] },
    { 'table:columns': [null, { name: 'x' }] },
    { item_assets: { visual: null } },
    { providers: 'Someone' },
    { extent: { spatial: { bbox: 'everywhere' }, temporal: { interval: [[1, 2]] } } },
    { assets: { ...cog, broken: null, roleString: { href: './m.json', roles: 'metadata' } } },
  ]) {
    const out = layers({ type: 'Collection', id: 'odd', assets: cog, ...odd }, base);
    assert.ok(out.length >= 1, JSON.stringify(odd));
  }
});

test('a role given as a string is not matched by substring', () => {
  // 'metadata' contains 'data'; it must not be read as the data asset.
  const out = layers(
    { type: 'Collection', id: 'roles', assets: { notes: { href: './notes.parquet', type: 'application/vnd.apache.parquet', roles: 'metadata' } } },
    'https://example.org/c/collection.json',
  );
  assert.equal(out[0].kind, 'unsupported');
});

test('an attribution url or thumbnail that is not http(s) is dropped, not passed on', () => {
  const out = layers(
    {
      type: 'Collection',
      id: 'hostile',
      license: 'CC-BY-4.0',
      providers: [{ name: 'X', roles: ['licensor'], url: 'javascript:alert(1)' }],
      assets: {
        cog: { href: './a.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] },
        thumbnail: { href: 'javascript:alert(2)', roles: ['thumbnail'] },
      },
    },
    'https://example.org/c/collection.json',
  );
  assert.equal(out[0].kind, 'cog');
  assert.equal(out[0].thumbnail, undefined);
  assert.equal(out[0].attribution[0].url, undefined);
  assert.equal(out[0].attribution[0].text, 'X');
});

test('something that is not a collection is refused', () => {
  assert.throws(() => layersFromCollection(null, { baseUrl: 'https://example.org/c.json' }), (e) => e.code === 'LAYER_INVALID');
  assert.throws(() => layersFromCollection({ type: 'Collection' }, { baseUrl: 'https://example.org/c.json' }), (e) => e.code === 'LAYER_INVALID');
});
