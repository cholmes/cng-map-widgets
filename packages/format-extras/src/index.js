// @cnmw/format-extras -- public entry point: the "nearly free" formats
// (Chris's scope note). Both zero-dependency, zero-wasm; register either
// eagerly.
//
//   import { registerFormat } from '@cnmw/download-core';
//   import { createCsvFormat, createEsriJsonFormat } from '@cnmw/format-extras';
//   registerFormat(createCsvFormat());
//   registerFormat(createEsriJsonFormat());

export const VERSION = '0.1.0';

export { createCsvFormat } from './csv.js';
export { createEsriJsonFormat } from './esrijson.js';
export { wkbToGeoJson, geometryToWkt, esriRingsOf } from './geometry.js';

import { createCsvFormat } from './csv.js';
import { createEsriJsonFormat } from './esrijson.js';

/** Both resolve immediately -- no CDN fetch, nothing to lazily load. */
export const csvFormatDescriptor = {
  id: 'csv',
  label: 'CSV (WKT geometry)',
  extension: 'csv',
  mediaType: 'text/csv',
  streaming: true,
  capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
  approxBytes: { min: 0, max: 1_000, estimate: 300 },
  estimateBytes(schema, rows) {
    const perRow = schema.length * 12 + 70;
    return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
  },
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
  estimateBytes(schema, rows) {
    const perRow = schema.length * 28 + 180;
    return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
  },
  async load() {
    return createEsriJsonFormat();
  },
};
