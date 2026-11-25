// @cngeo/maplibre -- the one place this package reaches deck.gl.
//
// deck.gl, luma.gl and Development Seed's deck.gl-raster are loaded as ONE
// prebuilt ES module, `../vendor/deck-stack.js`, built by
// `tools/build-deck-bundle.mjs` and committed to the repo. Why a bundle
// rather than the pinned-CDN-URL pattern every other @cngeo dependency
// uses (`packages/raster-core/src/cdn.js`):
//
//   deck.gl-raster hands luma.gl `Texture` objects to the shader pipeline
//   the page's Deck instance runs, and checks `instanceof Texture` /
//   `instanceof WebMercatorViewport` on the way. Two copies of
//   `@luma.gl/core` or `@deck.gl/core` are two unrelated class identities:
//   textures stop binding and are never freed, with nothing in the console.
//   Per-package CDN ESM builds resolve to diverging patch versions, so they
//   produce exactly that. The only CDN recipe that yields one copy needs
//   entries in the *consumer's* page import map, which a package cannot
//   supply and design doc §4.4 rule 2 forbids relying on.
//   (docs/superpowers/specs/2026-11-25-map-widgets-design.md, call 1;
//   sentinel-2-catalog's vite.config.js records the same finding.)
//
// One bundle also means the timeline's MVT layers and the imagery rasters
// share a single deck.gl and a single overlay.
//
// The bundle is loaded lazily, the first time a deck-backed layer is added.
// A page that only ever shows MapLibre style layers never pays for it.

import { CngError } from '@cngeo/spec';

/** Absolute URL of the committed bundle, resolved against this module. */
export const DECK_BUNDLE_URL = new URL('../vendor/deck-stack.js', import.meta.url).href;

/**
 * The exports a usable deck module set must carry. Checked on BOTH paths
 * (the bundle and a host injection): deck.gl-raster is pre-1.0 and has
 * renamed exports and props in every minor, and JavaScript ignores a prop
 * it does not know -- a stale set draws nothing rather than throwing.
 * Refusing here turns that into an error that names what is missing.
 */
export const DECK_REQUIRED_EXPORTS = Object.freeze([
  'MapLibreOverlay',
  'COGLayer',
  'MultiCOGLayer',
  'COGSource',
  'RasterLayer',
  'MVTLayer',
  'GeoJsonLayer',
  'DataFilterExtension',
  'MVTLoader',
  'DecoderPool',
  'gpuModules',
  'VERSIONS',
]);

/**
 * Transferred weight (gzip) a UI can show before loading anything -- the
 * deferred-plugin contract `@cngeo/raster-core`'s APPROX_BYTES established.
 * Measured: `gzip -9` of the committed bundle is 446,168 bytes (1,495,218
 * raw), 2026-11-25 -- experiments/e12-deck-bundle/RESULTS.md. Re-measure
 * when the bundle is rebuilt.
 */
export const APPROX_BYTES = { deck: 446_000 };

/** @type {object|null} */
let injected = null;
/** @type {Promise<object>|null} */
let loading = null;

/** @param {object} mods @param {string} origin */
function assertDeckModules(mods, origin) {
  const missing = DECK_REQUIRED_EXPORTS.filter((name) => mods?.[name] === undefined || mods?.[name] === null);
  if (missing.length) {
    throw new CngError(
      `The deck.gl modules from ${origin} are missing: ${missing.join(', ')}. ` +
        'They were probably built against a different deck.gl-raster version.',
      'DECK_MODULES_INVALID',
      { retryable: false, context: { missing, origin } },
    );
  }
  return mods;
}

/**
 * Supply the host application's own deck.gl modules instead of the bundle.
 * For a bundled host that already ships deck.gl (portolan-browser does):
 * one deck, one luma, one module cache. Throws `DECK_MODULES_INVALID` if
 * the set is incomplete.
 * @param {object} mods An object carrying every name in DECK_REQUIRED_EXPORTS.
 */
export function setDeckModules(mods) {
  injected = assertDeckModules(mods, 'setDeckModules()');
  loading = null;
}

/** Undo `setDeckModules` and forget any loaded or in-flight bundle. */
export function clearDeckModules() {
  injected = null;
  loading = null;
}

/**
 * Load deck.gl. Resolves to the module namespace (see DECK_REQUIRED_EXPORTS).
 *
 * Concurrent callers share one import. A failure rejects with a retryable
 * `DECK_LOAD_FAILED` and is NOT cached, so the next call tries again.
 * @param {{ importer?: (url: string) => Promise<object> }} [options]
 *   `importer` exists for tests; the default is a dynamic `import()`.
 * @returns {Promise<object>}
 */
export function loadDeck(options = {}) {
  if (injected) return Promise.resolve(injected);
  if (loading) return loading;
  const importer = options.importer ?? ((url) => import(/* @vite-ignore */ url));
  const attempt = (async () => {
    let mods;
    try {
      mods = await importer(DECK_BUNDLE_URL);
    } catch (cause) {
      throw new CngError(`Could not load the deck.gl bundle from ${DECK_BUNDLE_URL}`, 'DECK_LOAD_FAILED', {
        retryable: true,
        cause,
        context: { url: DECK_BUNDLE_URL },
      });
    }
    return assertDeckModules(mods, DECK_BUNDLE_URL);
  })();
  loading = attempt;
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return attempt;
}

/**
 * What this browser can draw, so a widget can say why nothing appears.
 *   webgl2 -- required for everything deck.gl draws here.
 *   norm16 -- `EXT_texture_norm16`. Without it a 16-bit band (Sentinel-2
 *             reflectance) samples as zero and composites come out black,
 *             silently. 8-bit imagery (true-colour TCI, NAIP, most
 *             OpenAerialMap) is unaffected. Headless Chrome lacks it.
 * @param {{ getContext(type: string): any }} [canvas] Defaults to a throwaway <canvas>.
 * @returns {{ webgl2: boolean, norm16: boolean }}
 */
export function deckSupport(canvas) {
  const target = canvas ?? (typeof document !== 'undefined' ? document.createElement('canvas') : null);
  const gl = target?.getContext?.('webgl2') ?? null;
  if (!gl) return { webgl2: false, norm16: false };
  return { webgl2: true, norm16: Boolean(gl.getExtension?.('EXT_texture_norm16')) };
}
