// `descriptorFromCollection` / `collectionDownloadSupport` -- the §2.4
// derivation run against a collection JSON a host already holds in memory
// (added for E7's portolan-browser widget `condition`).
//
// The fixtures below are trimmed verbatim from real Portolan catalogs:
// `geoboundaries-catalog/catalog/adm0/collection.json` (single parquet,
// relative hrefs, bbox struct, pmtiles sibling) and the shape a raster
// collection has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptorFromCollection, collectionDownloadSupport } from '../src/dataset-resolve.js';

const BASE = 'https://data.example.org/geoboundaries/adm0/collection.json';

/** geoBoundaries CGAZ ADM0, trimmed. Note the `data`-role pmtiles sibling. */
function adm0Collection() {
  return {
    type: 'Collection',
    stac_version: '1.1.0',
    id: 'adm0',
    title: 'CGAZ ADM0 - Country Boundaries',
    license: 'CC-BY-4.0',
    providers: [
      { name: 'geoBoundaries', roles: ['producer', 'licensor'], url: 'https://www.geoboundaries.org/' },
    ],
    'table:primary_geometry': 'geometry',
    'table:row_count': 218,
    'table:columns': [
      { name: 'shapeName', type: 'string' },
      { name: 'shapeGroup', type: 'string' },
      { name: 'area_km2', type: 'double' },
      { name: 'bbox', type: 'struct' },
      { name: 'geometry', type: 'geometry' },
    ],
    assets: {
      data: { href: './cgaz_adm0.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] },
      pmtiles: { href: './adm0.pmtiles', type: 'application/vnd.pmtiles', roles: ['visual', 'data'] },
      display: { href: './cgaz_adm0_display.parquet', type: 'application/vnd.apache.parquet', roles: ['data', 'overview'] },
      thumbnail: { href: './adm0.thumb.png', type: 'image/png', roles: ['thumbnail'] },
    },
  };
}

test('descriptorFromCollection: single-parquet collection -> concrete parquet source', () => {
  const d = descriptorFromCollection(adm0Collection(), { baseUrl: BASE });
  assert.equal(d.spec, 'cng-dataset/1.0');
  assert.equal(d.id, 'adm0');
  assert.equal(d.title, 'CGAZ ADM0 - Country Boundaries');
  assert.equal(d.source.kind, 'parquet');
  // Relative href resolved against the collection URL: a descriptor has to
  // be self-contained, because it gets embedded in a DownloadRequest.
  assert.equal(d.source.url, 'https://data.example.org/geoboundaries/adm0/cgaz_adm0.parquet');
  assert.equal(d.table.geometryColumn, 'geometry');
  assert.equal(d.table.rowCount, 218);
  assert.deepEqual(d.table.bbox, { kind: 'struct', column: 'bbox' });
  assert.equal(d.table.crs, 'OGC:CRS84');
  assert.deepEqual(d.attribution, [
    { text: 'geoBoundaries', license: 'CC-BY-4.0', url: 'https://www.geoboundaries.org/', shareAlike: false },
  ]);
});

test('descriptorFromCollection: the full-resolution `data` asset wins over the `overview` one', () => {
  const d = descriptorFromCollection(adm0Collection(), { baseUrl: BASE });
  assert.match(d.source.url, /cgaz_adm0\.parquet$/);
  assert.doesNotMatch(d.source.url, /_display/);
});

test('descriptorFromCollection: an absolute href is left alone', () => {
  const c = adm0Collection();
  c.assets.data.href = 'https://other.example/x.parquet';
  assert.equal(descriptorFromCollection(c, { baseUrl: BASE }).source.url, 'https://other.example/x.parquet');
});

test('descriptorFromCollection: hive partitioning -> hive source', () => {
  const c = {
    id: 'detections',
    'partition:scheme': 'hive',
    'partition:glob': './year=*/*.parquet',
    'partition:keys': [{ name: 'year', type: 'int32', values: [2023, 2024] }],
    'partition:file_count': 2,
    'table:columns': [{ name: 'geometry', type: 'geometry' }, { name: 'datetime', type: 'timestamp' }],
    assets: {},
  };
  const d = descriptorFromCollection(c, { baseUrl: BASE });
  assert.equal(d.source.kind, 'hive');
  assert.equal(d.source.glob, './year=*/*.parquet');
  assert.equal(d.source.enumeration.kind, 'stac-items');
  assert.equal(d.table.timeColumn, 'datetime');
});

test('collectionDownloadSupport: raster/zarr collections are unsupported, not wrongly parquet', () => {
  // A Portolan raster collection carries role `data` on its COG asset. The
  // refusal has to name what it found (design call #8).
  const cog = {
    id: 'dem',
    assets: {
      data: { href: './dem.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] },
    },
  };
  const support = collectionDownloadSupport(cog, { baseUrl: BASE });
  assert.equal(support.supported, false);
  assert.equal(support.code, 'DATASET_UNSUPPORTED');
  assert.match(support.message, /raster\/zarr/i);
  assert.match(support.message, /geotiff/i);
});

test('collectionDownloadSupport: a pmtiles-only vector collection is unsupported', () => {
  const pmtiles = {
    id: 'basemap',
    assets: { tiles: { href: './x.pmtiles', type: 'application/vnd.pmtiles', roles: ['data', 'visual'] } },
  };
  assert.equal(collectionDownloadSupport(pmtiles, { baseUrl: BASE }).supported, false);
});

test('collectionDownloadSupport: a zarr collection is unsupported', () => {
  const zarr = {
    id: 'cube',
    assets: { data: { href: './cube.zarr', type: 'application/vnd+zarr', roles: ['data'] } },
  };
  assert.equal(collectionDownloadSupport(zarr, { baseUrl: BASE }).supported, false);
});

test('collectionDownloadSupport: supported collections come back with the descriptor', () => {
  const support = collectionDownloadSupport(adm0Collection(), { baseUrl: BASE });
  assert.equal(support.supported, true);
  assert.equal(support.descriptor.source.kind, 'parquet');
});

test('collectionDownloadSupport: junk input refuses instead of throwing', () => {
  for (const junk of [null, undefined, 42, 'collection']) {
    assert.equal(collectionDownloadSupport(junk).supported, false);
  }
  assert.equal(collectionDownloadSupport({ id: 'empty' }).supported, false);
});
