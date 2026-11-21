// @cngeo/spec -- bbox math and antimeridian handling (design doc §1.5).
//
// `BBox` is `[west, south, east, north]` in EPSG:4326 degrees. `west > east`
// means the box crosses the antimeridian (the *signed* form, for display).
// `bboxes[]` is the computational form: 1 or 2 boxes, each with
// `west <= east`. Every consumer that does arithmetic uses `bboxes`.

/** @typedef {[number, number, number, number]} BBox */

const ANTIMERIDIAN_BAND_DEG = 20;

/**
 * Compute the signed bbox of a ring of [lon, lat] pairs, without any
 * antimeridian handling -- the naive min/max.
 * @param {number[][]} coords
 * @returns {BBox}
 */
function naiveRingBBox(coords) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

/**
 * Flatten every [lon, lat] vertex out of a Polygon or MultiPolygon.
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @returns {number[][]}
 */
function* iterCoords(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polys) {
    for (const ring of poly) {
      for (const pt of ring) yield pt;
    }
  }
}

/**
 * Compute the naive (unsplit, possibly misleadingly-wide) bbox of a
 * Polygon/MultiPolygon.
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @returns {BBox}
 */
export function bboxOfGeometry(geometry) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of iterCoords(geometry)) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

/**
 * Detect whether a geometry should be treated as antimeridian-crossing, per
 * design doc §1.5 rule 4: the naive bbox spans more than 180° of longitude
 * AND the geometry has no vertex in a +/-20 deg band around longitude 0.
 * Ambiguous cases return false (over-fetch is the "performance bug" we
 * accept over the "correctness bug" of a wrongly-split bbox).
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @returns {boolean}
 */
export function crossesAntimeridian(geometry) {
  const [west, , east] = bboxOfGeometry(geometry);
  if (east - west <= 180) return false;
  for (const [lon] of iterCoords(geometry)) {
    if (Math.abs(lon) <= ANTIMERIDIAN_BAND_DEG) return false;
  }
  return true;
}

/**
 * Split a geometry's bbox into 1 or 2 normalized boxes (each west <= east)
 * that together cover the same extent, per design doc §1.5.
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @returns {{ bbox: BBox, bboxes: BBox[], crossesAntimeridian: boolean }}
 */
export function computeBBoxes(geometry) {
  const naive = bboxOfGeometry(geometry);
  if (!crossesAntimeridian(geometry)) {
    return { bbox: naive, bboxes: [naive], crossesAntimeridian: false };
  }
  // Split: separate vertices into an eastern-hemisphere cluster (lon >= 0)
  // and a western-hemisphere cluster (lon < 0); the true extent runs from
  // the eastern cluster's min lon, across 180, to the western cluster's max
  // lon. Build two boxes, one per side of the date line.
  let eastMin = Infinity, eastMax = -Infinity;
  let westMin = Infinity, westMax = -Infinity;
  let south = Infinity, north = -Infinity;
  for (const [lon, lat] of iterCoords(geometry)) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon >= 0) {
      if (lon < eastMin) eastMin = lon;
      if (lon > eastMax) eastMax = lon;
    } else {
      if (lon < westMin) westMin = lon;
      if (lon > westMax) westMax = lon;
    }
  }
  /** @type {BBox[]} */
  const bboxes = [];
  if (eastMax >= eastMin) bboxes.push([eastMin, south, eastMax, north]);
  if (westMax >= westMin) bboxes.push([westMin, south, westMax, north]);
  // Signed display bbox: west = the eastern cluster's min, east = the
  // western cluster's max, so west > east signals the wrap.
  const signedWest = eastMax >= eastMin ? eastMin : westMin;
  const signedEast = westMax >= westMin ? westMax : eastMax;
  return { bbox: [signedWest, south, signedEast, north], bboxes, crossesAntimeridian: true };
}

/**
 * True when two normalized (west <= east) bboxes intersect.
 * @param {BBox} a @param {BBox} b
 */
export function bboxesIntersect(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * True when point [lon, lat] falls within a normalized bbox.
 * @param {BBox} box @param {[number, number]} point
 */
export function bboxContainsPoint(box, [lon, lat]) {
  return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];
}

/** Center point of a normalized bbox. @param {BBox} box @returns {[number, number]} */
export function bboxCenter(box) {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

/**
 * Scale a bbox by `factor` about its center (used for the ranking "near"
 * test, design doc §3.2 RankingOptions.nearFactor).
 * @param {BBox} box @param {number} factor @returns {BBox}
 */
export function scaleBBox(box, factor) {
  const [cx, cy] = bboxCenter(box);
  const hw = ((box[2] - box[0]) / 2) * factor;
  const hh = ((box[3] - box[1]) / 2) * factor;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/**
 * Union of a list of normalized bboxes.
 * @param {BBox[]} boxes @returns {BBox}
 */
export function unionBBoxes(boxes) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [w, s, e, n] of boxes) {
    if (w < west) west = w;
    if (s < south) south = s;
    if (e > east) east = e;
    if (n > north) north = n;
  }
  return [west, south, east, north];
}
