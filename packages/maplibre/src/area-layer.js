// @cngeo/maplibre -- the outline layer (design doc §5.1 item 3, §5.2).
//
// Renders `Area.geometry`, and optionally a dashed "ghost" of
// `Area.filterGeometry` when it differs from the display geometry (so a
// user can see that their filter was simplified). Core (@cngeo/spec) owns
// simplification; this module only draws what it is given.

import { fitAreaBounds } from './fit-bounds.js';

const SOURCE_ID_PREFIX = 'cng-area';

/** @typedef {import('@cngeo/spec').Area} Area */

/**
 * @typedef {{
 *   lineColor?: string, lineWidth?: number, lineDasharray?: number[],
 *   fillColor?: string, fillOpacity?: number,
 *   showFilterGeometry?: boolean, beforeId?: string,
 * }} AreaLayerStyle
 */

const DEFAULT_STYLE = {
  lineColor: '#1a73e8',
  lineWidth: 2,
  fillColor: '#1a73e8',
  fillOpacity: 0.08,
  showFilterGeometry: true,
};

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {AreaLayerStyle & { id?: string }} [options]
 * @returns {{
 *   setArea(area: Area|null): void,
 *   setStyle(style: AreaLayerStyle): void,
 *   fit(options?: { padding?: number, maxZoom?: number }): void,
 *   remove(): void,
 * }}
 */
export function addAreaLayer(map, options = {}) {
  const id = options.id ?? SOURCE_ID_PREFIX;
  let style = { ...DEFAULT_STYLE, ...options };
  let currentArea = null;

  const displaySourceId = `${id}-display`;
  const filterSourceId = `${id}-filter`;
  const fillLayerId = `${id}-fill`;
  const lineLayerId = `${id}-line`;
  const filterLineLayerId = `${id}-filter-line`;

  function ensureLayers() {
    if (!map.getSource(displaySourceId)) {
      map.addSource(displaySourceId, { type: 'geojson', data: emptyFeatureCollection() });
    }
    if (!map.getSource(filterSourceId)) {
      map.addSource(filterSourceId, { type: 'geojson', data: emptyFeatureCollection() });
    }
    if (!map.getLayer(fillLayerId)) {
      map.addLayer(
        {
          id: fillLayerId,
          type: 'fill',
          source: displaySourceId,
          paint: { 'fill-color': style.fillColor, 'fill-opacity': style.fillOpacity },
        },
        style.beforeId,
      );
    }
    if (!map.getLayer(filterLineLayerId)) {
      map.addLayer(
        {
          id: filterLineLayerId,
          type: 'line',
          source: filterSourceId,
          paint: {
            'line-color': style.lineColor,
            'line-width': 1,
            'line-dasharray': [2, 2],
            'line-opacity': 0.8,
          },
          layout: { visibility: style.showFilterGeometry ? 'visible' : 'none' },
        },
        style.beforeId,
      );
    }
    if (!map.getLayer(lineLayerId)) {
      map.addLayer(
        {
          id: lineLayerId,
          type: 'line',
          source: displaySourceId,
          paint: {
            'line-color': style.lineColor,
            'line-width': style.lineWidth,
            ...(style.lineDasharray ? { 'line-dasharray': style.lineDasharray } : {}),
          },
        },
        style.beforeId,
      );
    }
  }

  function applyStylePaint() {
    if (map.getLayer(fillLayerId)) {
      map.setPaintProperty(fillLayerId, 'fill-color', style.fillColor);
      map.setPaintProperty(fillLayerId, 'fill-opacity', style.fillOpacity);
    }
    if (map.getLayer(lineLayerId)) {
      map.setPaintProperty(lineLayerId, 'line-color', style.lineColor);
      map.setPaintProperty(lineLayerId, 'line-width', style.lineWidth);
    }
    if (map.getLayer(filterLineLayerId)) {
      map.setLayoutProperty(filterLineLayerId, 'visibility', style.showFilterGeometry ? 'visible' : 'none');
    }
  }

  ensureLayers();

  function setArea(area) {
    currentArea = area;
    const displayFc = area ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: area.geometry }] } : emptyFeatureCollection();
    const filterDiffers = area && area.filterGeometry && area.filterGeometry !== area.geometry;
    const filterFc = filterDiffers
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: area.filterGeometry }] }
      : emptyFeatureCollection();
    map.getSource(displaySourceId)?.setData(displayFc);
    map.getSource(filterSourceId)?.setData(filterFc);
  }

  function setStyle(newStyle) {
    style = { ...style, ...newStyle };
    applyStylePaint();
  }

  function fit(fitOptions) {
    if (!currentArea) return;
    fitAreaBounds(map, currentArea.bboxes, fitOptions);
  }

  function remove() {
    for (const layerId of [fillLayerId, lineLayerId, filterLineLayerId]) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    for (const sourceId of [displaySourceId, filterSourceId]) {
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }

  return { setArea, setStyle, fit, remove };
}
