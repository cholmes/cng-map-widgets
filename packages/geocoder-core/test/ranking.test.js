import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMatch, computeViewportRank, rankRow, compareRanked, scoreOf } from '../src/ranking.js';

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
  const row = { nameNorm, level, bbox: extra.bbox ?? [0, 0, 1, 1], featureId };
  const rank = rankRow(row, extra.query ?? 'contra', { ...rankOpts, viewport: extra.viewport });
  return { nameNorm, featureId, rank };
}

test('compareRanked: ADM0 (level 0) beats ADM2 (level 2) at the same match class', () => {
  const adm0 = ranked('contra', 0, 'A');
  const adm2 = ranked('contra', 2, 'B');
  assert.ok(compareRanked(adm0, adm2) < 0, 'ADM0 should sort before ADM2');
});

test('compareRanked: match class dominates level (exact beats prefix even at a higher level)', () => {
  const exactAdm2 = ranked('contra', 2, 'A', { query: 'contra' }); // exact
  const prefixAdm0 = ranked('contra costa', 0, 'B', { query: 'contra' }); // prefix
  assert.ok(compareRanked(exactAdm2, prefixAdm0) < 0, 'exact match should sort before prefix match regardless of level');
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
