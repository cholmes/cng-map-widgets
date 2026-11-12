// @cnmw/geocoder-core -- public entry point.
//
// Same packaging deviation as @cnmw/spec (see its index.js): plain ESM +
// JSDoc, no build step, for this experiment phase. hyparquet itself is
// still externalized to a pinned, exact CDN URL (design doc §4.2) via
// ./cdn.js -- that part of the design is honored even without a bundler.

export { Geocoder, DEFAULT_INDEX_URL, VERSION, resolveResolutionMode } from './geocoder.js';
export { resolveJoinKey, geometryRefRowRange, firstMatch, resolveGeometry, openBoundaryFile } from './geometry-resolver.js';
export { CDN, loadHyparquet, setHyparquetModules, clearHyparquetModules } from './cdn.js';
export {
  compareRanked,
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
  DEFAULT_DIVERSITY,
} from './ranking.js';
export { prefixRange, findCandidateGroups, searchRangeIndex } from './index-loader.js';
export { GenerationGuard } from './generation-guard.js';
