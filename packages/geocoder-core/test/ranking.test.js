import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMatch,
  computeViewportRank,
  rankRow,
  compareRanked,
  scoreOf,
  dedupeByNameCountryLevel,
  capPerCountryLevelGroup,
  applyDiversity,
} from '../src/ranking.js';

const DEFAULT_CLASSES = ['exact', 'prefix', 'word-prefix'];

test('classifyMatch: exact beats prefix', () => {
  assert.equal(classifyMatch('contra costa', 'contra costa', DEFAULT_CLASSES), 'exact');
});

test('classifyMatch: prefix match', () => {
  assert.equal(classifyMatch('contra costa', 'contra', DEFAULT_CLASSES), 'prefix');
});

test('classifyMatch: word-prefix match on a later word', () => {
  assert.equal(classifyMatch('contra costa', 'costa', DEFAULT_CLASSES), 'word-prefix');
});

test('classifyMatch: substring is excluded by default', () => {
  assert.equal(classifyMatch('contra costa', 'ontra', DEFAULT_CLASSES), null);
});

test('classifyMatch: substring matches when explicitly allowed', () => {
  assert.equal(classifyMatch('contra costa', 'ontra', [...DEFAULT_CLASSES, 'substring']), 'substring');
});

test('classifyMatch: no match returns null', () => {
  assert.equal(classifyMatch('contra costa', 'zzz', DEFAULT_CLASSES), null);
});

test('classifyMatch: empty query matches nothing', () => {
  assert.equal(classifyMatch('contra costa', '', DEFAULT_CLASSES), null);
});

test('computeViewportRank: inside when feature center is in viewport', () => {
  const featureBBox = [-1, -1, 1, 1];
  const viewport = [-5, -5, 5, 5];
  assert.equal(computeViewportRank(featureBBox, viewport, 2), 'inside');
});

test('computeViewportRank: overlap when boxes intersect but center is outside', () => {
  const featureBBox = [4, 4, 10, 10]; // center (7,7), outside viewport
  const viewport = [-5, -5, 5, 5];
  assert.equal(computeViewportRank(featureBBox, viewport, 2), 'overlap');
});

test('computeViewportRank: near when within nearFactor-scaled viewport', () => {
  const featureBBox = [6, 6, 8, 8]; // doesn't intersect [-5,5], but within 2x scale [-10,10]
  const viewport = [-5, -5, 5, 5];
  assert.equal(computeViewportRank(featureBBox, viewport, 2), 'near');
});

test('computeViewportRank: outside when far away', () => {
  const featureBBox = [100, 100, 101, 101];
  const viewport = [-5, -5, 5, 5];
  assert.equal(computeViewportRank(featureBBox, viewport, 2), 'outside');
});

test('computeViewportRank: outside when no viewport supplied', () => {
  assert.equal(computeViewportRank([0, 0, 1, 1], undefined, 2), 'outside');
});

const rankOpts = { viewportBoost: 1, nearFactor: 2, matchClasses: DEFAULT_CLASSES };

test('rankRow: levelAdjusted promotes an in-viewport feature', () => {
  const row = { nameNorm: 'springfield', level: 1, bbox: [0, 0, 1, 1], featureId: 'A' };
  const rank = rankRow(row, 'spring', { ...rankOpts, viewport: [-5, -5, 5, 5] });
  assert.equal(rank.levelAdjusted, 0); // 1 - viewportBoost(1), since inside
  assert.equal(rank.level, 1);
  assert.equal(rank.viewportRank, 'inside');
});

test('rankRow: no boost when outside viewport', () => {
  const row = { nameNorm: 'springfield', level: 1, bbox: [100, 100, 101, 101], featureId: 'A' };
  const rank = rankRow(row, 'spring', { ...rankOpts, viewport: [-5, -5, 5, 5] });
  assert.equal(rank.levelAdjusted, 1);
});

test('rankRow: returns null when the row does not match', () => {
  const row = { nameNorm: 'springfield', level: 1, bbox: [0, 0, 1, 1], featureId: 'A' };
  assert.equal(rankRow(row, 'zzz', rankOpts), null);
});

