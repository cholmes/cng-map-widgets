// @cngeo/extract-core -- spatial filtering (design doc §2.2 SpatialFilter,
// §1.5 antimeridian).
//
// Pruning is bbox-first, always: a row's own bbox (from the covering
// column, or computed from its decoded geometry when there is no covering)
// is tested against every entry of `Area.bboxes` -- never the signed
// `Area.bbox` (design doc §1.5 rule 3). The exact `intersects` test then
// runs a point-in-polygon / edge-crossing check against `Area.filterGeometry`
// directly, unsplit, because the geometry's own coordinates never wrapped
// across the antimeridian (§1.5 rule 5).

/** @typedef {import('@cngeo/spec').BBox} BBox */

/**
 * True when a normalized feature bbox touches/overlaps any of the Area's
 * (possibly antimeridian-split) bboxes.
 * @param {BBox} featureBBox @param {BBox[]} areaBBoxes @param {boolean} [includeBboxTouch]
 */
export function bboxIntersectsAny(featureBBox, areaBBoxes, includeBboxTouch = false) {
  for (const box of areaBBoxes) {
    if (boxesTouch(featureBBox, box, includeBboxTouch)) return true;
  }
  return false;
}

/** @param {BBox} a @param {BBox} b @param {boolean} includeBboxTouch */
function boxesTouch(a, b, includeBboxTouch) {
  const closed = a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  if (!closed) return false;
  if (includeBboxTouch) return true;
  // Strictly-open: exclude the case where the only overlap is a shared edge/corner.
  const openX = a[0] < b[2] && a[2] > b[0];
  const openY = a[1] < b[3] && a[3] > b[1];
  return openX && openY;
}

/**
 * Ray-casting point-in-ring test (even-odd rule). Ring may or may not be
 * explicitly closed (first === last); both are handled.
 * @param {[number, number]} point @param {number[][]} ring
 */
export function pointInRing([x, y], ring) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Point-in-polygon, honoring holes (even-odd across rings: in outer ring,
 * not in any inner ring).
 * @param {[number, number]} point @param {GeoJSON.Polygon} polygon
 */
export function pointInPolygon(point, polygon) {
  const rings = polygon.coordinates;
  if (rings.length === 0) return false;
  if (!pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false;
  }
  return true;
}

/**
 * Point-in-geometry for Polygon or MultiPolygon.
 * @param {[number, number]} point @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 */
export function pointInGeometry(point, geometry) {
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry);
  for (const poly of geometry.coordinates) {
    if (pointInPolygon(point, { type: 'Polygon', coordinates: poly })) return true;
  }
  return false;
}

/** Standard segment-intersection test (proper crossing or touching), 2D. */
function segmentsIntersect(p1, p2, p3, p4) {
  const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const d2 = d(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  const d3 = d(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const d4 = d(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

function onSegment(a, b, p) {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function ringsIntersect(ringA, ringB) {
  for (let i = 0; i < ringA.length - 1; i++) {
    for (let j = 0; j < ringB.length - 1; j++) {
      if (segmentsIntersect(ringA[i], ringA[i + 1], ringB[j], ringB[j + 1])) return true;
    }
  }
  return false;
}

function allRings(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  const rings = [];
  for (const poly of polys) for (const ring of poly) rings.push(ring);
  return rings;
}

/**
 * Robust (if O(vertices²)) polygon/polygon intersects test: true if either
 * geometry contains a vertex of the other, or any pair of edges cross.
 * Sufficient for row-level filtering at the vertex ceilings this project
 * uses (design doc §1.3: filter geometry capped at 10,000 vertices; feature
 * geometries are typically small field/admin polygons).
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} a @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} b
 */
export function geometriesIntersect(a, b) {
  const ringsA = allRings(a);
  const ringsB = allRings(b);
  for (const ring of ringsA) {
    for (const pt of ring) {
      if (pointInGeometry(pt, b)) return true;
    }
  }
  for (const ring of ringsB) {
    for (const pt of ring) {
      if (pointInGeometry(pt, a)) return true;
    }
  }
  for (const ra of ringsA) {
    for (const rb of ringsB) {
      if (ringsIntersect(ra, rb)) return true;
    }
  }
  return false;
}

/**
 * Exact geometry test between a row's feature geometry and the area's
 * filter polygon, dispatching on the feature's own type. `geometriesIntersect`
 * (above) assumes both sides are Polygon/MultiPolygon, which breaks for a
 * point dataset (NASA FIRMS -- every row's geometry is a WKB Point; see
 * `./wkb-geometry.js`'s module doc for why that decode isn't in
 * `@cngeo/spec`). A point "intersects" a polygon area exactly when it falls
 * inside it, which `pointInGeometry` already answers directly -- no
 * ring/edge intersection test needed for a feature with no edges.
 * @param {GeoJSON.Point|GeoJSON.MultiPoint|GeoJSON.Polygon|GeoJSON.MultiPolygon} featureGeometry
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} filterGeometry
 */
export function geometryIntersectsArea(featureGeometry, filterGeometry) {
  if (featureGeometry.type === 'Point') return pointInGeometry(featureGeometry.coordinates, filterGeometry);
  if (featureGeometry.type === 'MultiPoint') {
    return featureGeometry.coordinates.some((pt) => pointInGeometry(pt, filterGeometry));
  }
  return geometriesIntersect(featureGeometry, filterGeometry);
}

/**
 * The full row-level spatial test (design doc §2.2 / §2.6's pruning
 * cascade step 4): bbox prune, then (for `intersects`) exact geometry test.
 *
 * @param {{
 *   featureBBox: BBox,
 *   featureGeometry?: GeoJSON.Point|GeoJSON.MultiPoint|GeoJSON.Polygon|GeoJSON.MultiPolygon|null,
 * }} row
 * @param {{ bboxes: BBox[], filterGeometry: GeoJSON.Polygon|GeoJSON.MultiPolygon|null }} area
 * @param {{ mode: 'bbox'|'intersects'|'clip', includeBboxTouch?: boolean }} spatial
 * @returns {boolean}
 */
export function rowMatchesArea(row, area, spatial) {
  const includeBboxTouch = spatial.includeBboxTouch ?? false;
  if (!bboxIntersectsAny(row.featureBBox, area.bboxes, includeBboxTouch)) return false;
  if (spatial.mode === 'bbox') return true;
  // intersects (and clip, which is `intersects` + a post-process the caller
  // handles -- see extract-core's clip refusal in estimate/engine).
  if (!area.filterGeometry || !row.featureGeometry) return true; // degraded-to-bbox
  return geometryIntersectsArea(row.featureGeometry, area.filterGeometry);
}
