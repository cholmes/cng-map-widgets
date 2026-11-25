// @cngeo/maplibre -- public entry point.

export const VERSION = '0.3.1';

export { GeocoderControl } from './geocoder-control.js';
export { addAreaLayer } from './area-layer.js';
export { viewportProvider } from './viewport.js';
export { fitAreaBounds } from './fit-bounds.js';
export {
  DECK_BUNDLE_URL,
  DECK_REQUIRED_EXPORTS,
  APPROX_BYTES,
  loadDeck,
  setDeckModules,
  clearDeckModules,
  deckSupport,
} from './deck-loader.js';
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
