// @cnmw/maplibre -- createDrawTool (design doc §5.2, un-demoted from §8's
// "specified here, not implemented" table). Minimal draw: rectangle (drag)
// and viewport (one click, no drag). Emits an `Area` with
// `provenance.source: 'draw'`, built through `@cnmw/spec`'s `buildArea` --
// this file never constructs an Area field by hand, per §5.1's "an adapter
// must not construct an Area from raw coordinates without going through
// @cnmw/spec's normalizer."
//
// Polygon (click-to-add-point, double-click-to-close) is NOT implemented
// here. §8's own entry for this symbol said "a half-working draw tool is
// worse than none" about the whole thing; the same reasoning applies to
// one tool inside it once the other two are solid. A host that needs
// freehand polygon drawing today still has the escape hatch §8 already
// names: a general draw library (e.g. terra-draw) plus
// `@cnmw/upload-core`'s `areaFromGeoJson` (source: 'upload').

import { buildArea } from '@cnmw/spec';

/** @typedef {import('@cnmw/spec').Area} Area */
/** @typedef {[number, number]} LngLat */

// Below this, a mousedown+mouseup with no real drag (a stray click, or a
// double-click landing while armed) would otherwise build a degenerate,
// near-zero-area rectangle. In degrees, not meters, because that is what
// the two corners are given in; ~1.1m at the equator, tighter at higher
// latitudes -- small enough to never reject an intentional rectangle.
const MIN_DEGREES = 1e-5;

/**
 * Build a rectangle ring (closed, counter-clockwise -- RFC 7946's exterior
 * winding) from two opposite corners in any order. Pure; no map, no DOM.
 * @param {LngLat} a
 * @param {LngLat} b
 * @returns {[number, number][]}
 */
