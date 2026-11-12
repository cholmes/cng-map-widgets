import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visvalingamRing, ringArea, simplifyToVertexCeiling } from '../src/simplify.js';

test('ringArea computes the shoelace area of a unit square', () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  assert.equal(ringArea(square), 1);
});

test('visvalingamRing removes a nearly-collinear point under tolerance', () => {
  // A square with an extra point on one edge that's almost collinear
  // (tiny triangle area) -- should be removed at a modest tolerance.
  const ring = [[0, 0], [0.5, 0.001], [1, 0], [1, 1], [0, 1], [0, 0]];
  const simplified = visvalingamRing(ring, 0.01);
  assert.ok(simplified.length < ring.length, 'expected the near-collinear point to be removed');
  assert.deepEqual(simplified[0], simplified[simplified.length - 1], 'ring must stay closed');
});

test('visvalingamRing with zero tolerance removes nothing', () => {
  const ring = [[0, 0], [0.5, 0.5], [1, 0], [1, 1], [0, 1], [0, 0]];
  const simplified = visvalingamRing(ring, 0);
  assert.equal(simplified.length, ring.length);
});

test('visvalingamRing never drops below a triangle (3 distinct points)', () => {
  const ring = [[0, 0], [0.5, 0.001], [1, 0], [1, 1], [0, 1], [0, 0]];
  const simplified = visvalingamRing(ring, 1e9); // huge tolerance: remove everything possible
  // open-ring point count (excluding duplicated closing point) must be >= 3
  assert.ok(simplified.length - 1 >= 3);
});

function manyVertexRing(n) {
  // A near-circular polygon with n vertices, so simplification has real work to do.
  const ring = [];
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    ring.push([Math.cos(theta), Math.sin(theta)]);
  }
  ring.push(ring[0]);
  return ring;
}

test('simplifyToVertexCeiling leaves a geometry under the ceiling untouched', () => {
  const geometry = { type: 'Polygon', coordinates: [manyVertexRing(50)] };
  const result = simplifyToVertexCeiling(geometry, { vertexCeiling: 1000 });
  assert.equal(result.method, 'none');
  assert.equal(result.degradedToBbox, false);
  assert.equal(result.outputVertices, result.inputVertices);
});

test('simplifyToVertexCeiling reduces vertex count under the ceiling for a dense ring', () => {
  const geometry = { type: 'Polygon', coordinates: [manyVertexRing(5000)] };
  const result = simplifyToVertexCeiling(geometry, { vertexCeiling: 500, areaDeltaMaxRatio: 0.1 });
  assert.ok(result.outputVertices <= 500, `expected <=500 vertices, got ${result.outputVertices}`);
  assert.equal(result.degradedToBbox, false);
  assert.ok(result.areaDeltaRatio <= 0.1);
});

test('simplifyToVertexCeiling degrades to bbox when the area delta ceiling cannot be honored', () => {
  // A pathological ring that loses a lot of area whenever it's thinned:
  // force the area-delta ceiling to be impossibly tight.
  const geometry = { type: 'Polygon', coordinates: [manyVertexRing(5000)] };
  const result = simplifyToVertexCeiling(geometry, { vertexCeiling: 10, areaDeltaMaxRatio: 1e-12 });
  assert.equal(result.degradedToBbox, true);
  assert.equal(result.method, 'bbox');
});