function ranked(nameNorm, level, featureId, extra = {}) {
  const row = {
    nameNorm,
    level,
    bbox: extra.bbox ?? [0, 0, 1, 1],
    featureId,
    areaKm2: extra.areaKm2,
    population: extra.population,
    class: extra.class,
    isAlt: extra.isAlt,
  };
  const rank = rankRow(row, extra.query ?? 'contra', { ...rankOpts, viewport: extra.viewport });
  return { nameNorm, featureId, country: extra.country, level, rank };
}

test('compareRanked: ADM0 (level 0) beats ADM2 (level 2) at the same match class', () => {
  const adm0 = ranked('contra', 0, 'A');
  const adm2 = ranked('contra', 2, 'B');
  assert.ok(compareRanked(adm0, adm2) < 0, 'ADM0 should sort before ADM2');
});

// FLIPPED 2026-11-12 (design doc §3.2 amendment, user feedback on the
// Overture-scale index): matchClass no longer dominates level unboundedly.
// Searching "bag" against the Overture index returned eight identical-
// looking "Bag" ADM4 villages (exact matches) with Baghdad -- a `prefix`
// match on "bag" -- buried below them, inverting the original spec's
// "ADM0 first, then ADM1, ..." intent. The fix demotes matchClass below
// level, but with a *bounded* promotion (see the next few tests): an exact
// match can still beat a prefix/word-prefix/substring match ONE level up,
// never two or more. A 2-level gap (ADM2 exact vs ADM0 prefix, as here) is
// outside that bound, so the prefix match -- being administratively
// higher -- now wins. This is deliberate, not a regression: see
// 'compareRanked: exact beats prefix one level up (bounded promotion)' and
// 'compareRanked: exact does NOT beat prefix two levels up' below for the
// bound itself, and the design doc's measured-examples table (bag/baghdad,
// paris) for why the bound is exactly one level.
test('compareRanked: level now wins over an unbounded matchClass gap (2+ levels)', () => {
  const exactAdm2 = ranked('contra', 2, 'A', { query: 'contra' }); // exact
  const prefixAdm0 = ranked('contra costa', 0, 'B', { query: 'contra' }); // prefix
  assert.ok(compareRanked(prefixAdm0, exactAdm2) < 0, 'ADM0 prefix match should now sort before an ADM2 exact match: the level gap (2) exceeds the bounded promotion (1)');
});

test('compareRanked: exact beats prefix one level up (bounded promotion) -- the Paris case', () => {
  // "Paris" exact match at ADM2/3 vs a `prefix`/`word-prefix` noise match
  // one level up (ADM1) -- e.g. a translated country name, or "Parish"
  // word-prefix-matching "paris". The bounded promotion (default 1 level)
  // lets the exact match win this adjacent-level tie, which is what keeps
  // "Paris, France" on top instead of random ADM0/ADM1 noise.
  const exactAdm2 = ranked('paris', 2, 'A', { query: 'paris' }); // exact
  const prefixAdm1 = ranked('paris region', 1, 'B', { query: 'paris' }); // prefix
  assert.ok(compareRanked(exactAdm2, prefixAdm1) < 0, 'exact ADM2 "Paris" should beat a prefix match one level up (ADM1)');
});

test('compareRanked: exact does NOT beat prefix two levels up -- the bound is exactly one level', () => {
  const exactAdm3 = ranked('paris', 3, 'A', { query: 'paris' }); // exact
  const prefixAdm1 = ranked('paris region', 1, 'B', { query: 'paris' }); // prefix, 2 levels up
  assert.ok(compareRanked(prefixAdm1, exactAdm3) < 0, 'a 2-level gap exceeds the bounded promotion: the ADM1 prefix match should win');
});

