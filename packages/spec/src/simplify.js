// @cnmw/spec -- Visvalingam-Whyatt simplification + the tolerance search
// described in design doc §1.3.
//
// `maxSyncInputVertices` / `MAX_SYNC_SIMPLIFY_VERTICES` (fix history,
// "Canada ADM0 select() blocks the main thread for ~24s"): the binary
// search below runs up to 20 full Visvalingam passes, each O(m) per
// removal over the *current* alive-point count -- O(m^2) worst case per
// pass, because at least one trial (the highest tried tolerance) always
// removes down to the minimum 3 points regardless of `vertexCeiling`, so
// the cost is driven by the *input* size, not by how close the input
// already is to the ceiling. Measured directly against this
// implementation (worst case: `vertexCeiling` set to 10% of the input, so
// every trial does real work):
//
//   input vertices | wall time
//   ---------------|----------
//   1,000          |    38 ms
//   1,500          |    87 ms
//   2,000          |   152 ms
//   3,000          |   339 ms
//   5,000          |   921 ms
//   10,000         | 3,852 ms
//
// and inputs only modestly *above* a realistic 10,000-vertex
// `filterVertexCeiling` are just as expensive as a large ratio: 10,500
// vertices (500 over the ceiling) still costs ~4.2s, because the
// high-tolerance binary-search trial above still strips the ring down to
// (almost) nothing. There is no "a little over the ceiling is cheap"
// regime once real reduction is needed -- only "input is small" is cheap.
// `MAX_SYNC_SIMPLIFY_VERTICES` (1,500) is the largest input size that
// stays comfortably under 100ms even in the worst-case-ratio trial above;
// a caller that passes `maxSyncInputVertices` opts into skipping the
// search entirely (degrading straight to bbox, design doc §1.3's
// `degradedToBbox`) once the input exceeds it, rather than ever running
// the O(m^2) search on it. The parameter defaults to `undefined` (no
// guard, original unbounded behavior) so existing callers that already
// accept running this search on moderate inputs (e.g. `@cnmw/upload-core`,
// which has no interactive-latency budget the way a map click does) are
// unaffected; `@cnmw/geocoder-core`'s `select()` -- the main-thread-latency-
// sensitive caller -- opts in via `buildArea({ maxSyncInputVertices })`.
// Use `simplifyToVertexCeilingAsync` (`simplify-async.js`) for the O(m log
// m), chunked/yielding version that's actually safe to run on raw
// full-resolution geometry regardless of size.
export const MAX_SYNC_SIMPLIFY_VERTICES = 1500;

/**
 * Planar (degree-space) area of a triangle, doubled (we only ever compare
 * areas to each other, so the factor of 2 cancels).
 */
function triangleArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

/**
 * Visvalingam-Whyatt simplification of a single ring (array of [x,y],
 * closed: first === last). Removes points whose triangle area (with their
 * two neighbors) is below `areaTolerance`, recomputing affected
 * neighbors' areas as points are removed. First/last point (the closing
 * vertex) is never removed.
 * @param {number[][]} ring
 * @param {number} areaTolerance
 * @returns {number[][]}
 */
export function visvalingamRing(ring, areaTolerance) {
  const n = ring.length;
  if (n <= 4) return ring; // triangle + closing point: nothing to remove

  // Work on open ring (drop the duplicated closing point), re-close at end.
  const pts = ring.slice(0, n - 1);
  const m = pts.length;
  if (m <= 3) return ring;

  const alive = new Array(m).fill(true);
  const areas = new Array(m).fill(Infinity);
  const prevOf = new Array(m);
  const nextOf = new Array(m);
  for (let i = 0; i < m; i++) {
    prevOf[i] = (i - 1 + m) % m;
    nextOf[i] = (i + 1) % m;
  }
  function recompute(i) {
    areas[i] = triangleArea(pts[prevOf[i]], pts[i], pts[nextOf[i]]);
  }
  for (let i = 0; i < m; i++) recompute(i);

  let aliveCount = m;
  const minAlive = 3;

  // Classic Visvalingam: repeatedly remove the globally smallest-area
  // point. O(m^2) worst case, fine for CGAZ-scale rings under the ceiling
  // search (<=20 iterations x a few thousand points).
  while (aliveCount > minAlive) {
    let minIdx = -1;
    let minArea = Infinity;
    for (let i = 0; i < m; i++) {
      if (alive[i] && areas[i] < minArea) {
        minArea = areas[i];
        minIdx = i;
      }
    }
    if (minIdx === -1 || minArea > areaTolerance) break;
    alive[minIdx] = false;
    aliveCount--;
    const p = prevOf[minIdx];
    const nx = nextOf[minIdx];
    nextOf[p] = nx;
    prevOf[nx] = p;
    if (aliveCount > minAlive) {
      recompute(p);
      recompute(nx);
    }
  }

  const out = [];
  for (let i = 0; i < m; i++) if (alive[i]) out.push(pts[i]);
  out.push(out[0]);
  return out;
}

