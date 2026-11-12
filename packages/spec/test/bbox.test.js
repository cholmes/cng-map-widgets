import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bboxOfGeometry,
  crossesAntimeridian,
  computeBBoxes,
  bboxesIntersect,
  bboxContainsPoint,
  scaleBBox,
  unionBBoxes,
} from '../src/bbox.js';

const contraCosta = {
  type: 'Polygon',
  coordinates: [[[-122.4267, 37.7177], [-121.5347, 37.7177], [-121.5347, 38.0994], [-122.4267, 38.0994], [-122.4267, 37.7177]]],
};

// A geometry that genuinely crosses the antimeridian (Fiji-shaped): nothing
// near lon 0, and spans > 180 deg naive width.
const fijiLike = {
  type: 'MultiPolygon',
  coordinates: [
    [[[177.0, -19.0], [179.9, -19.0], [179.9, -16.0], [177.0, -16.0], [177.0, -19.0]]],
    [[[-179.5, -19.0], [-176.8, -19.0], [-176.8, -16.0], [-179.5, -16.0], [-179.5, -19.0]]],
  ],
};

// A global-ish polygon that is just wide, not antimeridian-crossing (has a
// vertex near lon 0).
const wideButNotCrossing = {
  type: 'Polygon',
  coordinates: [[[-170, -10], [0, -10], [170, -10], [170, 10], [0, 10], [-170, 10], [-170, -10]]],
};

test('bboxOfGeometry: simple polygon', () => {
  assert.deepEqual(bboxOfGeometry(contraCosta), [-122.4267, 37.7177, -121.5347, 38.0994]);
});

test('crossesAntimeridian: false for a normal county', () => {
  assert.equal(crossesAntimeridian(contraCosta), false);
});

test('crossesAntimeridian: true for a Fiji-like split geometry', () => {
  assert.equal(crossesAntimeridian(fijiLike), true);
});

test('crossesAntimeridian: false when a vertex sits near lon 0 even if wide', () => {
  assert.equal(crossesAntimeridian(wideButNotCrossing), false);
});

test('computeBBoxes: non-crossing geometry gets exactly one bbox, signed === bboxes[0]', () => {
  const { bbox, bboxes, crossesAntimeridian: crosses } = computeBBoxes(contraCosta);
  assert.equal(crosses, false);
  assert.equal(bboxes.length, 1);
  assert.deepEqual(bbox, bboxes[0]);
});

test('computeBBoxes: crossing geometry gets two normalized boxes + a signed wrap bbox', () => {
  const { bbox, bboxes, crossesAntimeridian: crosses } = computeBBoxes(fijiLike);
  assert.equal(crosses, true);
  assert.equal(bboxes.length, 2);
  for (const box of bboxes) assert.ok(box[0] <= box[2], 'every entry in bboxes must have west <= east');
  // signed bbox wraps: west > east
  assert.ok(bbox[0] > bbox[2], 'signed bbox should have west > east to signal wrap');
});

test('bboxesIntersect', () => {
  assert.equal(bboxesIntersect([0, 0, 10, 10], [5, 5, 15, 15]), true);
  assert.equal(bboxesIntersect([0, 0, 10, 10], [20, 20, 30, 30]), false);
});

test('bboxContainsPoint', () => {
  assert.equal(bboxContainsPoint([0, 0, 10, 10], [5, 5]), true);
  assert.equal(bboxContainsPoint([0, 0, 10, 10], [15, 5]), false);
});

test('scaleBBox doubles the half-extent about the center', () => {
  const box = [0, 0, 10, 10];
  const scaled = scaleBBox(box, 2);
  assert.deepEqual(scaled, [-5, -5, 15, 15]);
});

test('unionBBoxes', () => {
  assert.deepEqual(unionBBoxes([[0, 0, 5, 5], [3, -2, 8, 4]]), [0, -2, 8, 5]);
});
