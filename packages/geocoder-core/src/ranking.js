// @cnmw/geocoder-core -- the ranking total-order + result-diversity logic
// (design doc §3.2 "The ranking rule, normatively", amended 2026-11-12 on
// user feedback against the Overture-scale index -- see the amendment's
// measured-examples table for why the order below is what it is).
//
// Pure functions, no I/O, no DOM: easy to unit test independently of the
// index loader.

import { bboxesIntersect, bboxContainsPoint, bboxCenter, scaleBBox } from '@cnmw/spec';

/** @typedef {import('@cnmw/spec').BBox} BBox */
/** @typedef {'exact'|'prefix'|'word-prefix'|'substring'|'fuzzy'} MatchClass */
/** @typedef {'inside'|'overlap'|'near'|'outside'} ViewportRank */

// `fuzzy` (design doc §3.2 amendment, 2026-11-13): produced only by the
// fuzzy fallback (see fuzzy.js), never by `classifyMatch` -- a fuzzy rank
// ranks below every real match class by construction, though in practice
// the two kinds never meet in one result list (the fallback only runs when
// the normal search matched nothing at all).
export const MATCH_CLASS_RANK = { exact: 0, prefix: 1, 'word-prefix': 2, substring: 3, fuzzy: 4 };
export const VIEWPORT_RANK = { inside: 0, overlap: 1, near: 2, outside: 3 };

/** Default admin-level promotion granted to an `exact` match over a
 *  `prefix`/`word-prefix`/`substring` match at the next level up, per the
 *  2026-11-12 amendment. See `compareRanked`'s doc comment. */
export const DEFAULT_EXACT_LEVEL_PROMOTION = 1;

/** Default admin-level demotion applied to a `prefix`/`word-prefix`/
 *  `substring` match against an alt-name row (`isAlt`), per the
 *  2026-11-12 "alt-demotion" follow-up amendment -- the mirror image of
 *  `DEFAULT_EXACT_LEVEL_PROMOTION` above. An `exact` match against an
 *  alt-name row is deliberately exempt (demotion `0`): see `rankRow`'s
 *  doc comment for why. */
export const DEFAULT_ALT_LEVEL_DEMOTION = 1;

