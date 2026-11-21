// @cngeo/spec -- async, O(m log m) Visvalingam-Whyatt simplification for
// the geocoder-core background-upgrade path (design doc §1: "fetch/attach
// the full-res [filterGeometry] in the background").
//
// `simplify.js`'s `visvalingamRing`/`simplifyToVertexCeiling` are the
// classic algorithm: at every step, scan *every* alive point for the
// globally smallest removable triangle -- O(m) per removal, O(m^2) per
// full pass, times up to 20 binary-search passes. That is fine for the
// <=200k-vertex *display* geometry, but it is exactly what hung the
// browser on a raw CGAZ ADM0 ring: Canada's mainland ring alone is
// ~195,000 points, and 20 O(m^2) passes over it is on the order of 10^12
// operations -- not merely slow, effectively never finishes.
//
// This module reimplements the *same* removal rule (always drop the
// alive point whose triangle area with its current two neighbors is
// smallest, as long as that area is below the tolerance, then recompute
// the two affected neighbors) using a binary min-heap with lazy
// invalidation instead of a linear scan, making each removal O(log m)
// instead of O(m). It also breaks the work into chunks with a cooperative
// yield (`yieldToMain`, design doc task: "the main thread never blocks
// >50ms") between them, so even the now-small amount of total work never
// runs as one long synchronous stretch.
//
// `simplify.js`'s synchronous functions are untouched and still used by
// the display-vertex-ceiling step and by any caller that wants the
// simple, dependency-free version on geometry it already knows is small
// (<=200k vertices, the display ceiling).

import { yieldToMain } from './yield.js';
import { vertexCount, totalArea } from './simplify.js';

function triangleArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

