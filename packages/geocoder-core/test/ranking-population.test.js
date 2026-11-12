import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankRow,
  compareRanked,
  DEFAULT_POPULATION_PROMOTION_THRESHOLD,
  DEFAULT_POPULATION_LEVEL_PROMOTION,
} from '../src/ranking.js';
import { Geocoder } from '../src/index.js';

// Unit + end-to-end regression for the 2026-11-12 "population-promotion"
// follow-up (design doc §3.2 amendment, "the Brooklyn case"): the third
// bounded `effLevel` adjustment, alongside the exact-match promotion and
// the alt-row demotion, plus the comparator reordering (prominence ahead of
// raw `level`) without which the promotion cannot decide anything.
//
// The live case this file encodes, measured against the Who's On First
// names index: searching "brooklyn" did not surface Brooklyn the New York
// borough (`level` 4, `population` 2,504,700) in the top 8 at all, because
// `localadmin` townships of 318-11,022 people sat one rung shallower
// (`level` 3) and `compareRanked` component (1) decided it outright.

const rankOpts = {
  viewportBoost: 1,
  nearFactor: 2,
  matchClasses: ['exact', 'prefix', 'word-prefix'],
};

/** A ranked entry, shaped the way `compareRanked` consumes them. */
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
  const rank = rankRow(row, extra.query ?? nameNorm, { ...rankOpts, ...extra.options });
  return { nameNorm, featureId, country: extra.country, level, rank };
}

// --- The constants themselves -------------------------------------------

test('the promotion is bounded to exactly one level, and the threshold is a six-figure population', () => {
  assert.equal(DEFAULT_POPULATION_LEVEL_PROMOTION, 1, 'bounded to one level, like the exact promotion and the alt demotion');
  assert.equal(DEFAULT_POPULATION_PROMOTION_THRESHOLD, 100_000);
});

// --- rankRow: the adjustment itself -------------------------------------

test('rankRow: population at or above the threshold promotes effLevel by one', () => {
  const borough = { nameNorm: 'brooklyn', level: 4, bbox: [0, 0, 1, 1], featureId: 'BOROUGH', population: 2_504_700 };
  // `prefix` query, so the exact-match promotion is not also in play and
  // this isolates the population promotion: 4 -> 3.
  const rank = rankRow(borough, 'brook', rankOpts);
  assert.equal(rank.level, 4);
  assert.equal(rank.effLevel, 3);
});

test('rankRow: population exactly at the threshold promotes (the bound is inclusive)', () => {
  const row = { nameNorm: 'springfield', level: 4, bbox: [0, 0, 1, 1], featureId: 'AT', population: DEFAULT_POPULATION_PROMOTION_THRESHOLD };
  assert.equal(rankRow(row, 'spring', rankOpts).effLevel, 3);
});

test('rankRow: population one below the threshold does NOT promote', () => {
  const row = { nameNorm: 'springfield', level: 4, bbox: [0, 0, 1, 1], featureId: 'UNDER', population: DEFAULT_POPULATION_PROMOTION_THRESHOLD - 1 };
  assert.equal(rankRow(row, 'spring', rankOpts).effLevel, 4);
});

test('rankRow: a small town does not promote -- the measured 10,000-threshold failure, encoded', () => {
  // Brooklyn, Ohio: `level` 3, population 11,022. At a 10,000 threshold it
  // promoted to effLevel 1 and took position 1 *from* the borough. At the
  // shipped threshold it stays put.
  const ohio = { nameNorm: 'brooklyn', level: 3, bbox: [0, 0, 1, 1], featureId: 'OHIO', population: 11_022, isAlt: true };
  assert.equal(rankRow(ohio, 'brooklyn', rankOpts).effLevel, 2, 'exact promotion only (3 -> 2), no population promotion');
});

test('rankRow: population 0 is a real value, not a missing one, and does not promote', () => {
  // WOF genuinely stores `population: 0` on some rows (Springfield,
  // Division No. 12, CAN) -- it must survive onto the rank record as `0`
  // rather than being falsified to `undefined`.
  const row = { nameNorm: 'springfield', level: 3, bbox: [0, 0, 1, 1], featureId: 'ZERO', population: 0 };
  const rank = rankRow(row, 'spring', rankOpts);
  assert.equal(rank.population, 0);
  assert.equal(rank.effLevel, 3);
});

test('rankRow: a row with no population at all is unaffected', () => {
  const row = { nameNorm: 'springfield', level: 3, bbox: [0, 0, 1, 1], featureId: 'NONE' };
  const rank = rankRow(row, 'spring', rankOpts);
  assert.equal(rank.population, undefined);
  assert.equal(rank.effLevel, 3);
});

