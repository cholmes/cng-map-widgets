// Issue #1: teach the gazetteer loader to read a STAC Collection (the
// `gazetteer`/`gazetteer-boundaries` extension shape) in addition to the
// legacy bespoke manifest (`spec: 'cnmw-index/1.0' | 'cng-index/1.0'`).
//
// `loadManifest` must keep returning the internal manifest shape the rest
// of geocoder-core already consumes (index-loader.js's `assertSchema`/
// `projectRow`, geocoder.js's field reads) no matter which document shape
// it was handed -- see `normalizeStacGazetteerCollection` in
// `../src/index-loader.js`, the one adapter this file tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadManifest, normalizeStacGazetteerCollection } from '../src/index-loader.js';
import { isCngError } from '@cngeo/spec';

const EXAMPLE_PATH = fileURLToPath(new URL('../../../spec-draft/examples/geoboundaries-cgaz-collection.json', import.meta.url));
const EXAMPLE_COLLECTION_URL = 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/collection.json';

function readExampleCollection() {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
}

function fakeFetch(doc) {
  return async () => ({ ok: true, json: async () => doc });
}

/** A minimal, valid gazetteer Collection, for the tests that don't need the full worked example. */
function minimalCollection(overrides = {}) {
  return {
    type: 'Collection',
    stac_version: '1.1.0',
    stac_extensions: ['https://example.org/gazetteer/v1.0.0/schema.json'],
    id: 'minimal-gaz',
    license: 'CC-BY-4.0',
    providers: [{ name: 'Example Publisher', roles: ['producer', 'licensor'], url: 'https://example.test/' }],
    'gazetteer:levels': [0],
    assets: {
      index: {
        href: './names.parquet',
        roles: ['gazetteer-index'],
        'file:size': 1000,
        'table:row_count': 10,
      },
    },
    ...overrides,
  };
}

test('a legacy manifest still loads unchanged (regression)', async () => {
  const legacy = {
    spec: 'cnmw-index/1.0',
    source: 'geoboundaries-cgaz',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 52398,
    levels: [0, 1, 2],
    index: { url: './cgaz_names.parquet', size: 3901414, row_groups: 35 },
    boundaries: [],
    attribution: [{ text: 'geoBoundaries', license: 'CC-BY-4.0', url: 'https://www.geoboundaries.org/', share_alike: false }],
  };
  const result = await loadManifest('https://example.test/index.json', fakeFetch(legacy));
  assert.deepEqual(result, legacy, 'legacy manifests must pass through untouched');
});

test('a document that is neither a legacy manifest nor a gazetteer Collection is rejected', async () => {
  const bogus = { type: 'FeatureCollection', features: [] };
  await assert.rejects(
    loadManifest('https://example.test/index.json', fakeFetch(bogus)),
    (err) => {
      assert.ok(isCngError(err));
      assert.equal(err.code, 'INDEX_SCHEMA_MISMATCH');
      return true;
    },
  );
});

test('a Collection with no gazetteer-index asset throws INDEX_SCHEMA_MISMATCH naming what is missing', async () => {
  const noIndexAsset = minimalCollection({
    assets: {
      boundaries: { href: './adm0.parquet', roles: ['gazetteer-boundaries'], 'gazetteer:level': 0, 'gazetteer:variant': 'full', 'gazetteer:geometry_column': 'geometry' },
    },
  });
  await assert.rejects(
    loadManifest('https://example.test/collection.json', fakeFetch(noIndexAsset)),
    (err) => {
      assert.ok(isCngError(err));
      assert.equal(err.code, 'INDEX_SCHEMA_MISMATCH');
      assert.match(err.message, /gazetteer-index/);
      return true;
    },
  );
});

test('relative asset hrefs resolve against the Collection URL', () => {
  const normalized = normalizeStacGazetteerCollection(minimalCollection(), 'https://example.test/catalog/names/collection.json');
  assert.equal(normalized.index.url, 'https://example.test/catalog/names/names.parquet');
});

test('share-alike derivation: CC-BY-4.0 -> false', () => {
  const normalized = normalizeStacGazetteerCollection(minimalCollection({ license: 'CC-BY-4.0' }), 'https://example.test/collection.json');
  assert.equal(normalized.attribution[0].shareAlike, false);
  assert.equal(normalized.attribution[0].share_alike, false);
});

test('share-alike derivation: ODbL-1.0 -> true', () => {
  const normalized = normalizeStacGazetteerCollection(minimalCollection({ license: 'ODbL-1.0' }), 'https://example.test/collection.json');
  assert.equal(normalized.attribution[0].shareAlike, true);
  assert.equal(normalized.attribution[0].share_alike, true);
});

test('share-alike derivation: CC-BY-SA-3.0-IGO -> true', () => {
  const normalized = normalizeStacGazetteerCollection(minimalCollection({ license: 'CC-BY-SA-3.0-IGO' }), 'https://example.test/collection.json');
  assert.equal(normalized.attribution[0].shareAlike, true);
  assert.equal(normalized.attribution[0].share_alike, true);
});

