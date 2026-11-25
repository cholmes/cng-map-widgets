// @cngeo/maplibre -- the mapping between LayerManager and the panel.
//
// The panel is opengeos' maplibre-gl-layer-control. It knows about MapLibre
// style layers natively and about everything else through a
// `CustomLayerAdapter`. Here EVERY LayerSpec goes through the adapter, style
// layers included (the panel is told to ignore our `cng-layer-*` style
// layers), so one LayerSpec is one row whatever it is made of, and the
// LayerManager stays the single source of truth.
//
// Two conventions differ and are bridged here: the manager's list is
// bottom-first (draw order), the panel's is top-first (reading order).
//
// Pure: no DOM, no map. See layer-control.js for the wiring.

const RASTER_KINDS = new Set(['cog', 'scenes']);

/**
 * A `CustomLayerAdapter` (maplibre-gl-layer-control's interface) over a LayerManager.
 * @param {import('./layer-manager.js').LayerManager} manager
 */
export function createControlAdapter(manager) {
  return {
    type: 'cng',
    getLayerIds: () => manager.list().map((e) => e.id).reverse(),
    getLayerState(id) {
      const entry = manager.get(id);
      return entry ? { visible: entry.visible, opacity: entry.opacity, name: entry.title } : null;
    },
    setVisibility: (id, visible) => manager.setVisible(id, visible),
    setOpacity: (id, opacity) => manager.setOpacity(id, opacity),
    getName: (id) => manager.get(id)?.title ?? id,
    getSymbolType: (id) => (RASTER_KINDS.has(manager.get(id)?.kind) ? 'raster' : 'fill'),
    getBounds: (id) => manager.get(id)?.bbox ?? null,
    removeLayer: (id) => manager.remove(id),
    onLayerChange: (callback) =>
      manager.on('change', (event) => {
        if (event.type === 'add' || event.type === 'remove') callback(event.type, event.id);
      }),
  };
}

/**
 * Make the manager's order match what the panel reports after a drag.
 * `topFirstIds` is the panel's list, top row first; it may contain ids that
 * are not ours (the basemap group, another library's layers), which are
 * ignored. Layers of ours the panel did not mention keep their places.
 * @param {import('./layer-manager.js').LayerManager} manager
 * @param {string[]} topFirstIds
 */
export function applyPanelOrder(manager, topFirstIds) {
  const current = manager.list().map((e) => e.id);
  const known = new Set(current);
  const reported = topFirstIds.filter((id) => known.has(id)).reverse(); // bottom-first
  const mentioned = new Set(reported);
  // The slots the mentioned layers occupy now are refilled in the reported order.
  let next = 0;
  const target = current.map((id) => (mentioned.has(id) ? reported[next++] : id));
  target.forEach((id, index) => manager.move(id, index));
}
