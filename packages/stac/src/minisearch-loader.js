// @cngeo/stac -- the one place this package reaches MiniSearch.
//
// Text search over a catalog index is Luca Ongaro's MiniSearch (MIT): a small
// in-memory full-text index with prefix and fuzzy matching. It is loaded
// lazily -- the first time a search has words in it -- from an exact pinned
// URL, like every other third-party module in @cngeo. A page that only
// browses by area never fetches it.
//
// `setMinisearchModules` is the injection seam for a host that bundles
// (`import MiniSearch from 'minisearch'`) and for Node, which has no network
// imports.

import { CngError } from '@cngeo/spec';

/** Exact version. The ES build has no imports of its own. */
export const MINISEARCH_URL = 'https://cdn.jsdelivr.net/npm/minisearch@7.2.0/dist/es/index.js';

/** @type {any} */
let injected = null;
/** @type {Promise<any>|null} */
let loading = null;

/**
 * Hand in MiniSearch instead of loading it from the CDN.
 * @param {{ MiniSearch: any }} modules  The class: `import MiniSearch from 'minisearch'`.
 */
export function setMinisearchModules(modules) {
  if (typeof modules?.MiniSearch !== 'function') throw new TypeError('setMinisearchModules({ MiniSearch }) needs the MiniSearch class.');
  injected = modules.MiniSearch;
  loading = null;
}

/** Forget an injected or loaded MiniSearch (tests). */
export function clearMinisearchModules() {
  injected = null;
  loading = null;
}

/**
 * The MiniSearch class. Loaded once; a failed load is not remembered.
 * @param {{ importer?: (url: string) => Promise<any> }} [options]
 * @returns {Promise<any>}
 */
export function loadMinisearch(options = {}) {
  if (injected) return Promise.resolve(injected);
  if (!loading) {
    const importer = options.importer ?? ((url) => import(/* @vite-ignore */ url));
    const pending = importer(MINISEARCH_URL).then(
      (mod) => {
        const MiniSearch = mod?.default ?? mod?.MiniSearch;
        if (typeof MiniSearch !== 'function') throw new CngError('The text-search module did not export MiniSearch.', 'INTERNAL', { context: { url: MINISEARCH_URL } });
        return MiniSearch;
      },
      (cause) => {
        throw new CngError(`Couldn't load the text-search module: ${MINISEARCH_URL}`, 'NETWORK', { cause, context: { url: MINISEARCH_URL } });
      },
    );
    loading = pending;
    pending.catch(() => {
      if (loading === pending) loading = null;
    });
  }
  return loading;
}
