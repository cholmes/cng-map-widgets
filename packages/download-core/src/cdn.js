// @cng/download-core -- pinned CDN dependency URLs + a test-only injection
// seam.
//
// Design doc §4.2 requires externalizing hyparquet (and friends) to a
// pinned, *exact* CDN URL rather than inlining them, loaded via dynamic
// `import()` of the absolute URL (never a bare specifier -- design doc §4.4
// rule 2). This package pins the same hyparquet/hyparquet-compressors
// versions `@cng/geocoder-core` pins (1.33.0 / 1.1.3), per §4.2's
// version-unification obligation: one hyparquet version per release train.
//
// hyparquet-writer's own `src/index.js` has a bare `import 'hyparquet'`
// internally (its `schema.js`), which only resolves through a bundler or an
// import map -- the same problem E1 hit with hyparquet-compressors. So, like
// `hyparquetCompressors` below, we pull hyparquet-writer's pre-bundled ESM
// via jsdelivr's `+esm` endpoint rather than its raw `src/index.js`.
//
// DEVIATION (documented): `import('https://...')` of an absolute URL is not
// supported by plain Node ESM (no bundler, no browser), so `node --test`
// cannot exercise this CDN path directly. `setHyparquetModules` lets a test
// inject the equivalent npm-installed packages (declared as devDependencies
// of this package) in place of the dynamic CDN import.
//
// The same seam is also the documented HOST-INJECTION path (added by E7,
// portolan-browser integration): inside a bundler, `import(CDN.hyparquet)`
// has a runtime-computed specifier that no bundler can rewrite, so a host
// app that already bundles hyparquet would end up running a second copy
// from the network. portolan-browser pins hyparquet@1.26.0, we pin 1.33.0:
// one page, two parsers, two module caches, no benefit. A host hands its
// own modules in once, before the first `estimate()`/`download()`. The CDN
// path remains the default for zero-build pages and is never bypassed
// unless a host (or a test) calls this.
export const CDN = {
  hyparquet: 'https://cdn.jsdelivr.net/npm/hyparquet@1.33.0/src/index.js',
  hyparquetCompressors: 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.3/+esm',
  hyparquetWriter: 'https://cdn.jsdelivr.net/npm/hyparquet-writer@0.18.0/+esm',
};

/** @type {{ hyparquet: any, compressors: any, writer: any } | null} */
let testOverride = null;

/**
 * Supply the host application's own hyparquet (+ compressors, + optionally
 * hyparquet-writer, needed only for GeoParquet output) in place of the
 * dynamic CDN imports -- see the module doc comment. Also used by the test
 * suite to inject the npm-installed packages.
 * @param {{ hyparquet: any, compressors: any, writer?: any }} mods
 */
export function setHyparquetModules(mods) {
  testOverride = mods;
}

/** Undo `setHyparquetModules` (tests, and hosts that want the CDN back). */
export function clearHyparquetModules() {
  testOverride = null;
}

let hyparquetPromise = null;
/** Lazily loads hyparquet + its compressors map (design doc §4.2). */
export async function loadHyparquet() {
  if (testOverride) return { hyparquet: testOverride.hyparquet, compressors: testOverride.compressors };
  if (!hyparquetPromise) {
    hyparquetPromise = Promise.all([
      import(/* @vite-ignore */ CDN.hyparquet),
      import(/* @vite-ignore */ CDN.hyparquetCompressors),
    ]).then(([hyparquet, compressorsMod]) => ({ hyparquet, compressors: compressorsMod.compressors }));
  }
  return hyparquetPromise;
}

let writerPromise = null;
/** Lazily loads hyparquet-writer, only needed by the geoparquet format plugin. */
export async function loadHyparquetWriter() {
  if (testOverride?.writer) return testOverride.writer;
  if (!writerPromise) writerPromise = import(/* @vite-ignore */ CDN.hyparquetWriter);
  return writerPromise;
}
