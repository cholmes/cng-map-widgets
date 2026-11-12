// A `SearchResult` must survive `JSON.stringify()` (design doc §3.2: a
// search result is a plain data value a caller is expected to persist,
// post or log).
//
// It did not. hyparquet decodes parquet `INT64` as `BigInt`, and
// `geometry_ref.row` is `INT64` on every index that carries the column
// (confirmed against both the live geoBoundaries catalog and the Who's On
// First index), so `JSON.stringify(result)` **threw** `TypeError: Do not
// know how to serialize a BigInt`. It was a documented known issue in the
// root README; this file is the regression test for the fix.
//
// The same `INT64`-decodes-as-`BigInt` trap also silently *dropped* the
// `population` column on any index that types it as `INT64` -- the WOF
// index does -- because the old guard was `typeof row.population ===
// 'number'`. That half is tested here too: it is the same boundary, the
// same coercion, and the bug that made `compareRanked`'s prominence
// tiebreak a no-op on the one shipped index that populates the column.
//
// Uses the same `__deps` injection seam as select.test.js /
// search-geometry-ref.test.js, for the same reason (hyparquet's pinned CDN
// import is unsupported under `node --test`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder } from '../src/index.js';

function makeManifest() {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 1,
    levels: [4],
    index: { url: './index.parquet', size: 100 },
    boundaries: [{ level: 4, feature_id_column: 'feature_id', geometry_column: 'geometry', row_group_rows: 512, full: { url: './locality.parquet' } }],
    attribution: [],
  };
}

const BASE_ROW = {
  name: 'Brooklyn',
  name_norm: 'brooklyn',
  level: 4,
  country: 'USA',
  feature_id: '421205765',
  source: 'test-source',
  bbox: { xmin: -74.05, ymin: 40.57, xmax: -73.83, ymax: 40.74 },
};

function geocoderFor(row) {
  return new Geocoder({
    indexUrl: 'https://example.test/fake/index.json',
    __deps: {
      loadManifest: async () => makeManifest(),
      loadFullIndex: async () => ({ rows: [row], nameNorms: [row.name_norm] }),
      openRangeIndex: async () => ({ groups: [], rows: 0 }),
    },
  });
}

test('JSON.stringify(searchResult) works when geometry_ref.row decodes as a BigInt', async () => {
  const row = { ...BASE_ROW, geometry_ref: { file: 'wof_locality.parquet', row_group: 12, row: 36579n } };
  const [result] = await geocoderFor(row).search('brooklyn');

  // The BigInt is converted at the boundary, so the field is a plain number...
  assert.deepEqual(result.geometryRef, { file: 'wof_locality.parquet', rowGroup: 12, row: 36579 });
  assert.equal(typeof result.geometryRef.row, 'number');

  // ...and the whole result round-trips through JSON, which is the point.
  const roundTripped = JSON.parse(JSON.stringify(result));
  assert.equal(roundTripped.geometryRef.row, 36579);
  assert.equal(roundTripped.featureId, '421205765');
});

test('a row_group that also decodes as a BigInt is converted too', async () => {
  const row = { ...BASE_ROW, geometry_ref: { file: 'f.parquet', row_group: 7n, row: 9n } };
  const [result] = await geocoderFor(row).search('brooklyn');
  assert.deepEqual(result.geometryRef, { file: 'f.parquet', rowGroup: 7, row: 9 });
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('a BigInt too large to be a safe integer keeps its precision but still serializes', async () => {
  // Pathological, but the alternative -- silently rounding -- would point
  // select() at the wrong row. Precision is kept; `toJSON` keeps
  // JSON.stringify working by emitting the decimal string.
  const huge = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a Number
  const row = { ...BASE_ROW, geometry_ref: { file: 'f.parquet', row_group: 1, row: huge } };
  const [result] = await geocoderFor(row).search('brooklyn');

  assert.equal(result.geometryRef.row, huge, 'precision preserved rather than rounded');
  const roundTripped = JSON.parse(JSON.stringify(result));
  assert.equal(roundTripped.geometryRef.row, '9007199254740993');

  // `toJSON` must not show up as a field: Object.keys/spread/deepEqual
  // still see exactly the three documented ones.
  assert.deepEqual(Object.keys(result.geometryRef), ['file', 'rowGroup', 'row']);
});

test('a whole result array, with no geometry_ref at all, serializes', async () => {
  const [result] = await geocoderFor({ ...BASE_ROW }).search('brooklyn');
  assert.equal(result.geometryRef, undefined);
  assert.doesNotThrow(() => JSON.stringify([result]));
});

test('population typed as parquet INT64 (a BigInt) reaches the result as a number', async () => {
  const row = { ...BASE_ROW, population: 2_504_700n };
  const [result] = await geocoderFor(row).search('brooklyn');
  assert.equal(result.population, 2_504_700);
  assert.equal(typeof result.population, 'number');
  assert.equal(result.rank.population, 2_504_700, 'and reaches the ranking record, where it decides order');
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('a population of 0 is a real value and survives as 0, not undefined', async () => {
  // Measured on the live WOF index: `population` is null on most rows and
  // literally `0` on some (e.g. Springfield, Division No. 12, CAN). A
  // falsy-check boundary would turn a known-zero into "unknown", which
  // ranks it differently -- `prominenceKey` puts any row with a real
  // population in a strictly better tier than one without.
  for (const zero of [0, 0n]) {
    const [result] = await geocoderFor({ ...BASE_ROW, population: zero }).search('brooklyn');
    assert.equal(result.population, 0, `population ${typeof zero} 0 must survive`);
    assert.equal(result.rank.population, 0);
  }
});

test('a null/absent population stays undefined', async () => {
  for (const absent of [null, undefined]) {
    const [result] = await geocoderFor({ ...BASE_ROW, population: absent }).search('brooklyn');
    assert.equal(result.population, undefined);
  }
});
