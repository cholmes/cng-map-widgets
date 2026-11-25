// @cngeo/timeline -- public entry point.
//
// Plain ESM + JSDoc, no build step, like every other @cngeo package.
// No map library. Unlike the `*-core` packages it does touch the DOM: the
// timeline component paints a <canvas>. Everything else here is pure.
//
//   keys.js             bucket keys: a calendar day or month, as text
//   axis.js             an axis, and a view and a selection on it
//   chunks.js           chunk descriptors, and the rules for a set of them
//   orchestrator.js     which chunks load, which draw; the ChunkFormat interface
//   playback.js         a clock
//   timeline-canvas.js  the canvas component
//
// Ported and generalised from firms-catalog's apps/firms-explorer
// (timeline.js, mounted.js, archives.js, and the page glue of deck.html).

export const VERSION = '0.3.1';

export {
  daysFromCivil, civilFromDays, keyIndex, indexKey, compareKeys, unitOfKey, formatKey, keyToISO, isoToKey,
  dayRangeOfKey, bucketKeyOfDay, dayKeyOfDate, addDays,
} from './keys.js';
export {
  makeAxis, MIN_SPAN, xToCoord, coordToX, bucketAt, clampDomain, zoomDomain, panDomain, domainBuckets,
  clampSelection, moveSelection, resizeSelection, makeSeries, sumRange, seriesFromBuckets, quantize, ticks,
  COUNT_RAMP, rampColor, liftForTrack,
} from './axis.js';
export { validateChunks, chunksFromTemplate, extentOf, covers, ownerOf, ownedRanges, axisFor, gapsIn, forView, forSelection } from './chunks.js';
export { createChunkSet } from './orchestrator.js';
export { createPlayback } from './playback.js';
export { TimelineCanvas, TIMELINE_THEME_DARK, TIMELINE_THEME_LIGHT } from './timeline-canvas.js';
