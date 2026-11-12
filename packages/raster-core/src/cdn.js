// @cnmw/raster-core -- pinned CDN dependency URLs + the host-injection seam,
// mirroring @cnmw/download-core's src/cdn.js exactly (design doc §4.2: exact
// pinned URLs, never a bare specifier, never a range).
//
// Why jsdelivr's `+esm` endpoint and not `geotiff@2.1.3/dist-module/geotiff.js`:
// measured -- the raw dist-module entry contains bare imports
// (`@petamoriken/float16`, `xml-utils/find-tags-by-name.js`), which a
// zero-build page cannot resolve. The `+esm` build rewrites those to
// absolute, version-pinned sibling URLs on the same CDN
// (`/npm/@petamoriken/float16@3.8.4/+esm`), so the whole graph resolves with
// no import map and every URL still names an exact version. This is the same
// reason download-core pins hyparquet-compressors and hyparquet-writer via
// `+esm`. §4.2's "esm.sh rewrites and re-bundles" objection does not apply:
// geotiff is not shared with any other @cnmw package, so a rewritten copy
// cannot produce a duplicate-instance problem.
//
// Measured wire weight (gzip -9 of the served bundles, 2026-11-12):
//   geotiff@2.1.3/+esm                 71.4 KB raw -> 22.6 KB gz
//   @petamoriken/float16@3.8.4/+esm    12.4 KB raw ->  4.8 KB gz
//   zstddec@0.1.0/+esm (optional)      61.8 KB raw -> 23.8 KB gz
// i.e. ~27 KB gz for the read path, ~51 KB gz with ZSTD support.
export const CDN = {
  geotiff: 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm',
  zstddec: 'https://cdn.jsdelivr.net/npm/zstddec@0.1.0/+esm',
};

/** Weight a UI can show *before* loading anything (the deferred-plugin contract). */
export const APPROX_BYTES = {
  /** geotiff + float16, min+gz. */
  read: 27_500,
  /** + zstddec, min+gz. Only fetched when a source turns out to be ZSTD-compressed. */
  zstd: 23_800,
};

/** @type {{ geotiff: any, zstddec?: any } | null} */
let injected = null;

/**
 * Supply the host application's own `geotiff` module (and optionally
 * `zstddec`) instead of the dynamic CDN import. Two users:
 *   1. a bundled host app that already ships geotiff (portolan-browser's
 *      COG viewer does) -- one parser, one module cache;
 *   2. `node --test`, which cannot `import()` an absolute https URL, so the
 *      tests inject the npm-installed devDependency.
 * @param {{ geotiff: any, zstddec?: any }} mods
 */
export function setGeoTiffModules(mods) {
  injected = mods;
}

/** Undo `setGeoTiffModules`. */
export function clearGeoTiffModules() {
  injected = null;
}

let geotiffPromise = null;

/** Lazily loads geotiff.js. @returns {Promise<any>} */
export async function loadGeoTiff() {
  if (injected) return injected.geotiff;
  if (!geotiffPromise) geotiffPromise = import(/* @vite-ignore */ CDN.geotiff);
  return geotiffPromise;
}

let zstdPromise = null;

/** Lazily loads zstddec. @returns {Promise<any>} */
export async function loadZstdDec() {
  if (injected?.zstddec) return injected.zstddec;
  if (!zstdPromise) zstdPromise = import(/* @vite-ignore */ CDN.zstddec);
  return zstdPromise;
}
