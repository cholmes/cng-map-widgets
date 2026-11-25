// @cngeo/maplibre -- public entry point.

export const VERSION = '0.3.1';

export { GeocoderControl } from './geocoder-control.js';
export { addAreaLayer } from './area-layer.js';
export { viewportProvider } from './viewport.js';
export { fitAreaBounds } from './fit-bounds.js';
export { LayerManager, registerLayerRenderer } from './layer-manager.js';
export { PMTILES_CDN, loadPmtiles, setPmtilesModules, clearPmtilesModules } from './pmtiles-loader.js';
export { planStyle, defaultVectorStyle, opacityPaint } from './renderers/style-plan.js';
export { LayerControl } from './layer-control.js';
export { createControlAdapter, applyPanelOrder } from './layer-control-adapter.js';
export { urlAddProvider, specsFromUrl, addFromUrl } from './add-providers.js';
export {
  LAYER_CONTROL_VERSION,
  LAYER_CONTROL_CDN,
  loadLayerControl,
  setLayerControlModules,
  clearLayerControlModules,
} from './layer-control-loader.js';

// The built-in renderers. Registered as a side effect of importing this
// module (the way @cngeo/extract-core registers its built-in formats), so a
// `new LayerManager(map)` can draw every kind out of the box. Importing a
// renderer loads none of its dependencies: pmtiles and the deck.gl bundle are
// fetched the first time a layer of that kind is added.
import { registerLayerRenderer } from './layer-manager.js';
import { pmtilesVectorRenderer } from './renderers/pmtiles-vector.js';
import { geojsonRenderer } from './renderers/geojson.js';
import { cogRenderer } from './renderers/cog.js';

registerLayerRenderer('pmtiles-vector', pmtilesVectorRenderer);
registerLayerRenderer('geojson', geojsonRenderer);
registerLayerRenderer('cog', cogRenderer);
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