/** Shoelace area of a ring (closed), unsigned, in degree^2. @param {number[][]} ring */
export function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry */
export function vertexCount(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let n = 0;
  for (const poly of polys) for (const ring of poly) n += ring.length;
  return n;
}

/** @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry */
export function totalArea(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let a = 0;
  for (const poly of polys) for (const ring of poly) a += ringArea(ring);
  return a;
}

/** Apply a fixed area tolerance to every ring of a Polygon/MultiPolygon. */
function simplifyAtTolerance(geometry, areaTolerance) {
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map((r) => visvalingamRing(r, areaTolerance)) };
  }
  return {
    type: 'MultiPolygon',
    coordinates: geometry.coordinates.map((poly) => poly.map((r) => visvalingamRing(r, areaTolerance))),
  };
}

/**
 * Binary search `toleranceDeg` over [1e-7, 1] for at most 20 iterations
 * (design doc §1.3), taking the largest tolerance whose output is under
 * `vertexCeiling`; abort early if `areaDeltaRatio > areaDeltaMaxRatio`.
 * `toleranceDeg` here is interpreted as a triangle-area tolerance in
 * degree^2 (not a linear distance) because Visvalingam is area-based; the
 * field name is kept as the design doc specifies.
 *
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @param {{ vertexCeiling: number, areaDeltaWarnRatio?: number, areaDeltaMaxRatio?: number, maxSyncInputVertices?: number }} opts
 *   `maxSyncInputVertices`: opt-in guard (see `MAX_SYNC_SIMPLIFY_VERTICES` above) -- when the input
 *   exceeds it, skip the O(m^2) search and degrade straight to bbox. `undefined` (the default):
 *   no guard, run the search regardless of input size (the original, unbounded behavior).
 * @returns {{
 *   geometry: GeoJSON.Polygon|GeoJSON.MultiPolygon,
 *   method: 'visvalingam'|'none'|'bbox',
 *   toleranceDeg: number,
 *   inputVertices: number,
 *   outputVertices: number,
 *   areaDeltaRatio: number,
 *   degradedToBbox: boolean,
 * }}
 */
export function simplifyToVertexCeiling(geometry, opts) {
  const { vertexCeiling, areaDeltaMaxRatio = 0.05, maxSyncInputVertices } = opts;
  const inputVertices = vertexCount(geometry);
  const originalArea = totalArea(geometry);

  if (inputVertices <= vertexCeiling) {
    return {
      geometry,
      method: 'none',
      toleranceDeg: 0,
      inputVertices,
      outputVertices: inputVertices,
      areaDeltaRatio: 0,
      degradedToBbox: false,
    };
  }

  if (maxSyncInputVertices != null && inputVertices > maxSyncInputVertices) {
    // Too large to run the O(m^2) search synchronously without risking a
    // multi-second (or worse) main-thread block -- see this module's
    // header comment for the measurements. Degrade immediately rather
    // than ever attempting it; a caller that wants the real answer on
    // input this size should use `simplifyToVertexCeilingAsync` instead.
    return {
      geometry,
      method: 'bbox',
      toleranceDeg: 0,
      inputVertices,
      outputVertices: inputVertices,
      areaDeltaRatio: 0,
      degradedToBbox: true,
    };
  }

  let lo = 1e-7, hi = 1;
  /** @type {GeoJSON.Polygon|GeoJSON.MultiPolygon|null} */
  let best = null;
  let bestTolerance = 0;
  let bestOutputVertices = inputVertices;
  let bestAreaDeltaRatio = 0;

  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2;
    const candidate = simplifyAtTolerance(geometry, mid);
    const outputVertices = vertexCount(candidate);
    const candidateArea = totalArea(candidate);
    const areaDeltaRatio = originalArea === 0 ? 0 : Math.abs(candidateArea - originalArea) / originalArea;

    if (outputVertices <= vertexCeiling && areaDeltaRatio <= areaDeltaMaxRatio) {
      // Under budget and honest: this tolerance works; try a larger one
      // (fewer vertices still) in case it's also acceptable.
      best = candidate;
      bestTolerance = mid;
      bestOutputVertices = outputVertices;
      bestAreaDeltaRatio = areaDeltaRatio;
      lo = mid;
    } else if (areaDeltaRatio > areaDeltaMaxRatio) {
      // Too aggressive already; back off.
      hi = mid;
    } else {
      // Still over the vertex ceiling; go more aggressive.
      lo = mid;
    }
    if (hi - lo < 1e-9) break;
  }

  if (best === null || bestOutputVertices > vertexCeiling) {
    return {
      geometry,
      method: 'bbox',
      toleranceDeg: bestTolerance,
      inputVertices,
      outputVertices: inputVertices,
      areaDeltaRatio: bestAreaDeltaRatio,
      degradedToBbox: true,
    };
  }

  return {
    geometry: best,
    method: 'visvalingam',
    toleranceDeg: bestTolerance,
    inputVertices,
    outputVertices: bestOutputVertices,
    areaDeltaRatio: bestAreaDeltaRatio,
    degradedToBbox: false,
  };
}