test('both share-alike key spellings are always set and agree with each other', () => {
  for (const license of ['CC-BY-4.0', 'ODbL-1.0', 'CC-BY-SA-3.0-IGO', 'CC0-1.0']) {
    const normalized = normalizeStacGazetteerCollection(minimalCollection({ license }), 'https://example.test/collection.json');
    const [entry] = normalized.attribution;
    assert.equal(typeof entry.shareAlike, 'boolean', license);
    assert.equal(typeof entry.share_alike, 'boolean', license);
    assert.equal(entry.shareAlike, entry.share_alike, license);
  }
});

test('the worked example Collection normalises to the expected internal shape', async () => {
  const collection = readExampleCollection();
  const manifest = await loadManifest(EXAMPLE_COLLECTION_URL, fakeFetch(collection));

  // Collection-level fields.
  assert.equal(manifest.source, 'geoboundaries-cgaz');
  assert.equal(manifest.index_version, 'geoboundaries-cgaz-2026-11-12');
  assert.equal(manifest.catalog_version, 'geoboundaries-cgaz-2026-11-12');
  assert.deepEqual(manifest.levels, [0, 1, 2]);
  assert.equal(manifest.stats_truncated, false);
  assert.equal(manifest.dropped_unnamed, 37);

  // The index asset.
  assert.equal(manifest.index.url, 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/cgaz_names.parquet');
  assert.equal(manifest.index.size, 3901414);
  assert.equal(manifest.index.row_groups, 35);
  assert.equal(manifest.index.row_group_rows, 1536);
  assert.equal(manifest.index.feature_id_column, 'shape_id');
  assert.equal(manifest.index.footer_metadata_bytes, 75606);
  assert.equal(manifest.rows, 52398);

  // No `prominent` asset in the worked example -> no `prominent_index` key at all.
  assert.equal('prominent_index' in manifest, false);

  // Attribution, derived from license + providers.
  assert.equal(manifest.attribution.length, 1);
  const [attribution] = manifest.attribution;
  assert.equal(attribution.license, 'CC-BY-4.0');
  assert.equal(attribution.url, 'https://www.geoboundaries.org/');
  assert.match(attribution.text, /geoBoundaries/);
  assert.equal(attribution.shareAlike, false);
  assert.equal(attribution.share_alike, false);

  // Boundaries, grouped by level with full/display sub-objects.
  assert.equal(manifest.boundaries.length, 3);
  const adm0 = manifest.boundaries.find((b) => b.level === 0);
  const adm1 = manifest.boundaries.find((b) => b.level === 1);
  const adm2 = manifest.boundaries.find((b) => b.level === 2);
  assert.ok(adm0 && adm1 && adm2);

  // ADM0: no feature-id column at all -- `null` is legal and meaningful,
  // and must survive as exactly `null`, never `undefined` (which would
  // silently fall back to the `'feature_id'` default) and never a string.
  assert.equal('feature_id_column' in adm0, true);
  assert.equal(adm0.feature_id_column, null);
  assert.ok(Object.is(adm0.feature_id_column, null), 'must be exactly null, not undefined');
  assert.equal(adm0.index_key_column, 'country');
  assert.equal(adm0.country_column, 'shapeGroup');
  assert.equal(adm0.geometry_column, 'geometry');
  assert.equal(adm0.row_group_rows, 1);
  assert.equal(adm0.full.url, 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/adm0/cgaz_adm0.parquet');
  assert.equal(adm0.full.size, 104201824);
  assert.equal(adm0.full.row_count, 218);
  assert.equal(adm0.full.row_groups, 218);
  assert.equal(adm0.full.footer_metadata_bytes, 271716);
  assert.equal(adm0.display.url, 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/adm0/cgaz_adm0_display.parquet');
  assert.equal(adm0.display.size, 7521581);
  assert.equal(adm0.display.row_count, 218);
  assert.equal(adm0.display.row_groups, 218);
  assert.equal(adm0.display.footer_metadata_bytes, 189008);

  // ADM1/ADM2: a real feature-id column, preserved as a string.
  assert.equal(adm1.feature_id_column, 'shapeID');
  assert.equal(adm1.country_column, 'shapeGroup');
  assert.equal(adm1.row_group_rows, 16);
  assert.equal(adm1.full.row_count, 3224);
  assert.equal(adm1.full.row_groups, 202);
  assert.equal(adm2.feature_id_column, 'shapeID');
  assert.equal(adm2.row_group_rows, 256);
  assert.equal(adm2.full.row_count, 49349);
  assert.equal(adm2.full.row_groups, 193);
});

// --- attribution text must survive the round trip ---
// The legacy manifest carries a full CC-BY citation ("Boundaries:
// geoBoundaries CGAZ. Runfola, D., et al. (2020)... PLoS ONE..."). STAC's
// providers[].name cannot hold that, and AGENTS.md calls
// provenance.attribution "what your UI MUST display" -- so losing it is a
// licence-compliance regression, not a cosmetic one. The `sci` extension's
// sci:citation is the idiomatic home for it.
test('attribution text prefers sci:citation over the provider name', () => {
  const coll = {
    type: 'Collection',
    stac_extensions: [
      'https://stac-extensions.github.io/scientific/v1.0.0/schema.json',
      'https://cholmes.github.io/stac-gazetteer/gazetteer/v1.0.0/schema.json',
    ],
    id: 'geoboundaries-cgaz',
    license: 'CC-BY-4.0',
    'sci:citation': 'Boundaries: geoBoundaries CGAZ. Runfola, D., et al. (2020). PLoS ONE 15(4): e0231866.',
    'sci:doi': '10.1371/journal.pone.0231866',
    providers: [{ name: 'geoBoundaries', roles: ['producer', 'licensor'], url: 'https://www.geoboundaries.org/' }],
    'gazetteer:levels': [0],
    'gazetteer:normalization': 'nfd-strip-marks-lower/1',
    'gazetteer:sort': 'name_norm',
    assets: {
      index: { href: './n.parquet', roles: ['gazetteer-index'], 'table:row_count': 1, 'file:size': 1, 'gazetteer:row_groups': 1 },
    },
  };
  const m = normalizeStacGazetteerCollection(coll, 'https://example.org/c/collection.json');
  const a = m.attribution[0];
  assert.match(a.text, /Runfola/, 'the full citation must reach the UI, not just the provider name');
  assert.equal(a.license, 'CC-BY-4.0');
  assert.equal(a.url, 'https://www.geoboundaries.org/');
  assert.equal(a.doi, '10.1371/journal.pone.0231866');
});

test('attribution falls back to the provider name when there is no citation', () => {
  const coll = {
    type: 'Collection',
    stac_extensions: ['https://cholmes.github.io/stac-gazetteer/gazetteer/v1.0.0/schema.json'],
    id: 'x', license: 'ODbL-1.0',
    providers: [{ name: 'Overture Maps Foundation', roles: ['producer'], url: 'https://overturemaps.org/' }],
    'gazetteer:levels': [0], 'gazetteer:normalization': 'nfd-strip-marks-lower/1', 'gazetteer:sort': 'name_norm',
    assets: { index: { href: './n.parquet', roles: ['gazetteer-index'], 'table:row_count': 1, 'file:size': 1, 'gazetteer:row_groups': 1 } },
  };
  const a = normalizeStacGazetteerCollection(coll, 'https://example.org/c/collection.json').attribution[0];
  assert.equal(a.text, 'Overture Maps Foundation');
  assert.equal(a.shareAlike, true, 'ODbL is share-alike');
  assert.equal(a.doi, undefined);
});

// --- share-alike must distinguish "no" from "unknown" ---
// isShareAlikeLicense() returns false for any unrecognised license string, so
// `license: "other"` produced shareAlike:false -- asserting an absence of
// obligation we have not established. Who's On First legitimately publishes
// `license: "other"` (its docs: "no single SPDX identifier is true of" it),
// and a catalog that is share-alike but non-SPDX would be reported as free of
// obligation. Same silent-under-reporting hazard as AGENTS.md pitfall 3.
test('an unrecognised license reports share-alike as undetermined, not as false', () => {
  const base = {
    type: 'Collection',
    stac_extensions: ['https://cholmes.github.io/stac-gazetteer/gazetteer/v1.0.0/schema.json'],
    id: 'x', 'gazetteer:levels': [0], 'gazetteer:normalization': 'nfd-strip-marks-lower/1', 'gazetteer:sort': 'name_norm',
    providers: [{ name: 'P', roles: ['producer'], url: 'https://example.org/' }],
    assets: { index: { href: './n.parquet', roles: ['gazetteer-index'], 'table:row_count': 1, 'file:size': 1, 'gazetteer:row_groups': 1 } },
  };
  const at = (license) => normalizeStacGazetteerCollection({ ...base, license }, 'https://example.org/c/collection.json').attribution[0];

  const known = at('CC-BY-4.0');
  assert.equal(known.shareAlike, false);
  assert.equal(known.shareAlikeDetermined, true, 'a recognised SPDX id is a determination');

  const sa = at('ODbL-1.0');
  assert.equal(sa.shareAlike, true);
  assert.equal(sa.shareAlikeDetermined, true);

  for (const vague of ['other', 'proprietary', undefined, null]) {
    const a = at(vague);
    assert.equal(a.shareAlikeDetermined, false, `${JSON.stringify(vague)} is not a determination`);
    assert.equal(a.shareAlike, false, 'the boolean stays false for back-compat');
    assert.equal(a.share_alike, false, 'both spellings still agree');
  }
});