/** Default population at or above which a row earns the bounded
 *  population promotion below (`DEFAULT_POPULATION_LEVEL_PROMOTION`), per
 *  the 2026-11-12 "population-promotion" follow-up amendment -- the third
 *  bounded `effLevel` adjustment, alongside the exact-match promotion and
 *  the alt-row demotion above.
 *
 *  **Chosen from measurement, not taste.** Swept live against the Who's
 *  On First names index (9.48M rows; `population` populated on 4,075 of
 *  the 12,800 rows in the row group holding "brooklyn", so ~32%) for the
 *  query "brooklyn", whose target -- Brooklyn the New York borough,
 *  `level` 4, `population` 2,504,700 -- did not appear in the top 8 at
 *  all, buried below `localadmin` townships of 318-11,022 people whose
 *  `level` 3 decided the comparison at component (1), before any
 *  prominence tiebreak was reached. Five thresholds, same script, same
 *  seven other queries (full tables in the amendment):
 *
 *  - `10_000`: **breaks the target case outright.** Brooklyn, Ohio
 *    (`level` 3, population 11,022) clears the threshold too, is promoted
 *    to `effLevel` 1, and takes position 1 *from* the borough, which lands
 *    at 2. Also pulls Brooklyn Park (75,781) and Brooklyn Center (30,104)
 *    -- `prefix` matches, not even exact -- into positions 4-5. The WOF
 *    population distribution's p90 is ~13.8k, so a 10k threshold promotes
 *    roughly a tenth of every populated row and discriminates nothing.
 *  - `50_000`: fixes the target (borough at 1). Costs one place on
 *    "brooklyn": Brooklyn Park, Minnesota (75,781) is promoted to
 *    `effLevel` 2 and takes position 4 as a mere `prefix` match, pushing
 *    an `exact` "Brooklyn" (uMlalazi, ZAF) out of the top 8. Slightly
 *    *better* than `100_000` on Overture's "bag": Bagua, Peru (95,858)
 *    clears 50k and rises 6 -> 2.
 *  - `100_000`: **shipped.** Fixes the target (borough at 1) with no
 *    `prefix`-over-`exact` inversion anywhere in the eight measured
 *    query/index pairs. Best measured "springfield": Springfield,
 *    Massachusetts (153,672) at 1 and Springfield, Missouri (171,589) at
 *    2, i.e. the two genuinely large Springfields on top, ordered by
 *    level-then-population exactly as the bounded design intends.
 *  - `250_000`: identical to `100_000` on seven of the eight pairs, but
 *    drops Springfield, Missouri (171,589) from position 2 to 6 -- the
 *    second-most-obvious thing the promotion should fix, lost.
 *  - `1_000_000`: still fixes "brooklyn" (2.5M) and "baghdad" (7.2M), but
 *    loses Springfield, Missouri the same way *and* London, Ontario
 *    (346,765, position 3 at `100_000`, position 6 here). Cleanest "paris"
 *    of the five, which is the one argument in its favour. Too high.
 *
 *  `100_000` is where the two measured failure modes meet: below it,
 *  `prefix`-matched mid-size towns start out-ranking `exact` matches on
 *  the queried name; above it, genuinely large cities (Springfield MO,
 *  London ON) stop being reachable. It is not a plateau -- every
 *  neighbouring value measurably changes something -- so it is a real
 *  choice between measured costs, not a round number picked for looks.
 *  Override per `Geocoder` with
 *  `ranking: { populationPromotionThreshold: n }`; `Infinity` disables the
 *  promotion entirely and restores the pre-amendment `effLevel`s. */
export const DEFAULT_POPULATION_PROMOTION_THRESHOLD = 100_000;

/** Default admin-level promotion granted to a row whose `population` is at
 *  or above `DEFAULT_POPULATION_PROMOTION_THRESHOLD`. **Bounded to one
 *  level**, exactly like `DEFAULT_EXACT_LEVEL_PROMOTION` and
 *  `DEFAULT_ALT_LEVEL_DEMOTION`: a 2.5-million-person `level` 4 borough is
 *  treated as a `level` 3 for ordering purposes, never as a `level` 0
 *  country. See `rankRow` and `compareRanked`. */
export const DEFAULT_POPULATION_LEVEL_PROMOTION = 1;

/** Default result-diversity options (design doc §3.2 amendment, "Result
 *  diversity"): collapse exact (name_norm, country, level) duplicates to
 *  one row, then cap at 3 rows per (country, level) group. */
export const DEFAULT_DIVERSITY = {
  dedupe: true,
  maxPerGroup: 3,
};

/** How many collapsed rows `dedupeByNameCountryLevel` attaches to a
 *  dedupe group's representative row, as `collapsed[]` (expandable "+N
 *  more" follow-up, task 2). `moreCount` itself is never capped -- it is
 *  always the group's true collapsed count -- only the array of
 *  individually-addressable rows a UI can expand into is. */
export const MAX_COLLAPSED_ROWS = 10;

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
 * @param {{ nameNorm: string, level: number, bbox: BBox, featureId: string, areaKm2?: number|null, population?: number|bigint|null, class?: string|null, isAlt?: boolean }} row
 * @param {string} queryNorm
 * @param {{
 *   viewport?: BBox,
 *   viewportBoost: number,
 *   nearFactor: number,
 *   matchClasses: readonly MatchClass[],
 *   exactLevelPromotion?: number,
 *   altLevelDemotion?: number,
 *   populationPromotionThreshold?: number,
 *   populationLevelPromotion?: number,
 * }} options
 * @returns {{ matchClass: MatchClass, level: number, effLevel: number, levelAdjusted: number, viewportRank: ViewportRank, nameLength: number, areaKm2: number|undefined, population: number|undefined, class: string|undefined, isAlt: boolean } | null}
 */
