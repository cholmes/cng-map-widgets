import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wkbToGeoJson } from '../src/wkb.js';

/** Build little-endian WKB for a simple Polygon with one ring. */
function wkbPolygon(ring) {
  const numPoints = ring.length;
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + numPoints * 16);
  const view = new DataView(buf);
  let o = 0;
  view.setUint8(o, 1); o += 1; // little-endian
  view.setUint32(o, 3, true); o += 4; // Polygon
  view.setUint32(o, 1, true); o += 4; // 1 ring
  view.setUint32(o, numPoints, true); o += 4;
  for (const [x, y] of ring) {
    view.setFloat64(o, x, true); o += 8;
    view.setFloat64(o, y, true); o += 8;
  }
  return new Uint8Array(buf);
}

/** Build little-endian WKB for a MultiPolygon with the given list of single-ring polygons. */
function wkbMultiPolygon(polys) {
  const polyBufs = polys.map((ring) => {
    const numPoints = ring.length;
    const buf = new ArrayBuffer(1 + 4 + 4 + 4 + numPoints * 16);
    const view = new DataView(buf);
    let o = 0;
    view.setUint8(o, 1); o += 1;
    view.setUint32(o, 3, true); o += 4;
    view.setUint32(o, 1, true); o += 4;
    view.setUint32(o, numPoints, true); o += 4;
    for (const [x, y] of ring) {
      view.setFloat64(o, x, true); o += 8;
      view.setFloat64(o, y, true); o += 8;
    }
    return new Uint8Array(buf);
  });
  const header = new ArrayBuffer(1 + 4 + 4);
  const hv = new DataView(header);
  hv.setUint8(0, 1);
  hv.setUint32(1, 6, true); // MultiPolygon
  hv.setUint32(5, polys.length, true);
  const total = 9 + polyBufs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  out.set(new Uint8Array(header), 0);
  let offset = 9;
  for (const pb of polyBufs) {
    out.set(pb, offset);
    offset += pb.length;
  }
  return out;
}

const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

test('wkbToGeoJson decodes a Polygon', () => {
  const geo = wkbToGeoJson(wkbPolygon(square));
  assert.equal(geo.type, 'Polygon');
  assert.deepEqual(geo.coordinates, [square]);
});

test('wkbToGeoJson decodes a MultiPolygon', () => {
  const other = [[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]];
  const geo = wkbToGeoJson(wkbMultiPolygon([square, other]));
  assert.equal(geo.type, 'MultiPolygon');
  assert.deepEqual(geo.coordinates, [[square], [other]]);
});

test('wkbToGeoJson throws on an unsupported geometry type (Point = 1)', () => {
  const buf = new ArrayBuffer(21);
  const view = new DataView(buf);
  view.setUint8(0, 1);
  view.setUint32(1, 1, true); // Point
  view.setFloat64(5, 1.0, true);
  view.setFloat64(13, 2.0, true);
  assert.throws(() => wkbToGeoJson(new Uint8Array(buf)), /unsupported geometry type 1/);
});

test('wkbToGeoJson handles big-endian byte order', () => {
  const ring = square;
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + ring.length * 16);
  const view = new DataView(buf);
  let o = 0;
  view.setUint8(o, 0); o += 1; // big-endian
  view.setUint32(o, 3, false); o += 4;
  view.setUint32(o, 1, false); o += 4;
  view.setUint32(o, ring.length, false); o += 4;
  for (const [x, y] of ring) {
    view.setFloat64(o, x, false); o += 8;
    view.setFloat64(o, y, false); o += 8;
  }
  const geo = wkbToGeoJson(new Uint8Array(buf));
  assert.deepEqual(geo.coordinates, [ring]);
});
