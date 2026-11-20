// @cng/maplibre -- createEditTool: drag a displayed outline's vertices,
// insert a vertex at a midpoint, delete a vertex. New adapter file (task:
// "or edit a boundary that they brought up with the place search").
//
// Implementation choice, recorded here rather than only in the design doc
// amendment because this is the file a future maintainer opens first:
// **hand-rolled, not terra-draw.** terra-draw (with its MapLibre adapter)
// does polygon vertex editing out of the box and would have taken less
// code here. It was not used because:
//
//   - It is a real dependency this package would need to lazy-load from a
//     CDN to stay out of the eager bundle (format-gpkg's sql.js precedent),
//     and its published ESM bundle is itself a non-trivial fetch: curling
//     the jsdelivr `+esm` build of `terra-draw@1.39.0` (latest at the time
//     of this choice, 2026-11-13) measures 262,509 bytes min / 48,359 bytes
//     gzip (`curl -sI https://cdn.jsdelivr.net/npm/terra-draw@1.39.0/+esm`,
//     then again with `-H "Accept-Encoding: gzip"`) -- before its separate
//     MapLibre adapter package (`terra-draw-maplibre-gl-adapter`, another
//     8,534 bytes min / own fetch) is even added. That is roughly 25x this
//     entire hand-rolled file's source size, for a feature set (freeform
//     polygon/line/point drawing, snapping, multiple concurrent modes)
//     this task does not need.
//   - It supports whatever MapLibre version it was built against; this
//     repo pins exact CDN versions everywhere else (design doc §4.2), and
//     adding a second, independently-versioned drawing library is a real
//     compatibility surface for a feature whose actual requirement is
//     "drag a vertex, insert a midpoint, delete a vertex" on a single
//     polygon ring.
//   - The hand-rolled version's geometry math (moveVertex/insertMidpoint/
//     deleteVertex below) is plain array splicing with no DOM and no map
//     dependency at all, so it is unit-testable the same way
//     combobox-helpers.js's pure functions are -- see edit-tool.test.js.
//     terra-draw's internal state machine is not something this package
//     would own or be able to test that way.
//
// Honest cost of the choice made instead: this editor supports exactly one
// ring -- the exterior ring of the Area's largest polygon component (first
// ring if `Polygon`, the ring with the most vertices if `MultiPolygon`).
// Holes and any other polygon in a `MultiPolygon` are carried through
// unedited, not dropped. A host that needs to edit holes or multiple
// polygons' outlines independently needs more than this file offers today
// -- same spirit as this package's other "not implemented, here is the
// honest boundary" notes (design doc §8).

import { buildArea } from '@cng/spec';

/** @typedef {import('@cng/spec').Area} Area */
/** @typedef {[number, number]} LngLat */

const MIN_UNIQUE_VERTICES = 3; // a triangle is the smallest legal polygon ring

function clonePt(p) {
  return [p[0], p[1]];
}

/** Strip a GeoJSON ring's duplicated closing point. Pure. */
export function openRingOf(closedRing) {
  return closedRing.slice(0, -1).map(clonePt);
}

/** Re-close an "open" ring (no duplicated last point) into GeoJSON form. Pure. */
export function closeRing(openRing) {
  return [...openRing.map(clonePt), clonePt(openRing[0])];
}

/** @param {LngLat[]} openRing @param {number} index @param {LngLat} coord */
export function moveVertex(openRing, index, coord) {
  const out = openRing.map(clonePt);
  out[index] = clonePt(coord);
  return out;
}

