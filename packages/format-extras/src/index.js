// @cnmw/format-extras -- public entry point: the "nearly free" formats
// (Chris's scope note). Both zero-dependency, zero-wasm; register either
// eagerly.
//
//   import { registerFormat } from '@cnmw/download-core';
//   import { createCsvFormat, createEsriJsonFormat } from '@cnmw/format-extras';
//   registerFormat(createCsvFormat());
//   registerFormat(createEsriJsonFormat());

export const VERSION = '0.1.0';

export { createCsvFormat, estimateCsvBytes } from './csv.js';
export { createEsriJsonFormat, estimateEsriJsonBytes } from './esrijson.js';
export { wkbToGeoJson, geometryToWkt, esriRingsOf } from './geometry.js';

import { createCsvFormat, estimateCsvBytes } from './csv.js';
import { createEsriJsonFormat, estimateEsriJsonBytes } from './esrijson.js';

/** Both resolve immediately -- no CDN fetch, nothing to lazily load. */
export const csvFormatDescriptor = {
  id: 'csv',
  label: 'CSV (WKT geometry)',
  extension: 'csv',
  mediaType: 'text/csv',
  streaming: true,
  capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
  approxBytes: { min: 0, max: 1_000, estimate: 300 },
  // Shared with the plugin itself so the two can never drift (and still
  // pure JS, no wasm, as `LazyFormatDescriptor.estimateBytes` requires).
  estimateBytes: estimateCsvBytes,
  async load() {
    return createCsvFormat();
  },
};

export const esriJsonFormatDescriptor = {
  id: 'esrijson',
  label: 'Esri JSON (FeatureSet)',
  extension: 'json',
  mediaType: 'application/json',
  streaming: false,
  capabilities: { nestedColumns: false, mixedGeometryTypes: false, crs: ['OGC:CRS84', 'EPSG:4326'] },
  approxBytes: { min: 0, max: 1_000, estimate: 300 },
  estimateBytes: estimateEsriJsonBytes,
  async load() {
    return createEsriJsonFormat();
  },
};
