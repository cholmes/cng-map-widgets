// @cng/geocoder-core -- pinned CDN dependency URLs.
//
// Design doc §4.2 requires externalizing hyparquet to a pinned, *exact*
// CDN URL rather than inlining it, and §4.2's "version-unification
// obligation" requires one hyparquet version per @cng release train.
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

// HOST-INJECTION SEAM (added by E7, portolan-browser integration).
//
// The CDN URLs above are the right default for a zero-build page: a bare
// specifier would not resolve and an inlined copy would blow the bundle
// budget (§4.2). Inside a *bundler*, though, they are wrong in a specific
// way: `import(CDN.hyparquet)` has a runtime-computed specifier, so no
// bundler can rewrite it, and the page ends up running a second hyparquet
// from the network alongside the one the host app already bundles.
// portolan-browser pins hyparquet@1.26.0; loading 1.33.0 beside it doubles
// the parser and splits the module cache for no benefit.
//
// So a host that already has hyparquet may hand its own modules in, once,
// before the first `load()`/`select()`. The CDN path stays the default and
// is never bypassed unless a host calls this. The same seam exists in
// `@cng/download-core`; a host with both packages calls both.
/** @type {{ hyparquet: any, compressors: any } | null} */
let injected = null;

/**
 * Supply the host application's own hyparquet + compressors in place of the
 * pinned CDN import. Call once, before the first index load.
 * @param {{ hyparquet: any, compressors: any }} mods
 */
export function setHyparquetModules(mods) {
  injected = mods;
}

/** Undo `setHyparquetModules` (tests, and hosts that want the CDN back). */
export function clearHyparquetModules() {
  injected = null;
}

let hyparquetPromise = null;

/**
 * Lazily resolve hyparquet + its compressors map: the host-injected modules
 * when a host supplied them, otherwise the pinned CDN URLs (design doc
 * §4.2: a dynamic `import()` of an absolute URL, never a bare specifier).
 * @returns {Promise<{ hyparquet: any, compressors: any }>}
 */
export async function loadHyparquet() {
  if (injected) return injected;
  if (!hyparquetPromise) {
    hyparquetPromise = Promise.all([
      import(/* @vite-ignore */ CDN.hyparquet),
      import(/* @vite-ignore */ CDN.hyparquetCompressors),
    ]).then(([hyparquet, compressorsMod]) => ({ hyparquet, compressors: compressorsMod.compressors }));
  }
  return hyparquetPromise;
}
