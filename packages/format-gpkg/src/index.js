// @cng/format-gpkg -- public entry point.
//
// Two ways to use this package, matching download-core's registry seam
// (design doc §3.4, amended for lazy loading):
//
//   // Lazy (recommended for a page that only sometimes needs GeoPackage):
//   import { registerLazyFormat } from '@cng/download-core';
//   import { gpkgFormatDescriptor } from '@cng/format-gpkg';
//   registerLazyFormat(gpkgFormatDescriptor);
//   // sql.js's ~340KB (min+gz) wasm fetches only once a `download()` for
//   // format: 'gpkg' actually runs -- not when this module is imported,
//   // and not when it's registered.
//
//   // Eager (already have sql.js loaded, or want it loaded up front):
//   import { registerFormat } from '@cng/download-core';
//   import { createGpkgFormat } from '@cng/format-gpkg';
//   import initSqlJs from 'sql.js'; // or your own bundler-resolved import
//   registerFormat(createGpkgFormat(await initSqlJs()));

export const VERSION = '0.2.0';

export { createGpkgFormat, estimateGpkgBytes } from './gpkg-writer.js';
export { CDN, APPROX_BYTES, loadSqlJs, setSqlJsModule, clearSqlJsModule } from './cdn.js';
export { geojsonToWkb, gpkgGeometryBlob, wkbTypeName } from './wkb.js';

import { createGpkgFormat, estimateGpkgBytes } from './gpkg-writer.js';
import { loadSqlJs, APPROX_BYTES } from './cdn.js';

/**
 * A ready-made `LazyFormatDescriptor` (download-core's
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
  capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
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
