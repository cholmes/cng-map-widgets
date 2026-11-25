// @cngeo/maplibre -- opengeos' maplibre-gl-layer-control: pinned CDN URLs
// and the host-injection seam, mirroring packages/raster-core/src/cdn.js.
//
// Why this control and not one of our own: experiments/e12-deck-bundle
// (Gate B) measured it against seven requirements. It passed the five
// functional ones -- a deck.gl layer adapter, runtime add/remove, opacity,
// drag-reorder reported to the host -- and failed theming and keyboard
// access. Chris chose to adopt it and close those two gaps with a wrapper
// (layer-control-theme.js, layer-control-a11y.js) instead of rewriting the
// five that work.
//
// The published ESM has no bare imports (verified in Gate B), so it loads
// with no import-map entry. The version is pinned EXACTLY: the wrapper
// depends on this version's class names and on two of its private methods,
// both guarded where they are used. Bumping it means re-running
// examples/layers-demo/verify.mjs.

export const LAYER_CONTROL_VERSION = '0.18.3';

export const LAYER_CONTROL_CDN = {
  js: `https://cdn.jsdelivr.net/npm/maplibre-gl-layer-control@${LAYER_CONTROL_VERSION}/dist/index.mjs`,
  css: `https://cdn.jsdelivr.net/npm/maplibre-gl-layer-control@${LAYER_CONTROL_VERSION}/dist/maplibre-gl-layer-control.css`,
};

/** @type {{ LayerControl: any }|null} */
let injected = null;
let loading = null;

/**
 * Supply the host's own copy of maplibre-gl-layer-control (a bundled app, or
 * a test). The host is then also responsible for loading its stylesheet.
 * @param {{ LayerControl: any }} mods
 */
export function setLayerControlModules(mods) {
  injected = mods;
}

export function clearLayerControlModules() {
  injected = null;
  loading = null;
}

/** Lazily loads the control. @returns {Promise<{ LayerControl: any }>} */
export async function loadLayerControl() {
  if (injected) return injected;
  if (!loading) {
    loading = import(/* @vite-ignore */ LAYER_CONTROL_CDN.js);
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Add the control's own stylesheet to the page, once. No-op when the host injected the control. */
export function ensureLayerControlCss(doc = globalThis.document) {
  if (injected || !doc || doc.getElementById('cng-layer-control-base-css')) return;
  const link = doc.createElement('link');
  link.id = 'cng-layer-control-base-css';
  link.rel = 'stylesheet';
  link.href = LAYER_CONTROL_CDN.css;
  doc.head.appendChild(link);
}