test('rankRow: a bigint population (WOF ships `population` as parquet INT64) is accepted, not silently dropped', () => {
  // The decode bug this follow-up uncovered: hyparquet decodes INT64 as
  // BigInt, so every `typeof x === "number"` guard read WOF's populated
  // `population` column as absent on every single row. `geocoder.js`
  // narrows at its own boundary; this is `rankRow`'s belt-and-braces guard
  // for a direct caller.
  const row = { nameNorm: 'brooklyn', level: 4, bbox: [0, 0, 1, 1], featureId: 'BIGINT', population: 2_504_700n };
  const rank = rankRow(row, 'brook', rankOpts);
  assert.equal(rank.population, 2_504_700, 'narrowed to a plain number so SearchResult.population keeps its documented type');
  assert.equal(rank.effLevel, 3, 'and it actually drives the promotion');
});

test('rankRow: populationPromotionThreshold is overridable, and Infinity opts out entirely', () => {
  const row = { nameNorm: 'brooklyn', level: 4, bbox: [0, 0, 1, 1], featureId: 'B', population: 2_504_700 };
  assert.equal(rankRow(row, 'brook', { ...rankOpts, populationPromotionThreshold: 5_000_000 }).effLevel, 4, 'above the row = no promotion');
  assert.equal(rankRow(row, 'brook', { ...rankOpts, populationPromotionThreshold: Infinity }).effLevel, 4, 'Infinity restores the pre-amendment effLevel');
  assert.equal(rankRow(row, 'brook', { ...rankOpts, populationLevelPromotion: 0 }).effLevel, 4, 'a 0-level promotion is also an opt-out');
});

// --- The bound: one level, never more -----------------------------------

test('compareRanked: the promotion is capped at one level -- a huge-population level-5 row never beats a level-0 country', () => {
  const megacity = ranked('x', 5, 'MEGACITY', { population: 40_000_000 });
  const country = ranked('x', 0, 'COUNTRY', {});
  assert.equal(megacity.rank.effLevel, 3, 'exact promotion (1) + population promotion (1) = 5 -> 3, and no further');
  assert.ok(compareRanked(country, megacity) < 0, 'a level-0 country must still win against a level-5 row four rungs away');
});

test('compareRanked: the promotion closes a one-level gap and no more -- a two-level gap survives it', () => {
  const big = ranked('x', 4, 'BIG', { population: 9_000_000 });
  const twoUp = ranked('x', 2, 'TWO-UP', {});
  assert.equal(big.rank.effLevel, 2, '4 - 1 (exact) - 1 (population)');
  assert.equal(twoUp.rank.effLevel, 1, '2 - 1 (exact)');
  assert.ok(compareRanked(twoUp, big) < 0, 'two levels up still wins; the promotion is not a general importance override');
});

test('rankRow: effLevel never goes below 0, however large the population', () => {
  const row = { nameNorm: 'china', level: 0, bbox: [0, 0, 1, 1], featureId: 'CHN', population: 1_400_000_000 };
  assert.equal(rankRow(row, 'china', rankOpts).effLevel, 0, 'clamped at ADM0; nothing is shallower than a country');
});

// --- The Brooklyn case, end to end through the comparator ---------------

test('compareRanked: THE BROOKLYN CASE -- a 2.5M-population level-4 borough now beats the small level-3 townships that buried it', () => {
  // Every row here is an `exact`, alt-name match, exactly as measured on
  // WOF: so components (1) levelAdjusted, (2) effLevel, (3) matchClass and
  // (4) isAlt all tie once the promotion lands, and the comparison is
  // decided by prominence -- which is only reachable because this
  // amendment moved it ahead of raw `level`.
  const borough = ranked('brooklyn', 4, 'NY-BOROUGH', { country: 'USA', population: 2_504_700, isAlt: true });
  const ohio = ranked('brooklyn', 3, 'OH-TOWNSHIP', { country: 'USA', population: 11_022, isAlt: true });
  const australia = ranked('brooklyn', 3, 'AUS-LOCALADMIN', { country: 'AUS', isAlt: true });

  assert.equal(borough.rank.effLevel, 2, '4 - 1 (exact) - 1 (population) = 2');
  assert.equal(ohio.rank.effLevel, 2, '3 - 1 (exact) = 2, no population promotion at 11,022');
  assert.equal(australia.rank.effLevel, 2);

  const sorted = [australia, ohio, borough].sort(compareRanked);
  assert.deepEqual(
    sorted.map((r) => r.featureId),
    ['NY-BOROUGH', 'OH-TOWNSHIP', 'AUS-LOCALADMIN'],
    'the borough first, then the township that at least has a population, then the one with none',
  );
});

