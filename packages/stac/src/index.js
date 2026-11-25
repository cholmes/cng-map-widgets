// @cngeo/stac -- public entry point.
//
// Plain ESM + JSDoc, no build step, like every other @cngeo package.
// Headless: no DOM, no map library.
//
// Scope (design: docs/superpowers/specs/2026-11-25-map-widgets-design.md):
//   - layersFromCollection(): a STAC collection -> LayerSpec[] (Phase 1)
//   - imageryProfile() + ImagerySearch: scene search over STAC-GeoParquet (Phase 2)
//   - CatalogIndex: search over a collections.parquet index (Phase 3)
//   - chunksFromStac(): time chunks for @cngeo/timeline (Phase 4)
//
// The collection -> DatasetDescriptor derivation stays in
// @cngeo/extract-core (`descriptorFromCollection`); this package imports it
// rather than duplicating it.

export const VERSION = '0.3.1';

export { layersFromCollection } from './layers-from-collection.js';
export { imageryProfile } from './imagery-profile.js';
