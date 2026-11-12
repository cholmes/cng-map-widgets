// @cnmw/geocoder-core -- the ranking total-order + result-diversity logic
// (design doc §3.2 "The ranking rule, normatively", amended 2026-11-12 on
// user feedback against the Overture-scale index -- see the amendment's
// measured-examples table for why the order below is what it is).
//
// Pure functions, no I/O, no DOM: easy to unit test independently of the
// index loader.

import { bboxesIntersect, bboxContainsPoint, bboxCenter, scaleBBox } from '@cnmw/spec';

/** @typedef {import('@cnmw/spec').BBox} BBox */
/** @typedef {'exact'|'prefix'|'word-prefix'|'substring'} MatchClass */
/** @typedef {'inside'|'overlap'|'near'|'outside'} ViewportRank */

export const MATCH_CLASS_RANK = { exact: 0, prefix: 1, 'word-prefix': 2, substring: 3 };
export const VIEWPORT_RANK = { inside: 0, overlap: 1, near: 2, outside: 3 };

/** Default admin-level promotion granted to an `exact` match over a
 *  `prefix`/`word-prefix`/`substring` match at the next level up, per the
 *  2026-11-12 amendment. See `compareRanked`'s doc comment. */
export const DEFAULT_EXACT_LEVEL_PROMOTION = 1;

/** Default result-diversity options (design doc §3.2 amendment, "Result
 *  diversity"): collapse exact (name_norm, country, level) duplicates to
 *  one row, then cap at 3 rows per (country, level) group. */
export const DEFAULT_DIVERSITY = {
  dedupe: true,
  maxPerGroup: 3,
};

/**
 * Classify how `queryNorm` matches `nameNorm`, in priority order
 * (exact > prefix > word-prefix > substring). Returns null if none of the
 * allowed classes match.
 * @param {string} nameNorm
 * @param {string} queryNorm
 * @param {readonly MatchClass[]} allowedClasses
 * @returns {MatchClass|null}
 */
export function classifyMatch(nameNorm, queryNorm, allowedClasses) {
  if (queryNorm.length === 0) return null;
  if (nameNorm === queryNorm) return allowedClasses.includes('exact') ? 'exact' : null;
  if (nameNorm.startsWith(queryNorm)) return allowedClasses.includes('prefix') ? 'prefix' : null;
  if (allowedClasses.includes('word-prefix')) {
    const words = nameNorm.split(' ');
    for (let i = 1; i < words.length; i++) {
      if (words[i].startsWith(queryNorm)) return 'word-prefix';
    }
  }
  if (allowedClasses.includes('substring') && nameNorm.includes(queryNorm)) return 'substring';
  return null;
}

/**
 * Compute the viewport rank for a feature bbox against the current map
 * viewport, per design doc §3.2: `inside` if the feature bbox's centre is
 * in the viewport, `overlap` if the boxes intersect, `near` if the
 * feature bbox intersects the viewport scaled by `nearFactor` about its
 * own centre, else `outside`.
 * @param {BBox} featureBBox
 * @param {BBox|undefined} viewport
 * @param {number} nearFactor
 * @returns {ViewportRank}
 */
export function computeViewportRank(featureBBox, viewport, nearFactor) {
  if (!viewport) return 'outside';
  if (bboxContainsPoint(viewport, bboxCenter(featureBBox))) return 'inside';
  if (bboxesIntersect(featureBBox, viewport)) return 'overlap';
  const scaled = scaleBBox(viewport, nearFactor);
  if (bboxesIntersect(featureBBox, scaled)) return 'near';
  return 'outside';
}

/**
 * Build the full rank record + derived display score for one index row
 * against one query. Returns null if the row does not match under the
 * allowed match classes.
 *
 * @param {{ nameNorm: string, level: number, bbox: BBox, featureId: string, areaKm2?: number|null }} row
 * @param {string} queryNorm
 * @param {{
 *   viewport?: BBox,
 *   viewportBoost: number,
 *   nearFactor: number,
 *   matchClasses: readonly MatchClass[],
 *   exactLevelPromotion?: number,
 * }} options
 * @returns {{ matchClass: MatchClass, level: number, effLevel: number, levelAdjusted: number, viewportRank: ViewportRank, nameLength: number, areaKm2: number|undefined } | null}
 */
