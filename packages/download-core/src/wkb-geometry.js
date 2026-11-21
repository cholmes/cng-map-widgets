// @cngeo/download-core -- WKB geometry decode, extended for Point/MultiPoint
// beyond what @cngeo/spec's `wkbToGeoJson` supports.
//
// @cngeo/spec's decoder is deliberately Polygon(3)/MultiPolygon(6) only (see
// packages/spec/src/wkb.js's module doc: "all CGAZ [geoBoundaries]
// publishes"). NASA FIRMS -- this package's E6 real-dataset stress test --
// is a *point* dataset: every row's `geometry` column is a WKB Point (type
// 1). Both `wkbToGeoJson` (throws "unsupported geometry type 1") and
// `bboxOfGeometry` (reads `geometry.coordinates` as polygon rings; a Point's
// `coordinates` is `[x, y]`, so it throws trying to iterate a number) break
// on every single row, in three places this package calls them: the
// row-level bbox/intersects fallback when a dataset has no bbox covering
// (engine-hyparquet.js -- FIRMS has no covering column at all, so this path
// always runs), and both bundled format writers (geojson.js, geoparquet.js).
// Not an edge case: a hard, whole-dataset blocker, found running this
// package's own E6 stress test against the live FIRMS catalog.
//
// Scope note: extending WKB geometry-type coverage is correctly
// @cngeo/spec's job -- everything else in this system gets its WKB/bbox math
// from there, and a real fix belongs in packages/spec/src/wkb.js +
// bbox.js. This file is a decorator that stays entirely inside
// packages/download-core (this task's scope boundary): it decodes the WKB
// type byte itself, handles Point/MultiPoint locally, and delegates
// everything else unchanged to @cngeo/spec. A follow-up should fold
// Point/MultiPoint support into @cngeo/spec directly and delete this file.

import { wkbToGeoJson, bboxOfGeometry } from '@cngeo/spec';

const WKB_TYPE_POINT = 1;
const WKB_TYPE_MULTIPOINT = 4;

/**
 * True when `v` is already a decoded GeoJSON geometry object rather than
 * raw WKB bytes.
 *
 * Why this check exists at all: `parquet-io.js`'s `openParquetFile` passes
 * `geoparquet: false` to hyparquet specifically to suppress ITS auto-decode
 * of a column carrying the *older* GeoParquet convention (a plain
 * BYTE_ARRAY column plus a `geo` key-value-metadata JSON sidecar) -- see
 * that module's doc comment. But FIRMS and s2-stac-geoparquet (this
 * package's E6 real-dataset stress test subjects) are "GeoParquet 2.0":
 * written with the *native* Parquet `GEOMETRY` logical type, a different,
 * newer mechanism. hyparquet auto-decodes a native-logical-type column
 * unconditionally via its own (complete -- Point through
 * GeometryCollection) WKB reader, independent of the `geoparquet` convert
 * flag, which only ever governed the sidecar-metadata heuristic. The
 * result: `row[geometryColumn]` for such a dataset is already a GeoJSON
 * object by the time it reaches this package, not the raw bytes every
 * caller here (and `@cngeo/spec`'s decoders) was written assuming. Found
 * running this package's own E6 stress test against the real FIRMS
 * catalog: without this check, every row crashed trying to read WKB type
 * bytes out of a `{ type: 'Point', coordinates: […] }` object coerced
 * through `new Uint8Array(object)`, which silently produces a zero-length
 * buffer rather than throwing something legible.
 * @param {unknown} v
 */
function isDecodedGeometry(v) {
  return typeof v === 'object' && v !== null && typeof /** @type {any} */ (v).type === 'string' && 'coordinates' in v;
}

/** @param {Uint8Array|ArrayBuffer} buf */
function toView(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Peek a WKB buffer's geometry type code without fully decoding it. @param {DataView} view */
function peekWkbType(view) {
  const littleEndian = view.getUint8(0) === 1;
  return view.getUint32(1, littleEndian);
}

/**
 * Decode any WKB geometry this project needs to handle: Point and
 * MultiPoint locally (see module doc for why they're not in @cngeo/spec),
 * everything else via @cngeo/spec's `wkbToGeoJson`.
 * @param {Uint8Array|ArrayBuffer} buf
 * @returns {GeoJSON.Point|GeoJSON.MultiPoint|GeoJSON.Polygon|GeoJSON.MultiPolygon}
 */
export function decodeWkbGeometry(buf) {
  if (isDecodedGeometry(buf)) return /** @type {any} */ (buf); // see isDecodedGeometry's doc comment
  const view = toView(buf);
  const type = peekWkbType(view);
  if (type !== WKB_TYPE_POINT && type !== WKB_TYPE_MULTIPOINT) return wkbToGeoJson(buf);

  const littleEndian = view.getUint8(0) === 1;

  if (type === WKB_TYPE_POINT) {
    const x = view.getFloat64(5, littleEndian);
    const y = view.getFloat64(13, littleEndian);
    return { type: 'Point', coordinates: [x, y] };
  }

  // MultiPoint: a count, then each point is itself a full nested WKB
  // geometry (byte order + type + x + y) -- the same "each element re-states
  // its own header" shape @cngeo/spec's MultiPolygon reader already relies
  // on for its inner Polygons.
  const numPoints = view.getUint32(5, littleEndian);
  let offset = 9;
  const coordinates = new Array(numPoints);
  for (let i = 0; i < numPoints; i++) {
    const innerLE = view.getUint8(offset) === 1;
    offset += 1 + 4; // inner byte-order + inner type (assumed Point; not re-validated)
    coordinates[i] = [view.getFloat64(offset, innerLE), view.getFloat64(offset + 8, innerLE)];
    offset += 16;
  }
  return { type: 'MultiPoint', coordinates };
}

/**
 * bbox of any geometry this project needs to handle: Point/MultiPoint
 * locally, everything else via @cngeo/spec's `bboxOfGeometry`.
 * @param {GeoJSON.Point|GeoJSON.MultiPoint|GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @returns {[number, number, number, number]}
 */
export function bboxOfAnyGeometry(geometry) {
  if (geometry.type === 'Point') {
    const [x, y] = geometry.coordinates;
    return [x, y, x, y];
  }
  if (geometry.type === 'MultiPoint') {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const [x, y] of geometry.coordinates) {
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
    }
    return [west, south, east, north];
  }
  return bboxOfGeometry(geometry);
}
