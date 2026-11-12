// @cnmw/geocoder-core -- the six-component total-order ranking (design doc
// §3.2 "The ranking rule, normatively").
//
// Pure functions, no I/O, no DOM: easy to unit test independently of the
// index loader.

import { bboxesIntersect, bboxContainsPoint, bboxCenter, scaleBBox } from '@cnmw/spec';

/** @typedef {import('@cnmw/spec').BBox} BBox */
/** @typedef {'exact'|'prefix'|'word-prefix'|'substring'} MatchClass */
/** @typedef {'inside'|'overlap'|'near'|'outside'} ViewportRank */

export const MATCH_CLASS_RANK = { exact: 0, prefix: 1, 'word-prefix': 2, substring: 3 };
export const VIEWPORT_RANK = { inside: 0, overlap: 1, near: 2, outside: 3 };

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
 * @param {{ nameNorm: string, level: number, bbox: BBox, featureId: string }} row
 * @param {string} queryNorm
 * @param {{
 *   viewport?: BBox,
 *   viewportBoost: number,
 *   nearFactor: number,
 *   matchClasses: readonly MatchClass[],
 * }} options
 * @returns {{ matchClass: MatchClass, level: number, levelAdjusted: number, viewportRank: ViewportRank, nameLength: number } | null}
 */
export function rankRow(row, queryNorm, options) {
  const matchClass = classifyMatch(row.nameNorm, queryNorm, options.matchClasses);
  if (matchClass === null) return null;
  const viewportRank = computeViewportRank(row.bbox, options.viewport, options.nearFactor);
  const boostEligible = viewportRank === 'inside' || viewportRank === 'overlap';
  const levelAdjusted = row.level - (boostEligible ? options.viewportBoost : 0);
  return {
    matchClass,
    level: row.level,
    levelAdjusted,
    viewportRank,
    nameLength: row.nameNorm.length,
  };
}

/**
 * The total-order comparator over two ranked rows (ascending = better
 * first), per design doc §3.2's six components:
 * 1. matchClassRank  2. levelAdjusted  3. level  4. viewportRank
 * 5. nameLength asc  6. nameNorm asc, then featureId asc.
 *
 * @param {{ rank: ReturnType<typeof rankRow>, nameNorm: string, featureId: string }} a
 * @param {{ rank: ReturnType<typeof rankRow>, nameNorm: string, featureId: string }} b
 * @returns {number}
 */
export function compareRanked(a, b) {
  const mcA = MATCH_CLASS_RANK[a.rank.matchClass];
  const mcB = MATCH_CLASS_RANK[b.rank.matchClass];
  if (mcA !== mcB) return mcA - mcB;

  if (a.rank.levelAdjusted !== b.rank.levelAdjusted) return a.rank.levelAdjusted - b.rank.levelAdjusted;

  if (a.rank.level !== b.rank.level) return a.rank.level - b.rank.level;

  const vrA = VIEWPORT_RANK[a.rank.viewportRank];
  const vrB = VIEWPORT_RANK[b.rank.viewportRank];
  if (vrA !== vrB) return vrA - vrB;

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
