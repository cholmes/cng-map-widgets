// @cng/geocoder-core -- Jaro-Winkler fuzzy-match fallback (design doc
// §3.2 amendment, 2026-11-13, "Fuzzy fallback").
//
// **Adapted from Development Seed's gazet** (MIT licensed):
//   https://github.com/developmentseed/gazet
//   src/gazet/search.py, `simple_fuzzy_search`
// and its DuckDB `jaro_winkler_similarity`-based ranking. The parts taken
// from gazet are the *decisions*, which they measured and we verified:
//   - substring containment (the name contains the query) is a stronger
//     true-match signal than a slightly higher raw similarity score, so it
//     ranks first ("Loja" inside "Loja Province" beats the near-miss
//     "Lodja");
//   - every name a record answers to is scored and the record takes its
//     best name (our indexes ship alt names as their own rows, so this
//     falls out of scanning all rows rather than needing a per-record
//     names list);
//   - population breaks ties, so the big city outranks the same-named
//     village (we reuse this package's existing prominence comparator for
//     that rather than reimplementing it).
// Blog post: https://developmentseed.org/blog/2026-04-29-gazet
//
// Where this deviates from gazet, deliberately:
//   - substring containment is **one-directional** (name contains query),
//     exactly as gazet's `contains(s.folded, query)` is. An earlier draft
//     of this module also kept the reverse (query contains name), which
//     measurably breaks the flagship typo case: "bagdhad" *contains*
//     "bag", so every village literally named "Bag" would take a
//     substring win over Baghdad's 0.95 similarity.
//   - this runs only as a FALLBACK when the normal prefix search returned
//     nothing (gazet's fuzzy endpoint is its primary name lookup). A
//     non-empty prefix result is never reordered or augmented.
//
// Pure functions, no I/O: easy to unit test independently of the Geocoder.

/**
 * Jaro similarity of two strings, the standard definition: the mean of
 * (matches/|a|, matches/|b|, (matches - transpositions/2)/matches), where
 * characters match within a window of floor(max(|a|,|b|)/2) - 1.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function jaroSimilarity(a, b) {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const matchA = new Array(la).fill(false);
  const matchB = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(lb - 1, i + window);
    const ca = a.charCodeAt(i);
    for (let j = start; j <= end; j++) {
      if (matchB[j] || ca !== b.charCodeAt(j)) continue;
      matchA[i] = true;
      matchB[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!matchA[i]) continue;
    while (!matchB[k]) k++;
    if (a.charCodeAt(i) !== b.charCodeAt(k)) transpositions++;
    k++;
  }
  return (matches / la + matches / lb + (matches - transpositions / 2) / matches) / 3;
}

/** Winkler prefix bonus parameters: the standard 0.1 scale over a common
 *  prefix capped at 4 characters, applied only when the Jaro similarity
 *  already clears 0.7 -- the same "boost threshold" DuckDB's
 *  `jaro_winkler_similarity` applies, which is the function gazet's
 *  ranking was measured with, so our scores are comparable to theirs. */
export const WINKLER_PREFIX_SCALE = 0.1;
export const WINKLER_MAX_PREFIX = 4;
export const WINKLER_BOOST_THRESHOLD = 0.7;

/**
 * Jaro-Winkler similarity: Jaro plus a bonus for a shared prefix (people
 * mistype the ends of place names far more often than the starts).
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function jaroWinklerSimilarity(a, b) {
  const jaro = jaroSimilarity(a, b);
  if (jaro <= WINKLER_BOOST_THRESHOLD) return jaro;
  let prefix = 0;
  const maxPrefix = Math.min(WINKLER_MAX_PREFIX, a.length, b.length);
  while (prefix < maxPrefix && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  return jaro + prefix * WINKLER_PREFIX_SCALE * (1 - jaro);
}

/**
 * The default minimum Jaro-Winkler similarity a non-substring candidate
 * must reach to survive the fuzzy fallback. Measured (2026-11-13), not
 * guessed -- this implementation's scores for the typo cases the fallback
 * exists for:
 *
 *   "liechtenstien" vs "liechtenstein"   0.9846
 *   "bagdhad"       vs "baghdad"         0.9667
 *   "brookln"       vs "brooklyn"        0.9750
 *   "mumbia"        vs "mumbai"          0.9667
 *   "san fransisco" vs "san francisco"   0.9526
 *   "californa"     vs "california"      0.9800
 *
 * and for the near-miss *noise* on the same queries that a lower bar
 * would let through: "bagdhad" vs "baghdud" 0.8944, vs "bandad" 0.8794,
 * vs "baidoa" 0.7968. Every measured target clears 0.95 and every
 * measured noise pair stays below 0.90, so 0.90 keeps the targets with
 * real margin while cutting the whole noise tail. (Verified against the
 * live geoBoundaries and Overture indexes in the dated design-doc
 * amendment's table.) Override per Geocoder with
 * `fuzzy: { minSimilarity: n }`.
 */
export const DEFAULT_FUZZY_MIN_SIMILARITY = 0.9;

/** Fuzzy fallback never fires for a normalized query shorter than this:
 *  one- and two-character queries make nearly every short name a
 *  high-similarity "match", and a user two characters in hasn't finished
 *  typing anyway. */
export const DEFAULT_FUZZY_MIN_QUERY_LENGTH = 3;

