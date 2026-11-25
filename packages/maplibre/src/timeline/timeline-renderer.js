// @cngeo/maplibre -- a timeline as one layer.
//
// The renderer for `LayerSpec.kind: 'timeline'`. However many chunks are
// mounted behind it, the layer manager sees ONE entry: it is hidden, faded,
// reordered and removed as one thing, and its credit is shown once.
//
// What a control drives it with is its SESSION (`manager.handle(id)`):
// `@cngeo/timeline`'s chunk set, wired to this map -- the map's view feeds the
// histogram, and every change of what draws is redrawn.
//
// A chunk format is looked up by `chunk.format`. `pmtiles` is built in;
// `registerChunkFormat()` adds another without touching this file.

import { CngError } from '@cngeo/spec';
import { loadTimeline } from '../timeline-loader.js';
import { pmtilesChunkFormat } from './pmtiles-chunk-format.js';

/** @type {Map<string, (env: object) => object>} */
const FORMATS = new Map();

/**
 * Register how chunks of a `format` are read and drawn.
 * @param {string} name  Matched against `chunk.format`.
 * @param {(env: { source: object, slug: string, deck: () => Promise<object>, timeline: object,
 *   onTileError: (chunk: object, error: any) => void }) => object} factory
 *   Returns a `ChunkFormat` (see `@cngeo/timeline`) whose mounts also have
 *   `layers(state, beforeId)` -> deck.gl layers, and optionally `refresh()` and `tiles()`.
 */
export function registerChunkFormat(name, factory) {
  FORMATS.set(name, factory);
}

registerChunkFormat('pmtiles', ({ source, slug, deck, timeline, onTileError }) =>
  pmtilesChunkFormat({
    aggregate: source.aggregate,
    points: source.points,
    stops: source.stops ?? timeline.COUNT_RAMP,
    cellOpacity: source.cellOpacity,
    outline: source.outline,
    idPrefix: `cng-layer-${slug}`,
    loadDeck: deck,
    onTileError,
  }),
);

/**
 * @typedef {Object} TimelineSession
 * @property {object} timeline   `@cngeo/timeline`'s exports, as loaded.
 * @property {object} set        The chunk set (`createChunkSet`).
 * @property {object} state      `set.state`, fresh.
 * @property {string} title
 * @property {object} source     The layer's `source`.
 * @property {(type: 'change', fn: (state: object) => void) => () => void} on
 * @property {(window: { from: string, to: string }, options?: { dragging?: boolean }) => void} setView   Day keys.
 * @property {(window: { from: string, to: string }) => void} setSelection
 * @property {(id: string) => void} retry
 * @property {() => { selected: number, loaded: number, errors: number }} tiles  Across every mounted chunk.
 * @property {() => void} destroy
 */

async function createSession(ctx) {
  const T = await loadTimeline();
  await ctx.deck(); // the overlay the layers go into
  const { map, spec, slug } = ctx;
  const source = spec.source;
  const chunks = T.validateChunks(source.chunks);

  let tileErrors = 0;
  const env = { source, slug, deck: ctx.deck, timeline: T, onTileError: () => { tileErrors += 1; } };
  const formats = {};
  for (const name of new Set(chunks.map((c) => c.format))) {
    const factory = FORMATS.get(name);
    if (factory) formats[name] = factory(env);
  }
  const set = T.createChunkSet({ chunks, formats, cap: source.cap });

  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();
  let destroyed = false;
  let started = false;
  let refreshTimer = null;
  let startTimer = null;

  const pushViewport = () => {
    const b = map.getBounds?.();
    if (!b) return;
    set.setViewport({ bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], zoom: map.getZoom?.() ?? 0 });
  };
  /** Ask each chunk whether this view has loaded: deck.gl says when a view finishes, not when one starts. */
  const refresh = () => {
    for (const m of set.mounts()) m.mount.refresh?.();
  };
  const onMoveEnd = () => {
    if (destroyed) return;
    pushViewport();
    refresh();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 400); // again once deck.gl has had a frame to decide what it needs
  };

  /** A chunk that will not load is a note; nothing loadable at all is a failed layer. */
  const report = (state) => {
    if (!started) return;
    if (!state.failed.length) {
      ctx.note('');
      return;
    }
    if (!state.loaded.length && !state.pending.length) {
      const first = state.failed[0].error;
      ctx.fail(first instanceof CngError ? first : new CngError(String(first?.message ?? first), 'LAYER_LOAD_FAILED', { context: { id: spec.id } }));
      return;
    }
    ctx.note(`Not loaded: ${state.failed.map((f) => `${f.id} (${f.error?.message ?? f.error})`).join('; ')}`);
  };

  set.on('change', (state) => {
    if (destroyed) return;
    ctx.redraw();
    report(state);
    for (const fn of [...listeners]) fn(state);
  });
  map.on('moveend', onMoveEnd);

  // Open on the most recent days of the record, in real time so it means the
  // same whatever the chunks' unit: a control moves it from there.
  const end = chunks.reduce((latest, c) => (c.end > latest ? c.end : latest), chunks[0].end);
  const start = chunks.reduce((earliest, c) => (c.start < earliest ? c.start : earliest), chunks[0].start);
  const back = (days) => {
    const from = T.addDays(end, -(Math.max(1, days) - 1));
    return from < start ? start : from;
  };
  set.setView({ from: back(source.open?.viewDays ?? 100), to: end });
  set.setSelection({ from: back(source.open?.selectDays ?? 5), to: end });
  pushViewport();
  // Failures are judged only once `add()` has returned: one found while the
  // layer is still being added would fail the add itself, or not, depending
  // on whether the chunk failed in this tick or the next.
  startTimer = setTimeout(() => {
    started = true;
    if (!destroyed) report(set.state);
  }, 0);

  /** @type {TimelineSession} */
  const session = {
    timeline: T,
    set,
    source,
    title: spec.title ?? spec.id,
    get state() {
      return set.state;
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setView: (window, options) => set.setView(window, options),
    setSelection: (window) => set.setSelection(window),
    retry: (id) => set.retry(id),
    tiles() {
      const total = { selected: 0, loaded: 0, errors: tileErrors };
      for (const m of set.mounts()) {
        const t = m.mount.tiles?.();
        if (!t) continue;
        total.selected += t.selected;
        total.loaded += t.loaded;
        total.errors += t.errors ?? 0;
      }
      return total;
    },
    /** Every mounted chunk's deck.gl layers, bottom first. */
    layers(state, beforeId) {
      if (destroyed) return [];
      return set.mounts().flatMap((m) => m.mount.layers?.(state, beforeId) ?? []);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(refreshTimer);
      clearTimeout(startTimer);
      map.off('moveend', onMoveEnd);
      listeners.clear();
      set.destroy();
    },
    get destroyed() {
      return destroyed;
    },
  };
  return session;
}

/** The `LayerManager` renderer for `kind: 'timeline'`. */
export function timelineRenderer(ctx) {
  /** @type {TimelineSession|null} */
  let session = null;
  return {
    // Called again when the basemap style is replaced. deck.gl layers do not
    // live in the style, so there is nothing to rebuild: the session stays.
    async add() {
      if (session && !session.destroyed) return;
      session = await createSession(ctx);
    },
    remove() {
      session?.destroy();
      session = null;
    },
    setVisible() {},
    setOpacity() {},
    deckLayers: (state, beforeId) => session?.layers(state, beforeId) ?? [],
    handle: () => session,
  };
}