/** One midpoint per edge, each tagged with the vertex index it follows. Pure. */
export function midpointsOf(openRing) {
  const n = openRing.length;
  const mids = [];
  for (let i = 0; i < n; i++) {
    const a = openRing[i];
    const b = openRing[(i + 1) % n];
    mids.push({ afterIndex: i, coord: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  return mids;
}

/** @param {LngLat[]} openRing @param {number} afterIndex @param {LngLat} coord */
export function insertMidpoint(openRing, afterIndex, coord) {
  const out = openRing.map(clonePt);
  out.splice(afterIndex + 1, 0, clonePt(coord));
  return out;
}

/** No-op (returns an equal-length copy) rather than throwing, below the
 *  minimum -- "delete" on the last legal vertex is a user doing nothing
 *  wrong; degrading to an invalid ring would be the actual bug. */
export function deleteVertex(openRing, index) {
  if (openRing.length <= MIN_UNIQUE_VERTICES) return openRing.map(clonePt);
  const out = openRing.map(clonePt);
  out.splice(index, 1);
  return out;
}

/** Pick which (polygonIndex, ringIndex=0) this editor edits: the exterior
 *  ring with the most vertices. Pure. */
export function largestExteriorRing(geometry) {
  if (geometry.type === 'Polygon') return { polygonIndex: 0, ring: geometry.coordinates[0] };
  let best = { polygonIndex: 0, ring: geometry.coordinates[0][0] };
  for (let i = 1; i < geometry.coordinates.length; i++) {
    const ring = geometry.coordinates[i][0];
    if (ring.length > best.ring.length) best = { polygonIndex: i, ring };
  }
  return best;
}

/** Rebuild `geometry` with its exterior ring at `polygonIndex` replaced by
 *  `closedRing`; every other ring/polygon is carried through unchanged
 *  (same array references where untouched). Pure. */
export function withExteriorRing(geometry, polygonIndex, closedRing) {
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: [closedRing, ...geometry.coordinates.slice(1)] };
  }
  const coordinates = geometry.coordinates.map((poly, i) => (i === polygonIndex ? [closedRing, ...poly.slice(1)] : poly));
  return { type: 'MultiPolygon', coordinates };
}

/**
 * Build the edited `Area` from its parent, through `@cng/spec`'s
 * `buildArea` (never a hand-built provenance object -- §5.1's rule).
 * `provenance.source` is `'edited'`; `provenance.edited` keeps the parent's
 * lineage (`parentAreaId`/`parentSource`/`parentCreatedAt`) and
 * `features` is carried over verbatim from the parent so the original
 * `featureId`(s) are never lost. `filterGeometry` is re-derived fresh by
 * `buildArea`'s own simplify path -- this function never touches it
 * directly.
 * @param {Area} parentArea
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry
 * @param {{ moved?: number, inserted?: number, deleted?: number }} [edits]
 * @returns {Area}
 */
export function buildEditedArea(parentArea, geometry, edits = {}) {
  return buildArea({
    name: /\(edited\)$/.test(parentArea.name ?? '') ? parentArea.name : `${parentArea.name ?? 'Area'} (edited)`,
    geometry,
    source: 'edited',
    features: parentArea.provenance?.features ?? [],
    combine: parentArea.provenance?.combine ?? 'single',
    geometryVariant: 'full',
    provenanceExtra: {
      edited: {
        parentAreaId: parentArea.id,
        parentSource: parentArea.provenance?.source ?? null,
        parentCreatedAt: parentArea.provenance?.createdAt ?? null,
        tool: 'vertex-editor',
        edits: { moved: edits.moved ?? 0, inserted: edits.inserted ?? 0, deleted: edits.deleted ?? 0 },
      },
    },
  });
}

function pointFeature(coord, properties) {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: coord } };
}
function featureCollection(features) {
  return { type: 'FeatureCollection', features };
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {Area} area
 * @param {{ id?: string }} [options]
 * @returns {{
 *   on(event: 'change'|'done', handler: (payload: { area: Area }) => void): () => void,
 *   getArea(): Area,
 *   remove(): void,
 * }}
 */
export function createEditTool(map, area, options = {}) {
  const id = options.id ?? 'cng-edit';
  const outlineSourceId = `${id}-outline`;
  const outlineLayerId = `${id}-outline-line`;
  const vertexSourceId = `${id}-vertices`;
  const vertexLayerId = `${id}-vertices-point`;
  const midpointSourceId = `${id}-midpoints`;
  const midpointLayerId = `${id}-midpoints-point`;

  const { polygonIndex, ring: initialClosedRing } = largestExteriorRing(area.geometry);
  let openRing = openRingOf(initialClosedRing);
  const editCounts = { moved: 0, inserted: 0, deleted: 0 };

  let dragIndex = null; // index into openRing currently being dragged, or null

  const listeners = new Map();
  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }
  function emit(event, payload) {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  }

  function addLayers() {
    map.addSource(outlineSourceId, { type: 'geojson', data: featureCollection([]) });
    map.addLayer({ id: outlineLayerId, type: 'line', source: outlineSourceId, paint: { 'line-color': '#e8731a', 'line-width': 2 } });

    map.addSource(midpointSourceId, { type: 'geojson', data: featureCollection([]) });
    map.addLayer({
      id: midpointLayerId,
      type: 'circle',
      source: midpointSourceId,
      paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#e8731a', 'circle-stroke-width': 1.5, 'circle-opacity': 0.9 },
    });

    map.addSource(vertexSourceId, { type: 'geojson', data: featureCollection([]) });
    map.addLayer({
      id: vertexLayerId,
      type: 'circle',
      source: vertexSourceId,
      paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#e8731a', 'circle-stroke-width': 2 },
    });
  }

  function render() {
    const closed = closeRing(openRing);
    map.getSource(outlineSourceId)?.setData(featureCollection([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: closed } }]));
    map.getSource(vertexSourceId)?.setData(
      featureCollection(openRing.map((coord, index) => pointFeature(coord, { index, kind: 'vertex' }))),
    );
    map.getSource(midpointSourceId)?.setData(
      featureCollection(midpointsOf(openRing).map((m) => pointFeature(m.coord, { afterIndex: m.afterIndex, kind: 'midpoint' }))),
    );
  }

  function currentGeometry() {
    return withExteriorRing(area.geometry, polygonIndex, closeRing(openRing));
  }

  function commitChange() {
    const edited = buildEditedArea(area, currentGeometry(), editCounts);
    emit('change', { area: edited });
  }

  function setCursor(cursor) {
    map.getCanvas().style.cursor = cursor;
  }

  function pointFromClient(clientX, clientY) {
    const rect = map.getContainer().getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }
  function lngLatFromClient(clientX, clientY) {
    const ll = map.unproject(pointFromClient(clientX, clientY));
    return [ll.lng, ll.lat];
  }

  // Window-level listeners while `dragIndex !== null`, for the same reason
  // draw-tool.js's rectangle drag uses them: a layer-scoped `map.on(...)`
  // only fires while the pointer is over the canvas, so a vertex dragged
  // out past this demo's floating panel (or anywhere else on the page)
  // would otherwise never reach a mouseup handler and get stuck mid-drag.
  function startWindowDragListeners() {
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
  }
  function stopWindowDragListeners() {
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
  }

  function onVertexDown(e) {
    const index = e.features?.[0]?.properties?.index;
    if (index === undefined) return;
    e.preventDefault?.();
    dragIndex = index;
    map.dragPan.disable();
    setCursor('grabbing');
    startWindowDragListeners();
  }
  function onMidpointDown(e) {
    const afterIndex = e.features?.[0]?.properties?.afterIndex;
    if (afterIndex === undefined) return;
    e.preventDefault?.();
    const coord = [e.lngLat.lng, e.lngLat.lat];
    openRing = insertMidpoint(openRing, afterIndex, coord);
    editCounts.inserted += 1;
    dragIndex = afterIndex + 1; // immediately drag the vertex just created, out of its midpoint
    render();
    map.dragPan.disable();
    setCursor('grabbing');
    startWindowDragListeners();
  }
  function onWindowMouseMove(e) {
    if (dragIndex === null) return;
    openRing = moveVertex(openRing, dragIndex, lngLatFromClient(e.clientX, e.clientY));
    render();
  }
  function onWindowMouseUp() {
    if (dragIndex === null) return;
    dragIndex = null;
    map.dragPan.enable();
    setCursor('');
    stopWindowDragListeners();
    editCounts.moved += 1;
    commitChange();
  }
  function onVertexDblClick(e) {
    const index = e.features?.[0]?.properties?.index;
    if (index === undefined) return;
    e.preventDefault?.();
    const before = openRing.length;
    openRing = deleteVertex(openRing, index);
    if (openRing.length !== before) {
      editCounts.deleted += 1;
      render();
      commitChange();
    }
  }
  function onEnterPoint() {
    setCursor('grab');
  }
  function onLeavePoint() {
    if (dragIndex === null) setCursor('');
  }

  addLayers();
  render();

  map.on('mousedown', vertexLayerId, onVertexDown);
  map.on('mousedown', midpointLayerId, onMidpointDown);
  map.on('dblclick', vertexLayerId, onVertexDblClick);
  map.on('mousemove', vertexLayerId, onEnterPoint);
  map.on('mousemove', midpointLayerId, onEnterPoint);
  map.on('mouseleave', vertexLayerId, onLeavePoint);
  map.on('mouseleave', midpointLayerId, onLeavePoint);

  function getArea() {
    return buildEditedArea(area, currentGeometry(), editCounts);
  }

  function remove() {
    map.off('mousedown', vertexLayerId, onVertexDown);
    map.off('mousedown', midpointLayerId, onMidpointDown);
    map.off('dblclick', vertexLayerId, onVertexDblClick);
    map.off('mousemove', vertexLayerId, onEnterPoint);
    map.off('mousemove', midpointLayerId, onEnterPoint);
    map.off('mouseleave', vertexLayerId, onLeavePoint);
    map.off('mouseleave', midpointLayerId, onLeavePoint);
    stopWindowDragListeners();
    setCursor('');
    map.dragPan.enable();
    for (const layerId of [outlineLayerId, vertexLayerId, midpointLayerId]) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    for (const sourceId of [outlineSourceId, vertexSourceId, midpointSourceId]) {
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
    listeners.clear();
  }

  return { on, getArea, remove };
}
