// @cngeo/geocoder-core -- public entry point.
//
// Same packaging deviation as @cngeo/spec (see its index.js): plain ESM +
// JSDoc, no build step, for this experiment phase. hyparquet itself is
// still externalized to a pinned, exact CDN URL (design doc §4.2) via
// ./cdn.js -- that part of the design is honored even without a bundler.

export { Geocoder, DEFAULT_INDEX_URL, VERSION, resolveResolutionMode } from './geocoder.js';
export { resolveJoinKey, geometryRefRowRange, firstMatch, resolveGeometry, openBoundaryFile } from './geometry-resolver.js';
export { CDN, loadHyparquet, setHyparquetModules, clearHyparquetModules } from './cdn.js';
export {
  jaroSimilarity,
  jaroWinklerSimilarity,
  similarityUpperBound,
  scoreFuzzyCandidate,
  fuzzyScan,
  fuzzyScanAsync,
  resolveFuzzyOptions,
  DEFAULT_FUZZY_MIN_SIMILARITY,
  DEFAULT_FUZZY_MIN_QUERY_LENGTH,
} from './fuzzy.js';
export {
  compareRanked,
  compareFuzzyRanked,
  rankFuzzyRow,
  classifyMatch,
  computeViewportRank,
  rankRow,
  scoreOf,
  applyDiversity,
  dedupeByNameCountryLevel,
  capPerCountryLevelGroup,
  MATCH_CLASS_RANK,
  VIEWPORT_RANK,
  DEFAULT_EXACT_LEVEL_PROMOTION,
  DEFAULT_ALT_LEVEL_DEMOTION,
  DEFAULT_DIVERSITY,
  MAX_COLLAPSED_ROWS,
} from './ranking.js';
export {
  prefixRange,
  findCandidateGroups,
  searchRangeIndex,
  DEFAULT_RANGE_GROUP_CONCURRENCY,
  DEFAULT_RANGE_MAX_CANDIDATE_GROUPS,
} from './index-loader.js';
export { GenerationGuard } from './generation-guard.js';