export function rankRow(row, queryNorm, options) {
  const matchClass = classifyMatch(row.nameNorm, queryNorm, options.matchClasses);
  if (matchClass === null) return null;
  const viewportRank = computeViewportRank(row.bbox, options.viewport, options.nearFactor);
  const boostEligible = viewportRank === 'inside' || viewportRank === 'overlap';

  // Bounded exact-match promotion (2026-11-12 amendment): an `exact` match
  // is treated as if it sat `exactLevelPromotion` admin levels higher
  // (closer to ADM0) than it really does, when deciding level order. This
  // is what lets an exact ADM3 "Paris" beat a `prefix`/`word-prefix` match
  // one level up (an ADM1/ADM2 noise row), without letting an exact ADM4
  // "Bag" beat an ADM0 country three levels up -- see `compareRanked`.
  const promotion = matchClass === 'exact' ? (options.exactLevelPromotion ?? DEFAULT_EXACT_LEVEL_PROMOTION) : 0;
  const effLevel = Math.max(0, row.level - promotion);
  const levelAdjusted = effLevel - (boostEligible ? options.viewportBoost : 0);

  return {
    matchClass,
    level: row.level,
    effLevel,
    levelAdjusted,
    viewportRank,
    nameLength: row.nameNorm.length,
    areaKm2: typeof row.areaKm2 === 'number' && !Number.isNaN(row.areaKm2) ? row.areaKm2 : undefined,
  };
}

function areaOrNegInf(areaKm2) {
  return typeof areaKm2 === 'number' ? areaKm2 : -Infinity;
}

/**
 * The total-order comparator over two ranked rows (ascending = better
 * first), per design doc §3.2's ranking rule, amended 2026-11-12:
 *
 * 1. `levelAdjusted` -- the bounded-promotion effective level (below),
 *    further boosted toward ADM0 by `viewportBoost` when the feature is
 *    `inside`/`overlapping` the current viewport.
 * 2. `effLevel` -- the bounded-promotion effective level without the
 *    viewport boost; breaks `levelAdjusted` ties the viewport boost caused.
 * 3. `matchClassRank` -- `exact` 0, `prefix` 1, `word-prefix` 2,
 *    `substring` 3. Only reached once (1) and (2) have already tied, which
 *    happens exactly when an `exact` match's promoted level lands on the
 *    same rung as a lower-match-class row's unpromoted level -- this is
 *    where the bounded promotion actually resolves in the exact match's
 *    favour.
 * 4. `level` -- the true, unpromoted admin level. Final level-based
 *    tiebreak for anything still tied (normally redundant with (2)/(3),
 *    but kept as the honest "ADM0 before ADM1" fallback the original spec
 *    asked for).
 * 5. `areaKm2` descending, `null`/`undefined` sorted last -- the
 *    importance signal: among same-level, same-match-class rows, the
 *    bigger (or more complete) feature wins. Point-only localities with no
 *    `area_km2` always sort after ones that have it.
 * 6. `nameLength` ascending -- "Contra Costa" before "Contra Costa Centre".
 * 7. `nameNorm` ascending, then `featureId` ascending -- deterministic,
 *    testable tiebreak.
 *
 * Why `effLevel` is bounded rather than matchClass dominating outright
 * (the pre-amendment behaviour): see the design doc's measured-examples
 * table. In short, an unbounded "exact always beats prefix" rule buries
 * Baghdad (a `prefix` match on "bag") under every administrative unit
 * literally named "Bag" worldwide; an unbounded "level always wins" rule
 * (no promotion at all) buries the obvious "Paris, France" under ADM0/ADM1
 * noise matches one level up (translated country names, "Parish"
 * word-prefix hits). A *bounded* promotion -- exact beats prefix/word-
 * prefix/substring across one level gap, never more -- fixes the Paris
 * case (a one-level gap) without manufacturing a false win for an exact
 * ADM4 match against an ADM0/ADM1 noise row three or four levels away.
 *
 * @param {{ rank: ReturnType<typeof rankRow>, nameNorm: string, featureId: string }} a
 * @param {{ rank: ReturnType<typeof rankRow>, nameNorm: string, featureId: string }} b
 * @returns {number}
 */
export function compareRanked(a, b) {
  if (a.rank.levelAdjusted !== b.rank.levelAdjusted) return a.rank.levelAdjusted - b.rank.levelAdjusted;

  if (a.rank.effLevel !== b.rank.effLevel) return a.rank.effLevel - b.rank.effLevel;

  const mcA = MATCH_CLASS_RANK[a.rank.matchClass];
  const mcB = MATCH_CLASS_RANK[b.rank.matchClass];
  if (mcA !== mcB) return mcA - mcB;

  if (a.rank.level !== b.rank.level) return a.rank.level - b.rank.level;

  const areaA = areaOrNegInf(a.rank.areaKm2);
  const areaB = areaOrNegInf(b.rank.areaKm2);
  if (areaA !== areaB) return areaB - areaA; // descending

  if (a.rank.nameLength !== b.rank.nameLength) return a.rank.nameLength - b.rank.nameLength;

  if (a.nameNorm !== b.nameNorm) return a.nameNorm < b.nameNorm ? -1 : 1;

  if (a.featureId !== b.featureId) return a.featureId < b.featureId ? -1 : 1;

  return 0;
}

