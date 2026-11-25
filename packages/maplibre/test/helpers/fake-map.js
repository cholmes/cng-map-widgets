// A stand-in for a MapLibre map, for unit tests of the layer manager and
// its renderers. It models exactly what they rely on: an ORDERED list of
// style layers that `addLayer(def, beforeId)` and `moveLayer(id, beforeId)`
// really reorder; sources; paint and layout properties; controls; and events.
// Draw order is `getStyle().layers` order, bottom first, as in MapLibre.
//
// It draws nothing. Whether pixels appear is examples/layers-demo/verify.mjs's job.

export function createFakeMap(options = {}) {
  /** @type {{ id: string, type: string, source?: string, paint: Record<string, unknown>, layout: Record<string, unknown> }[]} */
  let layers = (options.layers ?? [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill' },
    { id: 'labels', type: 'symbol' },
  ]).map((l) => ({ paint: {}, layout: {}, ...l }));
  const basemap = layers.map((l) => ({ ...l }));
  const sources = new Map();
  const controls = [];
  const handlers = new Map();
  const calls = [];
  const log = (name, ...args) => calls.push([name, ...args]);

  // MapLibre refuses to add anything until its style has loaded.
  let styleLoaded = options.styleLoaded !== false;
  const requireStyle = () => {
    if (!styleLoaded) throw new Error('Style is not done loading.');
  };

  const indexOf = (id) => layers.findIndex((l) => l.id === id);
  const insert = (layer, beforeId) => {
    const at = beforeId === undefined || beforeId === null ? -1 : indexOf(beforeId);
    if (beforeId !== undefined && beforeId !== null && at === -1) throw new Error(`fake-map: no layer "${beforeId}" to insert before`);
    if (at === -1) layers.push(layer);
    else layers.splice(at, 0, layer);
  };

  const map = {
    calls,
    controls,
    /** Layer ids, bottom first. */
    order: () => layers.map((l) => l.id),
    /** Only the ids this library added. */
    ours: () => layers.map((l) => l.id).filter((id) => id.startsWith('cng-layer-')),
    sourceIds: () => [...sources.keys()],

    isStyleLoaded: () => true,
    getStyle: () => ({ version: 8, sources: Object.fromEntries(sources), layers: layers.map((l) => ({ ...l })) }),
    getLayer: (id) => layers.find((l) => l.id === id),
    getSource: (id) => sources.get(id),

    addSource(id, def) {
      requireStyle();
      if (sources.has(id)) throw new Error(`fake-map: source "${id}" already exists`);
      sources.set(id, def);
      log('addSource', id);
    },
    removeSource(id) {
      if (layers.some((l) => l.source === id)) throw new Error(`fake-map: source "${id}" is still in use`);
      sources.delete(id);
      log('removeSource', id);
    },
    addLayer(def, beforeId) {
      requireStyle();
      if (indexOf(def.id) !== -1) throw new Error(`fake-map: layer "${def.id}" already exists`);
      if (def.source && typeof def.source === 'string' && !sources.has(def.source)) throw new Error(`fake-map: layer "${def.id}" names a missing source "${def.source}"`);
      insert({ paint: {}, layout: {}, ...def, paint: { ...(def.paint ?? {}) }, layout: { ...(def.layout ?? {}) } }, beforeId);
      log('addLayer', def.id, beforeId);
    },
    removeLayer(id) {
      const at = indexOf(id);
      if (at === -1) throw new Error(`fake-map: no layer "${id}" to remove`);
      layers.splice(at, 1);
      log('removeLayer', id);
    },
    moveLayer(id, beforeId) {
      const at = indexOf(id);
      if (at === -1) throw new Error(`fake-map: no layer "${id}" to move`);
      if (id === beforeId) return;
      const [layer] = layers.splice(at, 1);
      insert(layer, beforeId);
      log('moveLayer', id, beforeId);
    },
    setPaintProperty(id, prop, value) {
      const layer = map.getLayer(id);
      if (!layer) throw new Error(`fake-map: no layer "${id}"`);
      layer.paint[prop] = value;
      log('setPaintProperty', id, prop, value);
    },
    getPaintProperty: (id, prop) => map.getLayer(id)?.paint[prop],
    setLayoutProperty(id, prop, value) {
      const layer = map.getLayer(id);
      if (!layer) throw new Error(`fake-map: no layer "${id}"`);
      layer.layout[prop] = value;
      log('setLayoutProperty', id, prop, value);
    },
    getLayoutProperty: (id, prop) => map.getLayer(id)?.layout[prop],

    addControl(control) {
      controls.push(control);
      control.onAdd?.(map);
      log('addControl');
    },
    removeControl(control) {
      const at = controls.indexOf(control);
      if (at !== -1) controls.splice(at, 1);
      control.onRemove?.(map);
      log('removeControl');
    },
    hasControl: (control) => controls.includes(control),
    triggerRepaint() {},

    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return map;
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
      return map;
    },
    once(event, handler) {
      const wrapped = (payload) => {
        map.off(event, wrapped);
        handler(payload);
      };
      return map.on(event, wrapped);
    },
    fire(event, payload) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
    listenerCount: (event) => handlers.get(event)?.size ?? 0,

    /** What `map.setStyle()` does: every added source and layer is gone; the basemap is back. */
    simulateSetStyle() {
      layers = basemap.map((l) => ({ ...l, paint: { ...l.paint }, layout: { ...l.layout } }));
      sources.clear();
      map.fire('style.load');
    },
    /** For a map created with `styleLoaded: false`: the style arrives. */
    finishLoadingStyle() {
      styleLoaded = true;
      map.fire('style.load');
    },
  };
  return map;
}

/** A deck.gl module set good enough for the loader's validation, with a recording overlay. */
export function fakeDeckModules(required) {
  class MapLibreOverlay {
    constructor(props) {
      this.props = { ...props };
      this.added = false;
    }
    setProps(props) {
      Object.assign(this.props, props);
    }
    onAdd() {
      this.added = true;
      return {};
    }
    onRemove() {
      this.added = false;
    }
  }
  class COGLayer {
    constructor(props) {
      this.props = props;
      this.id = props.id;
    }
  }
  /** `new DecoderPool({})` -- no `createWorker` -- is the real class's main-thread mode. */
  class DecoderPool {
    constructor(options) {
      this.kind = 'decoder-pool';
      this.options = options;
    }
  }
  const defaultDecoderPool = () => ({ kind: 'default-worker-pool' });
  // proj4's `defs(name)` / `defs(name, definition)`.
  const definitions = new Map();
  const proj4 = { defs: (name, def) => (def === undefined ? definitions.get(name) : void definitions.set(name, def)) };
  const mods = Object.fromEntries(required.map((name) => [name, {}]));
  return { ...mods, MapLibreOverlay, COGLayer, DecoderPool, defaultDecoderPool, proj4, VERSIONS: { deck: 'fake', raster: 'fake' } };
}