export function rankRow(row, queryNorm, options) {
  const matchClass = classifyMatch(row.nameNorm, queryNorm, options.matchClasses);
  if (matchClass === null) return null;
  const viewportRank = computeViewportRank(row.bbox, options.viewport, options.nearFactor);
  const boostEligible = viewportRank === 'inside' || viewportRank === 'overlap';
  const isAlt = Boolean(row.isAlt);
  const isExact = matchClass === 'exact';

  // Bounded exact-match promotion (2026-11-12 amendment): an `exact` match
  // is treated as if it sat `exactLevelPromotion` admin levels higher
  // (closer to ADM0) than it really does, when deciding level order. This
  // is what lets an exact ADM3 "Paris" beat a `prefix`/`word-prefix` match
  // one level up (an ADM1/ADM2 noise row), without letting an exact ADM4
  // "Bag" beat an ADM0 country three levels up -- see `compareRanked`.
  const promotion = isExact ? (options.exactLevelPromotion ?? DEFAULT_EXACT_LEVEL_PROMOTION) : 0;

  // Bounded alt-row demotion (2026-11-12 "alt-demotion" follow-up,
  // mirroring the promotion above): a `prefix`/`word-prefix`/`substring`
  // match against an alt-name row (`isAlt`) is treated as if it sat
  // `altLevelDemotion` admin levels *lower* (farther from ADM0) than it
  // really does. This is what lets a primary-name match one level up tie
  // -- and then win the `isAlt` tiebreak in `compareRanked` -- against an
  // alt-name match that would otherwise out-rank it purely on its
  // division's raw level (the residual the 2026-11-12 ranking-residual
  // follow-up's `isAlt` tiebreak measured but could not reach on its own,
  // since that tiebreak only applies once every level-based component
  // already ties). **Exempted for an `exact` match** (`isExact` guards
  // this below): typing the alt name in full -- "Deutschland", "中国" --
  // is a deliberate, high-confidence query in that language, and
  // penalizing it would be exactly backwards from what alt names are for.
  const demotion = isAlt && !isExact ? (options.altLevelDemotion ?? DEFAULT_ALT_LEVEL_DEMOTION) : 0;

  // Bounded population promotion (2026-11-12 "population-promotion"
  // follow-up, the third adjustment of the same shape as the two above): a
  // row whose `population` is at or above `populationPromotionThreshold`
  // is treated as if it sat `populationLevelPromotion` (default `1`) admin
  // levels *higher* (closer to ADM0) than it really does. This is what
  // lets Brooklyn-the-borough (WOF `level` 4, population 2,504,700) reach
  // the same `effLevel` rung as the `level`-3 `localadmin` townships of
  // 300-11,000 people that otherwise decide "brooklyn" outright at
  // `compareRanked` component (1), long before the prominence tiebreak is
  // reached. See `DEFAULT_POPULATION_PROMOTION_THRESHOLD` for the measured
  // threshold sweep and `compareRanked` for why prominence had to move
  // ahead of raw `level` for this adjustment to be able to decide anything.
  //
  // **`demotion === 0` is the one gate, and it is measured, not
  // defensive.** A row that took the alt demotion does *not* also get the
  // population promotion: the two are the same magnitude and would exactly
  // cancel, handing a non-exact alt-name match back the level privilege the
  // alt demotion exists to take away -- on the strength of the population
  // of the division whose name it merely transliterates. Measured both
  // ways, same queries, same script:
  //  - ungated, "paris" (WOF): the Jamaican ADM1 alt rows "Parish of Saint
  //    Catherine" (516,218), "Parish of Manchester" (189,797) and "Parish
  //    of Saint James" (183,811) -- `prefix` matches -- have their
  //    demotion cancelled, reach `effLevel` 1 and take positions 3-5,
  //    pushing the `exact` "Paris, Paris, FRA" row (2,138,551) down to 6.
  //    A `prefix` hit on a Jamaican parish out-ranking an `exact` hit on
  //    Paris is plainly the wrong answer.
  //  - ungated, "bag" (Overture): "Bagraain" (an alt spelling of Bahrain,
  //    ADM0, 1,234,571) has its demotion cancelled and keeps position 1 --
  //    re-opening precisely the bug the 2026-11-12 alt-demotion amendment
  //    closed.
  //  - gated (shipped): "paris" positions 1-4 are all genuine Paris rows
  //    and the parishes fall to 6-8, *better* than the pre-amendment
  //    baseline; "bag" position 1 becomes Bağcılar (TUR ADM2, primary,
  //    719,071), clearing all four Bahrain/Bahamas ADM0 alt rows for the
  //    first time -- the improvement the alt-demotion amendment wanted and
  //    measured itself unable to reach.
  // Brooklyn and Baghdad are untouched by the gate: their English-language
  // rows *are* alt rows, but they are `exact` matches, so `isExact` already
  // exempted them from the demotion and the gate is open for them. That is
  // also why the promotion is not restricted to primary rows -- a `!isAlt`
  // gate would leave both target cases exactly where they started.
  const population = toPopulation(row.population);
  const populationThreshold = options.populationPromotionThreshold ?? DEFAULT_POPULATION_PROMOTION_THRESHOLD;
  const populationPromotion =
    demotion === 0 && population !== undefined && population >= populationThreshold
      ? (options.populationLevelPromotion ?? DEFAULT_POPULATION_LEVEL_PROMOTION)
      : 0;

  const effLevel = Math.max(0, row.level - promotion + demotion - populationPromotion);
  const levelAdjusted = effLevel - (boostEligible ? options.viewportBoost : 0);

  return {
    matchClass,
    level: row.level,
    effLevel,
    levelAdjusted,
    viewportRank,
    nameLength: row.nameNorm.length,
    areaKm2: typeof row.areaKm2 === 'number' && !Number.isNaN(row.areaKm2) ? row.areaKm2 : undefined,
    population,
    class: typeof row.class === 'string' ? row.class : undefined,
    isAlt,
  };
}

