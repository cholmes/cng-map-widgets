// @cnmw/openlayers -- the projection bridge (design doc §5.1 item 5).
//
// Core (@cnmw/spec) is EPSG:4326-only. MapLibre's GeoJSON sources are
// 4326-native, so @cnmw/maplibre needs no bridge at all. OpenLayers maps
// are frequently EPSG:3857 (or something exotic), so this module is the
// one real asymmetry between the two adapters: it reprojects on the way
// *in* (an Area's 4326 geometry -> the view's projection, for rendering)
// and *out* (the view's extent -> a 4326 bbox, for the ranking viewport
// boost and for fitBounds math).
//
// Deliberately pure and dependency-free for the EPSG:3857 fast path --
// no `ol` import here -- so the single most common case ("OL maps are
// often EPSG:3857", design doc §5.1) is unit-testable in plain Node
// without installing the `ol` peer dependency, and so this is the exact
// code path exercised at runtime for that case (not a parallel
// implementation that only the tests see). For any other projection
// code, callers inject an OL `transform`/`transformExtent`-shaped
// function (see ol-proj-bridge.js), which is the generic escape hatch
// for "something exotic".

const MERCATOR_RADIUS = 6378137;
const MAX_MERCATOR_LAT = 85.06; // OL/Google/MapLibre's standard Web Mercator clamp

/** @typedef {import('@cnmw/spec').BBox} BBox */
/** @typedef {GeoJSON.Polygon|GeoJSON.MultiPolygon} AreaGeometry */

/** True for every code string that names Web/Spherical Mercator. */
export function isMercatorCode(code) {
  return code === 'EPSG:3857' || code === 'EPSG:900913' || code === 'EPSG:102100' || code === 'EPSG:102113';
}

/** True for every code string that names plain lon/lat (RFC 7946 default). */
export function isLonLatCode(code) {
  return code === 'EPSG:4326' || code === 'OGC:CRS84' || code === 'CRS:84';
}

/**
 * [lon, lat] (degrees) -> [x, y] (meters) in EPSG:3857. Closed-form, the
 * standard Web Mercator formula every map library implements identically.
 * @param {[number, number]} lonLat
 * @returns {[number, number]}
 */
export function lonLatToMercator([lon, lat]) {
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const x = (lon * Math.PI * MERCATOR_RADIUS) / 180;
  const y = MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360));
  return [x, y];
}

/**
 * [x, y] (meters) in EPSG:3857 -> [lon, lat] (degrees). Exact inverse of
 * {@link lonLatToMercator}.
 * @param {[number, number]} xy
 * @returns {[number, number]}
 */
export function mercatorToLonLat([x, y]) {
  const lon = (x * 180) / (Math.PI * MERCATOR_RADIUS);
  const lat = ((2 * Math.atan(Math.exp(y / MERCATOR_RADIUS)) - Math.PI / 2) * 180) / Math.PI;
  return [lon, lat];
}

/**
 * Project one [lon, lat] point from EPSG:4326 into `toCode`.
 * @param {[number, number]} lonLat
 * @param {string} toCode
 * @param {{ transform?: (coord: [number, number], from: string, to: string) => [number, number] }} [opts]
 * @returns {[number, number]}
 */
export function projectPoint(lonLat, toCode, opts = {}) {
  if (isLonLatCode(toCode)) return [lonLat[0], lonLat[1]];
  if (isMercatorCode(toCode)) return lonLatToMercator(lonLat);
  if (opts.transform) return opts.transform(lonLat, 'EPSG:4326', toCode);
  throw new Error(
    `@cnmw/openlayers: projection "${toCode}" is not EPSG:4326 or EPSG:3857, and no transform() was supplied. ` +
      'Pass the view\'s projection via ol-proj-bridge, or register it with ol/proj before use.',
  );
}

/**
 * Inverse of {@link projectPoint}: a point in `fromCode` -> [lon, lat] in
 * EPSG:4326.
 * @param {[number, number]} coord
 * @param {string} fromCode
 * @param {{ transform?: (coord: [number, number], from: string, to: string) => [number, number] }} [opts]
 * @returns {[number, number]}
 */
export function unprojectPoint(coord, fromCode, opts = {}) {
  if (isLonLatCode(fromCode)) return [coord[0], coord[1]];
  if (isMercatorCode(fromCode)) return mercatorToLonLat(coord);
  if (opts.transform) return opts.transform(coord, fromCode, 'EPSG:4326');
  throw new Error(
    `@cnmw/openlayers: projection "${fromCode}" is not EPSG:4326 or EPSG:3857, and no transform() was supplied.`,
  );
}

/**
 * Project a normalized `BBox` ([west, south, east, north], EPSG:4326)
 * into `toCode`'s extent form [minX, minY, maxX, maxY]. Corner-projection
 * is correct here because `bboxes[]` entries are always normalized
 * (west <= east) before this is called -- antimeridian splitting already
 * happened in `@cnmw/spec` (design doc §1.5).
 * @param {BBox} bbox
 * @param {string} toCode
 * @param {{ transform?: (coord: [number, number], from: string, to: string) => [number, number] }} [opts]
 * @returns {[number, number, number, number]}
 */
export function projectExtent(bbox, toCode, opts = {}) {
  const [x0, y0] = projectPoint([bbox[0], bbox[1]], toCode, opts);
  const [x1, y1] = projectPoint([bbox[2], bbox[3]], toCode, opts);
  return [x0, y0, x1, y1];
}

/**
 * Inverse of {@link projectExtent}: a map-projection extent -> a 4326
 * `BBox`.
 * @param {[number, number, number, number]} extent
 * @param {string} fromCode
 * @param {{ transform?: (coord: [number, number], from: string, to: string) => [number, number] }} [opts]
 * @returns {BBox}
 */
export function unprojectExtent(extent, fromCode, opts = {}) {
  const [w, s] = unprojectPoint([extent[0], extent[1]], fromCode, opts);
  const [e, n] = unprojectPoint([extent[2], extent[3]], fromCode, opts);
  return [w, s, e, n];
}

/**
 * Deep-reproject an Area's display/filter geometry (always Polygon or
 * MultiPolygon, always EPSG:4326 coming in) into the view's projection,
 * for handing to an OL `Feature`/`GeoJSON` reader as already-projected
 * coordinates.
 * @param {AreaGeometry} geometry
 * @param {string} toCode
 * @param {{ transform?: (coord: [number, number], from: string, to: string) => [number, number] }} [opts]
 * @returns {AreaGeometry}
 */
export function projectGeometry(geometry, toCode, opts = {}) {
  if (isLonLatCode(toCode)) return geometry;
  const projectRing = (ring) => ring.map((pt) => projectPoint(pt, toCode, opts));
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map(projectRing) };
  }
  return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((poly) => poly.map(projectRing)) };
}
