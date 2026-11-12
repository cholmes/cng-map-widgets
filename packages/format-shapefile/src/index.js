// @cnmw/format-shapefile -- public entry point.
//
// Zero dependencies, zero wasm: register it eagerly, no CDN fetch needed.
//
//   import { registerFormat } from '@cnmw/download-core';
//   import { createShapefileFormat } from '@cnmw/format-shapefile';
//   registerFormat(createShapefileFormat());
//
// A tiny `shapefileFormatDescriptor` (download-core's lazy-registration
// shape) is also exported for a host page that wants every non-built-in
// format listed uniformly through `registerLazyFormat` -- its `load()`
// resolves immediately (there is nothing to fetch), so this costs nothing
// beyond the registry bookkeeping.

export const VERSION = '0.1.0';

export { createShapefileFormat } from './shapefile-writer.js';
export { writeDbf } from './dbf.js';
export { SHAPE_TYPE, shapeFamilyOf, polygonRingsForShapefile, buildShapeRecordContent, assembleShpShx } from './shp.js';
export { writeZipStored } from './zip.js';
export { wkbToGeoJson } from './wkb-decode.js';

import { createShapefileFormat } from './shapefile-writer.js';

export const shapefileFormatDescriptor = {
  id: 'shapefile',
  label: 'Shapefile',
  extension: 'shp.zip',
  mediaType: 'application/zip',
  streaming: false,
  capabilities: { nestedColumns: false, mixedGeometryTypes: false, crs: ['OGC:CRS84', 'EPSG:4326'] },
  approxBytes: { min: 0, max: 2_000, estimate: 500 }, // this package's own code only -- no wasm, no CDN fetch
  estimateBytes(schema, rows) {
    const perRow = schema.length * 40 + 90;
    return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
  },
  async load() {
    return createShapefileFormat();
  },
};