/**
 * Build the rank record for one row matched by the **fuzzy fallback**
 * (design doc §3.2 amendment, 2026-11-13; adapted from Development Seed's
 * gazet, see fuzzy.js's module comment for the full credit and the parts
 * taken). The shape is `rankRow`'s with `matchClass: 'fuzzy'` plus the two
 * fuzzy signals (`similarity`, `substring`), so a fuzzy result flows
 * through `applyDiversity`, `scoreOf` and every consumer of
 * `SearchResult.rank` unchanged.
 *
 * Reuses `rankRow`'s measured `effLevel` machinery rather than
 * reimplementing it, with the one difference that follows from what a
 * fuzzy match *is*: there is no exact-match promotion (a fuzzy match is
 * never exact -- an exact match would have been found by the normal
 * search and the fallback would not be running). The alt-row demotion and
 * the population promotion (and their mutual-exclusion gate) apply
 * exactly as in `rankRow` -- a typo'd "bagdhad" should still surface
 * Baghdad-the-7-million-person-city over a hamlet spelled closer.
 *
 * @param {{ nameNorm: string, level: number, bbox: BBox, featureId: string, areaKm2?: number|null, population?: number|bigint|null, class?: string|null, isAlt?: boolean }} row
 * @param {{ similarity: number, substring: boolean }} fuzzy
 * @param {Parameters<typeof rankRow>[2]} options
 * @returns {(ReturnType<typeof rankRow> & { similarity: number, substring: boolean })}
 */
