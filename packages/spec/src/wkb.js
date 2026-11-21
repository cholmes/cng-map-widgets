// @cngeo/spec -- WKB -> GeoJSON decoder.
//
// Deliberately minimal: handles Polygon (type 3) and MultiPolygon (type 6)
// only, which is all CGAZ (geoBoundaries) publishes, per the task scope.
// No Z/M, no SRID (EWKB) support -- CGAZ geometry is plain 2D ISO WKB.
// Throws on anything else rather than guessing.

import { yieldToMain } from './yield.js';

const WKB_TYPE_POLYGON = 3;
const WKB_TYPE_MULTIPOLYGON = 6;

/**
 * Decode a WKB buffer into a GeoJSON Polygon or MultiPolygon.
 * @param {Uint8Array|ArrayBuffer} buf
 * @returns {GeoJSON.Polygon|GeoJSON.MultiPolygon}
 */
export function wkbToGeoJson(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cursor = { offset: 0 };
  return readGeometry(view, cursor);
}

/** @param {DataView} view @param {{offset: number}} cursor */
function readGeometry(view, cursor) {
  const byteOrder = view.getUint8(cursor.offset);
  cursor.offset += 1;
  const littleEndian = byteOrder === 1;
  const type = view.getUint32(cursor.offset, littleEndian);
  cursor.offset += 4;

  if (type === WKB_TYPE_POLYGON) {
    return { type: 'Polygon', coordinates: readPolygonRings(view, cursor, littleEndian) };
  }
  if (type === WKB_TYPE_MULTIPOLYGON) {
    const numPolygons = view.getUint32(cursor.offset, littleEndian);
    cursor.offset += 4;
    const polygons = [];
    for (let i = 0; i < numPolygons; i++) {
      // Each polygon in a MultiPolygon is itself a full WKB geometry
      // (byte order + type + rings).
      const innerByteOrder = view.getUint8(cursor.offset);
      cursor.offset += 1;
      const innerLE = innerByteOrder === 1;
      const innerType = view.getUint32(cursor.offset, innerLE);
      cursor.offset += 4;
      if (innerType !== WKB_TYPE_POLYGON) {
        throw new Error(`wkbToGeoJson: expected Polygon (3) inside MultiPolygon, got type ${innerType}`);
      }
      polygons.push(readPolygonRings(view, cursor, innerLE));
    }
    return { type: 'MultiPolygon', coordinates: polygons };
  }
  throw new Error(`wkbToGeoJson: unsupported geometry type ${type} (only Polygon=3, MultiPolygon=6 supported)`);
}

/**
 * @param {DataView} view @param {{offset: number}} cursor @param {boolean} littleEndian
 * @returns {number[][][]}
 */
function readPolygonRings(view, cursor, littleEndian) {
  const numRings = view.getUint32(cursor.offset, littleEndian);
  cursor.offset += 4;
  const rings = [];
  for (let r = 0; r < numRings; r++) {
    const numPoints = view.getUint32(cursor.offset, littleEndian);
    cursor.offset += 4;
    const ring = new Array(numPoints);
    for (let p = 0; p < numPoints; p++) {
      const x = view.getFloat64(cursor.offset, littleEndian);
      cursor.offset += 8;
      const y = view.getFloat64(cursor.offset, littleEndian);
      cursor.offset += 8;
      ring[p] = [x, y];
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Chunked/yielding equivalent of `wkbToGeoJson`, for the geocoder-core
 * background-upgrade path (design doc §1): decodes a raw full-resolution
 * boundary's WKB without blocking the main thread for the whole decode.
 * In practice decode itself is cheap even for the largest CGAZ ADM0
 * geometry (tens of milliseconds for Canada's ~528K vertices) -- the
 * simplification step is what needed the algorithmic fix in
 * `simplify-async.js` -- but this still yields between sub-polygons and
 * within very large single rings as defensive insurance for whatever the
 * next order-of-magnitude-larger boundary source turns out to be.
 * @param {Uint8Array|ArrayBuffer} buf
 * @param {{ chunkPoints?: number, chunkPolygons?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<GeoJSON.Polygon|GeoJSON.MultiPolygon>}
 */
export async function wkbToGeoJsonAsync(buf, opts = {}) {
  const chunkPoints = opts.chunkPoints ?? 50_000;
  const chunkPolygons = opts.chunkPolygons ?? 20;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cursor = { offset: 0 };
  return readGeometryAsync(view, cursor, { chunkPoints, chunkPolygons, signal: opts.signal });
}

async function readGeometryAsync(view, cursor, opts) {
  const byteOrder = view.getUint8(cursor.offset);
  cursor.offset += 1;
  const littleEndian = byteOrder === 1;
  const type = view.getUint32(cursor.offset, littleEndian);
  cursor.offset += 4;

  if (type === WKB_TYPE_POLYGON) {
    return { type: 'Polygon', coordinates: await readPolygonRingsAsync(view, cursor, littleEndian, opts) };
  }
  if (type === WKB_TYPE_MULTIPOLYGON) {
    const numPolygons = view.getUint32(cursor.offset, littleEndian);
    cursor.offset += 4;
    const polygons = [];
    for (let i = 0; i < numPolygons; i++) {
      const innerByteOrder = view.getUint8(cursor.offset);
      cursor.offset += 1;
      const innerLE = innerByteOrder === 1;
      const innerType = view.getUint32(cursor.offset, innerLE);
      cursor.offset += 4;
      if (innerType !== WKB_TYPE_POLYGON) {
        throw new Error(`wkbToGeoJsonAsync: expected Polygon (3) inside MultiPolygon, got type ${innerType}`);
      }
      polygons.push(await readPolygonRingsAsync(view, cursor, innerLE, opts));
      if ((i + 1) % opts.chunkPolygons === 0) {
        opts.signal?.throwIfAborted();
        await yieldToMain();
      }
    }
    return { type: 'MultiPolygon', coordinates: polygons };
  }
  throw new Error(`wkbToGeoJsonAsync: unsupported geometry type ${type} (only Polygon=3, MultiPolygon=6 supported)`);
}

async function readPolygonRingsAsync(view, cursor, littleEndian, opts) {
  const numRings = view.getUint32(cursor.offset, littleEndian);
  cursor.offset += 4;
  const rings = [];
  for (let r = 0; r < numRings; r++) {
    const numPoints = view.getUint32(cursor.offset, littleEndian);
    cursor.offset += 4;
    const ring = new Array(numPoints);
    for (let p = 0; p < numPoints; p++) {
      const x = view.getFloat64(cursor.offset, littleEndian);
      cursor.offset += 8;
      const y = view.getFloat64(cursor.offset, littleEndian);
      cursor.offset += 8;
      ring[p] = [x, y];
      if ((p + 1) % opts.chunkPoints === 0) {
        opts.signal?.throwIfAborted();
        await yieldToMain();
      }
    }
    rings.push(ring);
  }
  return rings;
}