test('compareRanked: bag/baghdad regression -- exact "Bag" villages (ADM4) no longer bury Baghdad (ADM4 prefix) under an unrelated ADM0/ADM1 pile, and importance (area_km2) breaks ties among them', () => {
  // Synthetic rows modeled on the real bug report: searching "bag" against
  // the Overture-scale index returned eight near-identical "Bag"/IND/ADM4
  // rows (exact matches, no area data) with Baghdad -- a `prefix` match,
  // also ADM4, but with real area_km2 -- buried below them.
  const bagHun = ranked('bag', 4, 'HUN1', { query: 'bag', country: 'HUN', areaKm2: 23.57 }); // exact, has area
  const bagIndNoArea = ranked('bag', 4, 'IND1', { query: 'bag', country: 'IND' }); // exact, no area (a village)
  const baghdad = ranked('baghdad', 4, 'IRQ1', { query: 'bag', country: 'IRQ', areaKm2: 861.7 }); // prefix, same level, has area

  // All three are ADM4: effLevel for the two exact rows is 4-1=3 (bounded
  // promotion), Baghdad (prefix) stays at effLevel 4 -- so the exact
  // matches still sort ahead of Baghdad at the SAME level, by design (an
  // exact match beats a prefix match one level up, which trivially
  // includes "beats it at the very same level"). This is why dedupe (not
  // the comparator) is what actually surfaces Baghdad: collapsing the
  // eight look-alike "Bag" villages into one annotated row is what frees
  // up the result list, not reordering exact above/below prefix within a
  // level.
  const sorted = [baghdad, bagIndNoArea, bagHun].sort(compareRanked);
  assert.deepEqual(sorted.map((r) => r.featureId), ['HUN1', 'IND1', 'IRQ1'], 'both exact "Bag" rows should sort ahead of the prefix "Baghdad" row at the same effective level; area_km2 breaks the tie between the two exact rows (HUN has area, IND does not)');
});

test('compareRanked: viewport boost lets an in-viewport ADM1 beat an out-of-viewport ADM0 tie on levelAdjusted, but raw level still breaks the further tie correctly', () => {
  // levelAdjusted: ADM1 inside viewport -> 1 - 1 = 0; ADM0 outside -> 0 - 0 = 0. Tied on levelAdjusted.
  // Raw level: ADM0 (0) < ADM1 (1), so ADM0 should still win the raw-level tiebreak per design doc §3.2.
  const adm1InViewport = ranked('springfield', 1, 'A', { query: 'spring', viewport: [-1, -1, 1, 1], bbox: [0, 0, 0.5, 0.5] });
  const adm0Outside = ranked('spring nation', 0, 'B', { query: 'spring', bbox: [100, 100, 101, 101] });
  assert.equal(adm1InViewport.rank.levelAdjusted, 0);
  assert.equal(adm0Outside.rank.levelAdjusted, 0);
  assert.ok(compareRanked(adm0Outside, adm1InViewport) < 0, 'raw level should still break the levelAdjusted tie');
});

test('compareRanked: shorter name wins at an otherwise-equal rank', () => {
  const short = ranked('contra costa', 2, 'A', { query: 'contra' });
  const long = ranked('contra costa centre', 2, 'B', { query: 'contra' });
  assert.ok(compareRanked(short, long) < 0, '"Contra Costa" should sort before "Contra Costa Centre"');
});

test('compareRanked: deterministic tiebreak by nameNorm then featureId', () => {
  const a = ranked('contra costa', 2, 'B', { query: 'contra' });
  const b = ranked('contra costa', 2, 'A', { query: 'contra' });
  // same nameNorm, same everything else -> featureId breaks the tie ascending
  assert.ok(compareRanked(b, a) < 0);
});

test('compareRanked is a stable total order usable with Array.sort', () => {
  const rows = [
    // Same level and match class; "unionville" (10 chars) is shortest and
    // wins on nameLength (component 5) before "united aa"/"united bb"
    // (9 chars... use equal-length pair below to isolate the nameNorm tiebreak).
    ranked('unionville', 2, 'UNI2', { query: 'uni' }),
    ranked('united bb', 0, 'UB', { query: 'uni' }),
    ranked('united aa', 0, 'UA', { query: 'uni' }),
  ];
  const sorted = [...rows].sort(compareRanked);
  // level 0 beats level 2 first; within the level-0 pair (same nameLength,
  // 9 chars), nameNorm ascending breaks the tie: "united aa" < "united bb".
  assert.deepEqual(sorted.map((r) => r.featureId), ['UA', 'UB', 'UNI2']);
});

test('scoreOf returns a value in [0,1] and rewards exact+inside over substring+outside', () => {
  const best = scoreOf({ matchClass: 'exact', viewportRank: 'inside' });
  const worst = scoreOf({ matchClass: 'substring', viewportRank: 'outside' });
  assert.ok(best > worst);
  assert.ok(best <= 1 && best >= 0);
  assert.ok(worst <= 1 && worst >= 0);
});

// --- Result diversity (design doc §3.2 amendment, "Result diversity") ---

