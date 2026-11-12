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
    // 50_000 sits deliberately *below*
    // `DEFAULT_POPULATION_PROMOTION_THRESHOLD` (2026-11-12
    // population-promotion follow-up): this test is about the prominence
    // tiebreak, and a six-figure population would decide the comparison a
    // step earlier at `effLevel`, leaving the step under test unexercised.
    row('Springfield', 'springfield', 'USA', 4, 'BIG-CITY', { population: 50_000, areaKm2: 10 }),
  ];
  const geocoder = makeGeocoder(rows, { limit: 10, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('springfield');
  assert.equal(results[0].featureId, 'BIG-CITY', 'population must win the prominence tiebreak over a bigger area_km2');
  assert.equal(results[0].rank.effLevel, results[1].rank.effLevel, 'neither row is population-promoted, so this really is the prominence step');
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

// --- Alt-demotion follow-up (design doc §3.2 amendment, "alt-demotion",
// 2026-11-12), end to end through search(): the live reproduction against
// the published Overture catalog -- searching "bag" returned alt-language
// spellings of Bahrain/Bahamas (ADM0, `alt_of` set) ranked above
// Bağcılar/Bagua (ADM2, primary) and above Baghdad, because the
// pre-amendment `isAlt` tiebreak (previous block, above) only applied
// once two rows already tied on raw `level` -- which an ADM0 alt row and
// an ADM1+ primary row never do. This block is the synthetic shape of
// that exact scenario, plus the "typing the full alt name must not be
// penalized" exemption (Deutschland/中国/Bahamas), run through the real
// `search()` -> `_rankAndFilter()` pipeline rather than `ranking.js` in
// isolation. ---------------------------------------------------------

test('search(): "bag" -- a level-0 alt match (translated country name) no longer unconditionally outranks a level-1 primary match', async () => {
  const rows = [
    row('Bagraain', 'bagraain', 'BHR', 0, 'ALT-NOISE', { alt_of: 'bahrain-primary-uuid' }), // real shape: Bahrain's alt name happens to prefix-match "bag"
    row('Bagdad Province', 'bagdad province', 'IRQ', 1, 'PRIMARY-ADM1'), // alt_of absent: primary
  ];
  const geocoder = makeGeocoder(rows, { limit: 10, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('bag');
  assert.equal(results[0].featureId, 'PRIMARY-ADM1', 'the ADM1 primary should now rank first, not the demoted ADM0 alt-name noise');
});

test('search(): "deutschland" -- an exact match against an alt-name row for a country is not penalized (stays promoted like any exact match)', async () => {
  const rows = [
    row('Deutschland', 'deutschland', 'DEU', 0, 'DEU-EXACT-ALT', { alt_of: 'germany-primary-uuid' }), // German endonym stored as an alt row
    row('Deutschlandsberg', 'deutschlandsberg', 'AUT', 4, 'AUT-PREFIX-PRIMARY'), // unrelated Austrian town, primary, prefix match
  ];
  const geocoder = makeGeocoder(rows, { limit: 10, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('deutschland');
  assert.equal(results[0].featureId, 'DEU-EXACT-ALT', 'the exact alt-name match for the country itself must win, same as an exact primary match would');
});

test('search(): altLevelDemotion is configurable via GeocoderOptions.ranking, like exactLevelPromotion', async () => {
  const rows = [
    row('Bagraain', 'bagraain', 'BHR', 0, 'ALT-NOISE', { alt_of: 'bahrain-primary-uuid' }),
    row('Bagdad Province', 'bagdad province', 'IRQ', 1, 'PRIMARY-ADM1'),
  ];
  const geocoder = makeGeocoder(rows, {
    limit: 10,
    diversity: { dedupe: false, maxPerGroup: null },
    ranking: { altLevelDemotion: 0 }, // opt out: restores the pre-amendment ordering
  });
  const results = await geocoder.search('bag');
  assert.equal(results[0].featureId, 'ALT-NOISE', 'with the demotion disabled, raw level alone decides again: ADM0 before ADM1');
});