export function rankFuzzyRow(row, fuzzy, options) {
  const viewportRank = computeViewportRank(row.bbox, options.viewport, options.nearFactor);
  const boostEligible = viewportRank === 'inside' || viewportRank === 'overlap';
  const isAlt = Boolean(row.isAlt);
  const demotion = isAlt ? (options.altLevelDemotion ?? DEFAULT_ALT_LEVEL_DEMOTION) : 0;
  const population = toPopulation(row.population);
  const populationThreshold = options.populationPromotionThreshold ?? DEFAULT_POPULATION_PROMOTION_THRESHOLD;
  const populationPromotion =
    demotion === 0 && population !== undefined && population >= populationThreshold
      ? (options.populationLevelPromotion ?? DEFAULT_POPULATION_LEVEL_PROMOTION)
      : 0;
  const effLevel = Math.max(0, row.level + demotion - populationPromotion);
  const levelAdjusted = effLevel - (boostEligible ? options.viewportBoost : 0);
  return {
    matchClass: 'fuzzy',
    level: row.level,
    effLevel,
    levelAdjusted,
    viewportRank,
    nameLength: row.nameNorm.length,
    areaKm2: typeof row.areaKm2 === 'number' && !Number.isNaN(row.areaKm2) ? row.areaKm2 : undefined,
    population,
    class: typeof row.class === 'string' ? row.class : undefined,
    isAlt,
    similarity: fuzzy.similarity,
    substring: fuzzy.substring,
  };
}

/**
 * Comparator for fuzzy-fallback result lists (every row's rank built by
 * `rankFuzzyRow`): the two fuzzy signals decide first -- substring
 * containment over everything (gazet's measured call: literal containment
 * is a stronger true-match signal than a higher edit-distance score),
 * then similarity descending -- and everything still tied falls through
 * to `compareRanked`, i.e. the exact viewport/level/prominence order every
 * other result list already sorts by.
 * @param {{ rank: ReturnType<typeof rankFuzzyRow>, nameNorm: string, featureId: string }} a
 * @param {{ rank: ReturnType<typeof rankFuzzyRow>, nameNorm: string, featureId: string }} b
 * @returns {number}
 */
export function compareFuzzyRanked(a, b) {
  const subA = a.rank.substring ? 1 : 0;
  const subB = b.rank.substring ? 1 : 0;
  if (subA !== subB) return subB - subA;
  if (a.rank.similarity !== b.rank.similarity) return b.rank.similarity - a.rank.similarity;
  return compareRanked(a, b);
}

/**
 * Coerce a decoded `population` cell to a usable finite number, or
 * `undefined` when the row has no usable population.
 *
 * **Why a `bigint` branch exists (2026-11-12 population-promotion
 * follow-up).** `population` is an `INT64` column in the Who's On First
 * names index, and `hyparquet` decodes `INT64` as a JavaScript `BigInt`,
 * not a `number`. Every `typeof x === 'number'` guard in this file and in
 * `geocoder.js` therefore rejected it silently: measured live against the
 * WOF index, *zero* of the 109 "brooklyn" candidate rows reported a
 * population through `SearchResult.population`, even though 4,075 of the
 * 12,800 rows in the row group holding them carry one in the Parquet file
 * (Brooklyn the borough among them, at 2,504,700). This is the real reason
 * the prominence tiebreak (`compareRanked` component (5)) was still a
 * measured no-op on WOF after the alt-demotion amendment declared it live
 * on Overture -- Overture's own `population` column is 32-bit and decodes
 * as a plain `number`, so the bug was invisible there.
 *
 * @param {number|bigint|null|undefined} value
 * @returns {number|undefined}
 */