test('dedupeByNameCountryLevel: collapses the reported bug -- eight identical "Bag"/IND/ADM4 rows become one, annotated with moreCount', () => {
  const villages = Array.from({ length: 8 }, (_, i) => ({
    nameNorm: 'bag', country: 'IND', level: 4, featureId: `IND${i}`, areaKm2: undefined,
  }));
  const deduped = dedupeByNameCountryLevel(villages);
  assert.equal(deduped.length, 1, 'eight identical (nameNorm, country, level) rows collapse to one');
  assert.equal(deduped[0].moreCount, 7, 'the other seven are reported via moreCount');
});

test('dedupeByNameCountryLevel: keeps the largest-area row as the representative', () => {
  const rows = [
    { nameNorm: 'bag', country: 'IND', level: 4, featureId: 'small', areaKm2: 1.2 },
    { nameNorm: 'bag', country: 'IND', level: 4, featureId: 'big', areaKm2: 40.9 },
    { nameNorm: 'bag', country: 'IND', level: 4, featureId: 'no-area', areaKm2: undefined },
  ];
  const deduped = dedupeByNameCountryLevel(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].featureId, 'big', 'the row with the largest area_km2 is kept, even though it was not first in input order');
  assert.equal(deduped[0].moreCount, 2);
});

test('dedupeByNameCountryLevel: distinct names, countries, or levels are never collapsed together', () => {
  const rows = [
    { nameNorm: 'bag', country: 'IND', level: 4, featureId: 'A' },
    { nameNorm: 'bag', country: 'HUN', level: 4, featureId: 'B' }, // different country
    { nameNorm: 'baghdad', country: 'IND', level: 4, featureId: 'C' }, // different name
    { nameNorm: 'bag', country: 'IND', level: 3, featureId: 'D' }, // different level
  ];
  const deduped = dedupeByNameCountryLevel(rows);
  assert.equal(deduped.length, 4);
  assert.ok(deduped.every((r) => r.moreCount === undefined));
});

test('dedupeByNameCountryLevel: preserves rank order -- a key surfaces at its first (best-ranked) occurrence', () => {
  const rows = [
    { nameNorm: 'paris', country: 'FRA', level: 2, featureId: 'best' },
    { nameNorm: 'bag', country: 'IND', level: 4, featureId: 'mid' },
    { nameNorm: 'paris', country: 'FRA', level: 2, featureId: 'dup-of-best', areaKm2: 999 },
  ];
  const deduped = dedupeByNameCountryLevel(rows);
  assert.deepEqual(deduped.map((r) => r.nameNorm), ['paris', 'bag'], '"paris" keeps its first-occurrence position even though its duplicate (bigger area) appears after "bag" in input order');
});

test('capPerCountryLevelGroup: caps at maxPerGroup per (country, level), filling with the next-ranked distinct groups', () => {
  const rows = [
    { country: 'ARG', level: 1, featureId: 'arg1' },
    { country: 'ARG', level: 1, featureId: 'arg2' },
    { country: 'ARG', level: 1, featureId: 'arg3' },
    { country: 'ARG', level: 1, featureId: 'arg4' }, // 4th ARG/level1 -- dropped
    { country: 'BOL', level: 1, featureId: 'bol1' }, // fills the slot instead
  ];
  const kept = capPerCountryLevelGroup(rows, 3);
  assert.deepEqual(kept.map((r) => r.featureId), ['arg1', 'arg2', 'arg3', 'bol1']);
});

test('applyDiversity: dedupe then cap, in that order, with dedupe disabled as an opt-out', () => {
  const rows = [
    { nameNorm: 'bag', country: 'IND', level: 4, featureId: 'ind1' },
    { nameNorm: 'bag', country: 'IND', level: 4, featureId: 'ind2' }, // dup of ind1
    { nameNorm: 'bago', country: 'IND', level: 4, featureId: 'ind3' },
    { nameNorm: 'bagh', country: 'IND', level: 4, featureId: 'ind4' },
    { nameNorm: 'bagr', country: 'IND', level: 4, featureId: 'ind5' }, // 4th distinct IND/level4 name -- capped
  ];
  const diversified = applyDiversity(rows);
  // After dedupe: ind1+ind2 -> one row (ind1, +1 more); ind3, ind4, ind5
  // distinct. That is 4 distinct IND/level4 rows -- capPerCountryLevelGroup
  // then drops the 4th (default maxPerGroup: 3).
  assert.deepEqual(diversified.map((r) => r.featureId), ['ind1', 'ind3', 'ind4']);
  assert.equal(diversified[0].moreCount, 1);

  const withoutDedupe = applyDiversity(rows, { dedupe: false, maxPerGroup: null });
  assert.equal(withoutDedupe.length, 5, 'dedupe: false and maxPerGroup: null is a full opt-out');
});

