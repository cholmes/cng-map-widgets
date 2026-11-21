// @cngeo/format-gpkg -- public entry point.
//
// Two ways to use this package, matching extract-core's registry seam
// (design doc §3.4, amended for lazy loading):
//
//   // Lazy (recommended for a page that only sometimes needs GeoPackage):
//   import { registerLazyFormat } from '@cngeo/extract-core';
//   import { gpkgFormatDescriptor } from '@cngeo/format-gpkg';
//   registerLazyFormat(gpkgFormatDescriptor);
//   // sql.js's ~340KB (min+gz) wasm fetches only once a `download()` for
//   // format: 'gpkg' actually runs -- not when this module is imported,
//   // and not when it's registered.
//
//   // Eager (already have sql.js loaded, or want it loaded up front):
//   import { registerFormat } from '@cngeo/extract-core';
//   import { createGpkgFormat } from '@cngeo/format-gpkg';
//   import initSqlJs from 'sql.js'; // or your own bundler-resolved import
//   registerFormat(createGpkgFormat(await initSqlJs()));

export const VERSION = '0.3.0';

export { createGpkgFormat, estimateGpkgBytes } from './gpkg-writer.js';
export { CDN, APPROX_BYTES, loadSqlJs, setSqlJsModule, clearSqlJsModule } from './cdn.js';
export { geojsonToWkb, gpkgGeometryBlob, wkbTypeName } from './wkb.js';

import { createGpkgFormat, estimateGpkgBytes } from './gpkg-writer.js';
import { loadSqlJs, APPROX_BYTES } from './cdn.js';

/**
 * A ready-made `LazyFormatDescriptor` (extract-core's
 * `registerLazyFormat` shape) for the `gpkg` format id. `load()` resolves
 * to a `FormatPlugin` built from sql.js once it has finished loading from
 * the pinned CDN URL in `cdn.js` -- or from `setSqlJsModule`'s injection,
 * for this package's own tests.
 */
export const gpkgFormatDescriptor = {
  id: 'gpkg',
  label: 'GeoPackage',
  extension: 'gpkg',
  mediaType: 'application/geopackage+sqlite3',
  streaming: false,
  // memoryFactor: 2.9 -- measured (gpkg-writer.js's module doc and
  // test/memory-factor.verify.mjs), down from 3.5 after bigger-downloads
  // task 9 (per-batch insert: `writeBatch` now inserts straight into the
  // open sql.js database instead of buffering rows in JS arrays, so only
  // two copies -- the wasm-heap SQLite database and the exported
  // `Uint8Array` -- are alive at once, not three). Kept in agreement
  // with the plugin's own `capabilities` in gpkg-writer.js -- the
  // registry reads whichever one is actually used (`registerFormat`'s
  // eager plugin vs. this lazy descriptor resolved by `load()` below).
  capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'], memoryFactor: 2.9 },
  approxBytes: APPROX_BYTES,
  // Shared with the plugin, so the descriptor's estimate and the loaded
  // plugin's can never disagree -- and still pure JS (no sql.js needed to
  // model bytes-per-row), as `LazyFormatDescriptor.estimateBytes` requires.
  estimateBytes: estimateGpkgBytes,
  async load() {
    const SQL = await loadSqlJs();
    return createGpkgFormat(SQL);
  },
};
