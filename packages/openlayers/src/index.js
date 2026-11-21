// @cngeo/openlayers -- public entry point.
//
// Same packaging deviation as @cngeo/spec/@cngeo/maplibre (see their
// index.js files): plain ESM + JSDoc, no build step, for this experiment
// phase. `ol` is a peer dependency, loaded by the host page -- in a
// bundled app from node_modules, in a zero-build page via an import-map
// prefix entry (`"ol/": "https://cdn.jsdelivr.net/npm/ol@<exact>/"`), per
// design doc §4.2's "pinned, exact CDN URL, never a floating specifier".

export const VERSION = '0.3.0';

export { GeocoderControl } from './geocoder-control.js';
export { addAreaLayer } from './area-layer.js';
export { viewportProvider } from './viewport.js';
export { fitAreaBounds } from './fit-bounds.js';
export { selectNearestBBox } from './nearest-bbox.js';
export {
  isMercatorCode,
  isLonLatCode,
  lonLatToMercator,
  mercatorToLonLat,
  projectPoint,
  unprojectPoint,
  projectExtent,
  unprojectExtent,
  projectGeometry,
} from './projection.js';
