// @cngeo/openlayers -- the outline layer (design doc §5.1 item 3, §5.2).
//
// Renders `Area.geometry`, and optionally a dashed "ghost" of
// `Area.filterGeometry` when it differs from the display geometry.
// Mirrors @cngeo/maplibre/src/area-layer.js, but every geometry handed to
// OL must first go through the projection bridge ("in" direction): Area
// geometry is always EPSG:4326 (design doc §1), OL vector sources render
// in the view's projection.

import VectorSource from 'ol/source/Vector.js';
import VectorLayer from 'ol/layer/Vector.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';

import { projectGeometry, isMercatorCode } from './projection.js';
import { olTransform } from './ol-proj-bridge.js';
import { fitAreaBounds } from './fit-bounds.js';

/** @typedef {import('@cngeo/spec').Area} Area */

/**
 * @typedef {{
 *   lineColor?: string, lineWidth?: number, lineDash?: number[],
 *   fillColor?: string, fillOpacity?: number,
 *   showFilterGeometry?: boolean, featureProjection?: string,
 * }} AreaLayerStyle
 */

const DEFAULT_STYLE = {
  lineColor: '#1a73e8',
  lineWidth: 2,
  fillColor: '#1a73e8',
  fillOpacity: 0.08,
  showFilterGeometry: true,
};

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const geoJsonFormat = new GeoJSON();

/**
 * @param {import('ol/Map.js').default} map
 * @param {AreaLayerStyle} [options]
 * @returns {{
 *   setArea(area: Area|null): void,
 *   setStyle(style: AreaLayerStyle): void,
 *   fit(options?: { padding?: number, maxZoom?: number }): void,
 *   remove(): void,
 * }}
 */
export function addAreaLayer(map, options = {}) {
  let style = { ...DEFAULT_STYLE, ...options };
  let currentArea = null;

  const displaySource = new VectorSource();
  const filterSource = new VectorSource();

  function fillStyle() {
    return new Style({
      stroke: new Stroke({ color: style.lineColor, width: style.lineWidth, lineDash: style.lineDash }),
      fill: new Fill({ color: hexToRgba(style.fillColor, style.fillOpacity) }),
    });
  }
  function filterGhostStyle() {
    return new Style({ stroke: new Stroke({ color: style.lineColor, width: 1, lineDash: [2, 2] }) });
  }

  const displayLayer = new VectorLayer({ source: displaySource, style: fillStyle() });
  const filterLayer = new VectorLayer({
    source: filterSource,
    style: filterGhostStyle(),
    visible: style.showFilterGeometry,
  });

  map.addLayer(displayLayer);
  map.addLayer(filterLayer);

  function mapProjectionCode() {
    return style.featureProjection ?? map.getView().getProjection().getCode();
  }

  function toFeature(geometry) {
    const code = mapProjectionCode();
    const transformOpt = isMercatorCode(code) ? {} : { transform: olTransform };
    const projected = projectGeometry(geometry, code, transformOpt);
    return geoJsonFormat.readFeature({ type: 'Feature', properties: {}, geometry: projected });
  }

  function setArea(area) {
    currentArea = area;
    displaySource.clear();
    filterSource.clear();
    if (!area) return;
    displaySource.addFeature(toFeature(area.geometry));
    const filterDiffers = area.filterGeometry && area.filterGeometry !== area.geometry;
    if (filterDiffers) filterSource.addFeature(toFeature(area.filterGeometry));
  }

  function setStyle(newStyle) {
    style = { ...style, ...newStyle };
    displayLayer.setStyle(fillStyle());
    filterLayer.setStyle(filterGhostStyle());
    filterLayer.setVisible(style.showFilterGeometry);
  }

  function fit(fitOptions = {}) {
    if (!currentArea) return;
    fitAreaBounds(map, currentArea.bboxes, { ...fitOptions, featureProjection: style.featureProjection });
  }

  function remove() {
    map.removeLayer(displayLayer);
    map.removeLayer(filterLayer);
  }

  /** Not in the design doc's `AreaLayerHandle` (§5.2); a small, harmless addition for introspection (e.g. verification scripts). */
  function getArea() {
    return currentArea;
  }

  return { setArea, setStyle, fit, remove, getArea };
}
