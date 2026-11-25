// @cngeo/maplibre -- what every style-layer renderer does once it has a plan:
// put the plan's sources and layers on the map, and keep their visibility and
// opacity in step. `plan` is `{ sources, layers }` from ./style-plan.js; the
// layer definitions in it are the BASE (what the style said), which is what
// opacity is always scaled from.

import { opacityPaint } from './style-plan.js';

/**
 * @param {any} map
 * @param {{ sources: Record<string, object>, layers: any[] }} plan
 * @param {{ visible: boolean, opacity: number }} state
 */
export function addPlan(map, plan, state) {
  for (const [id, def] of Object.entries(plan.sources)) {
    if (!map.getSource(id)) map.addSource(id, def);
  }
  for (const layer of plan.layers) {
    if (map.getLayer(layer.id)) continue;
    map.addLayer({
      ...layer,
      paint: { ...(layer.paint ?? {}), ...(state.opacity === 1 ? {} : opacityPaint(layer, state.opacity)) },
      layout: { ...(layer.layout ?? {}), visibility: state.visible ? 'visible' : 'none' },
    });
  }
}

export function removePlan(map, plan) {
  // Layers first: MapLibre refuses to remove a source a layer still uses.
  for (const layer of plan.layers) {
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  for (const id of Object.keys(plan.sources)) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

export function setPlanVisible(map, plan, visible) {
  for (const layer of plan.layers) {
    if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
  }
}

export function setPlanOpacity(map, plan, opacity) {
  for (const layer of plan.layers) {
    if (!map.getLayer(layer.id)) continue;
    for (const [prop, value] of Object.entries(opacityPaint(layer, opacity))) map.setPaintProperty(layer.id, prop, value);
  }
}
