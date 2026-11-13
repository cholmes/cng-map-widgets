import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jaroSimilarity,
  jaroWinklerSimilarity,
  similarityUpperBound,
  scoreFuzzyCandidate,
  fuzzyScan,
  fuzzyScanAsync,
  resolveFuzzyOptions,
  DEFAULT_FUZZY_MIN_SIMILARITY,
} from '../src/fuzzy.js';
import { rankFuzzyRow, compareFuzzyRanked } from '../src/ranking.js';
import { Geocoder } from '../src/index.js';

// ── Jaro-Winkler math against the classic published vectors ─────────────────
// (Winkler 1990 / the values every reference implementation reproduces.)

test('jaroSimilarity: known vectors', () => {
  assert.ok(Math.abs(jaroSimilarity('martha', 'marhta') - 0.9444) < 0.001);
  assert.ok(Math.abs(jaroSimilarity('dixon', 'dicksonx') - 0.7667) < 0.001);
  assert.ok(Math.abs(jaroSimilarity('dwayne', 'duane') - 0.8222) < 0.001);
  assert.equal(jaroSimilarity('same', 'same'), 1);
  assert.equal(jaroSimilarity('', 'abc'), 0);
  assert.equal(jaroSimilarity('abc', ''), 0);
  assert.equal(jaroSimilarity('abc', 'xyz'), 0);
});

test('jaroWinklerSimilarity: known vectors, prefix bonus, boost threshold', () => {
  assert.ok(Math.abs(jaroWinklerSimilarity('martha', 'marhta') - 0.9611) < 0.001);
  assert.ok(Math.abs(jaroWinklerSimilarity('dixon', 'dicksonx') - 0.8133) < 0.001);
  assert.ok(Math.abs(jaroWinklerSimilarity('dwayne', 'duane') - 0.84) < 0.001);
  // Below the 0.7 boost threshold the Winkler bonus must NOT apply even
  // with a shared prefix (DuckDB-compatible behavior; see fuzzy.js).
  const lowJaro = jaroSimilarity('baabcdefgh', 'bazzzzzzzz');
  assert.ok(lowJaro <= 0.7, `test vector assumption: jaro ${lowJaro} <= 0.7`);
  assert.equal(jaroWinklerSimilarity('baabcdefgh', 'bazzzzzzzz'), lowJaro);
  // Symmetry.
  assert.equal(jaroWinklerSimilarity('bagdhad', 'baghdad'), jaroWinklerSimilarity('baghdad', 'bagdhad'));
});

test('the flagship typo cases clear the default threshold; the measured noise does not', () => {
  for (const [a, b] of [
    ['liechtenstien', 'liechtenstein'],
    ['bagdhad', 'baghdad'],
    ['brookln', 'brooklyn'],
    ['mumbia', 'mumbai'],
    ['san fransisco', 'san francisco'],
    ['californa', 'california'],
  ]) {
    assert.ok(
      jaroWinklerSimilarity(a, b) >= DEFAULT_FUZZY_MIN_SIMILARITY,
      `${a} vs ${b} should clear the default threshold`,
    );
  }
  for (const [a, b] of [
    ['bagdhad', 'baghdud'],
    ['bagdhad', 'bandad'],
    ['bagdhad', 'baidoa'],
  ]) {
    assert.ok(
      jaroWinklerSimilarity(a, b) < DEFAULT_FUZZY_MIN_SIMILARITY,
      `${a} vs ${b} should stay below the default threshold`,
    );
  }
});

test('similarityUpperBound: never below the real similarity (soundness of the prefilter)', () => {
  const words = ['bag', 'paris', 'baghdad', 'liechtenstein', 'contra costa', 'rio de janeiro', 'a', 'nizhny novgorod'];
  for (const a of words) {
    for (const b of words) {
      assert.ok(
        similarityUpperBound(a.length, b.length) >= jaroWinklerSimilarity(a, b) - 1e-9,
        `upper bound violated for ${a} / ${b}`,
      );
    }
  }
});

// ── scoreFuzzyCandidate / scan semantics ─────────────────────────────────────

test('substring containment is one-directional: name contains query, never the reverse', () => {
  // "loja" inside "loja province" -- gazet's own example -- is a hit.
  const hit = scoreFuzzyCandidate('loja province', 'loja', 0.9);
  assert.ok(hit && hit.substring);
  // The reverse direction must NOT count: "bagdhad" contains "bag", and if
  // it did, every village named "Bag" would outrank Baghdad on the typo.
  const reverse = scoreFuzzyCandidate('bag', 'bagdhad', 0.9);
  assert.ok(reverse === null || reverse.substring === false, 'query-contains-name must not be a substring hit');
});

