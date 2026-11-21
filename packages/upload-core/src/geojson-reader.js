// @cngeo/upload-core -- the built-in GeoJSON reader (design doc §3.3: "Core
// registers GeoJSON only"; `registerReader()` is the seam a host app uses
// to add shapefile-js / gdal3.js / etc. readers without upload-core
// depending on them).

import { CngError } from '@cngeo/spec';
import { extractRawFeatures, detectDeclaredCrs } from './geojson-parse.js';

/** @type {import('./types.js').GeometryReader} */
export const geoJsonReader = {
  id: 'geojson',
  extensions: ['.geojson', '.json'],
  mediaTypes: ['application/geo+json', 'application/json', 'application/vnd.geo+json'],

  async read(file, signal) {
    signal?.throwIfAborted();
    let text;
    try {
      text = await file.text();
    } catch (cause) {
      throw new CngError(`Couldn't read "${file.name}".`, 'UPLOAD_PARSE_ERROR', { cause, context: { filename: file.name } });
    }
    signal?.throwIfAborted();

    let json;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new CngError(`"${file.name}" is not valid JSON.`, 'UPLOAD_PARSE_ERROR', { cause, context: { filename: file.name } });
    }

    return { features: extractRawFeatures(json), declaredCrs: detectDeclaredCrs(json) };
  },
};
