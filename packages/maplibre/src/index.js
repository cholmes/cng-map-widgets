// @cngeo/maplibre -- public entry point.

export const VERSION = '0.2.0';

export { GeocoderControl } from './geocoder-control.js';
export { addAreaLayer } from './area-layer.js';
export { viewportProvider } from './viewport.js';
export { fitAreaBounds } from './fit-bounds.js';
export {
  createDrawTool,
  rectangleRingFromCorners,
  rectanglePolygonFromCorners,
  isDegenerateRectangle,
  polygonRingFromVertices,
  polygonFromVertices,
  isClosablePolygon,
  isSameScreenPoint,
} from './draw-tool.js';
export {
  createEditTool,
  buildEditedArea,
  openRingOf,
  closeRing,
  moveVertex,
  midpointsOf,
  insertMidpoint,
  deleteVertex,
  largestExteriorRing,
  withExteriorRing,
} from './edit-tool.js';