test('fuzzyScan: keeps targets, drops noise, scores substring hits too', () => {
  const rows = [
    { name_norm: 'liechtenstein' },
    { name_norm: 'liechtenstein land' }, // substring hit for the exact spelling query below
    { name_norm: 'lichfield' },
    { name_norm: 'baghdad' },
    { name_norm: 'bag' },
  ];
  const typo = fuzzyScan(rows, 'liechtenstien', { minSimilarity: 0.9 });
  assert.deepEqual(typo.map((c) => c.row.name_norm).sort(), ['liechtenstein', 'liechtenstein land']);

  const sub = fuzzyScan(rows, 'liechtenstein', { minSimilarity: 0.9 });
  const subHit = sub.find((c) => c.row.name_norm === 'liechtenstein land');
  assert.ok(subHit && subHit.substring, 'containment counts as a substring hit');
});

test('fuzzyScanAsync agrees exactly with fuzzyScan across chunk boundaries', async () => {
  const rows = [];
  for (let i = 0; i < 40_000; i++) rows.push({ name_norm: `place ${i}` });
  rows.push({ name_norm: 'baghdad' });
  rows[17] = { name_norm: 'baghdud' };
  const sync = fuzzyScan(rows, 'bagdhad');
  const async = await fuzzyScanAsync(rows, 'bagdhad');
  assert.deepEqual(async, sync);
  assert.equal(sync.length, 1);
  assert.equal(sync[0].row.name_norm, 'baghdad');
});

test('resolveFuzzyOptions: defaults, disable, per-field override', () => {
  assert.deepEqual(resolveFuzzyOptions(undefined), { minSimilarity: 0.9, minQueryLength: 3 });
  assert.deepEqual(resolveFuzzyOptions(true), { minSimilarity: 0.9, minQueryLength: 3 });
  assert.equal(resolveFuzzyOptions(false), null);
  assert.deepEqual(resolveFuzzyOptions({ minSimilarity: 0.95 }), { minSimilarity: 0.95, minQueryLength: 3 });
});

// ── rankFuzzyRow / compareFuzzyRanked ────────────────────────────────────────

const BBOX = [0, 0, 1, 1];

function fuzzyRanked(nameNorm, fuzzy, rowExtra = {}) {
  const row = { nameNorm, level: 2, bbox: BBOX, featureId: nameNorm, ...rowExtra };
  return {
    rank: rankFuzzyRow(row, fuzzy, { viewportBoost: 1, nearFactor: 2, matchClasses: [] }),
    nameNorm,
    featureId: nameNorm,
  };
}

test('compareFuzzyRanked: substring beats higher raw similarity (the gazet Loja/Lodja rule)', () => {
  const substringHit = fuzzyRanked('loja province', { similarity: 0.85, substring: true });
  const nearMiss = fuzzyRanked('lodja', { similarity: 0.95, substring: false });
  assert.ok(compareFuzzyRanked(substringHit, nearMiss) < 0);
  assert.ok(compareFuzzyRanked(nearMiss, substringHit) > 0);
});

test('compareFuzzyRanked: similarity decides within a substring tier, prominence breaks exact ties', () => {
  const closer = fuzzyRanked('baghdad', { similarity: 0.97, substring: false });
  const farther = fuzzyRanked('baghdud', { similarity: 0.91, substring: false });
  assert.ok(compareFuzzyRanked(closer, farther) < 0);

  // Same similarity, same substring: falls through to compareRanked, where
  // the population promotion (>=100K) lifts the big city a level.
  const city = fuzzyRanked('springfield', { similarity: 0.95, substring: false }, { population: 170_000 });
  const hamlet = fuzzyRanked('springfeld', { similarity: 0.95, substring: false }, { population: 300 });
  assert.ok(compareFuzzyRanked(city, hamlet) < 0, 'population promotion applies to fuzzy ranks too');
});

test('rankFuzzyRow: matchClass is fuzzy, signals land on the rank, score stays in [0,1]', () => {
  const r = fuzzyRanked('baghdad', { similarity: 0.9667, substring: false });
  assert.equal(r.rank.matchClass, 'fuzzy');
  assert.equal(r.rank.similarity, 0.9667);
  assert.equal(r.rank.substring, false);
});

// ── Geocoder integration (same __deps seam as search-diversity.test.js) ─────

