// @cng/download-core -- public entry point.
//
// Deviation from the design doc's three-build-artifact packaging (§4.1),
// matching @cng/spec and @cng/geocoder-core: this experiment phase ships
// plain ESM + JSDoc with NO build step. A consumer imports this file
// directly; dependencies on hyparquet/hyparquet-writer are loaded lazily
// from pinned CDN URLs (see src/cdn.js), never bundled in.

export const VERSION = '0.2.0';

export { resolveDataset, descriptorFromCollection, collectionDownloadSupport } from './dataset-resolve.js';
export { CDN, loadHyparquet, loadHyparquetWriter, setHyparquetModules, clearHyparquetModules } from './cdn.js';
export { download, downloadRequest } from './download.js';
export { registerFormat, registerLazyFormat, formats, resolveFormat, getFormat, formatLoadState, onFormatState, registerEngine, engines } from './registry.js';
export { memorySink, blobSink, streamSink, fileSystemSink, autoSink } from './sinks.js';
export { createHyparquetEngine, HYPARQUET_ENGINE_ID, DEFAULT_MAX_CONCURRENT_REQUESTS } from './engine-hyparquet.js';
export { createGeoJsonFormat } from './formats/geojson.js';
export { createGeoParquetFormat } from './formats/geoparquet.js';
export { defaultCeiling, effectiveCeiling, memoryFactorOf, requirementsOf } from './ceiling.js';
export { evaluatePredicate, evaluateWhere, getPath } from './predicate.js';
export { rowMatchesArea, bboxIntersectsAny, pointInGeometry, geometriesIntersect, geometryIntersectsArea } from './spatial.js';
export { decodeWkbGeometry, bboxOfAnyGeometry } from './wkb-geometry.js';
export { boundedExact, boundedRange, addBounded, sumBounded, scaleBounded, capBounded, isEstimateWide } from './bounded.js';
export { enumeratePartitions, partitionPruneCascade, resolveMirrorPartUrl } from './partitions.js';
export { pruneRowGroupsByBBox, pruneRowGroupsByTime, pruneRowGroupsByWhere, predicateExcludesRowGroup, avgColumnBytesPerRow, STATS_PRUNABLE_OPS } from './prune.js';
export { CngError, CancelledError, CeilingExceededError, isCngError } from '@cng/spec';
export { RAW_FORMAT_ID, rawFormatDescriptor, planRaw, rawEstimate } from './raw.js';

import { registerFormat, registerEngine, getFormat, getEngine } from './registry.js';
import { createGeoJsonFormat } from './formats/geojson.js';
import { createGeoParquetFormat } from './formats/geoparquet.js';
import { createHyparquetEngine, HYPARQUET_ENGINE_ID } from './engine-hyparquet.js';
import { RAW_FORMAT_ID, rawFormatDescriptor, planRaw, rawEstimate } from './raw.js';
import { estimate as estimateDecoded } from './estimate.js';

/**
 * Ruling R14: the public `estimate()` is a thin ROUTER, living here (not in
 * estimate.js) specifically because `raw.js` already imports three
 * constants FROM estimate.js (`DEFAULT_LARGE_DOWNLOAD_BYTES`,
 * `DEFAULT_THROUGHPUT_BYTES_PER_SECOND`, `SLOW_DOWNLOAD_SECONDS`) --
 * estimate.js importing raw.js back would be a cycle. index.js already
 * imports both, so it is the one place that can see both paths without
 * creating one.
 *
 * `options.output?.format === RAW_FORMAT_ID` delegates to `planRaw` +
 * `rawEstimate` -- raw.js's own decode-free planning half, which never
 * opens a parquet footer -- instead of estimate.js's `estimate()`, which
 * would otherwise do exactly the footer reads the whole raw-passthrough
 * path exists to avoid, AND throw: `finalizeEstimate` unconditionally
 * calls `format.estimateBytes(...)` once `getFormat(options.output.format)`
 * resolves a format, and `rawFormatDescriptor` deliberately has no
 * `estimateBytes` (raw.js: "it has no schema/rows model at all" -- its
 * size comes from part metadata, not a schema+rows model).
 *
 * This is the SAME condition `download.js`'s `run()` branches on
 * (`output.format === RAW_FORMAT_ID`, checked before `engine.plan()`), so
 * a caller that pre-flights with this `estimate()` and then calls
 * `download()` sees the same path both times.
 *
 * One consequence, not a bug: `estimate` imported directly from
 * `./estimate.js` (as that file's own unit tests do) does NOT route --
 * only this, the public `@cng/download-core` entry point, does.
 *
 * @param {import('./types.js').DatasetDescriptor} dataset
 * @param {import('@cng/spec').Area|null} area
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('./types.js').DownloadCoreOptions & { output?: import('./types.js').OutputRequest, sink?: { kind: string }|null }} [options]
 * @returns {Promise<import('./types.js').Estimate>}
 */
export async function estimate(dataset, area, filter, options = {}) {
  if (options.output?.format === RAW_FORMAT_ID) {
    const rawPlan = await planRaw(dataset, area, filter, options);
    return rawEstimate(rawPlan, filter, options);
  }
  return estimateDecoded(dataset, area, filter, options);
}

// Built-in defaults (design doc §3.4: "geojson and geoparquet are in
// core"; design call #2: hyparquet is the default engine). Registered as a
// side effect of importing this module, idempotently.
if (!getFormat('geojson')) registerFormat(createGeoJsonFormat());
if (!getFormat('geoparquet')) registerFormat(createGeoParquetFormat());
if (!getEngine(HYPARQUET_ENGINE_ID)) registerEngine(createHyparquetEngine());
// Task 6 left this unregistered deliberately (its own file has no
// `registerFormat` call); Task 7 registers it here so `formats()` lists
// it for a UI to offer, same as geojson/geoparquet above. It is listed,
// never `getFormat()`-resolved into the normal decode pipeline: `download()`
// branches to the raw path on `output.format === RAW_FORMAT_ID` before any
// `getFormat()`/`resolveFormat()` call is reached (download.js), and
// `suggestedFormatsFor()` skips any registered entry with no
// `estimateBytes` (this descriptor has none -- it has no schema/rows model).
if (!getFormat(RAW_FORMAT_ID)) registerFormat(rawFormatDescriptor);
