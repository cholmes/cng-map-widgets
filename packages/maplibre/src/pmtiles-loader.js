// @cngeo/maplibre -- the pmtiles library: a pinned CDN URL and the
// host-injection seam, mirroring packages/raster-core/src/cdn.js.
//
// Why jsDelivr's `+esm` endpoint: pmtiles has no runtime dependencies beyond
// `fflate`, which `+esm` rewrites to a pinned sibling URL, so the module
// resolves with no import map. It is not shared with deck.gl or any other
// @cngeo package, so a second copy cannot cause an identity problem.

export const PMTILES_CDN = 'https://cdn.jsdelivr.net/npm/pmtiles@4.5.0/+esm';

/** @type {{ PMTiles: any, Protocol: any }|null} */
let injected = null;
let loading = null;

/**
 * Supply the host's own `pmtiles` module instead of the CDN import: a bundled
 * app that already ships it, or a test.
 * @param {{ PMTiles: any, Protocol: any }} mods
 */
export function setPmtilesModules(mods) {
  injected = mods;
  protocol = null;
}

/** Undo `setPmtilesModules` and forget the shared Protocol. */
export function clearPmtilesModules() {
  injected = null;
  loading = null;
  protocol = null;
}

/** Lazily loads pmtiles. @returns {Promise<{ PMTiles: any, Protocol: any }>} */
export async function loadPmtiles() {
  if (injected) return injected;
  if (!loading) {
    loading = import(/* @vite-ignore */ PMTILES_CDN);
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

let protocol = null;

/**
 * The page's one pmtiles `Protocol`. Sharing it shares its archive cache:
 * the header and directories of an archive are read once however many
 * layers and metadata lookups use it.
 */
export async function sharedProtocol() {
  const { Protocol } = await loadPmtiles();
  if (!protocol) protocol = new Protocol();
  return protocol;
}

/** The (cached) archive behind a URL, registered with the shared Protocol. */
export async function archiveFor(url) {
  const { PMTiles } = await loadPmtiles();
  const shared = await sharedProtocol();
  let archive = shared.get?.(url);
  if (!archive) {
    archive = new PMTiles(url);
    shared.add?.(archive);
  }
  return archive;
}