function toPopulation(value) {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function areaOrNegInf(areaKm2) {
  return typeof areaKm2 === 'number' ? areaKm2 : -Infinity;
}

// Ranking-residual follow-up (design doc §3.2 amendment, "Known residual
// limitation" / task 5). **This comment used to say `class` and
// `population` were "pending data columns, not yet populated on any
// shipped index"; that is no longer true and was corrected by the
// 2026-11-12 population-promotion follow-up.** Measured live: the
// published Overture divisions index populates both (Baghdad: `class`
// 'city', `population` 7,216,040), and the Who's On First names index
// populates `population` on roughly a third of its rows (4,075 of the
// 12,800 in the row group holding "brooklyn") but carries no `class`
// column at all, so WOF rows take the tier-1 `class` fallback below only
// when their own `population` is null. `CLASS_RANK` is the fixed ladder
// named in the original task: city outranks town outranks village
// outranks hamlet outranks anything else (an unrecognized class string,
// or no class at all).
const CLASS_RANK = { city: 0, town: 1, village: 2, hamlet: 3 };
const UNRANKED_CLASS = 4;

function classRankOf(klass) {
  if (typeof klass !== 'string') return UNRANKED_CLASS;
  return CLASS_RANK[klass.toLowerCase()] ?? UNRANKED_CLASS;
}

/**
 * Prominence tiebreak: `population` wins when present on a row (compared
 * descending, so bigger population = more prominent), falling back to the
 * fixed `class` ladder above when it is absent. Returns a `[tier, key]`
 * pair so `compareRanked` can compare it lexicographically: tier 0 (a real
 * `population` number) always outranks tier 1 (no population, class-rank
 * fallback), and within a tier the second element is the real comparison
 * key. When both columns are absent on every row (a geoBoundaries CGAZ
 * index, say, which carries neither), every row gets `[1, 4]` and this is
 * a pure no-op -- the comparator falls straight through to `areaKm2`,
 * exactly as before this existed.
 * @param {{ population?: number, class?: string }} rank
 * @returns {[number, number]}
 */
function prominenceKey(rank) {
  if (typeof rank.population === 'number' && !Number.isNaN(rank.population)) {
    return [0, -rank.population]; // tier 0; negate so ascending compare = descending population
  }
  return [1, classRankOf(rank.class)];
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
 * 4. `isAlt` -- **moved here by the 2026-11-12 alt-demotion follow-up**
 *    (originally component (5), after raw `level`; see "Why `isAlt` moved
 *    above raw `level`" below for why that placement didn't work). At
 *    equal `effLevel`/`matchClass` -- which now includes an alt-name
 *    `prefix`/`word-prefix`/`substring` match's own bounded, one-level
 *    *demotion* (`altLevelDemotion`, mirroring `exactLevelPromotion`; see
 *    `rankRow`) -- a match against a primary-name row ranks above the
 *    identical match against an alt-name row. `isAlt` is `false` for
 *    every row on an index with no `alt_of` column, so this (and the
 *    demotion that feeds it) is a no-op on such an index.
 * 5. **Prominence** -- added by the ranking-residual follow-up, and
 *    **moved here from component (6) by the 2026-11-12
 *    population-promotion follow-up** (see "Why prominence moved above
 *    raw `level`" below): `population` descending when the row carries
 *    one, else a fixed `class` ladder (`city` > `town` > `village` >
 *    `hamlet` > anything else/absent) -- see `prominenceKey`. Slots ahead
 *    of `areaKm2` per the original task ("a prominence key ... slots
 *    ahead of area_km2"), because population/class-of-place is a better
 *    importance signal *across* feature kinds (a capital city vs. a
 *    country) than area is -- see the first amendment's "Known residual
 *    limitation" for why `areaKm2` alone gets this backwards for exactly
 *    that comparison. **No longer a no-op**: the published Overture
 *    catalog populates `population` and `class`, and the Who's On First
 *    names index populates `population` on roughly a third of its rows
 *    (as an `INT64`, which is why `toPopulation` exists -- see its doc
 *    comment for the decode bug that kept this step a measured no-op on
 *    WOF until the population-promotion follow-up).
 * 6. `level` -- the true, unpromoted/undemoted/unpopulation-promoted
 *    admin level. Final level-based tiebreak for anything still tied
 *    (normally redundant with (2)-(4), but kept as the honest "ADM0
 *    before ADM1" fallback the original spec asked for).
 * 7. `areaKm2` descending, `null`/`undefined` sorted last -- the
 *    importance signal: among same-level, same-match-class rows, the
 *    bigger (or more complete) feature wins. Point-only localities with no
 *    `area_km2` always sort after ones that have it.
 * 8. `nameLength` ascending -- "Contra Costa" before "Contra Costa Centre".
 * 9. `nameNorm` ascending, then `featureId` ascending -- deterministic,
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
 * Why `isAlt` moved above raw `level` (the 2026-11-12 alt-demotion
 * follow-up): the ranking-residual follow-up's original placement -- an
 * `isAlt` tiebreak *after* raw `level` -- only ever triggered when two
 * rows already had the exact same level, which measured live against the
 * published Overture catalog, essentially never happens for the actual
 * bug (an alt-name row for an *unrelated, shallower* feature outranking a
 * deeper primary/alt match for the one the user meant): a level-0 alt
 * row's raw level (0) is less than a level-1+ row's, so the old ordering
 * -- `level` before `isAlt` -- picked the level-0 alt row every time,
 * never even reaching the `isAlt` check. `effLevel` now applies the same
 * bounded, one-level demotion to a non-exact alt match that it already
 * applies as a *promotion* to an exact match (see `rankRow`), so a
 * level-0 alt row demotes to `effLevel` 1 -- tying a genuine level-1
 * primary match, if one exists for the query, rather than beating it
 * outright. Once that tie exists, it has to be resolved by `isAlt` *before*
 * the raw-level tiebreak reopens the exact gap the demotion just closed
 * (raw `level` is still 0 vs. 1) -- hence the reordering. Like the
 * exact-match promotion, this is bounded to one level: it fixes a
 * level-0-alt-vs-level-1-primary tie, not a level-0-alt-vs-level-4-primary
 * one four levels away, which is the same honest limit as before --
 * documented, with the live measurements, in the design doc.
 *
 * Why prominence moved above raw `level` (the 2026-11-12
 * population-promotion follow-up, "the Brooklyn case"): identical in
 * structure to the `isAlt` move one amendment earlier. Searching
 * "brooklyn" on the Who's On First index put seven `localadmin`
 * townships of 318-11,022 people (`level` 3) above Brooklyn the New York
 * borough (`level` 4, population 2,504,700) -- component (1) decided it
 * outright on raw level and prominence was never reached. The bounded
 * population promotion in `rankRow` closes that one-level gap, bringing
 * the borough to `effLevel` 2 alongside the townships. But every one of
 * those rows is an `exact`, alt-name match too, so components (2), (3)
 * and (4) all tie as well, and the *old* component (5) -- raw `level`,
 * still 3 vs. 4 -- immediately re-opened the very gap the promotion had
 * just closed, exactly as raw `level` did to the alt demotion. Prominence
 * is the component that has to resolve a tie the promotion manufactured
 * *from* prominence, so it has to be consulted before raw `level`.
 * Measured consequence of the move on its own (no regression on any of
 * the seven other queries in the amendment's tables): it only ever
 * changes the order of rows that already tie on `levelAdjusted`,
 * `effLevel`, `matchClass` *and* `isAlt` while differing in raw `level`
 * -- which, by construction, happens only when one of the three bounded
 * `effLevel` adjustments put them on the same rung in the first place.
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

  // isAlt before raw level (2026-11-12 alt-demotion follow-up; see "Why
  // isAlt moved above raw level" below): checking raw level first would
  // undo the demotion `effLevel` just applied, since a demoted alt row's
  // raw level is still shallower than the primary it was demoted to tie
  // with.
  if (a.rank.isAlt !== b.rank.isAlt) return (a.rank.isAlt ? 1 : 0) - (b.rank.isAlt ? 1 : 0);

  // Prominence before raw level (2026-11-12 population-promotion
  // follow-up; see "Why prominence moved above raw `level`" below). Same
  // structural reason `isAlt` moved above raw `level` one amendment
  // earlier: raw `level` re-opens the exact one-level gap an `effLevel`
  // adjustment just closed, so any adjustment whose whole purpose is to
  // create a tie has to have that tie resolved before raw `level` is
  // consulted.
  const [tierA, prominenceA] = prominenceKey(a.rank);
  const [tierB, prominenceB] = prominenceKey(b.rank);
  if (tierA !== tierB) return tierA - tierB;
  if (prominenceA !== prominenceB) return prominenceA - prominenceB;

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
  // A fuzzy match's class component is its similarity scaled into the band
  // *below* `substring`'s fixed 0.25 -- so a confidence bar always shows a
  // fuzzy result as less certain than any real match class, and more-alike
  // fuzzy results as more certain than less-alike ones.
  const mc = rank.matchClass === 'fuzzy'
    ? 0.25 * (rank.similarity ?? 0)
    : 1 - MATCH_CLASS_RANK[rank.matchClass] / 4; // 1, .75, .5, .25
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
 * **Expandable "+N more" follow-up (task 2).** The pre-follow-up version
 * of this function discarded every collapsed row outright -- `moreCount`
 * told a UI *how many* were hidden, but gave it nothing to expand into.
 * Every row collapsed into a group (other than the kept representative),
 * up to `MAX_COLLAPSED_ROWS` of them, is now kept too, reduced to the
 * minimal fields a UI needs to render and select one directly -- `name`,
 * `featureId`, `level` -- as `collapsed[]` on the representative.
 * `country` and `nameNorm` are deliberately omitted: they are, by
 * construction, identical to the representative's own for every row in
 * the group, so a UI reconstructing a selectable result from a collapsed
 * entry gets them from the parent row it expanded, not duplicated here.
 * `moreCount` itself is never capped by `MAX_COLLAPSED_ROWS` -- it stays
 * the group's true count -- only `collapsed` (the array of individually
 * expandable rows) is, so an absurdly large group (hundreds of
 * identically-named hamlets) still reports its real size without forcing
 * every one of them into memory/the DOM.
 *
 * @template {{ nameNorm: string, country: string, level: number, name: string, featureId: string, areaKm2?: number }} T
 * @param {readonly T[]} sorted
 * @returns {(T & { moreCount?: number, collapsed?: { name: string, featureId: string, level: number }[] })[]}
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
    if (group.length > 1) {
      const collapsed = group
        .filter((g) => g !== rep)
        .slice(0, MAX_COLLAPSED_ROWS)
        .map((g) => ({ name: g.name, featureId: g.featureId, level: g.level }));
      out.push({ ...rep, moreCount: group.length - 1, collapsed });
    } else {
      out.push(rep);
    }
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
 * A row the dedupe step collapses carries its `collapsed[]` siblings
 * through capping unchanged -- `capPerCountryLevelGroup` only ever drops
 * whole (already-deduped) rows, never reaches inside one, so a group that
 * survives the cap keeps every collapsed row it had.
 *
 * @template {{ nameNorm: string, country: string, level: number, name: string, featureId: string, areaKm2?: number }} T
 * @param {readonly T[]} sorted
 * @param {{ dedupe?: boolean, maxPerGroup?: number|null }} [options]
 * @returns {(T & { moreCount?: number, collapsed?: { name: string, featureId: string, level: number }[] })[]}
 */
export function applyDiversity(sorted, options = {}) {
  const { dedupe = DEFAULT_DIVERSITY.dedupe, maxPerGroup = DEFAULT_DIVERSITY.maxPerGroup } = options;
  let rows = dedupe ? dedupeByNameCountryLevel(sorted) : sorted.slice();
  if (maxPerGroup != null) rows = capPerCountryLevelGroup(rows, maxPerGroup);
  return rows;
}
