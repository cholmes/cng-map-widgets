// The cnmw-index/1.0 -> cng-index/1.0 rollout. Both values must be accepted
// while the published catalogs are migrated: the deployed demo site runs
// deployed code, so flipping the validator and the catalogs independently
// breaks one side or the other. See CONTRIBUTING.md and issue #1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPTED_INDEX_SPECS, isAcceptedIndexSpec } from '../src/index-loader.js';

test('both the legacy and the current spec value are accepted', () => {
  assert.ok(isAcceptedIndexSpec('cnmw-index/1.0'), 'legacy value, still live on data.source.coop');
  assert.ok(isAcceptedIndexSpec('cng-index/1.0'), 'the renamed value');
});

test('anything else is rejected', () => {
  for (const bad of ['cng-index/2.0', 'cng-index', 'stac-index/1.0', '', null, undefined, 42]) {
    assert.equal(isAcceptedIndexSpec(bad), false, `${JSON.stringify(bad)} must not be accepted`);
  }
});

test('the accepted set is exported so the deprecation is discoverable', () => {
  assert.deepEqual([...ACCEPTED_INDEX_SPECS].sort(), ['cng-index/1.0', 'cnmw-index/1.0']);
});
