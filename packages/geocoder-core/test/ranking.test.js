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
  const row = { nameNorm, level, bbox: extra.bbox ?? [0, 0, 1, 1], featureId, areaKm2: extra.areaKm2 };
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