function makeManifest(extra = {}) {
  return {
    spec: 'cnmw-index/1.0',
    source: 'test-source',
    index_version: 'v1',
    catalog_version: 'cv1',
    rows: 10,
    levels: [0, 2],
    index: { url: './index.parquet', size: 100 },
    boundaries: [],
    attribution: [],
    ...extra,
  };
}

const ROW_BBOX = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };

function row(name, nameNorm, country, level, featureId, extra = {}) {
  return { name, name_norm: nameNorm, level, country, feature_id: featureId, source: 'test-source', bbox: ROW_BBOX, ...extra };
}

function sortedRows(rows) {
  return rows.slice().sort((a, b) => (a.name_norm < b.name_norm ? -1 : a.name_norm > b.name_norm ? 1 : 0));
}

const TYPO_ROWS = sortedRows([
  row('Liechtenstein', 'liechtenstein', 'LIE', 0, 'LIE0'),
  row('Lichfield', 'lichfield', 'GBR', 2, 'GBR0'),
  row('Baghdad', 'baghdad', 'IRQ', 2, 'IRQ0', { population: 7_216_040 }),
  row('Baghdud', 'baghdud', 'IRQ', 2, 'IRQ1'),
  row('Bag', 'bag', 'IND', 2, 'IND0'),
]);

function makeGeocoder(rows, options = {}) {
  const deps = {
    loadManifest: async () => makeManifest(),
    loadFullIndex: async () => ({ rows, nameNorms: rows.map((r) => r.name_norm) }),
    openRangeIndex: async () => ({ groups: [], rows: 0 }),
  };
  return new Geocoder({ indexUrl: 'https://example.test/fake/index.json', __deps: deps, ...options });
}

test('search("liechtenstien"): prefix search misses, fuzzy fallback finds Liechtenstein', async () => {
  const geocoder = makeGeocoder(TYPO_ROWS);
  const results = await geocoder.search('liechtenstien');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Liechtenstein');
  assert.equal(results[0].rank.matchClass, 'fuzzy');
  assert.ok(results[0].rank.similarity > 0.9 && results[0].rank.similarity < 1);
  assert.ok(results[0].score > 0 && results[0].score < 1);
});

test('search("bagdhad"): Baghdad found, near-miss Baghdud excluded, "Bag" not a reverse-substring hit', async () => {
  const geocoder = makeGeocoder(TYPO_ROWS);
  const results = await geocoder.search('bagdhad');
  assert.deepEqual(results.map((r) => r.name), ['Baghdad']);
});

test('fuzzy results are JSON-serializable (BigInt population coerced like every other path)', async () => {
  const rows = sortedRows([row('Baghdad', 'baghdad', 'IRQ', 2, 'IRQ0', { population: 7_216_040n })]);
  const geocoder = makeGeocoder(rows);
  const results = await geocoder.search('bagdhad');
  assert.equal(results.length, 1);
  assert.equal(results[0].population, 7_216_040);
  assert.doesNotThrow(() => JSON.stringify(results));
});

test('a non-empty prefix result is never augmented or reordered by fuzzy', async () => {
  const rows = sortedRows([
    row('Bag', 'bag', 'IND', 2, 'IND0'),
    row('Baghdad', 'baghdad', 'IRQ', 2, 'IRQ0'),
  ]);
  const geocoder = makeGeocoder(rows);
  const results = await geocoder.search('bag');
  assert.ok(results.length >= 2);
  for (const r of results) assert.notEqual(r.rank.matchClass, 'fuzzy');
});

test('fuzzy: false disables the fallback; short queries never trigger it', async () => {
  const off = makeGeocoder(TYPO_ROWS, { fuzzy: false });
  assert.deepEqual(await off.search('liechtenstien'), []);

  const on = makeGeocoder(TYPO_ROWS);
  // "bg" (2 chars, below minQueryLength 3) must not fuzzy-match "bag".
  assert.deepEqual(await on.search('bg'), []);
});

test('fuzzy: { minSimilarity } is honored', async () => {
  const strict = makeGeocoder(TYPO_ROWS, { fuzzy: { minSimilarity: 0.99 } });
  assert.deepEqual(await strict.search('bagdhad'), []);
  const loose = makeGeocoder(TYPO_ROWS, { fuzzy: { minSimilarity: 0.85 } });
  const results = await loose.search('bagdhad');
  // At 0.85 the near-misses Baghdud (0.8944) and Bag (0.8667) are allowed
  // in too -- but ranked below Baghdad (0.9667), strictly by similarity.
  assert.deepEqual(results.map((r) => r.name), ['Baghdad', 'Baghdud', 'Bag']);
});

