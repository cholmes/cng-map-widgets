// @cngeo/format-flatgeobuf -- minimal WKB -> GeoJSON decoder, 2D, the same
// six types `@cngeo/format-gpkg/src/wkb.js` and
// `@cngeo/format-shapefile/src/wkb-decode.js` handle. Duplicated rather
// than shared across these independent plugin packages -- see either of
// those files' module doc for why.

const TYPE_NAME = { 1: 'Point', 2: 'LineString', 3: 'Polygon', 4: 'MultiPoint', 5: 'MultiLineString', 6: 'MultiPolygon' };

function readPoint(view, c, le) {
  const x = view.getFloat64(c.offset, le); c.offset += 8;
  const y = view.getFloat64(c.offset, le); c.offset += 8;
  return [x, y];
}
function readLine(view, c, le) {
  const n = view.getUint32(c.offset, le); c.offset += 4;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = readPoint(view, c, le);
  return pts;
}
function readRings(view, c, le) {
  const n = view.getUint32(c.offset, le); c.offset += 4;
  const rings = new Array(n);
  for (let i = 0; i < n; i++) rings[i] = readLine(view, c, le);
  return rings;
}

/** @param {Uint8Array} bytes @returns {GeoJSON.Geometry} */
export function wkbToGeoJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const c = { offset: 0 };
  const le = view.getUint8(c.offset) === 1; c.offset += 1;
  const type = view.getUint32(c.offset, le); c.offset += 4;
  const name = TYPE_NAME[type];
  if (!name) throw new Error(`@cngeo/format-flatgeobuf: unsupported WKB geometry type ${type}`);

  if (name === 'Point') return { type: 'Point', coordinates: readPoint(view, c, le) };
  if (name === 'LineString') return { type: 'LineString', coordinates: readLine(view, c, le) };
  if (name === 'Polygon') return { type: 'Polygon', coordinates: readRings(view, c, le) };

  const n = view.getUint32(c.offset, le); c.offset += 4;
  if (name === 'MultiPoint') {
    const pts = new Array(n);
    for (let i = 0; i < n; i++) { c.offset += 5; pts[i] = readPoint(view, c, le); }
    return { type: 'MultiPoint', coordinates: pts };
  }
  if (name === 'MultiLineString') {
    const lines = new Array(n);
    for (let i = 0; i < n; i++) { c.offset += 5; lines[i] = readLine(view, c, le); }
    return { type: 'MultiLineString', coordinates: lines };
  }
  const polys = new Array(n);
  for (let i = 0; i < n; i++) { c.offset += 5; polys[i] = readRings(view, c, le); }
  return { type: 'MultiPolygon', coordinates: polys };
}

/** True when `v` looks like an already-decoded GeoJSON geometry rather than raw WKB bytes. */
export function isDecodedGeometry(v) {
  return typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && typeof v.type === 'string' && 'coordinates' in v;
}
