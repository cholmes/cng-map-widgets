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
import { attributionHtml } from './layer-attribution.js';

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
   * @param {() => Promise<any>} [options.loadDeck] How deck.gl is obtained. Default: this package's
   *   `loadDeck()` (the bundle, or whatever `setDeckModules()` injected).
   */
  constructor(map, options = {}) {
    this._map = map;
    this._beforeId = options.beforeId;
    this._addProtocol = options.addProtocol ?? globalThis.maplibregl?.addProtocol?.bind(globalThis.maplibregl);
    this._renderers = options.renderers ?? {};
    this._loadDeck = options.loadDeck ?? loadDeck;
    /** @type {any[]} bottom-first */
    this._entries = [];
    this._handlers = { change: new Set(), error: new Set() };
    this._overlay = null;
    /** The attribution box for deck.gl layers, once one is needed. */
    this._credits = null;
    /** @type {any[]} */
    this._deckLayers = [];
    this._destroyed = false;
    /** @type {Set<Promise<unknown>>} */
    this._inFlight = new Set();
    /** Resolvers of adds waiting for the style to load. */
    this._styleWaiters = new Set();
    this._onStyleLoad = () => {
      // deck.gl re-adds its layer groups the moment a style loads. A group
      // slotted under one of OUR style layers would name a layer that is not
      // back yet ("Cannot add layer … before non-existing layer"), so the
      // overlay is emptied first and refilled once the stack is rebuilt.
      if (this._overlay) {
        this._deckLayers = [];
        this._overlay.setProps({ layers: [] });
      }
      for (const resolve of [...this._styleWaiters]) resolve();
      this._styleWaiters.clear();
      this._track(this._rebuild());
    };
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
   * The deck.gl layer objects last handed to the shared overlay, bottom
   * first. For a legend, a debugger or a test: each carries its `id` and
   * `props` (`opacity`, `visible`, `beforeId`).
   * @returns {any[]}
   */
  deckLayers() {
    return [...this._deckLayers];
  }

  /**
   * What must be credited for the layers currently SHOWN (ready and visible),
   * bottom first: each attribution entry with the `id` and `title` of its
   * layer. Style layers also carry their credit on their MapLibre sources, so
   * MapLibre's own attribution control shows it; deck.gl layers have no
   * source, which is what `deckOnly` is for.
   * @param {{ deckOnly?: boolean }} [options]
   */
  attribution(options = {}) {
    const out = [];
    for (const entry of this._entries) {
      if (entry.status !== 'ready' || !entry.visible) continue;
      if (options.deckOnly && !entry.renderer?.deckLayers) continue;
      for (const a of entry.spec.attribution) out.push({ id: entry.id, title: entry.spec.title, ...a });
    }
    return out;
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
    if (this._credits) {
      this._map.removeControl(this._credits);
      this._credits = null;
    }
    this._deckLayers = [];
    this._map.off('style.load', this._onStyleLoad);
    // Let any add still waiting for the style finish (it will find itself removed).
    for (const resolve of [...this._styleWaiters]) resolve();
    this._styleWaiters.clear();
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
    // MapLibre ids are built from the SLUG, and different ids can share one
    // ("a b" and "a/b"). Two such layers would be one set of map layers that
    // both entries believed they owned.
    const slug = layerSlug(spec.id);
    const clash = this._entries.find((e) => e.slug === slug);
    if (clash) {
      throw new CngError(
        `The layer id "${spec.id}" is too close to "${clash.id}", which is already in the stack: both become "${slug}" on the map`,
        'LAYER_INVALID',
        { retryable: false, context: { reason: 'duplicate', id: spec.id, clashesWith: clash.id } },
      );
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
      slug,
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

    /** The state the renderer was last told about. */
    let given;
    try {
      entry.renderer = factory(this._context(entry));
      given = await this._addToMap(entry);
      // A renderer may report a failure before its add() has even returned.
      if (entry.failedEarly) throw entry.failedEarly;
    } catch (cause) {
      if (entry.removed) {
        this._discard(entry);
        return this._public(entry); // removed while loading: not a failure
      }
      this._markFailed(entry, cause, 'load');
      throw entry.error;
    }

    if (entry.removed) {
      this._discard(entry);
      return this._public(entry);
    }
    entry.status = 'ready';
    // Visibility or opacity may have been changed while it was loading. Deck
    // layers are rebuilt from current state anyway; a style renderer is told.
    if (given && !entry.renderer.deckLayers) {
      if (given.visible !== entry.visible) entry.renderer.setVisible(entry.visible);
      if (given.opacity !== entry.opacity) entry.renderer.setOpacity(entry.opacity);
    }
    this._applyOrder();
    this._emit('change', { type: 'ready', id: entry.id });
    return this._public(entry);
  }

  /**
   * Run a renderer's `add`, waiting for the map's style first if it is not
   * loaded yet (a manager made before the map's `load`, or an add made just
   * after `map.setStyle()`). MapLibre has no public "is the style ready for
   * addSource?" -- `isStyleLoaded()` is also false while tiles load -- so the
   * refusal itself is the signal.
   * @returns {Promise<LayerState|undefined>} the state the renderer was given
   */
  async _addToMap(entry) {
    for (let attempt = 0; ; attempt++) {
      const state = { visible: entry.visible, opacity: entry.opacity };
      try {
        await entry.renderer.add(state);
        return state;
      } catch (err) {
        if (attempt > 0 || !/style is not done loading/i.test(String(err?.message ?? err))) throw err;
        await new Promise((resolve) => this._styleWaiters.add(resolve));
        if (entry.removed || this._destroyed) return undefined;
      }
    }
  }

  /** `map.setStyle()` drops every added source and layer. Put the stack back. */
  async _rebuild() {
    for (const entry of [...this._entries]) {
      if (entry.status !== 'ready' || entry.removed) continue;
      try {
        await entry.renderer.add({ visible: entry.visible, opacity: entry.opacity });
      } catch (cause) {
        if (!entry.removed && !this._destroyed) this._markFailed(entry, cause, 'restore');
        continue;
      }
      // Removed (or the manager destroyed) while it was being re-added.
      if (entry.removed || this._destroyed) this._discard(entry);
    }
    if (!this._destroyed) this._applyOrder();
  }

  /** Record a failure: the entry stays in the list as an error and nothing of it stays on the map. */
  _markFailed(entry, cause, during) {
    entry.status = 'error';
    entry.error =
      cause instanceof CngError
        ? cause
        : new CngError(`Could not ${during} "${entry.spec.title}": ${cause?.message ?? cause}`, 'LAYER_LOAD_FAILED', { cause, context: { id: entry.id } });
    this._safeRemove(entry); // whatever it managed to add before failing
    this._emit('error', { id: entry.id, error: entry.error });
    this._emit('change', { type: 'error', id: entry.id });
  }

  /**
   * Clean up after an entry that was removed while it was loading. If a NEW
   * layer has since taken the same map ids (remove then re-add of one id),
   * those ids are no longer this entry's to remove.
   */
  _discard(entry) {
    const heir = this._entries.find((e) => e !== entry && e.slug === entry.slug);
    if (!heir) this._safeRemove(entry);
    if (!this._destroyed) this._syncDeck();
  }

  _context(entry) {
    return {
      map: this._map,
      spec: entry.spec,
      slug: entry.slug,
      addProtocol: this._addProtocol,
      deck: () => this._deck(),
      note: (text) => {
        if (entry.removed || entry.note === text) return;
        entry.note = text;
        this._emit('change', { type: 'note', id: entry.id });
      },
      // For a failure that arrives AFTER add() resolved -- deck.gl reports a
      // file it cannot open or cannot draw through a layer callback, long
      // after the layer object was handed over.
      fail: (cause) => {
        if (entry.removed || this._destroyed || entry.status === 'error') return;
        if (entry.status === 'loading') {
          entry.failedEarly = cause;
          return;
        }
        this._markFailed(entry, cause, 'load');
        this._applyOrder();
      },
    };
  }

  async _deck() {
    const mods = await this._loadDeck();
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
    this._deckLayers = layers;
    this._overlay.setProps({ layers });
    this._renderDeckCredits();
    this._map.triggerRepaint?.();
  }

  /**
   * Credit for deck.gl layers. A style layer's credit rides on its MapLibre
   * source and shows in MapLibre's own attribution control; a deck.gl layer
   * has no source, so its credit would otherwise never be displayed. This is
   * a second small attribution box in the same corner, listing the credits
   * of the deck.gl layers currently shown. Browser only.
   */
  _renderDeckCredits() {
    const doc = this._map.getContainer?.()?.ownerDocument;
    if (!doc) return;
    const html = attributionHtml(this.attribution({ deckOnly: true }));
    if (!this._credits) {
      if (!html) return;
      const el = doc.createElement('div');
      el.className = 'maplibregl-ctrl maplibregl-ctrl-attrib cng-layer-attribution';
      const inner = doc.createElement('div');
      inner.className = 'maplibregl-ctrl-attrib-inner';
      el.appendChild(inner);
      this._credits = { el, inner, onAdd: () => el, onRemove: () => el.remove() };
      this._map.addControl(this._credits, 'bottom-right');
    }
    // `attributionHtml` escapes everything and links only http(s): the one
    // place layer text is set as markup.
    if (this._credits.inner.innerHTML !== html) this._credits.inner.innerHTML = html;
    this._credits.el.hidden = !html;
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