export function rectangleRingFromCorners(a, b) {
  const west = Math.min(a[0], b[0]);
  const east = Math.max(a[0], b[0]);
  const south = Math.min(a[1], b[1]);
  const north = Math.max(a[1], b[1]);
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/**
 * @param {LngLat} a
 * @param {LngLat} b
 * @returns {GeoJSON.Polygon}
 */
export function rectanglePolygonFromCorners(a, b) {
  return { type: 'Polygon', coordinates: [rectangleRingFromCorners(a, b)] };
}

/** True when two corners are close enough that the rectangle between them
 *  is degenerate (a click with no real drag), in either axis. Pure. */
export function isDegenerateRectangle(a, b) {
  return Math.abs(a[0] - b[0]) < MIN_DEGREES || Math.abs(a[1] - b[1]) < MIN_DEGREES;
}

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {{ tools?: ('rectangle'|'polygon'|'viewport')[], id?: string }} [options]
 * @returns {{
 *   readonly armed: boolean,
 *   arm(tool?: 'rectangle'|'viewport'): void,
 *   disarm(): void,
 *   on(event: 'area'|'armed'|'disarmed'|'cancel', handler: (payload: unknown) => void): () => void,
 *   remove(): void,
 * }}
 */
export function createDrawTool(map, options = {}) {
  const tools = options.tools ?? ['rectangle', 'viewport'];
  if (tools.includes('polygon')) {
    // Honest about scope right where a caller would find out the hard way
    // otherwise -- see this file's header. Does not throw: declaring the
    // tool is harmless, only arming it would be a lie.
    // eslint-disable-next-line no-console
    console.warn('createDrawTool: "polygon" is accepted in `tools` but not implemented -- arm("polygon") throws. See draw-tool.js header.');
  }

  const sourceId = options.id ? `${options.id}-preview` : 'cnmw-draw-preview';
  const fillLayerId = `${sourceId}-fill`;
  const lineLayerId = `${sourceId}-line`;

  let armed = false;
  let dragging = false;
  /** @type {LngLat|null} */
  let startLngLat = null;
  let currentTool = null;

  const listeners = new Map();
  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }
  function emit(event, payload) {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  }

  function ensurePreviewLayer() {
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, { type: 'geojson', data: emptyFeatureCollection() });
    }
    if (!map.getLayer(fillLayerId)) {
      map.addLayer({ id: fillLayerId, type: 'fill', source: sourceId, paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.1 } });
    }
    if (!map.getLayer(lineLayerId)) {
      map.addLayer({
        id: lineLayerId,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': '#1a73e8', 'line-width': 2, 'line-dasharray': [2, 1] },
      });
    }
  }
  function setPreview(geometry) {
    ensurePreviewLayer();
    const fc = geometry ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] } : emptyFeatureCollection();
    map.getSource(sourceId)?.setData(fc);
  }
  function clearPreview() {
    setPreview(null);
  }
  function removePreviewLayer() {
    for (const id of [fillLayerId, lineLayerId]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }

  function pointFromClient(clientX, clientY) {
    const rect = map.getContainer().getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }
  /** @returns {LngLat} */
  function lngLatFromClient(clientX, clientY) {
    const ll = map.unproject(pointFromClient(clientX, clientY));
    return [ll.lng, ll.lat];
  }

  function endDrag() {
    dragging = false;
    startLngLat = null;
    map.dragPan.enable();
    clearPreview();
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
  }

  function finishRectangle(a, b, tool) {
    const geometry = rectanglePolygonFromCorners(a, b);
    const area = buildArea({
      name: tool === 'viewport' ? 'Current viewport' : 'Drawn area',
      geometry,
      source: 'draw',
      features: [],
      combine: 'single',
      geometryVariant: 'full',
      provenanceExtra: { draw: { tool, mapCrs: 'EPSG:4326' } },
    });
    emit('area', { area });
  }

  // Drag tracking deliberately does NOT use `map.on('mousemove'/'mouseup', ...)`
  // past the initial mousedown: MapLibre only dispatches those to a map's own
  // listeners while the pointer stays over the canvas, so a drag that ends
  // (or passes through) any other element on the page -- this demo's
  // floating panel overlaps a third of the map -- would never reach
  // a mouseup handler and leave `dragPan` disabled and the preview stuck. Once a
  // drag starts, `window`-level listeners (removed again in `endDrag`) take
  // over and compute the lngLat themselves via `map.unproject`.
  function onMouseDown(e) {
    if (!armed || currentTool !== 'rectangle') return;
    dragging = true;
    startLngLat = [e.lngLat.lng, e.lngLat.lat];
    map.dragPan.disable();
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
  }
  function onWindowMouseMove(e) {
    if (!dragging || !startLngLat) return;
    setPreview(rectanglePolygonFromCorners(startLngLat, lngLatFromClient(e.clientX, e.clientY)));
  }
  function onWindowMouseUp(e) {
    if (!dragging || !startLngLat) return;
    const end = lngLatFromClient(e.clientX, e.clientY);
    const start = startLngLat;
    endDrag();
    if (isDegenerateRectangle(start, end)) return; // a stray click, not a drag -- stay armed
    disarm();
    finishRectangle(start, end, 'rectangle');
  }
  function onKeyDown(e) {
    if (e.key !== 'Escape' || !armed) return;
    const wasDragging = dragging;
    if (wasDragging) endDrag();
    disarm();
    emit('cancel', { duringDrag: wasDragging });
  }

  /** @param {'rectangle'|'viewport'} [tool] */
  function arm(tool = 'rectangle') {
    if (!tools.includes(tool)) {
      throw new Error(`createDrawTool: tool "${tool}" is not in the enabled set (${tools.join(', ')}).`);
    }
    if (tool === 'polygon') {
      throw new Error('createDrawTool: "polygon" is not implemented -- see draw-tool.js header for the escape hatch.');
    }
    if (tool === 'viewport') {
      // One-shot: no pointer arming needed, nothing to disarm.
      const b = map.getBounds();
      finishRectangle([b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()], 'viewport');
      return;
    }
    if (armed) disarm();
    currentTool = tool;
    armed = true;
    map.getCanvas().style.cursor = 'crosshair';
    map.on('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    emit('armed', { tool });
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    currentTool = null;
    map.getCanvas().style.cursor = '';
    map.off('mousedown', onMouseDown);
    document.removeEventListener('keydown', onKeyDown);
    if (dragging) endDrag();
    emit('disarmed', {});
  }

  function remove() {
    disarm();
    removePreviewLayer();
    listeners.clear();
  }

  return {
    get armed() {
      return armed;
    },
    arm,
    disarm,
    on,
    remove,
  };
}
