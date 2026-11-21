// @cngeo/raster-core -- public entry point.
//
// Plain ESM + JSDoc, no build step, exactly like the other @cngeo packages
// in this repo. geotiff.js (and, only for ZSTD sources, zstddec) load
// lazily from exact pinned CDN URLs -- see src/cdn.js -- or are injected by
// a host that already ships them.
//
// Scope, stated plainly: this package clips a *bounding-box window* out of
// one or more Cloud-Optimized GeoTIFFs at native resolution, selects a band
// subset, and writes a plain (not cloud-optimized) GeoTIFF. It does not
// reproject, resample, mask to a polygon, or apply scale/offset. Each of
// those refusals is explicit rather than silent.

export const VERSION = '0.2.0';

export { CDN, APPROX_BYTES, loadGeoTiff, loadZstdDec, setGeoTiffModules, clearGeoTiffModules } from './cdn.js';
export { openRaster, ensureZstdDecoder, tileBytes, DTYPE_BYTES } from './source.js';
export { describeCrs, forwardTransform, projectBbox } from './crs.js';
export {
  describeRasterDataset,
  describeRasterUrl,
  planRasterClip,
  estimateRasterClip,
  windowForBbox,
  tilesForWindow,
  chooseLevel,
  defaultRasterCeiling,
} from './plan.js';
export { downloadRaster } from './download.js';
export { writeGeoTiff, DTYPES, dtypeOf } from './geotiff-writer.js';

import { APPROX_BYTES } from './cdn.js';

/**
 * The deferred-plugin descriptor, in the `{ name, approxBytes, load }`
 * shape download-core's `registerLazyFormat` amendment established: a host
 * can advertise "GeoTIFF clip (+~28 KB)" in a format picker and only pay
 * for geotiff.js when the user picks it.
 *
 * Raster is NOT registered as a download-core `FormatPlugin`, and that is a
 * design decision rather than an omission: a `FormatPlugin` consumes
 * `FeatureBatch`es (rows + WKB geometry) from a parquet engine, and a clip
 * has no rows. The raster path is a second pipeline that reuses
 * download-core's *contracts* -- `Bounded`, the ceiling/refusal gate, the
 * `Sink` interface, the handle state machine -- rather than its row engine.
 */
export const rasterClipPlugin = {
  name: 'raster-cog-geotiff',
  label: 'GeoTIFF (clipped window)',
  extension: 'tif',
  mediaType: 'image/tiff; application=geotiff',
  streaming: false,
  approxBytes: { min: APPROX_BYTES.read, max: APPROX_BYTES.read + APPROX_BYTES.zstd, estimate: APPROX_BYTES.read },
  capabilities: { bandSubset: true, polygonMask: false, reproject: false, resample: 'overviews-only' },
  async load() {
    const mod = await import('./index.js');
    await mod.loadGeoTiff();
    return mod;
  },
};
