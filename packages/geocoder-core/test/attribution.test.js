import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder } from '../src/index.js';

// Follow-up task 3, "attribution normalization": every manifest shipped
// so far declares each attribution entry's share-alike flag as
// `share_alike` (snake_case), but the design doc's documented
// `AreaAttribution` shape (§1.2) names it `shareAlike` (camelCase).
// `Geocoder#attribution`/`IndexInfo.attribution` now normalize on
// ingestion, so this is actually true rather than something every
// adapter has to separately defend against at the point it reads the
// field.

function makeManifest(attribution) {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 0,
    levels: [4],
    index: { url: './index.parquet', size: 100 },
    boundaries: [],
    attribution,
  };
}

function makeGeocoder(attribution) {
  const deps = {
    loadManifest: async () => makeManifest(attribution),
    loadFullIndex: async () => ({ rows: [], nameNorms: [] }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  return new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps });
}

test('load(): a manifest\'s snake_case share_alike normalizes to camelCase shareAlike', async () => {
  const geocoder = makeGeocoder([
    { text: 'OpenStreetMap contributors', license: 'ODbL-1.0', url: 'https://osm.org', share_alike: true },
    { text: 'geoBoundaries', license: 'CC-BY-4.0', url: 'https://geoboundaries.org', share_alike: false },
  ]);
  const info = await geocoder.load();

  assert.equal(geocoder.attribution[0].shareAlike, true);
  assert.equal(geocoder.attribution[1].shareAlike, false);
  assert.equal(info.attribution[0].shareAlike, true);
  // The raw key is kept alongside the normalized one -- cheap, and some
  // caller may still read the raw manifest spelling directly.
  assert.equal(geocoder.attribution[0].share_alike, true);
});

test('load(): a manifest that already spells it shareAlike (camelCase) is left as is', async () => {
  const geocoder = makeGeocoder([{ text: 'Some source', license: 'CC0-1.0', shareAlike: true }]);
  await geocoder.load();
  assert.equal(geocoder.attribution[0].shareAlike, true);
});

test('load(): an attribution entry with neither spelling normalizes to shareAlike: false, not undefined', async () => {
  const geocoder = makeGeocoder([{ text: 'Some source', license: 'CC0-1.0' }]);
  await geocoder.load();
  assert.equal(geocoder.attribution[0].shareAlike, false);
});

test('load(): no attribution at all on the manifest leaves Geocoder#attribution as an empty array', async () => {
  const geocoder = makeGeocoder(undefined);
  await geocoder.load();
  assert.deepEqual(geocoder.attribution, []);
});
