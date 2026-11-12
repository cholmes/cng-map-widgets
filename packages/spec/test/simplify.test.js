import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visvalingamRing, ringArea, simplifyToVertexCeiling, MAX_SYNC_SIMPLIFY_VERTICES } from '../src/simplify.js';

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

// `maxSyncInputVertices` -- the opt-in guard against the O(m^2) search's
// blow-up on large inputs (fix history: "Canada ADM0 select() blocks the
// main thread for ~24s"; see this module's header comment for the
// measurements behind the default).

test('simplifyToVertexCeiling without maxSyncInputVertices still runs the real search on a large input (unchanged default behavior)', () => {
  const geometry = { type: 'Polygon', coordinates: [manyVertexRing(5000)] };
  const result = simplifyToVertexCeiling(geometry, { vertexCeiling: 500, areaDeltaMaxRatio: 0.1 });
  assert.equal(result.method, 'visvalingam');
  assert.equal(result.degradedToBbox, false);
  assert.ok(result.outputVertices <= 500);
});

test('simplifyToVertexCeiling with maxSyncInputVertices degrades to bbox instead of running the search, once input exceeds it', () => {
  const geometry = { type: 'Polygon', coordinates: [manyVertexRing(5000)] };
  const result = simplifyToVertexCeiling(geometry, {
    vertexCeiling: 500,
    areaDeltaMaxRatio: 0.1,
    maxSyncInputVertices: MAX_SYNC_SIMPLIFY_VERTICES,
  });
  assert.equal(result.method, 'bbox');
  assert.equal(result.degradedToBbox, true);
  // The original, unsimplified geometry is returned untouched -- no
  // partial/best-effort reduction is attempted.
  assert.equal(result.geometry, geometry);
  assert.equal(result.outputVertices, result.inputVertices);
});

test('simplifyToVertexCeiling with maxSyncInputVertices still runs the real search when input is at or under the guard', () => {
  const geometry = { type: 'Polygon', coordinates: [manyVertexRing(1200)] };
  const result = simplifyToVertexCeiling(geometry, {
    vertexCeiling: 100,
    areaDeltaMaxRatio: 0.2,
    maxSyncInputVertices: MAX_SYNC_SIMPLIFY_VERTICES,
  });
  assert.equal(result.method, 'visvalingam');
  assert.equal(result.degradedToBbox, false);
  assert.ok(result.outputVertices <= 100);
});

test('simplifyToVertexCeiling with maxSyncInputVertices never even reaches the guard when input is already under the ceiling', () => {
  // inputVertices <= vertexCeiling short-circuits before the guard check,
  // regardless of how small maxSyncInputVertices is.
  const geometry = { type: 'Polygon', coordinates: [manyVertexRing(50)] };
  const result = simplifyToVertexCeiling(geometry, { vertexCeiling: 1000, maxSyncInputVertices: 10 });
  assert.equal(result.method, 'none');
  assert.equal(result.degradedToBbox, false);
});
