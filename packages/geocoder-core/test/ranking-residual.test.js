import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder } from '../src/index.js';

// End-to-end regression for the ranking-residual follow-up (design doc
// §3.2 amendment, "Ranking-residual follow-up: class/population/alt_of"):
// exercises `Geocoder#search()` -> `_rankAndFilter()` with raw index rows
// that carry `class`/`population`/`alt_of` -- the shape confirmed live
// against the refreshed Overture staging manifest (both Overture index
// files now carry `class` and `population`, per the catalog-side report)
// -- to prove the columns survive decode -> SearchResult and actually
// drive the comparator, not just ranking.js's own unit tests in isolation.

function makeManifest() {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 10,
    levels: [4],
    index: { url: './index.parquet', size: 100 },
    boundaries: [],
    attribution: [],
  };
}

const BBOX = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };

function row(name, nameNorm, country, level, featureId, extra = {}) {
  return { name, name_norm: nameNorm, level, country, feature_id: featureId, source: 'test-source', bbox: BBOX, ...extra };
}

function makeGeocoder(rows, options = {}) {
  const deps = {
    loadManifest: async () => makeManifest(),
    loadFullIndex: async () => ({ rows, nameNorms: rows.map((r) => r.name_norm) }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  return new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps, ...options });
}

test('search(): class/population survive decode onto SearchResult, undefined when the row has neither', async () => {
  const rows = [
    row('Springfield', 'springfield', 'USA', 4, 'A', { class: 'city', population: 150000 }),
    row('Springfield', 'springfield', 'USA', 4, 'B'), // no class/population at all
  ];
  const geocoder = makeGeocoder(rows, { limit: 10, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('springfield');
  const a = results.find((r) => r.featureId === 'A');
  const b = results.find((r) => r.featureId === 'B');
  assert.equal(a.class, 'city');
  assert.equal(a.population, 150000);
  assert.equal(b.class, undefined);
  assert.equal(b.population, undefined);
});

test('search(): a row with a real population outranks a same-level row with none, end to end through search()', async () => {
  const rows = [
    row('Springfield', 'springfield', 'USA', 4, 'SMALL-TOWN', { class: 'city', areaKm2: 900 }),
    row('Springfield', 'springfield', 'USA', 4, 'BIG-CITY', { population: 500_000, areaKm2: 10 }),
  ];
  const geocoder = makeGeocoder(rows, { limit: 10, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('springfield');
  assert.equal(results[0].featureId, 'BIG-CITY', 'population must win the prominence tiebreak over a bigger area_km2');
});

test('search(): at equal level, a primary-name match ranks above an alt-name match (alt_of set) for the same query', async () => {
  const rows = [
    row('Paris', 'paris', 'FRA', 2, 'ALT-ROW', { alt_of: 'PRIMARY-ROW' }), // an alt-name row that happens to also be named "paris"
    row('Paris', 'paris', 'FRA', 2, 'PRIMARY-ROW'), // alt_of null/absent: the primary
  ];
  const geocoder = makeGeocoder(rows, { limit: 10, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('paris');
  assert.equal(results[0].featureId, 'PRIMARY-ROW', 'the primary-name row must sort first over the alt-name row');
});

test('search(): with no class/population/alt_of on any row (every index shipped before this catalog refresh), results are unchanged -- areaKm2 still decides', async () => {
  const rows = [
    row('Bag', 'bag', 'IND', 4, 'SMALL', { areaKm2: 1.2 }),
    row('Bag', 'bag', 'HUN', 4, 'BIG', { areaKm2: 23.57 }),
  ];
  const geocoder = makeGeocoder(rows, { limit: 10, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('bag');
  assert.deepEqual(results.map((r) => r.featureId), ['BIG', 'SMALL']);
});

test('search(): class ladder (city > town > village > hamlet) decides when population is absent on every candidate', async () => {
  const rows = [
    row('Springfield', 'springfield', 'USA', 4, 'HAMLET', { class: 'hamlet' }),
    row('Springfield', 'springfield', 'USA', 4, 'CITY', { class: 'city' }),
    row('Springfield', 'springfield', 'USA', 4, 'VILLAGE', { class: 'village' }),
  ];
  const geocoder = makeGeocoder(rows, { limit: 10, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('springfield');
  assert.deepEqual(results.map((r) => r.featureId), ['CITY', 'VILLAGE', 'HAMLET']);
});
