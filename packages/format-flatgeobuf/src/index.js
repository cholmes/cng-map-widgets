// @cngeo/format-flatgeobuf -- public entry point.
//
//   import { registerLazyFormat } from '@cngeo/extract-core';
//   import { flatGeobufFormatDescriptor } from '@cngeo/format-flatgeobuf';
//   registerLazyFormat(flatGeobufFormatDescriptor);
//   // ~10KB (min+gz) fetches only on first download() for format: 'flatgeobuf'.

export const VERSION = '0.3.1';

export { createFlatGeobufFormat, estimateFlatGeobufBytes } from './flatgeobuf-writer.js';
export { CDN, APPROX_BYTES, loadFlatGeobuf, setFlatGeobufModule, clearFlatGeobufModule } from './cdn.js';
export { wkbToGeoJson } from './wkb-decode.js';

import { createFlatGeobufFormat, estimateFlatGeobufBytes } from './flatgeobuf-writer.js';
import { loadFlatGeobuf, APPROX_BYTES } from './cdn.js';

export const flatGeobufFormatDescriptor = {
  id: 'flatgeobuf',
  label: 'FlatGeobuf',
  extension: 'fgb',
  mediaType: 'application/octet-stream',
  streaming: false,
  capabilities: { nestedColumns: true, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
  approxBytes: APPROX_BYTES,
  estimateBytes: estimateFlatGeobufBytes, // shared with the plugin, so the two can never drift
  async load() {
    const mod = await loadFlatGeobuf();
    return createFlatGeobufFormat(mod);
  },
};
