import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bboxIntersectsAny, pointInRing, pointInPolygon, pointInGeometry, geometriesIntersect, rowMatchesArea } from '../src/spatial.js';

test('bboxIntersectsAny: overlapping boxes match', () => {
  assert.equal(bboxIntersectsAny([-1, -1, 1, 1], [[0, 0, 2, 2]]), true);
});

test('bboxIntersectsAny: disjoint boxes do not match', () => {
  assert.equal(bboxIntersectsAny([-1, -1, 1, 1], [[5, 5, 6, 6]]), false);
});

test('bboxIntersectsAny: exact edge touch excluded by default (includeBboxTouch=false)', () => {
  assert.equal(bboxIntersectsAny([0, 0, 1, 1], [[1, 0, 2, 1]]), false);
});

test('bboxIntersectsAny: exact edge touch included when includeBboxTouch=true', () => {
  assert.equal(bboxIntersectsAny([0, 0, 1, 1], [[1, 0, 2, 1]], true), true);
});

test('bboxIntersectsAny: matches against any entry in a multi-box (antimeridian) list', () => {
  // A feature near the date line on the western side; Area split into an
  // eastern box (170..180) and a western box (-180..-170) -- design doc
  // §1.5's antimeridian-split bboxes[] form.
  const areaBBoxes = [[170, -20, 180, -10], [-180, -20, -170, -10]];
  assert.equal(bboxIntersectsAny([-179, -15, -178, -14], areaBBoxes), true);
  assert.equal(bboxIntersectsAny([175, -15, 176, -14], areaBBoxes), true);
  assert.equal(bboxIntersectsAny([0, 0, 1, 1], areaBBoxes), false);
});

const SQUARE = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
const SQUARE_WITH_HOLE = {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
  ],
};

test('pointInRing: ray casting basics', () => {
  assert.equal(pointInRing([5, 5], SQUARE.coordinates[0]), true);
  assert.equal(pointInRing([15, 5], SQUARE.coordinates[0]), false);
});

test('pointInPolygon honors holes', () => {
  assert.equal(pointInPolygon([5, 5], SQUARE_WITH_HOLE), false); // inside the hole
  assert.equal(pointInPolygon([1, 1], SQUARE_WITH_HOLE), true); // inside outer, outside hole
  assert.equal(pointInPolygon([20, 20], SQUARE_WITH_HOLE), false); // outside entirely
});

test('pointInGeometry works for MultiPolygon', () => {
  const multi = { type: 'MultiPolygon', coordinates: [SQUARE.coordinates, [[[100, 100], [110, 100], [110, 110], [100, 110], [100, 100]]]] };
  assert.equal(pointInGeometry([5, 5], multi), true);
  assert.equal(pointInGeometry([105, 105], multi), true);
  assert.equal(pointInGeometry([50, 50], multi), false);
});

test('geometriesIntersect: one polygon fully inside another', () => {
  const inner = { type: 'Polygon', coordinates: [[[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]] };
  assert.equal(geometriesIntersect(SQUARE, inner), true);
});

test('geometriesIntersect: edges cross with no vertex of either inside the other', () => {
  // A plus-sign overlap: two rectangles that cross through each other
  // without either containing a vertex of the other.
  const a = { type: 'Polygon', coordinates: [[[-10, -1], [10, -1], [10, 1], [-10, 1], [-10, -1]]] }; // horizontal bar
  const b = { type: 'Polygon', coordinates: [[[-1, -10], [1, -10], [1, 10], [-1, 10], [-1, -10]]] }; // vertical bar
  assert.equal(geometriesIntersect(a, b), true);
});

test('geometriesIntersect: disjoint polygons', () => {
  const far = { type: 'Polygon', coordinates: [[[100, 100], [110, 100], [110, 110], [100, 110], [100, 100]]] };
  assert.equal(geometriesIntersect(SQUARE, far), false);
});

test('rowMatchesArea: bbox mode only checks bbox, ignores geometry entirely', () => {
  const area = { bboxes: [[0, 0, 10, 10]], filterGeometry: null };
  assert.equal(rowMatchesArea({ featureBBox: [1, 1, 2, 2] }, area, { mode: 'bbox' }), true);
  assert.equal(rowMatchesArea({ featureBBox: [20, 20, 21, 21] }, area, { mode: 'bbox' }), false);
});

test('rowMatchesArea: intersects mode degrades to bbox-only when filterGeometry is null', () => {
  const area = { bboxes: [[0, 0, 10, 10]], filterGeometry: null };
  // bbox overlaps but geometry test can't run -- design doc: "degraded-to-bbox"
  assert.equal(rowMatchesArea({ featureBBox: [8, 8, 20, 20], featureGeometry: SQUARE }, area, { mode: 'intersects' }), true);
});

test('rowMatchesArea: intersects mode runs the exact geometry test once bbox passes', () => {
  const area = { bboxes: [[0, 0, 10, 10]], filterGeometry: SQUARE_WITH_HOLE };
  const insideHole = { type: 'Polygon', coordinates: [[[4.5, 4.5], [5.5, 4.5], [5.5, 5.5], [4.5, 5.5], [4.5, 4.5]]] };
  assert.equal(rowMatchesArea({ featureBBox: [4.5, 4.5, 5.5, 5.5], featureGeometry: insideHole }, area, { mode: 'intersects' }), false);
  const outsideHole = { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] };
  assert.equal(rowMatchesArea({ featureBBox: [1, 1, 2, 2], featureGeometry: outsideHole }, area, { mode: 'intersects' }), true);
});