/** Array-backed binary min-heap of `{ area, index, version }`, ordered by `area`. */
class MinHeap {
  constructor() {
    /** @type {{area: number, index: number, version: number}[]} */
    this._a = [];
  }
  get size() {
    return this._a.length;
  }
  push(item) {
    const a = this._a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].area <= a[i].area) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this._a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      const n = a.length;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && a[l].area < a[smallest].area) smallest = l;
        if (r < n && a[r].area < a[smallest].area) smallest = r;
        if (smallest === i) break;
        [a[i], a[smallest]] = [a[smallest], a[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * O(m log m), chunked/yielding Visvalingam-Whyatt simplification of one
 * closed ring (first === last point). Same removal semantics as
 * `visvalingamRing` in `simplify.js`; see that file for the algorithm
 * description. First/last point is never removed.
 * @param {number[][]} ring
 * @param {number} areaTolerance
 * @param {{ chunkOps?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<number[][]>}
 */
export async function visvalingamRingAsync(ring, areaTolerance, opts = {}) {
  const chunkOps = opts.chunkOps ?? 4000; // op-count fallback ceiling between time checks
  const yieldBudgetMs = opts.yieldBudgetMs ?? 8; // never run longer than ~this without yielding, regardless of op count/hardware speed
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const n = ring.length;
  if (n <= 4) return ring;

  const pts = ring.slice(0, n - 1);
  const m = pts.length;
  if (m <= 3) return ring;

  const alive = new Uint8Array(m).fill(1);
  const prevOf = new Int32Array(m);
  const nextOf = new Int32Array(m);
  const versions = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    prevOf[i] = (i - 1 + m) % m;
    nextOf[i] = (i + 1) % m;
  }

  const areaOf = (i) => triangleArea(pts[prevOf[i]], pts[i], pts[nextOf[i]]);

  const heap = new MinHeap();
  for (let i = 0; i < m; i++) heap.push({ area: areaOf(i), index: i, version: 0 });

  let aliveCount = m;
  const minAlive = 3;
  let sinceYield = 0;
  let chunkStartedAt = now();

  while (aliveCount > minAlive && heap.size > 0) {
    const entry = heap.pop();
    sinceYield++;
    // Time-budget check first: op-count alone assumes a fixed per-op
    // cost, which varies with hardware and heap depth. Checking elapsed
    // wall time directly is what actually bounds how long a chunk can
    // run before yielding; `chunkOps` just limits how often we pay for a
    // `now()` call in between.
    if (sinceYield >= chunkOps || (sinceYield >= 200 && now() - chunkStartedAt >= yieldBudgetMs)) {
      sinceYield = 0;
      opts.signal?.throwIfAborted();
      await yieldToMain();
      chunkStartedAt = now();
    }

    const i = entry.index;
    if (!alive[i] || entry.version !== versions[i]) continue; // stale: superseded by a later recompute
    if (entry.area > areaTolerance) break; // smallest valid area already exceeds tolerance: done

    alive[i] = 0;
    aliveCount--;
    const p = prevOf[i];
    const nx = nextOf[i];
    nextOf[p] = nx;
    prevOf[nx] = p;

    if (aliveCount > minAlive) {
      versions[p] += 1;
      heap.push({ area: areaOf(p), index: p, version: versions[p] });
      versions[nx] += 1;
      heap.push({ area: areaOf(nx), index: nx, version: versions[nx] });
    }
  }

  const out = [];
  for (let i = 0; i < m; i++) if (alive[i]) out.push(pts[i]);
  out.push(out[0]);
  return out;
}

/** Apply a fixed area tolerance to every ring of a Polygon/MultiPolygon, yielding between rings. */
async function simplifyAtToleranceAsync(geometry, areaTolerance, opts) {
  if (geometry.type === 'Polygon') {
    const coordinates = [];
    for (const r of geometry.coordinates) {
      coordinates.push(await visvalingamRingAsync(r, areaTolerance, opts));
    }
    return { type: 'Polygon', coordinates };
  }
  const coordinates = [];
  for (const poly of geometry.coordinates) {
    const rings = [];
    for (const r of poly) rings.push(await visvalingamRingAsync(r, areaTolerance, opts));
    coordinates.push(rings);
  }
  return { type: 'MultiPolygon', coordinates };
}

/**
 * Async equivalent of `simplifyToVertexCeiling` (same binary search over
 * `toleranceDeg` in `[1e-7, 1]`, same result shape), built on the
 * O(m log m) ring simplifier above so it is safe to run on raw
 * full-resolution geometry, and yielding between binary-search passes in
 * addition to the yields inside each ring pass.
 * `maxIterations` (default 12, vs. the synchronous version's fixed 20)
 * is a deliberate deviation for the background-upgrade path only: this
 * runs on raw full-resolution geometry that can be hundreds of thousands
 * of vertices (Canada: 528,055), so each binary-search pass costs real
 * wall time, and this result only ever feeds `filterGeometry` -- an
 * already-approximate, non-user-blocking value -- not what's drawn on
 * screen. 12 passes over `[1e-7, 1]` still resolves `toleranceDeg` to
 * within ~1/4096 of the range, which in practice (measured against
 * Canada and the UK's overseas-territory MultiPolygon) picks the same
 * tolerance bucket the full 20-pass search would.
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @param {{ vertexCeiling: number, areaDeltaMaxRatio?: number, chunkOps?: number, maxIterations?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{
 *   geometry: GeoJSON.Polygon|GeoJSON.MultiPolygon,
 *   method: 'visvalingam'|'none'|'bbox',
 *   toleranceDeg: number,
 *   inputVertices: number,
 *   outputVertices: number,
 *   areaDeltaRatio: number,
 *   degradedToBbox: boolean,
 * }>}
 */
export async function simplifyToVertexCeilingAsync(geometry, opts) {
  const { vertexCeiling, areaDeltaMaxRatio = 0.05, signal } = opts;
  const ringOpts = { chunkOps: opts.chunkOps, signal };
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

  let lo = 1e-7;
  let hi = 1;
  /** @type {GeoJSON.Polygon|GeoJSON.MultiPolygon|null} */
  let best = null;
  let bestTolerance = 0;
  let bestOutputVertices = inputVertices;
  let bestAreaDeltaRatio = 0;

  const maxIterations = opts.maxIterations ?? 12;
  for (let iter = 0; iter < maxIterations; iter++) {
    signal?.throwIfAborted();
    await yieldToMain(); // always yield between binary-search passes, even on small inputs
    // Geometric bisection -- see simplify.js (2026-11-13): halve the
    // exponent, not the value, so few iterations still land in the
    // right tolerance decade.
    const mid = Math.sqrt(lo * hi);
    const candidate = await simplifyAtToleranceAsync(geometry, mid, ringOpts);
    const outputVertices = vertexCount(candidate);
    const candidateArea = totalArea(candidate);
    const areaDeltaRatio = originalArea === 0 ? 0 : Math.abs(candidateArea - originalArea) / originalArea;

    if (outputVertices > vertexCeiling) {
      // Not simplified enough to fit the ceiling: need a larger tolerance.
      lo = mid;
    } else {
      // Fits the ceiling: record it when honest, then search SMALLER
      // tolerances for more retained detail -- same objective as the
      // synchronous version (see simplify.js, 2026-11-13 fix: the search
      // previously ran the other way and maximized simplification).
      if (areaDeltaRatio <= areaDeltaMaxRatio) {
        best = candidate;
        bestTolerance = mid;
        bestOutputVertices = outputVertices;
        bestAreaDeltaRatio = areaDeltaRatio;
      }
      hi = mid;
    }
    if (hi / lo < 1 + 1e-6) break; // bracket resolved (log-space convergence)
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
