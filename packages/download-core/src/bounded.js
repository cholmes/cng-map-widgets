// @cng/download-core -- `Bounded` arithmetic (design doc §3.4).
//
// `Bounded.exact: true` means the number came straight from metadata (e.g.
// a row-group's `num_rows`, or a column chunk's `total_compressed_size`),
// not a selectivity model.

/** @typedef {{ min: number, max: number, estimate: number, exact: boolean }} Bounded */

/** @param {number} n @returns {Bounded} */
export function boundedExact(n) {
  return { min: n, max: n, estimate: n, exact: true };
}

/** @param {number} min @param {number} max @param {number} estimate @param {boolean} [exact] @returns {Bounded} */
export function boundedRange(min, max, estimate, exact = false) {
  return { min, max, estimate, exact };
}

/** @returns {Bounded} */
export function zeroBounded() {
  return boundedExact(0);
}

/** @param {Bounded} a @param {Bounded} b @returns {Bounded} */
export function addBounded(a, b) {
  return boundedRange(a.min + b.min, a.max + b.max, a.estimate + b.estimate, a.exact && b.exact);
}

/** @param {Bounded[]} list @returns {Bounded} */
export function sumBounded(list) {
  return list.reduce(addBounded, zeroBounded());
}

/** Scale every field by a constant factor (e.g. bytes-per-row). @param {Bounded} a @param {number} factor @returns {Bounded} */
export function scaleBounded(a, factor) {
  return boundedRange(a.min * factor, a.max * factor, a.estimate * factor, a.exact);
}

/** Clamp `a.estimate` to at most `cap` (e.g. a `limit` row cap). Keeps `exact` only if the cap did not bind. @param {Bounded} a @param {number} cap @returns {Bounded} */
export function capBounded(a, cap) {
  if (a.max <= cap) return a;
  return boundedRange(Math.min(a.min, cap), cap, Math.min(a.estimate, cap), false);
}

/** O12: `max/estimate > ratio` signals the estimate is "wide" (little selectivity information). @param {Bounded} a @param {number} [ratio] @returns {boolean} */
export function isEstimateWide(a, ratio = 10) {
  if (a.estimate <= 0) return a.max > 0;
  return a.max / a.estimate > ratio;
}
