// @cngeo/maplibre -- LayerManager: one ordered stack of layers on a map.
//
// The stack is a single bottom-first array of LayerSpecs (`@cngeo/spec`),
// and that array is the truth. The map is made to agree with it.
//
// Two very different things can be in the stack:
//   - layers MapLibre draws itself (vector tiles, GeoJSON): real style
//     layers, ordered with `map.moveLayer`;
//   - layers deck.gl draws (COGs, imagery scenes): not in the MapLibre style
//     at all. They live in ONE shared `MapLibreOverlay` in interleaved mode,
//     and each is told where to draw with deck's `beforeId` prop.
//
// One rule orders both. Walking the stack from the top down, keep a "slot":
// the id of the MapLibre layer the next thing must sit just below. It starts
// at the anchor (by default the basemap's first symbol layer, so the whole
// stack sits under the place labels). A style entry is moved to just below
// the slot and its own bottom layer becomes the new slot. A deck entry is
// given the slot as its `beforeId` and leaves the slot unchanged -- so a
// raster between two vector layers is drawn just below the upper one, and
// adjacent deck entries share a slot and keep their order by position in the
// overlay's `layers` array. (Interleaved re-slotting was measured sound in
// experiments/e12-deck-bundle: no blank frame.)
//
// A kind is drawn by a renderer registered for it (see `registerLayerRenderer`
// and src/renderers/). This module knows nothing about PMTiles or COGs.

import { CngError, RENDERABLE_KINDS, layerSlug, validateLayerSpec } from '@cngeo/spec';
import { loadDeck } from './deck-loader.js';

/**
 * @typedef {{ visible: boolean, opacity: number }} LayerState
 * @typedef {Object} RendererContext
 * @property {any} map
 * @property {import('@cngeo/spec').LayerSpec} spec
 * @property {string} slug                `layerSlug(spec.id)`; MapLibre ids are `cng-layer-<slug>…`.
 * @property {Function|undefined} addProtocol   MapLibre's `addProtocol`, for `pmtiles://`.
 * @property {() => Promise<any>} deck    Loads deck.gl and makes sure the shared overlay exists.
 * @property {(text: string) => void} note   Record something a user should know (a style that could not be loaded).
 * @typedef {Object} LayerRenderer
 * @property {(state: LayerState) => Promise<void>} add
 * @property {() => void} remove
 * @property {(visible: boolean) => void} setVisible
 * @property {(opacity: number) => void} setOpacity
 * @property {() => string[]} [styleLayerIds]   Bottom-first ids of the MapLibre layers it added.
 * @property {(state: LayerState, beforeId: string|undefined) => object[]} [deckLayers]
 * @typedef {Object} LayerEntry
 * @property {string} id
 * @property {string} title
 * @property {string} kind
 * @property {boolean} visible
 * @property {number} opacity
 * @property {'loading'|'ready'|'error'} status
 * @property {CngError} [error]
 * @property {string} [note]
 * @property {[number, number, number, number]} [bbox]
 * @property {object[]} attribution
 * @property {import('@cngeo/spec').LayerSpec} spec
 */

/** @type {Map<string, (ctx: RendererContext) => LayerRenderer>} */
const REGISTRY = new Map();

/**
 * Register how a `LayerSpec.kind` is drawn. The built-in renderers register
 * themselves when `@cngeo/maplibre` is imported; call this to add or replace one.
 * @param {string} kind
 * @param {(ctx: RendererContext) => LayerRenderer} factory
 */
