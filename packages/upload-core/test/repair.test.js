import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairFeatures } from '../src/repair.js';

function feature(geometry, properties = {}) {
  return { type: 'Feature', geometry, properties };
}

test('repairFeatures: closes an unclosed ring', () => {
  const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] }; // not closed
  const { features, repairs } = repairFeatures([feature(geometry)]);
  assert.equal(features.length, 1);
  const ring = features[0].geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(repairs.some((r) => r.kind === 'closed-ring' && r.count === 1));
});

test('repairFeatures: rewinds a clockwise exterior ring to counterclockwise (RFC 7946)', () => {
  // Clockwise square (exterior should be CCW).
  const cwRing = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
  const { features, repairs } = repairFeatures([feature({ type: 'Polygon', coordinates: [cwRing] })]);
  assert.equal(features.length, 1);
  const ring = features[0].geometry.coordinates[0];
  // Shoelace sign should now be positive (CCW).
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  assert.ok(sum > 0, 'exterior ring should be CCW after repair');
  assert.ok(repairs.some((r) => r.kind === 'rewound-ring' && r.count === 1));
});

test('repairFeatures: removes consecutive duplicate points', () => {
  const ring = [[0, 0], [0, 0], [1, 0], [1, 0], [1, 1], [0, 0]];
  const { features, repairs } = repairFeatures([feature({ type: 'Polygon', coordinates: [ring] })]);
  assert.equal(features.length, 1);
  assert.equal(features[0].geometry.coordinates[0].length, 4); // [0,0],[1,0],[1,1],[0,0]
  assert.ok(repairs.some((r) => r.kind === 'deduped-points' && r.count === 1));
});

test('repairFeatures: drops the Z coordinate', () => {
  const ring = [[0, 0, 100], [1, 0, 100], [1, 1, 100], [0, 0, 100]];
  const { features, repairs } = repairFeatures([feature({ type: 'Polygon', coordinates: [ring] })]);
  assert.equal(features[0].geometry.coordinates[0][0].length, 2);
  assert.ok(repairs.some((r) => r.kind === 'dropped-z' && r.count === 1));
});

test('repairFeatures: clamps an out-of-range longitude and latitude', () => {
  const ring = [[-200, 100], [1, 0], [1, 1], [-200, 100]];
  const { features, repairs } = repairFeatures([feature({ type: 'Polygon', coordinates: [ring] })]);
  const pt = features[0].geometry.coordinates[0][0];
  assert.equal(pt[0], -180);
  assert.equal(pt[1], 90);
  assert.ok(repairs.some((r) => r.kind === 'clamped-coordinate' && r.axis === 'lon'));
  assert.ok(repairs.some((r) => r.kind === 'clamped-coordinate' && r.axis === 'lat'));
});

test('repairFeatures: drops a degenerate ring (fewer than 3 distinct points) and the whole polygon when it was the exterior', () => {
  const ring = [[0, 0], [0, 0], [0, 0]]; // collapses to a single point after dedup
  const { features, repairs } = repairFeatures([feature({ type: 'Polygon', coordinates: [ring] })]);
  assert.equal(features.length, 0);
  assert.ok(repairs.some((r) => r.kind === 'dropped-empty'));
  assert.ok(repairs.some((r) => r.kind === 'dropped-feature'));
});

test('repairFeatures: drops non-areal features (Point/LineString) and counts them by type', () => {
  const point = feature({ type: 'Point', coordinates: [0, 0] });
  const line = feature({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
  const poly = feature({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
  const { features, repairs } = repairFeatures([point, line, poly]);
  assert.equal(features.length, 1);
  const nonAreal = repairs.find((r) => r.kind === 'dropped-non-areal');
  assert.equal(nonAreal.count, 2);
  assert.ok(nonAreal.types.includes('Point'));
  assert.ok(nonAreal.types.includes('LineString'));
});

test('repairFeatures: a MultiPolygon with one valid and one degenerate sub-polygon keeps only the valid one', () => {
  const valid = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
  const degenerate = [[[5, 5], [5, 5], [5, 5]]];
  const { features, repairs } = repairFeatures([feature({ type: 'MultiPolygon', coordinates: [valid, degenerate] })]);
  assert.equal(features.length, 1);
  assert.equal(features[0].geometry.type, 'MultiPolygon');
  assert.equal(features[0].geometry.coordinates.length, 1);
  assert.ok(repairs.some((r) => r.kind === 'dropped-empty'));
});

test('repairFeatures: a null geometry is dropped as dropped-feature', () => {
  const { features, repairs } = repairFeatures([{ type: 'Feature', geometry: null, properties: {} }]);
  assert.equal(features.length, 0);
  assert.ok(repairs.some((r) => r.kind === 'dropped-feature' && r.reason.includes('null-geometry')));
});

test('repairFeatures: a clean, already-valid ring produces no repairs', () => {
  const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
  // Already CCW: shoelace sum = 0*0 - 1*0 + 1*1 - 1*0 + 0*0 - 0*1 = 1 > 0.
  const { features, repairs } = repairFeatures([feature({ type: 'Polygon', coordinates: [ring] })]);
  assert.equal(features.length, 1);
  assert.deepEqual(repairs, []);
});