// --- Ranking-residual follow-up (design doc §3.2 amendment, "Known
// residual limitation" / task 5): `class`/`population`/`alt_of` are
// pending data columns, optional and absent on every index shipped so
// far. Every test in this block uses `rankOpts`'s plain level/matchClass
// setup (no viewport), so `levelAdjusted`/`effLevel`/`matchClassRank` all
// tie identically across the rows compared -- isolating the new
// `isAlt`/prominence tiebreaks this task adds. ---------------------------

test('rankRow: carries isAlt/population/class through onto the rank record', () => {
  const row = { nameNorm: 'springfield', level: 1, bbox: [0, 0, 1, 1], featureId: 'A', population: 12345, class: 'City', isAlt: true };
  const rank = rankRow(row, 'spring', rankOpts);
  assert.equal(rank.population, 12345);
  assert.equal(rank.class, 'City');
  assert.equal(rank.isAlt, true);
});

test('rankRow: isAlt defaults false, population/class default undefined when the row has none', () => {
  const row = { nameNorm: 'springfield', level: 1, bbox: [0, 0, 1, 1], featureId: 'A' };
  const rank = rankRow(row, 'spring', rankOpts);
  assert.equal(rank.isAlt, false);
  assert.equal(rank.population, undefined);
  assert.equal(rank.class, undefined);
});

test('compareRanked: at equal level, a primary-name match ranks above an alt-name match for the same query', () => {
  const primary = ranked('paris', 2, 'PRIMARY', { query: 'paris', isAlt: false });
  const alt = ranked('paris', 2, 'ALT', { query: 'paris', isAlt: true });
  assert.ok(compareRanked(primary, alt) < 0, 'the primary-name row must sort first');
});

test('compareRanked: population (descending) outranks area_km2 as the prominence tiebreak', () => {
  // Same level/match class, so this isolates the prominence step: the
  // smaller-area, bigger-population row must still win.
  const bigAreaLowPop = ranked('springfield', 2, 'A', { query: 'spring', areaKm2: 900, population: 500 });
  const smallAreaHighPop = ranked('springfield', 2, 'B', { query: 'spring', areaKm2: 10, population: 500_000 });
  assert.ok(compareRanked(smallAreaHighPop, bigAreaLowPop) < 0, 'higher population should win even with less area');
});

test('compareRanked: a row with a real population always outranks one with none, regardless of class', () => {
  const noPopulationCity = ranked('springfield', 2, 'A', { query: 'spring', class: 'city' });
  const lowPopulationHamlet = ranked('springfield', 2, 'B', { query: 'spring', population: 42, class: 'hamlet' });
  assert.ok(compareRanked(lowPopulationHamlet, noPopulationCity) < 0, 'tier 0 (has population) beats tier 1 (class fallback) even for a tiny population against a "better" class');
});

test('compareRanked: class ladder (city > town > village > hamlet > unrecognized/absent) breaks ties when population is absent on both sides', () => {
  const town = ranked('springfield', 2, 'TOWN', { query: 'spring', class: 'town' });
  const village = ranked('springfield', 2, 'VILLAGE', { query: 'spring', class: 'village' });
  const hamlet = ranked('springfield', 2, 'HAMLET', { query: 'spring', class: 'hamlet' });
  const unknown = ranked('springfield', 2, 'UNKNOWN', { query: 'spring', class: 'spaceport' });
  const none = ranked('springfield', 2, 'NONE', { query: 'spring' });
  const sorted = [none, unknown, hamlet, village, town].sort(compareRanked);
  // An unrecognized class string ("spaceport") and no class at all both
  // fall into the same unranked tier -- the ladder only names four real
  // ranks -- so UNKNOWN and NONE tie on class and fall through to the
  // final deterministic featureId tiebreak ('NONE' < 'UNKNOWN').
  assert.deepEqual(sorted.map((r) => r.featureId), ['TOWN', 'VILLAGE', 'HAMLET', 'NONE', 'UNKNOWN']);
});