/**
 * Derived `0..1` display score. Never used for sorting (the comparator
 * above is the sort), purely a convenience for a UI confidence bar.
 * @param {ReturnType<typeof rankRow>} rank
 * @returns {number}
 */
export function scoreOf(rank) {
  const mc = 1 - MATCH_CLASS_RANK[rank.matchClass] / 4; // 1, .75, .5, .25
  const vr = 1 - VIEWPORT_RANK[rank.viewportRank] / 4;
  return Math.max(0, Math.min(1, 0.7 * mc + 0.3 * vr));
}

/**
 * Collapse results identical in `(nameNorm, country, level)` to the single
 * best one (largest `areaKm2`; `null`/`undefined` loses), annotating the
 * kept row with `moreCount` (how many were collapsed into it) when more
 * than one shared the key. Input order (assumed already rank-sorted) is
 * preserved: a key's output position is wherever it *first* appears in
 * `sorted`, even though the row shown there may be a different array
 * element (the one with the biggest area).
 *
 * This is the direct fix for the reported bug: eight villages literally
 * named "Bag" in India, ADM4, collapse to one "Bag (+7 more)" row instead
 * of flooding the result list.
 *
 * @template {{ nameNorm: string, country: string, level: number, areaKm2?: number }} T
 * @param {readonly T[]} sorted
 * @returns {(T & { moreCount?: number })[]}
 */
export function dedupeByNameCountryLevel(sorted) {
  const dedupeKey = (r) => `${r.nameNorm}\u0000${r.country}\u0000${r.level}`;

  const groups = new Map();
  for (const r of sorted) {
    const key = dedupeKey(r);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  const seen = new Set();
  const out = [];
  for (const r of sorted) {
    const key = dedupeKey(r);
    if (seen.has(key)) continue;
    seen.add(key);

    const group = groups.get(key);
    let rep = group[0];
    let bestArea = areaOrNegInf(rep.areaKm2);
    for (let i = 1; i < group.length; i++) {
      const area = areaOrNegInf(group[i].areaKm2);
      if (area > bestArea) {
        rep = group[i];
        bestArea = area;
      }
    }
    out.push(group.length > 1 ? { ...rep, moreCount: group.length - 1 } : rep);
  }
  return out;
}

/**
 * Cap results per `(country, level)` group at `maxPerGroup`, dropping
 * entries beyond the cap but continuing to scan for lower-ranked entries
 * from *other* groups to fill the remainder of the list (the caller slices
 * to the requested `limit` afterwards). Assumes `rows` is already
 * rank-sorted, so "the first `maxPerGroup` per group" means "the
 * best-ranked `maxPerGroup` per group".
 *
 * @template {{ country: string, level: number }} T
 * @param {readonly T[]} rows
 * @param {number} maxPerGroup
 * @returns {T[]}
 */
export function capPerCountryLevelGroup(rows, maxPerGroup) {
  const counts = new Map();
  const kept = [];
  for (const r of rows) {
    const key = `${r.country}\u0000${r.level}`;
    const count = counts.get(key) ?? 0;
    if (count >= maxPerGroup) continue;
    counts.set(key, count + 1);
    kept.push(r);
  }
  return kept;
}

/**
 * Apply result diversity to an already rank-sorted list: dedupe identical
 * `(nameNorm, country, level)` rows, then cap per `(country, level)`.
 * Does NOT slice to a limit -- the caller does that, after diversity, so
 * capped-out groups make room for the next-ranked *distinct* groups rather
 * than shrinking the result count.
 *
 * @template {{ nameNorm: string, country: string, level: number, areaKm2?: number }} T
 * @param {readonly T[]} sorted
 * @param {{ dedupe?: boolean, maxPerGroup?: number|null }} [options]
 * @returns {(T & { moreCount?: number })[]}
 */
export function applyDiversity(sorted, options = {}) {
  const { dedupe = DEFAULT_DIVERSITY.dedupe, maxPerGroup = DEFAULT_DIVERSITY.maxPerGroup } = options;
  let rows = dedupe ? dedupeByNameCountryLevel(sorted) : sorted.slice();
  if (maxPerGroup != null) rows = capPerCountryLevelGroup(rows, maxPerGroup);
  return rows;
}
