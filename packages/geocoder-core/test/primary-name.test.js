import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder } from '../src/index.js';

// Follow-up task 1, "primaryName on alt matches": a SearchResult matched
// via an alt row (`rank.isAlt`/`row.alt_of` non-null) exposes the primary
// row's display name as `primaryName`, resolved honestly from data
// already loaded for this query -- never a per-result network round
// trip. See geocoder.js's `_rankAndFilter`/`_getFullIdToNameMap` for the
// two sources it's allowed to resolve from: the rows this query itself
// already fetched, and (full-load mode only) the rest of the already-
// resident full index.

function makeManifest() {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 10,
    levels: [1],
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

test('search(): primaryName is undefined for a primary (non-alt) match', async () => {
  const rows = [row('Zürich', 'zurich', 'CHE', 1, 'CHE0')];
  const geocoder = makeGeocoder(rows);
  const results = await geocoder.search('zurich');
  assert.equal(results[0].primaryName, undefined);
});

test('search(): full-load mode -- primaryName resolves via the whole-index fallback when the primary is outside this query\'s own matched rows', async () => {
  // The query ("zurech", the alt spelling) matches only the alt row -- the
  // primary's own name_norm ("zurich") does not start with "zurech", so
  // the primary is NOT among this query's own matched rows. Full-load
  // mode's lazily-built id->name map over the whole index is the only way
  // this can resolve at all.
  const rows = [
    row('Zürich', 'zurich', 'CHE', 1, 'CHE0'),
    row('Zürech', 'zurech', 'CHE', 1, 'CHE0-ALT', { alt_of: 'CHE0' }),
  ];
  const geocoder = makeGeocoder(rows, { diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('zurech');
  assert.equal(results.length, 1);
  assert.equal(results[0].featureId, 'CHE0-ALT');
  assert.equal(results[0].primaryName, 'Zürich');
});

test('search(): primaryName resolves from this query\'s own matched rows when the primary and alt share the query prefix, even before the whole-index fallback is consulted', async () => {
  // Both the primary ("Zurich"/"zurich") and the alt ("Zurigo"/"zurigo")
  // -- no, both must share prefix "zur" to land in the same matched set.
  const rows = [
    row('Zurich', 'zurich', 'CHE', 1, 'CHE0'),
    row('Zurimatt', 'zurimatt', 'CHE', 1, 'CHE0-ALT', { alt_of: 'CHE0' }),
  ];
  const geocoder = makeGeocoder(rows, { diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('zur');
  const alt = results.find((r) => r.featureId === 'CHE0-ALT');
  assert.equal(alt.primaryName, 'Zurich');
  const primary = results.find((r) => r.featureId === 'CHE0');
  assert.equal(primary.primaryName, undefined);
});

test('search(): primaryName is left undefined, honestly, when the primary is nowhere in the loaded data at all', async () => {
  // The primary row ("CHE0") was never shipped in this fixture at all --
  // not a real scenario (every alt row's primary genuinely exists in the
  // index), but it pins down that a lookup miss degrades to `undefined`
  // rather than throwing or inventing a network round trip to go find it.
  const altOnlyRow = row('Zürech', 'zurech', 'CHE', 1, 'CHE0-ALT', { alt_of: 'CHE0' });
  const geocoder = makeGeocoder([altOnlyRow]);
  const results = await geocoder.search('zurech');
  assert.equal(results.length, 1);
  assert.equal(results[0].primaryName, undefined, 'the primary is not in this query\'s own matched rows, so it is left undefined rather than guessed at or fetched over the network');
});