test('compareRanked: prominence is consulted BEFORE raw level -- without the reorder the promotion decides nothing', () => {
  // The same two rows, tied at effLevel 2 by the promotion. Raw level is
  // still 3 vs. 4, so a comparator that checked raw level first would hand
  // the win straight back to the township, re-opening the gap the
  // promotion just closed (the identical failure mode that made the
  // alt-demotion amendment move `isAlt` ahead of raw `level`).
  const borough = ranked('brooklyn', 4, 'BOROUGH', { population: 2_504_700, isAlt: true });
  const township = ranked('brooklyn', 3, 'TOWNSHIP', { population: 11_022, isAlt: true });
  assert.equal(borough.rank.effLevel, township.rank.effLevel, 'the promotion manufactured the tie');
  assert.notEqual(borough.rank.level, township.rank.level, 'raw level still differs, and must not be what decides');
  assert.ok(compareRanked(borough, township) < 0);
});

test('compareRanked: raw level is still the tiebreak when prominence ties', () => {
  // The reorder must not cost raw `level` its job -- it only loses
  // priority, it does not disappear. Neither row carries a population or
  // class, so prominence ties at [1, 4] and raw level decides.
  const shallow = ranked('x', 1, 'SHALLOW', { options: { exactLevelPromotion: 0 } });
  const deep = ranked('x', 2, 'DEEP', { options: { exactLevelPromotion: 2 } });
  assert.equal(shallow.rank.effLevel, 1);
  assert.equal(deep.rank.effLevel, 0);
  // effLevel puts DEEP first; force the effLevel tie instead:
  const deepTied = ranked('x', 2, 'DEEP-TIED', { options: { exactLevelPromotion: 1 } });
  assert.equal(deepTied.rank.effLevel, 1, 'tied with SHALLOW');
  assert.ok(compareRanked(shallow, deepTied) < 0, 'with prominence tied, the shallower raw level still wins');
});

// --- Interaction with the other two bounded adjustments -----------------

test('rankRow: the three adjustments compose -- exact promotion + population promotion stack to two levels', () => {
  const row = { nameNorm: 'brooklyn', level: 4, bbox: [0, 0, 1, 1], featureId: 'B', population: 2_504_700, isAlt: true };
  const rank = rankRow(row, 'brooklyn', rankOpts); // exact
  assert.equal(rank.effLevel, 2, '4 - 1 (exact, which also exempts the alt row from demotion) - 1 (population)');
});

test('rankRow: a demoted alt row does NOT also get the population promotion -- the two would exactly cancel', () => {
  // "Bagraain", an alt spelling of Bahrain: ADM0, population 1,234,571,
  // matched by `prefix` on "bag". Ungated, its population promotion
  // cancels its alt demotion and it keeps position 1, re-opening the bug
  // the alt-demotion amendment closed.
  const bagraain = { nameNorm: 'bagraain', level: 0, bbox: [0, 0, 1, 1], featureId: 'BHR', population: 1_234_571, isAlt: true };
  const rank = rankRow(bagraain, 'bag', rankOpts);
  assert.equal(rank.effLevel, 1, 'demoted to 1 and left there: the population promotion is gated off by the demotion');
});

test('compareRanked: because of that gate, a primary match still beats a huge-population alt noise match at the same raw level', () => {
  // The measured "bag" outcome: Bağcılar (TUR ADM2, primary, 719,071) is
  // promoted to effLevel 1 and clears all four Bahrain/Bahamas ADM0 alt
  // rows -- the improvement the alt-demotion amendment measured itself
  // unable to reach.
  const bagcilar = ranked('bagcilar', 2, 'TUR', { query: 'bag', country: 'TUR', population: 719_071 });
  const bagraain = ranked('bagraain', 0, 'BHR', { query: 'bag', country: 'BHR', population: 1_234_571, isAlt: true });
  assert.equal(bagcilar.rank.effLevel, 1, '2 - 1 (population); primary rows are not demoted so the gate is open');
  assert.equal(bagraain.rank.effLevel, 1, 'demoted, and not population-promoted');
  assert.ok(compareRanked(bagcilar, bagraain) < 0, 'at the resulting tie, the primary-name match wins on isAlt');
});

test('rankRow: an exact alt match keeps the demotion exemption AND the population promotion', () => {
  // Baghdad's English-language Overture row is an alt row with population
  // 7,216,040, matched exactly. `isExact` exempts it from the demotion, so
  // the gate is open and it gets the population promotion too: 4 -> 2.
  const baghdad = { nameNorm: 'baghdad', level: 4, bbox: [0, 0, 1, 1], featureId: 'IRQ', population: 7_216_040, isAlt: true };
  assert.equal(rankRow(baghdad, 'baghdad', rankOpts).effLevel, 2);
});

