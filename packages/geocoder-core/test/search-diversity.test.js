import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder } from '../src/index.js';

// End-to-end regression test for the reported bug (design doc §3.2
// amendment, "user feedback on the Overture-scale index"): searching "bag"
// against a names index returned eight identical-looking "Bag"/IND/ADM4
// rows with Baghdad buried below them. Exercises `Geocoder#search()` ->
// `_rankAndFilter()` end to end (ranking + result diversity + optional
// column passthrough), using the same `__deps` injection seam as
// select.test.js/search-geometry-ref.test.js, since `load()` can only run
// for real against a browser-capable dynamic import of hyparquet's pinned
// CDN URL (design doc §4.2), which `node --test` cannot do.

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

// Eight "Bag" villages in India (exact match, no area_km2 -- true to the
// real data: most ADM4 localities don't have it), one in Hungary (exact,
// WITH area_km2 and a parent_name), and Baghdad (prefix match on "bag",
// with area_km2 and a parent_name).
function bagRows() {
  const indiaVillages = Array.from({ length: 8 }, (_, i) =>
    row('Bag', 'bag', 'IND', 4, `IND${i}`, { parent_name: `District ${i}` }));
  const hungary = row('Bag', 'bag', 'HUN', 4, 'HUN0', { parent_name: 'Aszódi járás', area_km2: 23.57 });
  const baghdad = row('Baghdad', 'baghdad', 'IRQ', 4, 'IRQ0', { parent_name: 'Baghdad Governorate', area_km2: 861.7 });
  return [...indiaVillages, hungary, baghdad].sort((a, b) => (a.name_norm < b.name_norm ? -1 : a.name_norm > b.name_norm ? 1 : 0));
}

function makeGeocoder(rows, options = {}) {
  const deps = {
    loadManifest: async () => makeManifest(),
    loadFullIndex: async () => ({ rows, nameNorms: rows.map((r) => r.name_norm) }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  return new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps, ...options });
}

test('search("bag"): the eight India villages collapse to one row with moreCount, and Baghdad appears in the results', async () => {
  const geocoder = makeGeocoder(bagRows(), { limit: 10 });
  const results = await geocoder.search('bag');

  const indiaResults = results.filter((r) => r.country === 'IND');
  assert.equal(indiaResults.length, 1, 'all eight India "Bag" villages should collapse to a single row');
  assert.equal(indiaResults[0].moreCount, 7, 'the other seven are reported via moreCount');

  const baghdad = results.find((r) => r.featureId === 'IRQ0');
  assert.ok(baghdad, 'Baghdad should be present in the result list, not crowded out by duplicate villages');
  assert.equal(baghdad.name, 'Baghdad');
});

test('search("bag"): parent_name and area_km2 flow through onto SearchResult when the index carries them', async () => {
  const geocoder = makeGeocoder(bagRows(), { limit: 10 });
  const results = await geocoder.search('bag');

  const hungary = results.find((r) => r.featureId === 'HUN0');
  assert.ok(hungary);
  assert.equal(hungary.parentName, 'Aszódi járás');
  assert.equal(hungary.areaKm2, 23.57);

  const baghdad = results.find((r) => r.featureId === 'IRQ0');
  assert.equal(baghdad.parentName, 'Baghdad Governorate');
  assert.equal(baghdad.areaKm2, 861.7);
});

test('search(): a row with neither parent_name nor area_km2 nor country_name produces undefined, not a crash', async () => {
  const bareRow = row('Springfield', 'springfield', 'USA', 4, 'USA0');
  const geocoder = makeGeocoder([bareRow]);
  const results = await geocoder.search('springfield');
  assert.equal(results.length, 1);
  assert.equal(results[0].parentName, undefined);
  assert.equal(results[0].areaKm2, undefined);
  assert.equal(results[0].countryName, undefined);
});

test('search(): country_name flows through onto SearchResult (geoBoundaries-shaped index)', async () => {
  const geobRow = row('Zürich', 'zurich', 'CHE', 1, 'CHE0', { country_name: 'Switzerland', area_km2: 1728.86 });
  const geocoder = makeGeocoder([geobRow]);
  const results = await geocoder.search('zurich');
  assert.equal(results.length, 1);
  assert.equal(results[0].countryName, 'Switzerland');
  assert.equal(results[0].areaKm2, 1728.86);
});

test('search(): maxPerGroup caps results per (country, level), filling the limit from the next-ranked distinct group', async () => {
  // Four distinct ADM1 names in Argentina, all matching "san" as a
  // prefix/word-prefix, plus one in Bolivia. Default maxPerGroup (3)
  // should drop the 4th Argentina row and let Bolivia's through.
  const rows = [
    row('Santa Cruz', 'santa cruz', 'ARG', 1, 'A1'),
    row('Santa Fe', 'santa fe', 'ARG', 1, 'A2'),
    row('Santiago del Estero', 'santiago del estero', 'ARG', 1, 'A3'),
    row('San Luis', 'san luis', 'ARG', 1, 'A4'),
    row('Santa Cruz', 'santa cruz', 'BOL', 1, 'B1'),
  ];
  const geocoder = makeGeocoder(rows, { limit: 10 });
  const results = await geocoder.search('san');
  const argResults = results.filter((r) => r.country === 'ARG');
  assert.equal(argResults.length, 3, 'only 3 of the 4 Argentina ADM1 matches should survive the cap');
  assert.ok(results.some((r) => r.country === 'BOL'), 'Bolivia should fill the freed-up slot');
});

test('search(): diversity options are configurable per search() call', async () => {
  const rows = bagRows();
  const geocoder = makeGeocoder(rows, { limit: 10 });
  const results = await geocoder.search('bag', { diversity: { dedupe: false, maxPerGroup: null } });
  const indiaResults = results.filter((r) => r.country === 'IND');
  assert.equal(indiaResults.length, 8, 'dedupe: false should leave all eight India rows distinct');
});
