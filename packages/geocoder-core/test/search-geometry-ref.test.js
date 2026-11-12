import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder } from '../src/index.js';

// Closes the loop from a decoded index row to a usable select() input:
// geometry-resolver.js's fast path reads `result.geometryRef`, and this is
// where that field is actually produced -- Geocoder#_rankAndFilter projects
// a raw `row.geometry_ref` ({file, row_group, row}, the parquet column
// shape) onto a search result's `geometryRef` ({file, rowGroup, row}, the
// camelCase shape resolveGeometry/geometryRefRowRange consume). Uses the
// same `__deps` injection seam as select.test.js, for the same reason
// (hyparquet's pinned CDN import is unsupported under `node --test`).

function makeManifest() {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 1,
    levels: [2],
    index: { url: './index.parquet', size: 100 },
    boundaries: [{ level: 2, feature_id_column: 'feature_id', geometry_column: 'geometry', row_group_rows: 512, full: { url: './adm2-full.parquet' } }],
    attribution: [],
  };
}

const ROW = {
  name: 'Kisumu Central', name_norm: 'kisumu central', level: 2, country: 'KEN',
  feature_id: '67384312B19876', source: 'test-source',
  bbox: { xmin: 34, ymin: -0.2, xmax: 34.9, ymax: 0.1 },
  geometry_ref: { file: 'cgaz_adm2.parquet', row_group: 71, row: 36579 },
};

test('search(): a row carrying geometry_ref produces a result with a camelCase geometryRef, ready for select()', async () => {
  const deps = {
    loadManifest: async () => makeManifest(),
    loadFullIndex: async () => ({ rows: [ROW], nameNorms: [ROW.name_norm] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });

  const results = await geocoder.search('kisumu');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].geometryRef, { file: 'cgaz_adm2.parquet', rowGroup: 71, row: 36579 });
  assert.equal(results[0].featureId, '67384312B19876');
});

test('search(): a row with no geometry_ref column at all produces a result with geometryRef undefined, not a crash', async () => {
  const rowWithoutRef = { ...ROW };
  delete rowWithoutRef.geometry_ref;
  const deps = {
    loadManifest: async () => makeManifest(),
    loadFullIndex: async () => ({ rows: [rowWithoutRef], nameNorms: [rowWithoutRef.name_norm] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });

  const results = await geocoder.search('kisumu');
  assert.equal(results.length, 1);
  assert.equal(results[0].geometryRef, undefined);
});
