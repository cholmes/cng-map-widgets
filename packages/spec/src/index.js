// @cnmw/spec -- public entry point.
//
// Deviation from the design doc's three-build-artifact packaging (§4.1):
// this experiment phase ships plain ESM + JSDoc with NO build step at all
// (not even the bare/.cdn/.bundle split), per the task's explicit
// instruction to pick "plain ESM + JSDoc" for speed. There is exactly one
// source tree; a consumer imports this file directly (from node_modules,
// a relative path, or a self-hosted copy). This file has zero
// dependencies and makes zero network requests, so the externalize-to-CDN
// question (§4.2) does not apply to this package at all.

export const VERSION = '0.1.0-experiment';

export { AREA_VERSION, generateAreaId, buildArea, validateArea, toAreaDocument, fromAreaDocument } from './area.js';
export {
  bboxOfGeometry,
  crossesAntimeridian,
  computeBBoxes,
  bboxesIntersect,
  bboxContainsPoint,
  bboxCenter,
  scaleBBox,
  unionBBoxes,
} from './bbox.js';
export { normalizeName } from './normalize.js';
export { wkbToGeoJson } from './wkb.js';
export { visvalingamRing, ringArea, simplifyToVertexCeiling } from './simplify.js';
export { CnmwError, CancelledError, CeilingExceededError, isCnmwError } from './errors.js';

// §O11: a runtime singleton guard so two different `@cnmw/spec` versions
// loaded on one zero-build page don't silently diverge on `instanceof`
// checks. A second, different version logs one loud warning.
(function registerSingleton() {
  if (typeof globalThis === 'undefined') return;
  const key = Symbol.for('cnmw.spec');
  const existing = globalThis[key];
  if (existing && existing.version !== VERSION) {
    // eslint-disable-next-line no-console
    console.warn(
      `@cnmw/spec: multiple versions loaded on this page (${existing.version} and ${VERSION}). ` +
        'instanceof checks and Area validation may diverge; the first-loaded version wins.',
    );
    return;
  }
  if (!existing) globalThis[key] = { version: VERSION };
})();
