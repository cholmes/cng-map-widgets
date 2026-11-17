import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geojsonToWkb, bboxOfWkb, peekWkbType, wkbTypeName, gpkgGeometryBlob, isDecodedGeometry, bboxOf } from '../src/wkb.js';
import { wkbToGeoJson } from '@cng/spec';

test('geojsonToWkb: Polygon round-trips through @cng/spec\'s wkbToGeoJson', () => {
  const geom = { type: 'Polygon', coordinates: [[[9.5, 47.1], [9.55, 47.1], [9.55, 47.15], [9.5, 47.15], [9.5, 47.1]]] };
  const wkb = geojsonToWkb(geom);
  assert.deepEqual(wkbToGeoJson(wkb), geom);
  assert.equal(peekWkbType(wkb), 3);
  assert.equal(wkbTypeName(3), 'POLYGON');
});

test('geojsonToWkb: MultiPolygon round-trips through @cng/spec\'s wkbToGeoJson', () => {
  const geom = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      [[[10, 10], [11, 10], [11, 11], [10, 10]]],
    ],
  };
  const wkb = geojsonToWkb(geom);
  assert.deepEqual(wkbToGeoJson(wkb), geom);
  assert.equal(peekWkbType(wkb), 6);
});

test('geojsonToWkb + bboxOfWkb: Point', () => {
  const geom = { type: 'Point', coordinates: [9.5215, 47.1410] };
  const wkb = geojsonToWkb(geom);
  assert.equal(peekWkbType(wkb), 1);
  assert.deepEqual(bboxOfWkb(wkb), [9.5215, 47.141, 9.5215, 47.141]);
  assert.deepEqual(bboxOf(geom), [9.5215, 47.141, 9.5215, 47.141]);
});

test('geojsonToWkb + bboxOfWkb: MultiPoint', () => {
  const geom = { type: 'MultiPoint', coordinates: [[0, 0], [5, 10]] };
  const wkb = geojsonToWkb(geom);
  assert.equal(peekWkbType(wkb), 4);
  assert.deepEqual(bboxOfWkb(wkb), [0, 0, 5, 10]);
});

test('geojsonToWkb + bboxOfWkb: LineString and MultiLineString (the bug this test caught: nested WKB headers for Multi* parts)', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] };
  const lineWkb = geojsonToWkb(line);
  assert.equal(peekWkbType(lineWkb), 2);
  assert.deepEqual(bboxOfWkb(lineWkb), [0, 0, 2, 1]);

  const multiLine = { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[5, 5], [6, 6]]] };
  const multiLineWkb = geojsonToWkb(multiLine);
  assert.equal(peekWkbType(multiLineWkb), 5);
  assert.deepEqual(bboxOfWkb(multiLineWkb), [0, 0, 6, 6]);
});

test('bboxOfWkb: MultiPolygon bbox matches bboxOf on the decoded geometry', () => {
  const geom = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      [[[10, 10], [11, 10], [11, 11], [10, 10]]],
    ],
  };
  const wkb = geojsonToWkb(geom);
  assert.deepEqual(bboxOfWkb(wkb), bboxOf(geom));
  assert.deepEqual(bboxOfWkb(wkb), [0, 0, 11, 11]);
});

test('gpkgGeometryBlob: 8-byte header (magic GP, version 0, LE flag, no envelope) + the WKB bytes verbatim', () => {
  const wkb = geojsonToWkb({ type: 'Point', coordinates: [1, 2] });
  const blob = gpkgGeometryBlob(wkb, 4326);
  assert.equal(blob.length, 8 + wkb.length);
  assert.equal(blob[0], 0x47); // 'G'
  assert.equal(blob[1], 0x50); // 'P'
  assert.equal(blob[2], 0); // version
  assert.equal(blob[3] & 0x01, 1); // little-endian header flag
  assert.equal((blob[3] >> 1) & 0x07, 0); // no envelope
  const srsId = new DataView(blob.buffer).getInt32(4, true);
  assert.equal(srsId, 4326);
  assert.deepEqual(blob.slice(8), wkb);
});

test('isDecodedGeometry distinguishes a GeoJSON object from raw WKB bytes', () => {
  assert.equal(isDecodedGeometry({ type: 'Point', coordinates: [0, 0] }), true);
  assert.equal(isDecodedGeometry(geojsonToWkb({ type: 'Point', coordinates: [0, 0] })), false);
  assert.equal(isDecodedGeometry(null), false);
});

test('geojsonToWkb: an unsupported geometry type throws a legible error', () => {
  assert.throws(() => geojsonToWkb({ type: 'GeometryCollection', geometries: [] }), /unsupported geometry type/);
});