export function registerLayerRenderer(kind, factory) {
  REGISTRY.set(kind, factory);
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

export class LayerManager {
  /**
   * @param {any} map A MapLibre map.
   * @param {Object} [options]
   * @param {string|null} [options.beforeId] The MapLibre layer the stack sits just below. Default: the
   *   basemap's first symbol layer (under the labels). `null`: above everything.
   * @param {Function} [options.addProtocol] MapLibre's `addProtocol`. Default: `globalThis.maplibregl.addProtocol`.
   * @param {Record<string, (ctx: RendererContext) => LayerRenderer>} [options.renderers] Per-instance
   *   renderers, consulted before the registry.
   */
  constructor(map, options = {}) {
    this._map = map;
    this._beforeId = options.beforeId;
    this._addProtocol = options.addProtocol ?? globalThis.maplibregl?.addProtocol?.bind(globalThis.maplibregl);
    this._renderers = options.renderers ?? {};
    /** @type {any[]} bottom-first */
    this._entries = [];
    this._handlers = { change: new Set(), error: new Set() };
    this._overlay = null;
    this._destroyed = false;
    /** @type {Set<Promise<unknown>>} */
    this._inFlight = new Set();
    this._onStyleLoad = () => this._track(this._rebuild());
    map.on('style.load', this._onStyleLoad);
  }

  // --- public --------------------------------------------------------------

  /**
   * Add a layer on top of the stack (or at `index`). Resolves once it is on
   * the map. Rejects with `LAYER_INVALID` (bad spec, duplicate id),
   * `LAYER_UNSUPPORTED` (nothing draws this kind), or the renderer's own
   * failure -- in which case the layer STAYS in the list with status
   * `'error'`, so a panel can show what went wrong.
   * @param {unknown} spec
   * @param {{ visible?: boolean, opacity?: number, index?: number }} [options]
   * @returns {Promise<LayerEntry>}
   */
  add(spec, options = {}) {
    return this._track(this._add(spec, options));
  }

  /** Remove a layer. Unknown ids are ignored. Safe while the layer is still loading. */
  remove(id) {
    const at = this._entries.findIndex((e) => e.id === id);
    if (at === -1) return;
    const [entry] = this._entries.splice(at, 1);
    entry.removed = true;
    // A layer still loading has put nothing on the map yet; its own add()
    // cleans up when it finishes and finds itself removed.
    if (entry.status !== 'loading') this._safeRemove(entry);
    this._applyOrder();
    this._emit('change', { type: 'remove', id });
  }

  setVisible(id, visible) {
    const entry = this._find(id);
    if (!entry) return;
    entry.visible = Boolean(visible);
    if (entry.status === 'ready') {
      if (entry.renderer.deckLayers) this._syncDeck();
      else entry.renderer.setVisible(entry.visible);
    }
    this._emit('change', { type: 'visible', id });
  }

  /** Opacity 0..1, clamped. A value that is not a finite number is ignored. */
  setOpacity(id, opacity) {
    const entry = this._find(id);
    if (!entry || typeof opacity !== 'number' || !Number.isFinite(opacity)) return;
    entry.opacity = clamp01(opacity);
    if (entry.status === 'ready') {
      if (entry.renderer.deckLayers) this._syncDeck();
      else entry.renderer.setOpacity(entry.opacity);
    }
    this._emit('change', { type: 'opacity', id });
  }

  /** Move a layer to `toIndex` in the bottom-first list (clamped to the list). */
  move(id, toIndex) {
    const from = this._entries.findIndex((e) => e.id === id);
    if (from === -1) return;
    const to = Math.min(this._entries.length - 1, Math.max(0, Math.trunc(toIndex)));
    if (to === from) return;
    const [entry] = this._entries.splice(from, 1);
    this._entries.splice(to, 0, entry);
    this._applyOrder();
    this._emit('change', { type: 'move', id });
  }

  /** @returns {LayerEntry|null} A copy. */
  get(id) {
    const entry = this._find(id);
    return entry ? this._public(entry) : null;
  }

  /** The stack, bottom first. Copies. @returns {LayerEntry[]} */
  list() {
    return this._entries.map((e) => this._public(e));
  }

  /**
   * @param {'change'|'error'} event `change`: `{ type: 'add'|'ready'|'remove'|'move'|'visible'|'opacity'|'error', id }`.
   *   `error`: `{ id, error }`.
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    this._handlers[event]?.add(handler);
    return () => this._handlers[event]?.delete(handler);
  }

  /** Resolves when no add or rebuild is in flight. */
  async settled() {
    while (this._inFlight.size) await Promise.allSettled([...this._inFlight]);
  }

  /** Take everything off the map and stop listening to it. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const entry of this._entries.splice(0)) {
      entry.removed = true;
      if (entry.status !== 'loading') this._safeRemove(entry);
    }
    if (this._overlay) {
      this._map.removeControl(this._overlay);
      this._overlay = null;
    }
    this._map.off('style.load', this._onStyleLoad);
    this._handlers.change.clear();
    this._handlers.error.clear();
  }

  // --- internals -----------------------------------------------------------

  async _add(input, options) {
    if (this._destroyed) {
      throw new CngError('This LayerManager has been destroyed', 'LAYER_INVALID', { retryable: false, context: { reason: 'destroyed' } });
    }
    const spec = validateLayerSpec(input);
    if (this._find(spec.id)) {
      throw new CngError(`A layer with id "${spec.id}" is already in the stack`, 'LAYER_INVALID', {
        retryable: false,
        context: { reason: 'duplicate', id: spec.id },
      });
    }
    const factory = this._renderers[spec.kind] ?? REGISTRY.get(spec.kind);
    if (!RENDERABLE_KINDS.includes(spec.kind) || !factory) {
      const why =
        spec.kind === 'unsupported'
          ? String(spec.source.reason)
          : spec.kind === 'table'
            ? 'It is a table with no geometry: there is nothing to draw.'
            : `No renderer is registered for layers of kind "${spec.kind}".`;
      throw new CngError(`"${spec.title}" cannot be shown on the map. ${why}`, 'LAYER_UNSUPPORTED', {
        retryable: false,
        context: { kind: spec.kind, id: spec.id },
      });
    }

    const entry = {
      id: spec.id,
      spec,
      slug: layerSlug(spec.id),
      visible: options.visible !== false,
      opacity: typeof options.opacity === 'number' && Number.isFinite(options.opacity) ? clamp01(options.opacity) : 1,
      status: 'loading',
      error: undefined,
      note: undefined,
      removed: false,
      beforeId: undefined,
      renderer: null,
    };
    const at = typeof options.index === 'number' ? Math.min(this._entries.length, Math.max(0, Math.trunc(options.index))) : this._entries.length;
    this._entries.splice(at, 0, entry);
    this._emit('change', { type: 'add', id: entry.id });

    try {
      entry.renderer = factory(this._context(entry));
      await entry.renderer.add({ visible: entry.visible, opacity: entry.opacity });
    } catch (cause) {
      if (entry.removed) return this._public(entry); // removed while loading: not a failure
      entry.status = 'error';
      entry.error =
        cause instanceof CngError
          ? cause
          : new CngError(`Could not load "${spec.title}": ${cause?.message ?? cause}`, 'LAYER_LOAD_FAILED', { cause, context: { id: spec.id } });
      this._safeRemove(entry); // whatever it managed to add before failing
      this._emit('error', { id: entry.id, error: entry.error });
      this._emit('change', { type: 'error', id: entry.id });
      throw entry.error;
    }

    if (entry.removed) {
      this._safeRemove(entry);
      this._syncDeck();
      return this._public(entry);
    }
    entry.status = 'ready';
    this._applyOrder();
    this._emit('change', { type: 'ready', id: entry.id });
    return this._public(entry);
  }

  /** `map.setStyle()` drops every added source and layer. Put the stack back. */
  async _rebuild() {
    for (const entry of [...this._entries]) {
      if (entry.status !== 'ready' || entry.removed) continue;
      try {
        await entry.renderer.add({ visible: entry.visible, opacity: entry.opacity });
      } catch (cause) {
        entry.status = 'error';
        entry.error = cause instanceof CngError ? cause : new CngError(`Could not restore "${entry.spec.title}": ${cause?.message ?? cause}`, 'LAYER_LOAD_FAILED', { cause, context: { id: entry.id } });
        this._emit('error', { id: entry.id, error: entry.error });
      }
    }
    if (!this._destroyed) this._applyOrder();
  }

  _context(entry) {
    return {
      map: this._map,
      spec: entry.spec,
      slug: entry.slug,
      addProtocol: this._addProtocol,
      deck: () => this._deck(),
      note: (text) => {
        entry.note = text;
      },
    };
  }

  async _deck() {
    const mods = await loadDeck();
    if (!this._overlay && !this._destroyed) {
      this._overlay = new mods.MapLibreOverlay({ interleaved: true, layers: [] });
      this._map.addControl(this._overlay);
    }
    return mods;
  }

  /** The layer id the top of the stack sits just below; `undefined` means on top of everything. */
  _anchor() {
    if (this._beforeId === null) return undefined;
    if (typeof this._beforeId === 'string') return this._map.getLayer(this._beforeId) ? this._beforeId : undefined;
    const layers = this._map.getStyle()?.layers ?? [];
    return layers.find((l) => l.type === 'symbol' && !String(l.id).startsWith('cng-layer-'))?.id;
  }

  /** Make the map's draw order agree with the list. See the header for the rule. */
  _applyOrder() {
    let slot = this._anchor();
    for (let i = this._entries.length - 1; i >= 0; i--) {
      const entry = this._entries[i];
      if (entry.status !== 'ready') continue;
      if (entry.renderer.deckLayers) {
        entry.beforeId = slot;
        continue;
      }
      const ids = (entry.renderer.styleLayerIds?.() ?? []).filter((id) => this._map.getLayer(id));
      // Moving each, bottom first, to just below the slot leaves them in order.
      for (const id of ids) this._map.moveLayer(id, slot);
      if (ids.length) slot = ids[0];
    }
    this._syncDeck();
  }

  _syncDeck() {
    if (!this._overlay) return;
    const layers = [];
    for (const entry of this._entries) {
      if (entry.status !== 'ready' || !entry.renderer.deckLayers) continue;
      layers.push(...entry.renderer.deckLayers({ visible: entry.visible, opacity: entry.opacity }, entry.beforeId));
    }
    this._overlay.setProps({ layers });
    this._map.triggerRepaint?.();
  }

  _safeRemove(entry) {
    try {
      entry.renderer?.remove();
    } catch {
      /* the map may already have dropped it (a style change, a destroyed map) */
    }
  }

  _find(id) {
    return this._entries.find((e) => e.id === id);
  }

  _public(entry) {
    return {
      id: entry.id,
      title: entry.spec.title,
      kind: entry.spec.kind,
      visible: entry.visible,
      opacity: entry.opacity,
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.note ? { note: entry.note } : {}),
      ...(entry.spec.bbox ? { bbox: [...entry.spec.bbox] } : {}),
      attribution: entry.spec.attribution.map((a) => ({ ...a })),
      spec: entry.spec,
    };
  }

  _emit(event, payload) {
    for (const handler of [...this._handlers[event]]) handler(payload);
  }

  _track(promise) {
    this._inFlight.add(promise);
    const done = () => this._inFlight.delete(promise);
    promise.then(done, done);
    return promise;
  }
}
