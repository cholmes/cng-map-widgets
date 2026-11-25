// @cngeo/timeline -- public entry point.
//
// Plain ESM + JSDoc, no build step, like every other @cngeo package.
// No map library. Unlike the `*-core` packages it does touch the DOM: the
// timeline component paints a <canvas>. Everything else here is pure.
//
// Scope (design: docs/superpowers/specs/2026-11-25-map-widgets-design.md, Phase 4):
//   - chunk descriptors for any period, and the chunk-set orchestrator
//   - axis math, per-bucket ownership, gaps
//   - the playback clock
//   - the canvas Timeline component
//   - the ChunkFormat interface a map adapter implements
//
// Ported and generalised from firms-catalog's apps/firms-explorer
// (timeline.js, mounted.js).

export const VERSION = '0.3.1';
