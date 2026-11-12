// @cnmw/upload-core -- the repair pipeline (design doc §1.2's `AreaRepair`
// taxonomy, §3.3's `UploadProvenance.repairs`).
//
// Format-agnostic: it runs on plain GeoJSON `Feature`-shaped objects
// (`{ geometry, properties }`) regardless of which `GeometryReader`
// produced them, which is the point of splitting reader (bytes -> raw
// GeoJSON) from repair (raw GeoJSON -> valid areal geometry) -- a future
// shapefile/gdal3.js reader gets the same repairs for free.
//
// Implements, in order, the four classes of damage real-world uploaded
// GeoJSON actually has:
//   1. non-areal features (Point/LineString/etc.) -- dropped, counted.
//   2. per-ring damage: a Z coordinate, an out-of-range lon/lat, a run of
//      duplicate consecutive points, an unclosed ring, wrong winding
//      order (RFC 7946 §3.1.6: exterior CCW, holes CW).
//   3. a ring left with fewer than 4 points after (2) is dropped; if that
//      was a polygon's exterior ring, the whole polygon is dropped.
//   4. a feature left with zero polygons after (3) is dropped.
//
// DEVIATION (documented, see the upload-core handback report): the design
// doc's `AreaRepair` union (§1.2) does not have a slot for "removed N
// duplicate consecutive points", a real and common fix this module makes.
// Rather than silently fold it into an unrelated kind, this module adds
// one additional kind, `'deduped-points'`, with the same `{ kind, count }`
// shape as the rest of the union. Every other kind here is exactly the
// design doc's taxonomy. "Coordinate precision truncation" from the task
// description is intentionally NOT implemented here: design doc §1.3 is
// explicit that precision trimming happens "on serialization only" (i.e.
// in a format writer, @cnmw/download-core's job), not on upload.

/** @typedef {import('@cnmw/spec').AreaGeometry} AreaGeometry */

const MIN_RING_POINTS = 4; // 3 distinct vertices + the closing duplicate

function coordsEqual(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

/** Signed shoelace area (not absolute): positive = CCW, negative = CW, by the standard x=lon,y=lat convention. */
function signedRingArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/**
 * Repair one ring in place-ish (returns a new array, or null if the ring
 * is unsalvageable). Mutates the shared `counters` object's counts.
 * @param {number[][]} ring
 * @param {boolean} isExterior
 * @param {object} counters
 * @returns {number[][]|null}
 */
function repairRing(ring, isExterior, counters) {
  if (!Array.isArray(ring) || ring.length === 0) return null;

  // 1. Strip Z (and any further dimensions): every @cnmw geometry is 2D.
  let hadZ = false;
  let pts = ring.map((pt) => {
    if (pt.length > 2) hadZ = true;
    return [pt[0], pt[1]];
  });
  if (hadZ) counters.droppedZ++;

  // 2. Clamp out-of-range coordinates (lon to [-180,180], lat to [-90,90]).
  let clampedLon = false;
  let clampedLat = false;
  pts = pts.map(([lon, lat]) => {
    let outLon = lon;
    let outLat = lat;
    if (outLon < -180 || outLon > 180) {
      outLon = Math.max(-180, Math.min(180, outLon));
      clampedLon = true;
    }
    if (outLat < -90 || outLat > 90) {
      outLat = Math.max(-90, Math.min(90, outLat));
      clampedLat = true;
    }
    return [outLon, outLat];
  });
  if (clampedLon) counters.clampedLon++;
  if (clampedLat) counters.clampedLat++;

  // 3. Drop runs of duplicate consecutive points.
  const deduped = [pts[0]];
  let removedDuplicates = false;
  for (let i = 1; i < pts.length; i++) {
    if (coordsEqual(pts[i], deduped[deduped.length - 1])) {
      removedDuplicates = true;
      continue;
    }
    deduped.push(pts[i]);
  }
  pts = deduped;
  if (removedDuplicates) counters.dedupedPoints++;

  // 4. Close the ring if the dedup step above left it open (also catches
  // input that was simply never closed).
  if (pts.length > 0 && !coordsEqual(pts[0], pts[pts.length - 1])) {
    pts.push([pts[0][0], pts[0][1]]);
    counters.closedRing++;
  }

  // 5. Drop degenerate rings.
  if (pts.length < MIN_RING_POINTS) {
    counters.droppedEmpty++;
    return null;
  }

  // 6. Winding: exterior should be CCW (positive signed area), holes CW
  // (negative). Reverse if backwards.
  const area = signedRingArea(pts);
  const wantsPositive = isExterior;
  if ((wantsPositive && area < 0) || (!wantsPositive && area > 0)) {
    pts = [...pts].reverse();
    counters.rewoundRing++;
  }

  return pts;
}

/**
 * Repair one Polygon or MultiPolygon geometry. Returns null if nothing
 * usable survives.
 * @param {AreaGeometry} geometry
 * @param {object} counters
 * @returns {AreaGeometry|null}
 */
function repairPolygonal(geometry, counters) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  const keptPolys = [];
  for (const rings of polys) {
    const keptRings = [];
    rings.forEach((ring, i) => {
      const repaired = repairRing(ring, i === 0, counters);
      if (repaired) keptRings.push(repaired);
      else if (i === 0) {
        // Exterior ring lost: the rest of this polygon's holes are moot.
        keptRings.length = 0;
      }
    });
    if (keptRings.length > 0) keptPolys.push(keptRings);
  }
  if (keptPolys.length === 0) return null;
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: keptPolys[0] };
  return { type: 'MultiPolygon', coordinates: keptPolys };
}

