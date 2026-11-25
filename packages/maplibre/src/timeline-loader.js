// @cngeo/maplibre -- `@cngeo/timeline`, loaded when first needed.
//
// Every other @cngeo package this one uses is imported at the top of a file.
// Not this one. A static import would make every page that uses
// `@cngeo/maplibre` -- for a search box, a layer panel -- map
// `@cngeo/timeline` in its import map or fail to load at all, for a widget it
// does not show. So the timeline's renderer and control ask for it here, and
// only a page that adds a timeline has to be able to resolve it.
//
// It is a first-party package, so the specifier is bare: the page's import
// map (or a bundler) resolves it. A host can also hand it in.

import { CngError } from '@cngeo/spec';

/** What this package uses of `@cngeo/timeline`. */
export const TIMELINE_REQUIRED_EXPORTS = Object.freeze(['createChunkSet', 'createPlayback', 'TimelineCanvas', 'validateChunks', 'COUNT_RAMP', 'TIMELINE_THEME_DARK', 'TIMELINE_THEME_LIGHT', 'formatKey', 'keyToISO', 'isoToKey', 'addDays', 'keyIndex']);

let injected = null;
let loading = null;

/**
 * Supply `@cngeo/timeline` instead of having it imported: `import * as
 * timeline from '@cngeo/timeline'; setTimelineModules(timeline)`.
 * @param {object} mod
 */
export function setTimelineModules(mod) {
  const missing = TIMELINE_REQUIRED_EXPORTS.filter((name) => mod?.[name] === undefined);
  if (missing.length) {
    throw new CngError(`setTimelineModules() was not given @cngeo/timeline: it has no ${missing.join(', ')}.`, 'TIMELINE_INVALID', { retryable: false, context: { missing } });
  }
  injected = mod;
}

/** Undo `setTimelineModules`. */
export function clearTimelineModules() {
  injected = null;
  loading = null;
}

/**
 * `@cngeo/timeline`'s exports. Concurrent callers share one import; a failure
 * is not kept, so the next call tries again.
 * @returns {Promise<object>}
 */
export function loadTimeline() {
  if (injected) return Promise.resolve(injected);
  if (!loading) {
    loading = import(/* @vite-ignore */ '@cngeo/timeline');
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