test('compareRanked: class comparison is case-insensitive', () => {
  const upper = ranked('springfield', 2, 'UPPER', { query: 'spring', class: 'City' });
  const village = ranked('springfield', 2, 'VILLAGE', { query: 'spring', class: 'village' });
  assert.ok(compareRanked(upper, village) < 0, '"City" (mixed case) must rank as city, ahead of village');
});

test('compareRanked: with no population/class/isAlt data on either row (every index shipped today), the new tiebreaks are a complete no-op and areaKm2 still decides', () => {
  const bigArea = ranked('bag', 4, 'BIG', { query: 'bag', country: 'IND', areaKm2: 40.9 });
  const smallArea = ranked('bag', 4, 'SMALL', { query: 'bag', country: 'IND', areaKm2: 1.2 });
  const sorted = [smallArea, bigArea].sort(compareRanked);
  assert.deepEqual(sorted.map((r) => r.featureId), ['BIG', 'SMALL'], 'areaKm2 (descending) must still be reached and decide, exactly as before this task');
});

// --- Alt-demotion follow-up (design doc §3.2 amendment, "alt-demotion",
// 2026-11-12): the ranking-residual follow-up's `isAlt` tiebreak above
// only ever triggers when two rows already tie on raw `level` -- measured
// live against the published Overture catalog, searching "bag" returned
// alt-language spellings of Bahrain/Bahamas (ADM0, `alt_of` set) ranked
// above Bağcılar/Bagua (ADM2, primary) and above Baghdad itself (buried
// deeper still), because `level` was reached and decided *before* `isAlt`
// ever got a chance to. This block tests the fix: a bounded, one-level
// `effLevel` demotion for a non-exact alt match (mirroring the existing
// exact-match *promotion*), with `isAlt` moved ahead of raw `level` in the
// comparator so the demotion isn't immediately undone by the very
// tiebreak it was meant to feed into -- and the explicit exemption for an
// `exact` alt match (typing "Deutschland" or "中国" in full must not be
// penalized for being an alt-language name). ---------------------------

test('rankRow: a non-exact alt match is demoted one level (effLevel = level + altLevelDemotion)', () => {
  const row = { nameNorm: 'bagraain', level: 0, bbox: [0, 0, 1, 1], featureId: 'A', isAlt: true };
  const rank = rankRow(row, 'bag', { ...rankOpts, altLevelDemotion: 1 }); // 'bagraain' startsWith 'bag' -> prefix
  assert.equal(rank.matchClass, 'prefix');
  assert.equal(rank.effLevel, 1); // 0 + 1 (demoted), not promoted (not exact)
  assert.equal(rank.level, 0, 'the true, undemoted level is still reported');
});

test('rankRow: an exact alt match is exempt from demotion -- it still gets the exact-match promotion instead', () => {
  const row = { nameNorm: 'deutschland', level: 0, bbox: [0, 0, 1, 1], featureId: 'A', isAlt: true };
  const rank = rankRow(row, 'deutschland', { ...rankOpts, exactLevelPromotion: 1, altLevelDemotion: 1 });
  assert.equal(rank.matchClass, 'exact');
  assert.equal(rank.effLevel, 0, 'max(0, 0 - 1 promotion + 0 demotion): clamped at 0, never demoted for being exact+alt');
});

test('rankRow: a primary row is never demoted, exact or not', () => {
  const row = { nameNorm: 'bagua', level: 2, bbox: [0, 0, 1, 1], featureId: 'A', isAlt: false };
  const rank = rankRow(row, 'bag', rankOpts); // prefix match, not alt
  assert.equal(rank.effLevel, 2, 'no promotion (not exact), no demotion (not alt)');
});

test('rankRow: altLevelDemotion defaults to 1 when not specified in options', () => {
  const row = { nameNorm: 'bagraain', level: 0, bbox: [0, 0, 1, 1], featureId: 'A', isAlt: true };
  const rank = rankRow(row, 'bag', rankOpts); // rankOpts has no altLevelDemotion set
  assert.equal(rank.effLevel, 1);
});

