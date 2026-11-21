// @cngeo/format-gpkg -- GeoJSON <-> WKB, and the GeoPackage binary geometry
// header (OGC GeoPackage spec, clause "GeoPackage Binary Header"). No
// dependency: hyparquet-writer (which download-core's own geoparquet
// plugin uses for the same job) is a CDN-loaded, parquet-specific
// dependency this package has no other reason to pull in, and the encode
// itself is ~80 lines of DataView arithmetic. Handles the six geometry
// types a `FeatureBatch.geometry` entry can realistically be, 2D only (no
// Z/M) -- every source this project reads (CGAZ, FTW, FIRMS) is 2D.

const WKB_TYPE = {
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
};

/** @param {GeoJSON.Geometry} geometry @returns {number} byte length of the standard WKB encoding */
function wkbByteLength(geometry) {
  switch (geometry.type) {
    case 'Point':
      return 1 + 4 + 16;
    case 'MultiPoint':
      // Each point is itself a full nested WKB geometry (byte order+type+xy).
      return 1 + 4 + 4 + geometry.coordinates.length * (1 + 4 + 16);
    case 'LineString':
      return 1 + 4 + 4 + geometry.coordinates.length * 16;
    case 'MultiLineString':
      // Each component LineString is itself a full nested WKB geometry
      // (byte order + type + points), same pattern as MultiPoint/MultiPolygon.
      return 1 + 4 + 4 + geometry.coordinates.reduce((sum, line) => sum + 1 + 4 + 4 + line.length * 16, 0);
    case 'Polygon':
      return 1 + 4 + ringsByteLength(geometry.coordinates);
    case 'MultiPolygon':
      return 1 + 4 + 4 + geometry.coordinates.reduce((sum, poly) => sum + 1 + 4 + ringsByteLength(poly), 0);
    default:
      throw new Error(`@cngeo/format-gpkg: unsupported geometry type "${geometry.type}" (supports Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon)`);
  }
}

function ringsByteLength(rings) {
  let n = 4; // numRings
  for (const ring of rings) n += 4 + ring.length * 16;
  return n;
}

/**
 * Encode a GeoJSON geometry to standard (ISO) WKB, little-endian, 2D.
 * @param {GeoJSON.Geometry} geometry
 * @returns {Uint8Array}
 */
export function geojsonToWkb(geometry) {
  const buf = new Uint8Array(wkbByteLength(geometry));
  const view = new DataView(buf.buffer);
  writeGeometry(view, { offset: 0 }, geometry);
  return buf;
}

/** @param {DataView} view @param {{offset: number}} c @param {GeoJSON.Geometry} geometry */
function writeGeometry(view, c, geometry) {
  view.setUint8(c.offset, 1); // byte order: little-endian
  c.offset += 1;
  view.setUint32(c.offset, WKB_TYPE[geometry.type], true);
  c.offset += 4;
  switch (geometry.type) {
    case 'Point':
      writePoint(view, c, geometry.coordinates);
      return;
    case 'LineString':
      writeLine(view, c, geometry.coordinates);
      return;
    case 'Polygon':
      writeRings(view, c, geometry.coordinates);
      return;
    case 'MultiPoint':
      view.setUint32(c.offset, geometry.coordinates.length, true);
      c.offset += 4;
      for (const pt of geometry.coordinates) {
        view.setUint8(c.offset, 1);
        c.offset += 1;
        view.setUint32(c.offset, WKB_TYPE.Point, true);
        c.offset += 4;
        writePoint(view, c, pt);
      }
      return;
    case 'MultiLineString':
      view.setUint32(c.offset, geometry.coordinates.length, true);
      c.offset += 4;
      for (const line of geometry.coordinates) {
        view.setUint8(c.offset, 1);
        c.offset += 1;
        view.setUint32(c.offset, WKB_TYPE.LineString, true);
        c.offset += 4;
        writeLine(view, c, line);
      }
      return;
    case 'MultiPolygon':
      view.setUint32(c.offset, geometry.coordinates.length, true);
      c.offset += 4;
      for (const poly of geometry.coordinates) {
        view.setUint8(c.offset, 1);
        c.offset += 1;
        view.setUint32(c.offset, WKB_TYPE.Polygon, true);
        c.offset += 4;
        writeRings(view, c, poly);
      }
      return;
    default:
      throw new Error(`@cngeo/format-gpkg: unsupported geometry type "${geometry.type}"`);
  }
}

function writePoint(view, c, [x, y]) {
  view.setFloat64(c.offset, x, true);
  c.offset += 8;
  view.setFloat64(c.offset, y, true);
  c.offset += 8;
}

function writeLine(view, c, points) {
  view.setUint32(c.offset, points.length, true);
  c.offset += 4;
  for (const pt of points) writePoint(view, c, pt);
}

function writeRings(view, c, rings) {
  view.setUint32(c.offset, rings.length, true);
  c.offset += 4;
  for (const ring of rings) writeLine(view, c, ring);
}

/**
 * Peek a WKB buffer's geometry type code and byte order without fully
 * decoding it -- used to pass through already-WKB-encoded batch geometry
 * (the common case: download-core's engine hands rows WKB bytes straight
 * from the source parquet file) without a decode+re-encode round trip.
 * @param {Uint8Array} bytes
 */
