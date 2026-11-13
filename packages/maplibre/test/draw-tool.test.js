// @cnmw/maplibre -- unit tests for createDrawTool's pure geometry math
// (no DOM/map required: see draw-tool.js's header for why createDrawTool
// itself needs a real `map`, but these helpers do not).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectangleRingFromCorners, rectanglePolygonFromCorners, isDegenerateRectangle } from '../src/draw-tool.js';

test('rectangleRingFromCorners: normalizes corners given in any order', () => {
  const ring = rectangleRingFromCorners([10, 5], [2, 1]);
  assert.deepEqual(ring, [
    [2, 1],
    [10, 1],
    [10, 5],
    [2, 5],
    [2, 1],
  ]);
});

test('rectangleRingFromCorners: closed ring (first === last)', () => {
  const ring = rectangleRingFromCorners([0, 0], [1, 1]);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(ring.length, 5);
});

test('rectangleRingFromCorners: counter-clockwise winding (RFC 7946 exterior ring)', () => {
  const ring = rectangleRingFromCorners([0, 0], [1, 1]);
  // shoelace sum positive => counter-clockwise in a standard (x right, y up) frame
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  assert.ok(sum > 0, `expected positive (CCW) shoelace sum, got ${sum}`);
});

test('rectanglePolygonFromCorners: a Polygon with one ring', () => {
  const poly = rectanglePolygonFromCorners([0, 0], [1, 1]);
  assert.equal(poly.type, 'Polygon');
  assert.equal(poly.coordinates.length, 1);
  assert.equal(poly.coordinates[0].length, 5);
});

test('isDegenerateRectangle: true when corners nearly coincide on either axis', () => {
  assert.equal(isDegenerateRectangle([0, 0], [0, 0]), true);
  assert.equal(isDegenerateRectangle([0, 0], [0.0000001, 5]), true); // lon collapsed
  assert.equal(isDegenerateRectangle([0, 0], [5, 0.0000001]), true); // lat collapsed
});

test('isDegenerateRectangle: false for a real rectangle', () => {
  assert.equal(isDegenerateRectangle([0, 0], [1, 1]), false);
  assert.equal(isDegenerateRectangle([9.4, 47.0], [9.6, 47.3]), false);
});
