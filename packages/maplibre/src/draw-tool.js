// @cng/maplibre -- createDrawTool (design doc §5.2, un-demoted from §8's
// "specified here, not implemented" table). Three tools: rectangle (drag),
// polygon (click vertices, double-click/Enter to close) and viewport (one
// click, no drag). Each emits an `Area` with `provenance.source: 'draw'`,
// built through `@cng/spec`'s `buildArea` -- this file never constructs an
// Area field by hand, per §5.1's "an adapter must not construct an Area
// from raw coordinates without going through @cng/spec's normalizer."
//
// POLYGON, AND WHY IT IS HERE NOW. This file used to say polygon was out
// of scope, warn when it was declared and throw from `arm('polygon')`, on
// the grounds that "a half-working draw tool is worse than none" and that a
// host needing it could reach for terra-draw plus `@cng/upload-core`'s
// `areaFromGeoJson`. That escape hatch turned out to cost ~262 KB of CDN
// dependency (the figure edit-tool.js measured for terra-draw + its
// MapLibre adapter) for what is, below, about a hundred lines of click
// handling and array pushing -- on pages that already ship every piece it
// needs. portolan-browser's download widget wanted "Draw polygon" beside
// "Draw a box"; it was briefly implemented there instead, and then moved
// here, because two hosts would otherwise write it twice and a drawn
// polygon's provenance belongs in the same place as a drawn rectangle's.
//
// The geometry helpers stay pure and exported for the same reason the
// rectangle ones are: they are the part worth unit-testing without a map.

import { buildArea } from '@cng/spec';

/** @typedef {import('@cng/spec').Area} Area */
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

// Below this many screen pixels apart, two clicks are the same click: the
// second half of a double-click (which MapLibre delivers as an ordinary
// `click` before `dblclick`), or a shaky hand. In pixels rather than
// degrees because that is what the user is aiming with, and it stays
// honest at every zoom level.
const SAME_POINT_PX = 8;

// A ring needs three distinct corners before "close it" means anything.
const MIN_POLYGON_VERTICES = 3;

/**
 * Close a list of drawn vertices into a GeoJSON ring (first point repeated
 * last). Pure; no winding normalization -- `buildArea` owns that.
 * @param {LngLat[]} vertices open ring, no repeated last point
 * @returns {[number, number][]}
 */
export function polygonRingFromVertices(vertices) {
  return [...vertices.map((v) => [v[0], v[1]]), [vertices[0][0], vertices[0][1]]];
}

/**
 * @param {LngLat[]} vertices
 * @returns {GeoJSON.Polygon}
 */
export function polygonFromVertices(vertices) {
  return { type: 'Polygon', coordinates: [polygonRingFromVertices(vertices)] };
}

/** Enough vertices to close into a legal ring? Pure. */
export function isClosablePolygon(vertices) {
  return Array.isArray(vertices) && vertices.length >= MIN_POLYGON_VERTICES;
}

/** Two screen points close enough to be one click? Pure. */
export function isSameScreenPoint(a, b) {
  return Math.abs(a.x - b.x) < SAME_POINT_PX && Math.abs(a.y - b.y) < SAME_POINT_PX;
}

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {{
 *   tools?: ('rectangle'|'polygon'|'viewport')[],
 *   id?: string,
 *   names?: { drawn?: string, viewport?: string },
 * }} [options] `names` overrides the Area display names, for a host that
 *   has to translate them (portolan-browser does). `drawn` covers both the
 *   rectangle and the polygon, since from the user's side they are the
 *   same act.
 * @returns {{
 *   readonly armed: boolean,
 *   readonly tool: 'rectangle'|'polygon'|null,
 *   readonly vertices: LngLat[],
 *   arm(tool?: 'rectangle'|'polygon'|'viewport'): void,
 *   disarm(): void,
 *   on(event: 'area'|'armed'|'disarmed'|'cancel', handler: (payload: unknown) => void): () => void,
 *   remove(): void,
 * }}
 */