export function peekWkbType(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = view.getUint8(0) === 1;
  return view.getUint32(1, littleEndian);
}

// GeoPackage's gpkg_geometry_columns.geometry_type_name is the spec's
// upper-case standard geometry type name (clause "GeoPackage Geometry
// Type"), not the GeoJSON `type` string -- 'POINT', not 'Point'.
const WKB_TYPE_NAME = Object.fromEntries(Object.entries(WKB_TYPE).map(([name, code]) => [code, name.toUpperCase()]));

/** @param {number} code @returns {string} the GeoPackage-spec upper-case type name, or 'GEOMETRY' for an unknown code */
export function wkbTypeName(code) {
  return WKB_TYPE_NAME[code] ?? 'GEOMETRY';
}

/**
 * True when `v` is already a decoded GeoJSON geometry object rather than
 * raw WKB bytes -- the same ambiguity download-core's own
 * `wkb-geometry.js` documents (a GeoParquet-2.0 source hands back decoded
 * objects for its native-GEOMETRY-logical-type column). This package has
 * no dependency on download-core, so it re-checks the same shape locally.
 * @param {unknown} v
 */
export function isDecodedGeometry(v) {
  return typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && typeof /** @type {any} */ (v).type === 'string' && 'coordinates' in v;
}

/**
 * [xmin, ymin, xmax, ymax] of any supported GeoJSON geometry, flat over
 * all its coordinate arrays regardless of nesting depth.
 * @param {GeoJSON.Geometry} geometry
 */
export function bboxOf(geometry) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  (function walk(coords) {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
      return;
    }
    for (const c of coords) walk(c);
  })(geometry.coordinates);
  return [xmin, ymin, xmax, ymax];
}

/**
 * Minimal WKB -> flat [x,y] point list, used only to compute a bbox for
 * `gpkg_contents` when a row arrives as raw WKB bytes (the common case)
 * rather than already-decoded GeoJSON. Handles the same six 2D types
 * `geojsonToWkb` writes; does not reconstruct ring/part structure because
 * a bbox only needs every point once, flattened.
 * @param {Uint8Array} bytes
 * @returns {[number, number, number, number]}
 */
export function bboxOfWkb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  function see(x, y) {
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  function readPoint(c, le) {
    const x = view.getFloat64(c.offset, le);
    c.offset += 8;
    const y = view.getFloat64(c.offset, le);
    c.offset += 8;
    see(x, y);
  }
  function readLine(c, le) {
    const n = view.getUint32(c.offset, le);
    c.offset += 4;
    for (let i = 0; i < n; i++) readPoint(c, le);
  }
  function readRings(c, le) {
    const n = view.getUint32(c.offset, le);
    c.offset += 4;
    for (let i = 0; i < n; i++) readLine(c, le);
  }
  function readGeom(c) {
    const le = view.getUint8(c.offset) === 1;
    c.offset += 1;
    const type = view.getUint32(c.offset, le);
    c.offset += 4;
    if (type === WKB_TYPE.Point) readPoint(c, le);
    else if (type === WKB_TYPE.LineString) readLine(c, le);
    else if (type === WKB_TYPE.Polygon) readRings(c, le);
    else if (type === WKB_TYPE.MultiPoint) {
      const n = view.getUint32(c.offset, le);
      c.offset += 4;
      for (let i = 0; i < n; i++) {
        c.offset += 5; // nested byte-order + type
        readPoint(c, le);
      }
    } else if (type === WKB_TYPE.MultiLineString) {
      const n = view.getUint32(c.offset, le);
      c.offset += 4;
      for (let i = 0; i < n; i++) {
        c.offset += 5; // nested byte-order + type
        readLine(c, le);
      }
    } else if (type === WKB_TYPE.MultiPolygon) {
      const n = view.getUint32(c.offset, le);
      c.offset += 4;
      for (let i = 0; i < n; i++) {
        c.offset += 5;
        readRings(c, le);
      }
    } else {
      throw new Error(`@cngeo/format-gpkg: bboxOfWkb: unsupported geometry type ${type}`);
    }
  }
  readGeom({ offset: 0 });
  return [xmin, ymin, xmax, ymax];
}

/**
 * Wrap a standard WKB buffer in a GeoPackage Binary Header (OGC GeoPackage
 * spec): magic "GP" + version 0 + flags + srs_id, no envelope (flags'
 * envelope-contents-indicator left at 0 -- valid per spec; see the package
 * README for why this package always omits it: the per-row cost would be
 * 32-64 bytes for a value `ogrinfo -al -so` never needs, since GDAL
 * computes extents from the geometry itself when the header carries none).
 * @param {Uint8Array} wkb @param {number} srsId
 */
export function gpkgGeometryBlob(wkb, srsId) {
  const out = new Uint8Array(8 + wkb.length);
  out[0] = 0x47; // 'G'
  out[1] = 0x50; // 'P'
  out[2] = 0; // version 0
  out[3] = 0x01; // flags: bit0=1 (little-endian header), envelope indicator=0, empty=0
  new DataView(out.buffer).setInt32(4, srsId, true);
  out.set(wkb, 8);
  return out;
}