/**
 * Run the full repair pipeline over an array of raw GeoJSON `Feature`
 * objects (or bare `Geometry` objects -- both are accepted, matching
 * `GeometryReader.read()`'s loose contract).
 *
 * @param {ReadonlyArray<{ geometry?: unknown, type?: string, properties?: Record<string, unknown> }>} rawFeatures
 * @returns {{
 *   features: Array<{ geometry: AreaGeometry, properties: Record<string, unknown> }>,
 *   repairs: import('@cnmw/spec').AreaRepair[],
 * }}
 */
export function repairFeatures(rawFeatures) {
  const counters = {
    droppedZ: 0,
    clampedLon: 0,
    clampedLat: 0,
    dedupedPoints: 0,
    closedRing: 0,
    droppedEmpty: 0,
    rewoundRing: 0,
  };
  let droppedNonAreal = 0;
  const droppedNonArealTypes = new Set();
  let droppedFeatures = 0;
  const droppedReasons = new Set();

  const kept = [];
  for (const raw of rawFeatures ?? []) {
    const geometry = raw && typeof raw === 'object' && 'geometry' in raw ? raw.geometry : raw;
    const properties = (raw && typeof raw === 'object' && raw.properties) || {};
    if (!geometry || typeof geometry !== 'object' || !geometry.type) {
      droppedFeatures++;
      droppedReasons.add('null-geometry');
      continue;
    }
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      droppedNonAreal++;
      droppedNonArealTypes.add(geometry.type);
      continue;
    }
    const repaired = repairPolygonal(geometry, counters);
    if (!repaired) {
      droppedFeatures++;
      droppedReasons.add('empty-after-repair');
      continue;
    }
    kept.push({ geometry: repaired, properties });
  }

  /** @type {import('@cnmw/spec').AreaRepair[]} */
  const repairs = [];
  if (droppedNonAreal > 0) {
    repairs.push({ kind: 'dropped-non-areal', count: droppedNonAreal, types: [...droppedNonArealTypes] });
  }
  if (counters.closedRing > 0) repairs.push({ kind: 'closed-ring', count: counters.closedRing });
  if (counters.rewoundRing > 0) repairs.push({ kind: 'rewound-ring', count: counters.rewoundRing });
  if (counters.droppedEmpty > 0) repairs.push({ kind: 'dropped-empty', count: counters.droppedEmpty });
  if (counters.droppedZ > 0) repairs.push({ kind: 'dropped-z', count: counters.droppedZ });
  if (counters.clampedLon > 0) repairs.push({ kind: 'clamped-coordinate', count: counters.clampedLon, axis: 'lon' });
  if (counters.clampedLat > 0) repairs.push({ kind: 'clamped-coordinate', count: counters.clampedLat, axis: 'lat' });
  if (counters.dedupedPoints > 0) repairs.push({ kind: 'deduped-points', count: counters.dedupedPoints });
  if (droppedFeatures > 0) {
    repairs.push({ kind: 'dropped-feature', count: droppedFeatures, reason: [...droppedReasons].join(', ') });
  }

  return { features: kept, repairs };
}
