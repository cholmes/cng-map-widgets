// @cnmw/format-flatgeobuf -- public entry point.
//
//   import { registerLazyFormat } from '@cnmw/download-core';
//   import { flatGeobufFormatDescriptor } from '@cnmw/format-flatgeobuf';
//   registerLazyFormat(flatGeobufFormatDescriptor);
//   // ~10KB (min+gz) fetches only on first download() for format: 'flatgeobuf'.

export const VERSION = '0.1.0';

export { createFlatGeobufFormat } from './flatgeobuf-writer.js';
export { CDN, APPROX_BYTES, loadFlatGeobuf, setFlatGeobufModule, clearFlatGeobufModule } from './cdn.js';
export { wkbToGeoJson } from './wkb-decode.js';

import { createFlatGeobufFormat } from './flatgeobuf-writer.js';
import { loadFlatGeobuf, APPROX_BYTES } from './cdn.js';

export const flatGeobufFormatDescriptor = {
  id: 'flatgeobuf',
  label: 'FlatGeobuf',
  extension: 'fgb',
  mediaType: 'application/octet-stream',
  streaming: false,
  capabilities: { nestedColumns: true, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
  approxBytes: APPROX_BYTES,
  estimateBytes(schema, rows) {
    const perRow = schema.length * 15 + 50;
    return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
  },
  async load() {
    const mod = await loadFlatGeobuf();
    return createFlatGeobufFormat(mod);
  },
};