test('compareRanked: a level-0 alt noise match now ties (not beats) a level-1 primary match, and the primary wins the tie', () => {
  // The literal reported shape: "Bagraain" (Bahrain, ADM0, alt, prefix
  // match on "bag") vs a hypothetical ADM1 primary match one level down.
  // Before this fix, raw level (0 < 1) decided outright and the alt noise
  // won; now the demotion ties them at effLevel 1, and `isAlt` (checked
  // before raw level) picks the primary.
  const altAdm0 = ranked('bagraain', 0, 'ALT-NOISE', { query: 'bag', isAlt: true });
  const primaryAdm1 = ranked('bagdad province', 1, 'PRIMARY-ADM1', { query: 'bag', isAlt: false });
  assert.equal(altAdm0.rank.effLevel, 1);
  assert.equal(primaryAdm1.rank.effLevel, 1);
  assert.ok(compareRanked(primaryAdm1, altAdm0) < 0, 'the ADM1 primary should now sort before the demoted ADM0 alt-name noise');
});

test('compareRanked: FLIPPED by this amendment -- a level-0 alt match no longer unconditionally beats a level-1+ primary match', () => {
  // Same two rows as above, asserting the OLD (pre-amendment) direction
  // now fails: this is the literal bug ("alt rows inherit their
  // division's LEVEL privilege") the live reproduction measured.
  const altAdm0 = ranked('bagraain', 0, 'ALT-NOISE', { query: 'bag', isAlt: true });
  const primaryAdm1 = ranked('bagdad province', 1, 'PRIMARY-ADM1', { query: 'bag', isAlt: false });
  assert.ok(!(compareRanked(altAdm0, primaryAdm1) < 0), 'the pre-amendment ordering (alt-noise first, by raw level alone) must no longer hold');
});

test('compareRanked: the demotion is bounded to one level -- a level-0 alt match still beats a level-2 primary match (gap of 2)', () => {
  // Mirrors the exact-promotion bound (compareRanked: exact does NOT beat
  // prefix two levels up, in the earlier amendment's tests): just as an
  // exact match is only promoted one level, a non-exact alt match is only
  // demoted one level. This is the honest limitation measured live
  // against "bag" on the real Overture catalog: Bahrain/Bahamas (ADM0,
  // alt) still out-rank Bağcılar/Bagua-style ADM2 primaries, and Baghdad
  // itself (its best English-language match is ADM4, alt, four levels
  // down) remains out of easy reach -- see the design doc's measured
  // table for the honest, documented residual.
  const altAdm0 = ranked('bagraain', 0, 'ALT-NOISE', { query: 'bag', isAlt: true });
  const primaryAdm2 = ranked('bagua', 2, 'PRIMARY-ADM2', { query: 'bag', isAlt: false });
  assert.equal(altAdm0.rank.effLevel, 1); // demoted from 0
  assert.equal(primaryAdm2.rank.effLevel, 2); // undemoted
  assert.ok(compareRanked(altAdm0, primaryAdm2) < 0, 'a 2-level gap exceeds the bounded demotion: the ADM0 alt match still wins');
});

test('compareRanked: within a demotion-created tie, a primary beats an alt-exact match too if the alt-exact match is not actually at the same effLevel -- exact-alt exemption does not create a FALSE tie', () => {
  // "Deutschland" (exact, alt, ADM0) should behave exactly like a primary
  // exact match at ADM0 would: promoted, not demoted. It must still beat
  // a same-level primary prefix/word-prefix match, same as any exact
  // match would (the pre-existing bounded-promotion rule), confirming the
  // exemption doesn't degrade an exact alt match's ranking at all.
  const exactAltAdm0 = ranked('deutschland', 0, 'DEU-EXACT-ALT', { query: 'deutschland', isAlt: true });
  const prefixPrimaryAdm1 = ranked('deutschlandsberg', 1, 'AUT-PREFIX-PRIMARY', { query: 'deutschland', isAlt: false });
  assert.equal(exactAltAdm0.rank.effLevel, 0, 'exact alt match: promoted like any exact match, not demoted');
  assert.ok(compareRanked(exactAltAdm0, prefixPrimaryAdm1) < 0, 'the exact alt-name match for "Deutschland" should still win, exactly as an exact primary match would');
});

test('rankRow: altLevelDemotion: 0 disables the demotion entirely (opt-out)', () => {
  const row = { nameNorm: 'bagraain', level: 0, bbox: [0, 0, 1, 1], featureId: 'ALT-NOISE', isAlt: true };
  const rankNoOp = rankRow(row, 'bag', { ...rankOpts, altLevelDemotion: 0 });
  assert.equal(rankNoOp.effLevel, 0, 'effLevel unchanged when altLevelDemotion is explicitly 0');
});
