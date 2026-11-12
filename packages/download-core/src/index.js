// @cnmw/download-core -- public entry point.
//
// Deviation from the design doc's three-build-artifact packaging (§4.1),
// matching @cnmw/spec and @cnmw/geocoder-core: this experiment phase ships
// plain ESM + JSDoc with NO build step. A consumer imports this file
// directly; dependencies on hyparquet/hyparquet-writer are loaded lazily
// from pinned CDN URLs (see src/cdn.js), never bundled in.

export const VERSION = '0.1.0';

export { resolveDataset, descriptorFromCollection, collectionDownloadSupport } from './dataset-resolve.js';
export { CDN, loadHyparquet, loadHyparquetWriter, setHyparquetModules, clearHyparquetModules } from './cdn.js';
export { estimate } from './estimate.js';
export { download, downloadRequest } from './download.js';
export { registerFormat, registerLazyFormat, formats, resolveFormat, getFormat, formatLoadState, registerEngine, engines } from './registry.js';
export { memorySink, blobSink, streamSink, fileSystemSink, autoSink } from './sinks.js';
export { createHyparquetEngine, HYPARQUET_ENGINE_ID } from './engine-hyparquet.js';
export { createGeoJsonFormat } from './formats/geojson.js';
export { createGeoParquetFormat } from './formats/geoparquet.js';
export { defaultCeiling, requirementsOf } from './ceiling.js';
export { evaluatePredicate, evaluateWhere, getPath } from './predicate.js';
export { rowMatchesArea, bboxIntersectsAny, pointInGeometry, geometriesIntersect, geometryIntersectsArea } from './spatial.js';
export { decodeWkbGeometry, bboxOfAnyGeometry } from './wkb-geometry.js';
export { boundedExact, boundedRange, addBounded, sumBounded, scaleBounded, capBounded, isEstimateWide } from './bounded.js';
export { enumeratePartitions, partitionPruneCascade } from './partitions.js';
export { pruneRowGroupsByBBox, pruneRowGroupsByTime } from './prune.js';
export { CnmwError, CancelledError, CeilingExceededError, isCnmwError } from '@cnmw/spec';

import { registerFormat, registerEngine, getFormat, getEngine } from './registry.js';
import { createGeoJsonFormat } from './formats/geojson.js';
import { createGeoParquetFormat } from './formats/geoparquet.js';
import { createHyparquetEngine, HYPARQUET_ENGINE_ID } from './engine-hyparquet.js';

// Built-in defaults (design doc §3.4: "geojson and geoparquet are in
// core"; design call #2: hyparquet is the default engine). Registered as a
// side effect of importing this module, idempotently.
if (!getFormat('geojson')) registerFormat(createGeoJsonFormat());
if (!getFormat('geoparquet')) registerFormat(createGeoParquetFormat());
if (!getEngine(HYPARQUET_ENGINE_ID)) registerEngine(createHyparquetEngine());
