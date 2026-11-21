// @cngeo/upload-core -- public entry point.
//
// Same packaging deviation as @cngeo/spec/@cngeo/geocoder-core/@cngeo/maplibre
// (see their index.js files): plain ESM + JSDoc, no build step, for this
// experiment phase. Zero runtime dependencies beyond @cngeo/spec -- no
// network, no CDN externalization question (design doc §4.2) applies.

export const VERSION = '0.3.0';

export { areaFromFile, areaFromGeoJson, attachDropTarget, registerReader } from './upload.js';
export { geoJsonReader } from './geojson-reader.js';
export { repairFeatures } from './repair.js';
export { extractRawFeatures, detectDeclaredCrs } from './geojson-parse.js';
