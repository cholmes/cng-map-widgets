// @cnmw/format-extras -- shared geometry helpers for the CSV/EsriJSON
// writers in this package: WKB -> GeoJSON decode (the same six 2D types
// every other format plugin in this project handles -- see
// @cnmw/format-gpkg/src/wkb.js's module doc for why this is duplicated
// per plugin package rather than shared), GeoJSON -> WKT text, and the
// Esri ring-winding convention (identical to Shapefile's: outer rings
// clockwise, holes counter-clockwise -- @cnmw/format-shapefile/src/shp.js
// has the same logic for that package).

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
  if (!name) throw new Error(`@cnmw/format-extras: unsupported WKB geometry type ${type}`);
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

export function isDecodedGeometry(v) {
  return typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && typeof v.type === 'string' && 'coordinates' in v;
}

/** @param {unknown} raw @returns {GeoJSON.Geometry|null} */
export function toGeoJsonGeometry(raw) {
  if (raw == null) return null;
  return isDecodedGeometry(raw) ? raw : wkbToGeoJson(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
}

function ring(coords) {
  return coords.map(([x, y]) => `${x} ${y}`).join(', ');
}
function rings(coordsList) {
  return coordsList.map((r) => `(${ring(r)})`).join(', ');
}

/** @param {GeoJSON.Geometry} geometry @returns {string} WKT text */
export function geometryToWkt(geometry) {
  switch (geometry.type) {
    case 'Point':
      return `POINT (${geometry.coordinates[0]} ${geometry.coordinates[1]})`;
    case 'MultiPoint':
      return `MULTIPOINT (${geometry.coordinates.map(([x, y]) => `(${x} ${y})`).join(', ')})`;
    case 'LineString':
      return `LINESTRING (${ring(geometry.coordinates)})`;
    case 'MultiLineString':
      return `MULTILINESTRING (${geometry.coordinates.map((l) => `(${ring(l)})`).join(', ')})`;
    case 'Polygon':
      return `POLYGON (${rings(geometry.coordinates)})`;
    case 'MultiPolygon':
      return `MULTIPOLYGON (${geometry.coordinates.map((p) => `(${rings(p)})`).join(', ')})`;
    default:
      throw new Error(`@cnmw/format-extras: unsupported geometry type "${geometry.type}" for WKT`);
  }
}

/** Shoelace signed area; positive = counter-clockwise (standard, y-up). */
function signedArea(r) {
  let sum = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const [x0, y0] = r[i];
    const [x1, y1] = r[i + 1];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/**
 * Esri's `rings` winding convention is the same as Shapefile's: outer
 * rings clockwise, holes counter-clockwise (the mirror of GeoJSON's RFC
 * 7946 convention). Corrects by signed area rather than assuming the
 * input already follows it.
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @returns {number[][][]}
 */
export function esriRingsOf(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const out = [];
  for (const polyRings of polygons) {
    polyRings.forEach((r, i) => {
      const isOuter = i === 0;
      const isCCW = signedArea(r) > 0;
      const wantsReversal = isOuter ? isCCW : !isCCW;
      out.push(wantsReversal ? [...r].reverse() : r);
    });
  }
  return out;
}
