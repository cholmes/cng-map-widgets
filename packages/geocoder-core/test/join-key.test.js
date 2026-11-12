import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveJoinKey } from '../src/index.js';

// resolveGeometry's manifest-driven join-key decision (geometry-resolver.js),
// extracted for unit testing the same way resolveResolutionMode is: no
// network, no hyparquet. This is the fix for the geoboundaries-catalog
// ADM0 case (design doc §6.4 amendments; catalog's names/index.json):
// CGAZ's ADM0 boundary file has no shapeID column at all, so level 0's
// manifest entry sets `index_key_column: "country"` and joins on the
// boundary file's `shapeGroup` (declared as `country_column`) instead of
// `feature_id`.

const RESULT = { featureId: 'USA-ADM1-123', country: 'USA' };
const RESULT_NO_ID = { featureId: null, country: 'GBR' };

test('resolveJoinKey: no entry at all joins on feature_id (pre-existing default)', () => {
  assert.deepEqual(resolveJoinKey(undefined, RESULT), { column: 'feature_id', value: 'USA-ADM1-123' });
});

test('resolveJoinKey: entry with no index_key_column still defaults to feature_id', () => {
  const entry = { feature_id_column: 'shapeID', country_column: 'shapeGroup' };
  assert.deepEqual(resolveJoinKey(entry, RESULT), { column: 'shapeID', value: 'USA-ADM1-123' });
});

test('resolveJoinKey: feature_id_column default name is "feature_id" when the entry omits it', () => {
  const entry = { index_key_column: 'feature_id' };
  assert.deepEqual(resolveJoinKey(entry, RESULT), { column: 'feature_id', value: 'USA-ADM1-123' });
});

test('resolveJoinKey: ADM0 case -- index_key_column "country" joins on country_column, ignoring a null featureId', () => {
  const entry = { feature_id_column: null, index_key_column: 'country', country_column: 'shapeGroup' };
  assert.deepEqual(resolveJoinKey(entry, RESULT_NO_ID), { column: 'shapeGroup', value: 'GBR' });
});

test('resolveJoinKey: index_key_column "country" with no country_column defaults the boundary column name to "country"', () => {
  const entry = { feature_id_column: null, index_key_column: 'country' };
  assert.deepEqual(resolveJoinKey(entry, RESULT_NO_ID), { column: 'country', value: 'GBR' });
});

test('resolveJoinKey: never reads featureId when index_key_column is "country", even if featureId happens to be set', () => {
  const entry = { index_key_column: 'country', country_column: 'shapeGroup' };
  const result = { featureId: 'should-be-ignored', country: 'FRA' };
  assert.deepEqual(resolveJoinKey(entry, result), { column: 'shapeGroup', value: 'FRA' });
});
