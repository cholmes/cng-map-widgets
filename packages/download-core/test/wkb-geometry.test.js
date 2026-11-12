// Regression tests for the FIRMS (E6) blocker: @cnmw/spec's `wkbToGeoJson`
// and `bboxOfGeometry` are deliberately Polygon(3)/MultiPolygon(6) only (see
// packages/spec/src/wkb.js's module doc), so a point dataset -- every row's
// `geometry` column is a WKB Point -- threw "unsupported geometry type 1"
// on every single row, in three call sites (engine-hyparquet.js's row-level
// bbox/intersects fallback, and both bundled format writers). This is the
// local Point/MultiPoint decoder added in `../src/wkb-geometry.js` to fix
// that without touching packages/spec (outside this task's scope -- see
// that module's doc comment).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWkbGeometry, bboxOfAnyGeometry } from '../src/wkb-geometry.js';

/** Little-endian WKB Point: byte order (1) + type (1, uint32 LE) + x,y (float64 LE). */
function wkbPoint(x, y) {
  const buf = new ArrayBuffer(21);
  const view = new DataView(buf);
  view.setUint8(0, 1);
  view.setUint32(1, 1, true);
  view.setFloat64(5, x, true);
  view.setFloat64(13, y, true);
  return new Uint8Array(buf);
}

/** Little-endian WKB MultiPoint from a list of [x, y] pairs. */
function wkbMultiPoint(points) {
  const buf = new ArrayBuffer(9 + points.length * 21);
  const view = new DataView(buf);
  view.setUint8(0, 1);
  view.setUint32(1, 4, true); // MultiPoint
  view.setUint32(5, points.length, true);
  let offset = 9;
  for (const [x, y] of points) {
    view.setUint8(offset, 1);
    view.setUint32(offset + 1, 1, true); // inner Point
    view.setFloat64(offset + 5, x, true);
    view.setFloat64(offset + 13, y, true);
    offset += 21;
  }
  return new Uint8Array(buf);
}

/** Little-endian WKB Polygon, one ring, no holes -- same shape @cnmw/spec's wkbToGeoJson reads. */
function wkbPolygon(ring) {
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + ring.length * 16);
  const view = new DataView(buf);
  view.setUint8(0, 1);
  view.setUint32(1, 3, true); // Polygon
  view.setUint32(5, 1, true); // one ring
  view.setUint32(9, ring.length, true);
  let offset = 13;
  for (const [x, y] of ring) {
    view.setFloat64(offset, x, true);
    view.setFloat64(offset + 8, y, true);
    offset += 16;
  }
  return new Uint8Array(buf);
}

test('decodeWkbGeometry: decodes a WKB Point (the real FIRMS geometry encoding) that @cnmw/spec\'s wkbToGeoJson rejects', () => {
  const geom = decodeWkbGeometry(wkbPoint(-122.27, 37.81));
  assert.deepEqual(geom, { type: 'Point', coordinates: [-122.27, 37.81] });
});

test('decodeWkbGeometry: decodes a WKB MultiPoint', () => {
  const geom = decodeWkbGeometry(wkbMultiPoint([[1, 2], [3, 4], [-5, -6]]));
  assert.deepEqual(geom, { type: 'MultiPoint', coordinates: [[1, 2], [3, 4], [-5, -6]] });
});

test('decodeWkbGeometry: delegates Polygon (and everything else) unchanged to @cnmw/spec', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const geom = decodeWkbGeometry(wkbPolygon(ring));
  assert.equal(geom.type, 'Polygon');
  assert.deepEqual(geom.coordinates, [ring]);
});

test('decodeWkbGeometry: an unsupported type still throws the same way @cnmw/spec does (e.g. LineString=2)', () => {
  const buf = new Uint8Array(5);
  const view = new DataView(buf.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 2, true); // LineString -- not handled by this file either
  assert.throws(() => decodeWkbGeometry(buf), /unsupported geometry type 2/);
});

test('bboxOfAnyGeometry: a Point\'s bbox is a degenerate box at its own coordinate', () => {
  assert.deepEqual(bboxOfAnyGeometry({ type: 'Point', coordinates: [-122.27, 37.81] }), [-122.27, 37.81, -122.27, 37.81]);
});

test('bboxOfAnyGeometry: a MultiPoint\'s bbox covers every point', () => {
  const geom = { type: 'MultiPoint', coordinates: [[1, 2], [-5, 10], [3, -4]] };
  assert.deepEqual(bboxOfAnyGeometry(geom), [-5, -4, 3, 10]);
});

// GeoParquet 2.0 (native Parquet GEOMETRY logical type, as FIRMS and
// s2-stac-geoparquet are written) makes hyparquet auto-decode the geometry
// column itself, unconditionally -- independent of parquet-io.js's
// `geoparquet: false`, which only ever suppressed the *older* GeoParquet
// convention's sidecar-metadata heuristic. So `row[geometryColumn]` can
// arrive here already decoded, not as raw WKB bytes.
test('decodeWkbGeometry: passes an already-decoded GeoJSON geometry through unchanged (GeoParquet 2.0 native-logical-type columns)', () => {
  const point = { type: 'Point', coordinates: [-122.27, 37.81] };
  assert.equal(decodeWkbGeometry(point), point); // identity, not a copy
  const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  assert.equal(decodeWkbGeometry(polygon), polygon);
});

test('bboxOfAnyGeometry: Polygon/MultiPolygon still delegate to @cnmw/spec\'s bboxOfGeometry', () => {
  const geom = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
  assert.deepEqual(bboxOfAnyGeometry(geom), [0, 0, 10, 10]);
});