/** How many rows `fuzzyScanAsync` scores between yields to the event
 *  loop. Measured (M-series Mac, Node 22, mixed 3-30 char names, with the
 *  `similarityUpperBound` prefilter active): ~2,300-4,600 rows/ms, i.e.
 *  a 16K-row slice is roughly 3-7 ms of work -- short enough to keep the
 *  main thread responsive, long enough that a 300K-row prominent index
 *  finishes in ~19 slices (~60 ms of actual compute). */
const ASYNC_CHUNK_ROWS = 16_384;

/**
 * Upper bound on jaroWinklerSimilarity(a, b) given only the two lengths:
 * at best every character of the shorter string matches in order with no
 * transpositions, giving jaro = (m/la + m/lb + 1)/3 with m = min(la, lb),
 * then the maximal Winkler bonus on top. Used to skip whole rows without
 * running the O(la*lb) match loop -- for a 13-char query at threshold
 * 0.9, this alone rejects every name shorter than 8 or longer than 23
 * characters.
 * @param {number} la
 * @param {number} lb
 * @returns {number}
 */
export function similarityUpperBound(la, lb) {
  if (la === 0 || lb === 0) return 0;
  const m = Math.min(la, lb);
  const jaro = (m / la + m / lb + 1) / 3;
  if (jaro <= WINKLER_BOOST_THRESHOLD) return jaro;
  return jaro + WINKLER_MAX_PREFIX * WINKLER_PREFIX_SCALE * (1 - jaro);
}

/**
 * Score one already-normalized name against one already-normalized query:
 * `null` when the row cannot be a candidate, else
 * `{ similarity, substring }`.
 *
 * A substring hit (the NAME contains the QUERY -- one-directional, see
 * the module comment) is always a candidate regardless of its raw
 * similarity; anything else must clear `minSimilarity`.
 * @param {string} nameNorm
 * @param {string} queryNorm
 * @param {number} minSimilarity
 * @returns {{ similarity: number, substring: boolean } | null}
 */
export function scoreFuzzyCandidate(nameNorm, queryNorm, minSimilarity) {
  const substring = nameNorm.length > queryNorm.length && nameNorm.includes(queryNorm);
  if (substring) {
    return { similarity: jaroWinklerSimilarity(nameNorm, queryNorm), substring: true };
  }
  if (similarityUpperBound(nameNorm.length, queryNorm.length) < minSimilarity) return null;
  const similarity = jaroWinklerSimilarity(nameNorm, queryNorm);
  if (similarity < minSimilarity) return null;
  return { similarity, substring: false };
}

/**
 * Synchronous fuzzy scan over index rows (each `{ name_norm, ... }`,
 * exactly as the index loader materializes them). Returns candidates as
 * `{ row, similarity, substring }`, unsorted -- ordering is the
 * Geocoder's job (`compareFuzzyRanked`), where the fuzzy signals combine
 * with the existing viewport/prominence comparator.
 * @template {{ name_norm: string }} Row
 * @param {readonly Row[]} rows
 * @param {string} queryNorm
 * @param {{ minSimilarity?: number }} [options]
 * @returns {{ row: Row, similarity: number, substring: boolean }[]}
 */
export function fuzzyScan(rows, queryNorm, options = {}) {
  const minSimilarity = options.minSimilarity ?? DEFAULT_FUZZY_MIN_SIMILARITY;
  const out = [];
  for (const row of rows) {
    const scored = scoreFuzzyCandidate(row.name_norm, queryNorm, minSimilarity);
    if (scored) out.push({ row, similarity: scored.similarity, substring: scored.substring });
  }
  return out;
}

/**
 * The same scan, yielding to the event loop every `ASYNC_CHUNK_ROWS` rows
 * so a large prominent index (hundreds of thousands of rows) never
 * occupies the main thread in one block -- the same policy as
 * `simplifyToVertexCeilingAsync` over large rings. The whole scan is
 * fallback-path-only (it runs when a query matched *nothing*), so the
 * extra scheduling latency is invisible next to the empty dropdown it is
 * about to fill.
 * @template {{ name_norm: string }} Row
 * @param {readonly Row[]} rows
 * @param {string} queryNorm
 * @param {{ minSimilarity?: number }} [options]
 * @returns {Promise<{ row: Row, similarity: number, substring: boolean }[]>}
 */
export async function fuzzyScanAsync(rows, queryNorm, options = {}) {
  const minSimilarity = options.minSimilarity ?? DEFAULT_FUZZY_MIN_SIMILARITY;
  const out = [];
  for (let start = 0; start < rows.length; start += ASYNC_CHUNK_ROWS) {
    const end = Math.min(rows.length, start + ASYNC_CHUNK_ROWS);
    for (let i = start; i < end; i++) {
      const row = rows[i];
      const scored = scoreFuzzyCandidate(row.name_norm, queryNorm, minSimilarity);
      if (scored) out.push({ row, similarity: scored.similarity, substring: scored.substring });
    }
    if (end < rows.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

/**
 * Resolve a `GeocoderOptions.fuzzy` value to the effective config, or
 * `null` when the fallback is disabled. `undefined`/`true` -> defaults;
 * `false` -> disabled; an object -> defaults overridden per field.
 * @param {boolean | { minSimilarity?: number, minQueryLength?: number } | undefined} option
 * @returns {{ minSimilarity: number, minQueryLength: number } | null}
 */
export function resolveFuzzyOptions(option) {
  if (option === false) return null;
  const overrides = typeof option === 'object' && option !== null ? option : {};
  return {
    minSimilarity: overrides.minSimilarity ?? DEFAULT_FUZZY_MIN_SIMILARITY,
    minQueryLength: overrides.minQueryLength ?? DEFAULT_FUZZY_MIN_QUERY_LENGTH,
  };
}
