import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lonLatToMercator,
  mercatorToLonLat,
  projectPoint,
  unprojectPoint,
  projectExtent,
  unprojectExtent,
  projectGeometry,
  isMercatorCode,
  isLonLatCode,
} from '../src/projection.js';

function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

test('isMercatorCode / isLonLatCode recognize the common spellings', () => {
  assert.equal(isMercatorCode('EPSG:3857'), true);
  assert.equal(isMercatorCode('EPSG:900913'), true);
  assert.equal(isMercatorCode('EPSG:4326'), false);
  assert.equal(isLonLatCode('EPSG:4326'), true);
  assert.equal(isLonLatCode('OGC:CRS84'), true);
  assert.equal(isLonLatCode('EPSG:3857'), false);
});

test('lonLatToMercator / mercatorToLonLat round-trip for Contra Costa-ish coordinates', () => {
  const points = [
    [-122.0, 37.9],
    [0, 0],
    [179.9, 60],
    [-179.9, -60],
    [172.1, -17.8], // Fiji-ish
  ];
  for (const [lon, lat] of points) {
    const merc = lonLatToMercator([lon, lat]);
    const back = mercatorToLonLat(merc);
    assert.ok(approxEqual(back[0], lon, 1e-6), `lon round-trip for ${lon},${lat}: got ${back[0]}`);
    assert.ok(approxEqual(back[1], lat, 1e-6), `lat round-trip for ${lon},${lat}: got ${back[1]}`);
  }
});

test('lonLatToMercator matches the known EPSG:3857 value at the origin', () => {
  const [x, y] = lonLatToMercator([0, 0]);
  assert.ok(approxEqual(x, 0));
  assert.ok(approxEqual(y, 0));
});

test('lonLatToMercator matches a known reference point (approximately)', () => {
  // Well-known reference: 45 deg longitude -> x = R * pi/4
  const [x] = lonLatToMercator([45, 0]);
  assert.ok(approxEqual(x, 5009377.085697, 1));
});

test('projectPoint / unprojectPoint round-trip through EPSG:3857 by code', () => {
  const lonLat = [-121.9, 37.9];
  const projected = projectPoint(lonLat, 'EPSG:3857');
  const back = unprojectPoint(projected, 'EPSG:3857');
  assert.ok(approxEqual(back[0], lonLat[0]));
  assert.ok(approxEqual(back[1], lonLat[1]));
});

test('projectPoint is the identity for EPSG:4326 / OGC:CRS84', () => {
  assert.deepEqual(projectPoint([1, 2], 'EPSG:4326'), [1, 2]);
  assert.deepEqual(projectPoint([1, 2], 'OGC:CRS84'), [1, 2]);
});

test('projectPoint throws a clear error for an unsupported projection with no injected transform', () => {
  assert.throws(() => projectPoint([0, 0], 'EPSG:2193'), /EPSG:2193/);
});

test('projectPoint defers to an injected transform for a non-3857/4326 code', () => {
  let called = null;
  const transform = (coord, from, to) => {
    called = { coord, from, to };
    return [coord[0] * 2, coord[1] * 2];
  };
  const result = projectPoint([1, 2], 'EPSG:2193', { transform });
  assert.deepEqual(result, [2, 4]);
  assert.deepEqual(called, { coord: [1, 2], from: 'EPSG:4326', to: 'EPSG:2193' });
});

test('projectExtent / unprojectExtent round-trip a BBox through EPSG:3857', () => {
  const bbox = [-122.4267, 37.7177, -121.5347, 38.0994]; // Contra Costa
  const extent = projectExtent(bbox, 'EPSG:3857');
  const back = unprojectExtent(extent, 'EPSG:3857');
  for (let i = 0; i < 4; i++) assert.ok(approxEqual(back[i], bbox[i], 1e-6));
});

test('projectGeometry reprojects every coordinate of a Polygon into EPSG:3857', () => {
  const ring = [[-122.4, 37.9], [-122.3, 37.9], [-122.3, 38.0], [-122.4, 38.0], [-122.4, 37.9]];
  const polygon = { type: 'Polygon', coordinates: [ring] };
  const projected = projectGeometry(polygon, 'EPSG:3857');
  assert.equal(projected.type, 'Polygon');
  assert.equal(projected.coordinates[0].length, ring.length);
  // Spot-check one vertex against the point-level function.
  assert.deepEqual(projected.coordinates[0][0], lonLatToMercator(ring[0]));
});

test('projectGeometry handles MultiPolygon and is the identity for EPSG:4326', () => {
  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      [[[10, 10], [11, 10], [11, 11], [10, 10]]],
    ],
  };
  const identity = projectGeometry(multi, 'EPSG:4326');
  assert.deepEqual(identity, multi);
  const projected = projectGeometry(multi, 'EPSG:3857');
  assert.equal(projected.coordinates.length, 2);
  assert.notDeepEqual(projected.coordinates[0][0][0], multi.coordinates[0][0][0]);
});