test('levels/countries filters apply to fuzzy results', async () => {
  const geocoder = makeGeocoder(TYPO_ROWS);
  const results = await geocoder.search('bagdhad', { countries: ['FRA'] });
  assert.deepEqual(results, []);
  const byLevel = await geocoder.search('liechtenstien', { levels: [2] });
  assert.deepEqual(byLevel, []);
});

test('searchSync: same fuzzy fallback, synchronously', async () => {
  const geocoder = makeGeocoder(TYPO_ROWS);
  await geocoder.load();
  const results = geocoder.searchSync('liechtenstien');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Liechtenstein');
  assert.equal(results[0].rank.matchClass, 'fuzzy');
});

test('range mode without a prominent index: fuzzy fallback is skipped, [] returned (never range reads)', async () => {
  const deps = {
    loadManifest: async () => makeManifest({ index: { url: './index.parquet', size: 100_000_000 } }),
    loadFullIndex: async () => {
      throw new Error('full load must not be called in range mode');
    },
    openRangeIndex: async () => ({ groups: [], nameNorms: [], rows: 0 }),
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', loadStrategy: 'range', __deps: deps });
  const results = await geocoder.search('liechtenstien');
  assert.deepEqual(results, []);
});

test('range mode with a prominent index: fuzzy scans the prominent rows', async () => {
  const prominentRows = sortedRows([
    row('Liechtenstein', 'liechtenstein', 'LIE', 0, 'LIE0'),
    row('Baghdad', 'baghdad', 'IRQ', 2, 'IRQ0'),
  ]);
  const deps = {
    loadManifest: async () =>
      makeManifest({
        index: { url: './index.parquet', size: 100_000_000 },
        prominent_index: { url: './prominent.parquet', size: 50, row_count: 2 },
      }),
    // Only the prominent index full-loads in range mode.
    loadFullIndex: async () => ({ rows: prominentRows, nameNorms: prominentRows.map((r) => r.name_norm) }),
    openRangeIndex: async () => ({ groups: [], nameNorms: [], rows: 0 }),
  };
  const geocoder = new Geocoder({ indexUrl: 'https://example.test/fake/index.json', loadStrategy: 'range', __deps: deps });
  const results = await geocoder.search('liechtenstien');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Liechtenstein');
  assert.equal(results[0].rank.matchClass, 'fuzzy');
});

test('a search superseded while its fuzzy scan is in flight resolves [], never rejects', async () => {
  // 100K rows so fuzzyScanAsync takes several chunks (and several event-
  // loop turns), guaranteeing the second search() lands mid-scan.
  const bigRows = [{ name_norm: 'liechtenstein', name: 'Liechtenstein', level: 0, country: 'LIE', feature_id: 'LIE0', source: 'test-source', bbox: ROW_BBOX }];
  for (let i = 0; i < 100_000; i++) {
    bigRows.push({ name_norm: `zzz place ${i}`, name: `Zzz Place ${i}`, level: 2, country: 'ZZZ', feature_id: `Z${i}`, source: 'test-source', bbox: ROW_BBOX });
  }
  const rows = sortedRows(bigRows);
  const geocoder = makeGeocoder(rows);
  await geocoder.load();
  const first = geocoder.search('liechtenstien');
  const second = geocoder.search('zzz place 5');
  assert.deepEqual(await first, [], 'superseded fuzzy search resolves to []');
  const results = await second;
  assert.ok(results.length > 0);
  assert.notEqual(results[0].rank.matchClass, 'fuzzy');
});

test('fuzzy results flow through diversity dedupe like any other result', async () => {
  const rows = sortedRows([
    row('Lichtenstein', 'lichtenstein', 'DEU', 2, 'DEU0', { area_km2: 10 }),
    row('Lichtenstein', 'lichtenstein', 'DEU', 2, 'DEU1', { area_km2: 5 }),
    row('Lichtenstein', 'lichtenstein', 'DEU', 2, 'DEU2'),
  ]);
  const geocoder = makeGeocoder(rows);
  const results = await geocoder.search('lichtenstien');
  assert.equal(results.length, 1, 'identical (nameNorm, country, level) fuzzy rows collapse');
  assert.equal(results[0].moreCount, 2);
  assert.equal(results[0].featureId, 'DEU0', 'largest area is the representative');
});
