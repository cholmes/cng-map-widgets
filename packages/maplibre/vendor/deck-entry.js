// Entry module for the prebuilt deck.gl bundle (`deck-stack.js`).
//
// This file is NOT loaded by anything at runtime. `tools/build-deck-bundle.mjs`
// bundles it, with every import below inlined, into one ES module whose
// named exports are exactly these. `../src/deck-loader.js` loads that module
// and checks it against DECK_REQUIRED_EXPORTS; a name added there must be
// exported here, and the bundle rebuilt.
//
// Everything deck.gl-shaped any @cngeo widget needs comes through here, so
// the page holds one `@deck.gl/core` and one `@luma.gl/core`.

// deck.gl <-> MapLibre. Interleaved mode + `beforeId` is what lets a raster
// sit between two MapLibre style layers.
export { MapLibreOverlay } from '@deck.gl/maplibre';

export { COORDINATE_SYSTEM, WebMercatorViewport } from '@deck.gl/core';
export { GeoJsonLayer, ScatterplotLayer, PathLayer } from '@deck.gl/layers';

// The timeline's PMTiles chunks (Phase 4) draw as MVT layers and filter
// points on the GPU.
export { MVTLayer } from '@deck.gl/geo-layers';
export { DataFilterExtension } from '@deck.gl/extensions';
export { MVTLoader } from '@loaders.gl/mvt';

// Rasters: Development Seed's deck.gl-raster.
export { COGLayer, MultiCOGLayer, MosaicLayer, COGSource, MultiCOGSource } from '@developmentseed/deck.gl-geotiff';
export { RasterLayer, RasterTileLayer } from '@developmentseed/deck.gl-raster';
export * as gpuModules from '@developmentseed/deck.gl-raster/gpu-modules';
export { DecoderPool, defaultDecoderPool } from '@developmentseed/geotiff';

// CRS definitions. deck.gl-raster resolves a COG's EPSG code through
// `epsgResolver`, which answers from this `proj4`'s definitions when it can
// and asks epsg.io otherwise -- so `../src/projections.js` adds the UTM
// families to `proj4` up front. `registerProjection` takes WKT or PROJJSON,
// for a host with a CRS outside them.
export { default as proj4 } from 'proj4';
export { registerProjection, PROJECTION_REGISTRY, epsgResolver } from '@developmentseed/proj';

/** Versions baked in at build time: `{ deck, luma, raster, geotiff, loaders, proj4 }`. */
// eslint-disable-next-line no-undef
export const VERSIONS = __CNG_DECK_VERSIONS__;