test('rowMatchesArea: antimeridian-split area bboxes, point-in-polygon runs against the unsplit geometry', () => {
  // A Fiji-shaped Area: the overall bbox crosses the antimeridian, but (as
  // real CGAZ MultiPolygons do) no individual *ring* wraps -- one part sits
  // just east of 180, the other just west of -180 (design doc §1.5 rule 1:
  // "coordinates stay as published", no +360 unwrapping). bboxes[] is the
  // split, computational form; filterGeometry keeps its raw, per-part
  // coordinates, which is why the plain (non-antimeridian-aware)
  // point-in-polygon test in geometriesIntersect/pointInGeometry still
  // gives the right answer here -- each ring individually never wraps.
  const eastPart = [[[178, -19], [179.9, -19], [179.9, -17], [178, -17], [178, -19]]];
  const westPart = [[[-179.9, -19], [-178.2, -19], [-178.2, -17], [-179.9, -17], [-179.9, -19]]];
  const fijiLike = { type: 'MultiPolygon', coordinates: [eastPart, westPart] };
  const area = { bboxes: [[178, -20, 180, -16], [-180, -20, -178, -16]], filterGeometry: fijiLike };

  const featureInWestPart = { type: 'Polygon', coordinates: [[[-179.5, -18.5], [-179.2, -18.5], [-179.2, -18.2], [-179.5, -18.2], [-179.5, -18.5]]] };
  assert.equal(
    rowMatchesArea({ featureBBox: [-179.5, -18.5, -179.2, -18.2], featureGeometry: featureInWestPart }, area, { mode: 'intersects' }),
    true,
  );
  const featureInEastPart = { type: 'Polygon', coordinates: [[[178.5, -18.5], [178.8, -18.5], [178.8, -18.2], [178.5, -18.2], [178.5, -18.5]]] };
  assert.equal(
    rowMatchesArea({ featureBBox: [178.5, -18.5, 178.8, -18.2] }, area, { mode: 'bbox' }), // bbox-only still matches via bboxes[]
    true,
  );
  assert.equal(
    rowMatchesArea({ featureBBox: [178.5, -18.5, 178.8, -18.2], featureGeometry: featureInEastPart }, area, { mode: 'intersects' }),
    true,
  );
  // A feature on the opposite side of the globe fails the bbox prune before geometry is even considered.
  const farFeature = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  assert.equal(rowMatchesArea({ featureBBox: [0, 0, 1, 1], featureGeometry: farFeature }, area, { mode: 'intersects' }), false);
});

test('rowMatchesArea: KNOWN LIMITATION -- a single ring that itself straddles the antimeridian is not handled (documents the gap left by design doc §1.5\'s "coordinates never wrap" assumption)', () => {
  // If a *ring* (not just the Area's overall bbox) has vertices that jump
  // from ~180 to ~-180, plain planar ray-casting/edge-crossing has no way
  // to know the short path wraps around, and can misclassify points. This
  // only arises for geometry that is itself published with a wrapping
  // ring (CGAZ RUS/FJI ADM0 polygons can do this); exact clip is refused
  // across the antimeridian for exactly this class of problem (design doc
  // §1.5 rule 6) -- `intersects` has no such refusal, so this gap is real
  // and is called out here rather than silently asserted away.
  const wrappingRing = { type: 'Polygon', coordinates: [[[178, -19], [-179, -19], [-179, -17], [178, -17], [178, -19]]] };
  const pointClearlyInsideTheRealShape = [-179.35, -18.35];
  assert.equal(pointInGeometry(pointClearlyInsideTheRealShape, wrappingRing), false); // documents the limitation, not the desired behavior
});
