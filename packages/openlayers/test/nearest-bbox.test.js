import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNearestBBox } from '../src/nearest-bbox.js';

test('selectNearestBBox returns null for an empty list', () => {
  assert.equal(selectNearestBBox([], 0), null);
});

test('selectNearestBBox returns the only box for a single-entry list (the non-antimeridian case)', () => {
  const box = [-122.4, 37.7, -121.5, 38.1];
  assert.deepEqual(selectNearestBBox([box], -122), box);
});

test('selectNearestBBox picks the Fiji-east half when the view is centered over it', () => {
  // Fiji-ish split, per design doc §1.6's worked example. East half's
  // center is ~176.05; 177 sits well inside it and far (via wraparound)
  // from the west half's center (~-178.4, i.e. ~181.6 the other way).
  const eastHalf = [172.1, -19.2, 180.0, -12.4];
  const westHalf = [-180.0, -19.2, -176.8, -12.4];
  const picked = selectNearestBBox([eastHalf, westHalf], 177);
  assert.deepEqual(picked, eastHalf);
});

test('selectNearestBBox picks the Fiji-west half when the view is centered over it (wraparound distance)', () => {
  const eastHalf = [172.1, -19.2, 180.0, -12.4];
  const westHalf = [-180.0, -19.2, -176.8, -12.4];
  const picked = selectNearestBBox([eastHalf, westHalf], -177);
  assert.deepEqual(picked, westHalf);
});

test('selectNearestBBox uses true wraparound distance, not naive subtraction', () => {
  // Center at -179.9: naive |boxCenterLon - centerLon| would favor the
  // west half even though the east half's center (176.05) is actually
  // only ~5.85 deg away across the dateline, not ~355 deg away.
  const eastHalf = [172.1, -19.2, 180.0, -12.4]; // center ~176.05
  const westHalf = [-180.0, -19.2, -176.8, -12.4]; // center ~-178.4
  const picked = selectNearestBBox([eastHalf, westHalf], -179.9);
  assert.deepEqual(picked, westHalf, 'west half (~1.5 deg via wraparound) is closer than the east half (~4.05 deg via wraparound)');
});