test('compareRanked: THE BAGHDAD CASE -- the promotion lets an exact city match overtake shallower prefix noise', () => {
  // Measured live on Overture: Baghdad the city moved from position 7 to 1.
  const city = ranked('baghdad', 4, 'CITY', { query: 'baghdad', country: 'IRQ', population: 7_216_040, isAlt: true });
  const governorateNoise = ranked('baghdad province', 1, 'NOISE', { query: 'baghdad', country: 'IRQ', isAlt: true });
  assert.equal(city.rank.effLevel, 2);
  assert.equal(governorateNoise.rank.effLevel, 2, '1 + 1 (alt demotion, prefix match)');
  assert.ok(compareRanked(city, governorateNoise) < 0, 'tied at effLevel, the exact match wins at matchClass');
});

test('rankRow: the viewport boost still applies on top of the population promotion', () => {
  const row = { nameNorm: 'brooklyn', level: 4, bbox: [0, 0, 1, 1], featureId: 'B', population: 2_504_700 };
  const rank = rankRow(row, 'brook', { ...rankOpts, viewport: [-5, -5, 5, 5] });
  assert.equal(rank.effLevel, 3);
  assert.equal(rank.levelAdjusted, 2, 'effLevel 3 minus viewportBoost 1');
});

// --- End to end through search() ----------------------------------------

function makeManifest() {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 10,
    levels: [3, 4],
    index: { url: './index.parquet', size: 100 },
    boundaries: [],
    attribution: [],
  };
}

const BBOX = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };

function row(name, nameNorm, country, level, featureId, extra = {}) {
  return { name, name_norm: nameNorm, level, country, feature_id: featureId, source: 'test-source', bbox: BBOX, ...extra };
}

function makeGeocoder(rows, options = {}) {
  const deps = {
    loadManifest: async () => makeManifest(),
    loadFullIndex: async () => ({ rows, nameNorms: rows.map((r) => r.name_norm) }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  return new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps, ...options });
}

test('search(): the Brooklyn case end to end -- the borough comes up first through the real search path', async () => {
  const rows = [
    row('Brooklyn', 'brooklyn', 'AUS', 3, 'AUS-LA', { alt_of: '404222221' }),
    row('Brooklyn', 'brooklyn', 'USA', 3, 'OH-TOWNSHIP', { population: 11_022, alt_of: '404525053' }),
    row('Brooklyn', 'brooklyn', 'USA', 4, 'NY-BOROUGH', { population: 2_504_700, alt_of: '421205765' }),
  ];
  const geocoder = makeGeocoder(rows, { limit: 8, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('brooklyn');
  assert.deepEqual(results.map((r) => r.featureId), ['NY-BOROUGH', 'OH-TOWNSHIP', 'AUS-LA']);
  assert.equal(results[0].rank.effLevel, 2);
  assert.equal(results[0].population, 2_504_700);
});

test('search(): a bigint population column (parquet INT64, as WOF ships it) survives decode and drives the promotion', async () => {
  const rows = [
    row('Brooklyn', 'brooklyn', 'USA', 3, 'OH-TOWNSHIP', { population: 11_022n, alt_of: '404525053' }),
    row('Brooklyn', 'brooklyn', 'USA', 4, 'NY-BOROUGH', { population: 2_504_700n, alt_of: '421205765' }),
  ];
  const geocoder = makeGeocoder(rows, { limit: 8, diversity: { dedupe: false, maxPerGroup: null } });
  const results = await geocoder.search('brooklyn');
  assert.deepEqual(results.map((r) => r.featureId), ['NY-BOROUGH', 'OH-TOWNSHIP']);
  assert.equal(results[0].population, 2_504_700, 'narrowed to a plain number, not left as a BigInt');
  assert.equal(typeof results[0].population, 'number', 'SearchResult.population stays JSON-safe');
});

test('search(): ranking.populationPromotionThreshold passes through from the Geocoder options', async () => {
  const rows = [
    row('Brooklyn', 'brooklyn', 'USA', 3, 'OH-TOWNSHIP', { population: 11_022, alt_of: '404525053' }),
    row('Brooklyn', 'brooklyn', 'USA', 4, 'NY-BOROUGH', { population: 2_504_700, alt_of: '421205765' }),
  ];
  const geocoder = makeGeocoder(rows, {
    limit: 8,
    diversity: { dedupe: false, maxPerGroup: null },
    ranking: { populationPromotionThreshold: Infinity },
  });
  const results = await geocoder.search('brooklyn');
  assert.deepEqual(
    results.map((r) => r.featureId),
    ['OH-TOWNSHIP', 'NY-BOROUGH'],
    'opting out restores the pre-amendment ordering: the shallower township first',
  );
});
