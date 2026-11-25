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
 *   The format itself may have `close()`, called when the layer is removed.
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
  let tileNoteTimer = null;
  // A tile that fails leaves a hole in the map and a short count in the
  // track, while its chunk is perfectly "loaded". Said on the layer -- once
  // for a burst, not once a tile.
  const onTileError = () => {
    tileErrors += 1;
    if (tileNoteTimer !== null) return;
    tileNoteTimer = setTimeout(() => {
      tileNoteTimer = null;
      if (!destroyed && started) report(set.state);
    }, 500);
  };
  const env = { source, slug, deck: ctx.deck, timeline: T, onTileError };
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
  let everLoaded = false;
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

  /**
   * A chunk that will not load is a note; a layer that has never shown
   * anything and cannot is a failed layer.
   *
   * "Never" matters. "Nothing is loaded right now" is also what a healthy
   * layer looks like the moment its view moves onto one year whose archive
   * answers a 520: the other chunks have been let go. Failing the layer then
   * destroyed the session, with its Retry, over one chunk.
   */
  const report = (state) => {
    if (!started) return;
    if (state.loaded.length) everLoaded = true;
    if (!everLoaded && state.failed.length && !state.loaded.length && !state.pending.length) {
      const first = state.failed[0].error;
      ctx.fail(first instanceof CngError ? first : new CngError(String(first?.message ?? first), 'LAYER_LOAD_FAILED', { context: { id: spec.id } }));
      return;
    }
    const said = [];
    if (state.failed.length) said.push(`Not loaded: ${state.failed.map((f) => `${f.id} (${f.error?.message ?? f.error})`).join('; ')}.`);
    if (tileErrors > 0) said.push(`${tileErrors.toLocaleString('en-US')} tile${tileErrors === 1 ? '' : 's'} could not be loaded: the map and the counts are missing what was in ${tileErrors === 1 ? 'it' : 'them'}.`);
    ctx.note(said.join(' '));
  };

  set.on('change', (state) => {
    if (destroyed) return;
    if (state.loaded.length) everLoaded = true; // even before `started`
    ctx.redraw();
    report(state);
    for (const fn of [...listeners]) fn(state);
  });
  map.on('moveend', onMoveEnd);

  // Open on the most recent days of the record, in real time so it means the
  // same whatever the chunks' unit: a control moves it from there.
  //
  // The most recent days of the FINEST unit. A monthly overview covers its
  // last month whole, to the 30th, where the daily data ends today: opening
  // on the latest end of any chunk put the selection on days no daily chunk
  // has, and the timeline opened in months.
  const finest = chunks.some((c) => c.unit === 'day') ? chunks.filter((c) => c.unit === 'day') : chunks;
  const end = finest.reduce((latest, c) => (c.end > latest ? c.end : latest), finest[0].end);
  const start = finest.reduce((earliest, c) => (c.start < earliest ? c.start : earliest), finest[0].start);
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
      clearTimeout(tileNoteTimer);
      map.off('moveend', onMoveEnd);
      listeners.clear();
      set.destroy();
      // A format may keep what it opened across chunks coming and going; this is when it lets go.
      for (const format of Object.values(formats)) format.close?.();
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