export function createDrawTool(map, options = {}) {
  const tools = options.tools ?? ['rectangle', 'viewport'];
  const names = options.names ?? {};

  const sourceId = options.id ? `${options.id}-preview` : 'cng-draw-preview';
  const fillLayerId = `${sourceId}-fill`;
  const lineLayerId = `${sourceId}-line`;
  const vertexLayerId = `${sourceId}-vertex`;

  let armed = false;
  let dragging = false;
  /** @type {LngLat|null} */
  let startLngLat = null;
  let currentTool = null;
  /** Polygon only: the vertices placed so far, and where they were clicked. */
  /** @type {LngLat[]} */
  let vertices = [];
  /** @type {{x: number, y: number}[]} */
  let screenPoints = [];
  /** @type {LngLat|null} the cursor, for the rubber-band edge */
  let cursorLngLat = null;

  const listeners = new Map();
  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }
  function emit(event, payload) {
    // Iterate a copy: tearing the tool down from inside an `area` handler
    // is the normal thing for a host to do (portolan-browser's widget
    // rebuilds its map layers there, which calls `remove()` and so
    // `listeners.clear()`), and mutating the Set mid-iteration would
    // silently skip every handler after the one that did it.
    for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
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
        // A Point never renders as a line, but the filter keeps the dashed
        // edge off the polygon's vertex dots explicitly rather than by
        // luck.
        filter: ['!=', ['geometry-type'], 'Point'],
        paint: { 'line-color': '#1a73e8', 'line-width': 2, 'line-dasharray': [2, 1] },
      });
    }
    if (!map.getLayer(vertexLayerId)) {
      // Polygon only: the corners placed so far, so a half-drawn ring shows
      // what has been committed and what is still following the cursor.
      map.addLayer({
        id: vertexLayerId,
        type: 'circle',
        source: sourceId,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#1a73e8', 'circle-stroke-width': 2 },
      });
    }
  }
  function setPreview(geometry) {
    ensurePreviewLayer();
    const fc = geometry ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] } : emptyFeatureCollection();
    map.getSource(sourceId)?.setData(fc);
  }
  function setPreviewFeatures(features) {
    ensurePreviewLayer();
    map.getSource(sourceId)?.setData({ type: 'FeatureCollection', features });
  }
  function clearPreview() {
    setPreview(null);
  }
  function removePreviewLayer() {
    for (const id of [fillLayerId, lineLayerId, vertexLayerId]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }

  // The polygon in progress: the committed corners, the edge following the
  // cursor, and -- once there are enough corners to close -- the filled
  // ring that closing would produce, so "what will I get" is on the map
  // before the commitment rather than after it.
  function renderPolygon() {
    const features = [];
    const live = cursorLngLat ? [...vertices, cursorLngLat] : vertices;
    if (live.length >= MIN_POLYGON_VERTICES) {
      features.push({ type: 'Feature', properties: {}, geometry: polygonFromVertices(live) });
    } else if (live.length === 2) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: live.map((v) => [v[0], v[1]]) },
      });
    }
    for (const vertex of vertices) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [vertex[0], vertex[1]] } });
    }
    setPreviewFeatures(features);
  }

  function resetPolygon() {
    vertices = [];
    screenPoints = [];
    cursorLngLat = null;
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

  function emitArea(geometry, tool) {
    const area = buildArea({
      name: tool === 'viewport'
        ? (names.viewport ?? 'Current viewport')
        : (names.drawn ?? 'Drawn area'),
      geometry,
      source: 'draw',
      features: [],
      combine: 'single',
      geometryVariant: 'full',
      provenanceExtra: { draw: { tool, mapCrs: 'EPSG:4326' } },
    });
    emit('area', { area });
  }

  function finishRectangle(a, b, tool) {
    emitArea(rectanglePolygonFromCorners(a, b), tool);
  }

  // Close the ring, if there is one to close. Too few corners is not an
  // error worth telling the user about -- a stray double-click on an empty
  // map simply leaves the tool armed, the same way a mousedown with no drag
  // does for the rectangle.
  function finishPolygon() {
    if (!isClosablePolygon(vertices)) return;
    const geometry = polygonFromVertices(vertices);
    disarm();
    emitArea(geometry, 'polygon');
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
  function onPolygonClick(e) {
    if (!armed || currentTool !== 'polygon') return;
    const point = { x: e.point.x, y: e.point.y };
    const last = screenPoints[screenPoints.length - 1];
    // MapLibre delivers the second half of a double-click as an ordinary
    // `click` before `dblclick`. Dropping it keeps the ring from gaining a
    // duplicate corner every time the user closes one.
    if (last && isSameScreenPoint(point, last)) return;
    // Clicking the first corner again closes the ring, the way every map
    // editor behaves.
    const first = screenPoints[0];
    if (first && isSameScreenPoint(point, first) && isClosablePolygon(vertices)) {
      finishPolygon();
      return;
    }
    vertices = [...vertices, [e.lngLat.lng, e.lngLat.lat]];
    screenPoints = [...screenPoints, point];
    renderPolygon();
  }
  function onPolygonMouseMove(e) {
    if (!armed || currentTool !== 'polygon' || vertices.length === 0) return;
    cursorLngLat = [e.lngLat.lng, e.lngLat.lat];
    renderPolygon();
  }
  function onPolygonDblClick(e) {
    if (!armed || currentTool !== 'polygon') return;
    e.preventDefault?.();
    finishPolygon();
  }
  function onKeyDown(e) {
    if (!armed) return;
    if (e.key === 'Enter' && currentTool === 'polygon') {
      e.preventDefault?.();
      finishPolygon();
      return;
    }
    if (e.key !== 'Escape') return;
    const wasDragging = dragging;
    const wasDrawing = currentTool === 'polygon' && vertices.length > 0;
    if (wasDragging) endDrag();
    disarm();
    emit('cancel', { duringDrag: wasDragging, duringDraw: wasDrawing });
  }

  /** @param {'rectangle'|'polygon'|'viewport'} [tool] */
  function arm(tool = 'rectangle') {
    if (!tools.includes(tool)) {
      throw new Error(`createDrawTool: tool "${tool}" is not in the enabled set (${tools.join(', ')}).`);
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
    if (tool === 'polygon') {
      resetPolygon();
      // A double-click closes the ring, so the map must not also zoom on
      // it. Re-enabled in `disarm`, unconditionally.
      map.doubleClickZoom?.disable?.();
      map.on('click', onPolygonClick);
      map.on('mousemove', onPolygonMouseMove);
      map.on('dblclick', onPolygonDblClick);
    } else {
      map.on('mousedown', onMouseDown);
    }
    document.addEventListener('keydown', onKeyDown);
    emit('armed', { tool });
  }

  function disarm() {
    if (!armed) return;
    const wasTool = currentTool;
    armed = false;
    currentTool = null;
    map.getCanvas().style.cursor = '';
    if (wasTool === 'polygon') {
      map.doubleClickZoom?.enable?.();
      map.off('click', onPolygonClick);
      map.off('mousemove', onPolygonMouseMove);
      map.off('dblclick', onPolygonDblClick);
      resetPolygon();
      clearPreview();
    } else {
      map.off('mousedown', onMouseDown);
    }
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
    get tool() {
      return currentTool;
    },
    /** Polygon only: the corners placed so far (a copy). */
    get vertices() {
      return vertices.map((v) => [v[0], v[1]]);
    },
    arm,
    disarm,
    on,
    remove,
  };
}
