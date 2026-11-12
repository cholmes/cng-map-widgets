// @cnmw/geocoder-core -- pinned CDN dependency URLs.
//
// Design doc §4.2 requires externalizing hyparquet to a pinned, *exact*
// CDN URL rather than inlining it, and §4.2's "version-unification
// obligation" requires one hyparquet version per @cnmw release train.
//
// VERSION-UNIFICATION NOTE (per task instructions): the design doc's own
// package.json example pins hyparquet@1.26.0 / hyparquet-compressors@1.1.1
// (matching portolan-browser's existing pin), but this experiment reuses
// E1's proven harness pins -- hyparquet@1.33.0 / hyparquet-compressors@1.1.3
// -- because that is the exact pair E1 benchmarked against (row-group
// pruning behavior, footer-fetch-size tuning) and the provisional data in
// this repo. Shipping a different, unbenchmarked pair would be the actual
// risk. This is recorded here, once, as the single source of truth other
// packages must match -- the "declared once in the repo root" rule from
// §4.2, scoped to this package until a real release train exists.
export const CDN = {
  hyparquet: 'https://cdn.jsdelivr.net/npm/hyparquet@1.33.0/src/index.js',
  // hyparquet-compressors' src/index.js has bare imports (fzstd, hysnappy)
  // that only resolve through a bundler -- same issue E1 hit -- so pull
  // its pre-bundled ESM via jsdelivr's +esm endpoint, matching E1's harness.
  hyparquetCompressors: 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.3/+esm',
};
