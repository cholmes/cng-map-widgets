// @cngeo/timeline -- the chunk-set orchestrator.
//
// Given a set of chunks, a view (the span of time on screen) and a selection
// (the span of time to draw), it decides which chunks are loaded and which
// draw, and keeps a histogram of what is loaded. It knows nothing about maps
// or files: a ChunkFormat opens a chunk and mounts it, and this tells each
// mount what to show.
//
// The rules (each fixed a bug in the app this replaces, firms-explorer's
// deck.html, where they lived in page globals):
//
//   LOADED follows the VIEW. Chunks are added as the view reaches them --
//   throttled while a gesture is in flight -- and let go only once things
//   have been still for a moment. A chunk the selection draws from is never
//   let go.
//
//   DRAWING follows the SELECTION. Every loaded chunk that owns buckets of
//   the selection draws, each only the buckets it owns.
//
//   HANDOVER. A chunk that stops drawing while its successor has nothing on
//   screen yet is frozen -- it keeps showing what it showed -- and released
//   when the successor has settled. Otherwise every change of chunk is a
//   blank frame.
//
//   The UNIT (days or months) changes only when things are still, never
//   mid-gesture.
//
//   ONE reconcile at a time. A callback arriving during one marks it dirty
//   and it runs again; without that, a mount that reports back from inside
//   `setWindow` re-enters and the two chase each other.

import { CngError } from '@cngeo/spec';
import { bucketKeyOfDay, keyIndex } from './keys.js';
import { axisFor, forSelection, forView, gapsIn, ownedRanges, ownerOf, validateChunks } from './chunks.js';

/**
 * @typedef {Object} ChunkFormat
 * @property {(chunk: import('./chunks.js').ChunkDescriptor, env: { signal: AbortSignal }) => Promise<object>} open
 *   Read what the chunk says about itself. Whatever it resolves is handed back as `ctx.info`.
 * @property {(ctx: MountContext) => ChunkMount} mount
 *
 * @typedef {Object} MountContext
 * @property {import('./chunks.js').ChunkDescriptor} chunk
 * @property {object} info        What `open()` resolved.
 * @property {() => void} changed  Call when new data has arrived (a tile): the histogram is recomputed soon.
 * @property {(settled?: boolean) => void} settled  Call with true when everything on screen has loaded, false when loading again.
 *
 * @typedef {Object} ChunkMount
 * @property {(window: ChunkWindow|null) => void} setWindow  What to draw; null for "loaded, drawing nothing". Also ends a `freeze()`.
 * @property {(viewport: any) => Record<string, number>} histogram  Counts per bucket key, for what is in the viewport.
 * @property {() => void} freeze   Keep showing exactly what is shown now, until the next `setWindow()`.
 * @property {() => void} destroy
 *
 * @typedef {{ unit: 'day'|'month', ranges: [string, string][] }} ChunkWindow
 *   The buckets of the selection this chunk owns, as inclusive runs of bucket keys.
 */

const byStart = (a, b) => (a.chunk.start < b.chunk.start ? -1 : a.chunk.start > b.chunk.start ? 1 : a.chunk.id < b.chunk.id ? -1 : 1);
const middleOf = (w) => (keyIndex(w.from, 'day') + keyIndex(w.to, 'day')) / 2;
const distanceFrom = (chunk, mid) => Math.abs((keyIndex(chunk.start, 'day') + keyIndex(chunk.end, 'day')) / 2 - mid);

/**
 * @param {Object} options
 * @param {object[]} options.chunks   Chunk descriptors (see `validateChunks`).
 * @param {Record<string, ChunkFormat>} options.formats  By `chunk.format`.
 * @param {number} [options.cap]            Most big chunks a view loads. Default 3.
 * @param {number} [options.selectionCap]   Most chunks a selection loads. Default `cap * 4`.
 * @param {number} [options.settleMs]       Stillness before chunks are let go and the unit may change. Default 450.
 * @param {number} [options.loadEveryMs]    Mid-gesture, chunks are added at most this often. Default 150.
 * @param {number} [options.histogramMs]    The histogram follows new data by at most this. Default 180.
 * @param {number} [options.handoverMs]     Longest a frozen chunk is kept. Default 8000.
 * @param {number} [options.openTimeoutMs]  Longest a chunk may take to open. Default 60000.
 * @param {number} [options.stillMs]        Silence after which a `dragging` view counts as at rest. Default 2000.
 * @param {{ setTimeout: Function, clearTimeout: Function, now: () => number }} [options.timers]  For tests.
 */
export function createChunkSet(options) {
  const all = validateChunks(options?.chunks);
  const formats = options.formats ?? {};
  const cap = options.cap ?? 3;
  const selectionCap = options.selectionCap ?? cap * 4;
  const settleMs = options.settleMs ?? 450;
  const loadEveryMs = options.loadEveryMs ?? 150;
  const histogramMs = options.histogramMs ?? 180;
  const handoverMs = options.handoverMs ?? 8000;
  const openTimeoutMs = options.openTimeoutMs ?? 60_000;
  const stillMs = options.stillMs ?? 2000;
  const T = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id), now: () => Date.now(), ...options.timers };

  /** @type {Map<string, any>} chunk id -> entry */
  const entries = new Map();
  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();
  let unit = null;
  let view = null;
  let selection = null;
  let viewport = null;
  let dragging = false;
  let histogram = {};
  let histogramVersion = 0;
  let destroyed = false;
  let running = false;
  let dirty = false;
  let settleTimer = null;
  let loadTimer = null;
  let histogramTimer = null;
  let lastLoadAt = -Infinity;
  let lastViewAt = -Infinity;
  let lastSignature = '';

  const alive = (entry) => !destroyed && entries.get(entry.chunk.id) === entry;
  /** Mounted and part of the set: not on its way out. */
  const active = () => [...entries.values()].filter((e) => e.status === 'ready' && !e.evicting).sort(byStart);

  // --- state ---------------------------------------------------------------------------------

  function snapshot() {
    const live = active();
    const axis = unit ? axisFor(all, unit) : null;
    const opening = [...entries.values()].filter((e) => e.status === 'opening').sort(byStart);
    return {
      unit,
      axis,
      gaps: axis ? gapsIn(live.filter((e) => e.chunk.unit === unit).map((e) => e.chunk), axis) : [],
      loaded: live.map((e) => e.chunk.id),
      drawing: live.filter((e) => e.window !== null && !e.frozen).map((e) => e.chunk.id),
      outgoing: [...entries.values()].filter((e) => e.frozen).sort(byStart).map((e) => e.chunk.id),
      pending: opening.map((e) => e.chunk.id),
      failed: [...entries.values()].filter((e) => e.status === 'failed').sort(byStart).map((e) => ({ id: e.chunk.id, error: e.error })),
      histogram,
      partial: opening.length > 0 || live.some((e) => !e.settled),
      view,
      selection,
    };
  }

  function emit() {
    if (destroyed) return;
    const state = snapshot();
    const signature = JSON.stringify([state.unit, state.axis, state.gaps, state.loaded, state.drawing, state.outgoing, state.pending, state.failed.map((f) => f.id), state.partial, state.view, state.selection, histogramVersion]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    for (const fn of [...listeners]) fn(state);
  }

  // --- opening and letting go ------------------------------------------------------------------

  function failed(entry, error) {
    if (!alive(entry)) return;
    T.clearTimeout(entry.openTimer);
    entry.openTimer = null;
    entry.status = 'failed';
    entry.error = error;
    reconcile();
  }

  const loadFailed = (chunk, why, cause) =>
    new CngError(`Chunk "${chunk.id}" could not be loaded: ${why}`, 'LAYER_LOAD_FAILED', { retryable: true, context: { chunk: chunk.id, url: chunk.url }, ...(cause ? { cause } : {}) });

  function open(chunk) {
    const entry = {
      chunk, status: 'opening', mount: null, info: null, error: null,
      settled: false, settledOnce: false,
      window: null, windowKey: 'null',
      frozen: false, evicting: false, forced: false, holdTimer: null,
      controller: new AbortController(), openTimer: null,
    };
    entries.set(chunk.id, entry);
    const format = formats[chunk.format];
    if (!format) {
      entry.status = 'failed';
      entry.error = new CngError(`Chunk "${chunk.id}" is in the "${chunk.format}" format, which this timeline has no reader for.`, 'TIMELINE_INVALID', { retryable: false, context: { chunk: chunk.id, format: chunk.format } });
      return;
    }
    if (openTimeoutMs > 0) {
      entry.openTimer = T.setTimeout(() => {
        if (!alive(entry) || entry.status !== 'opening') return;
        const seconds = openTimeoutMs >= 1000 ? `${Math.round(openTimeoutMs / 1000)} s` : `${openTimeoutMs} ms`;
        failed(entry, loadFailed(chunk, `it did not answer within ${seconds}.`));
        entry.controller.abort();
      }, openTimeoutMs);
    }
    let opening;
    try {
      opening = Promise.resolve(format.open(chunk, { signal: entry.controller.signal }));
    } catch (cause) {
      opening = Promise.reject(cause);
    }
    opening.then(
      (info) => {
        if (!alive(entry) || entry.status !== 'opening') return;
        T.clearTimeout(entry.openTimer);
        entry.openTimer = null;
        entry.info = info ?? {};
        try {
          entry.mount = format.mount({
            chunk,
            info: entry.info,
            changed: () => {
              if (alive(entry)) scheduleHistogram();
            },
            settled: (on = true) => {
              if (!alive(entry)) return;
              const next = Boolean(on);
              if (next) entry.settledOnce = true;
              if (entry.settled === next) return;
              entry.settled = next;
              reconcile();
            },
          });
        } catch (cause) {
          failed(entry, cause instanceof CngError ? cause : loadFailed(chunk, cause?.message ?? String(cause), cause));
          return;
        }
        entry.status = 'ready';
        scheduleHistogram();
        reconcile();
      },
      (cause) => {
        if (!alive(entry) || entry.status !== 'opening') return;
        failed(entry, cause instanceof CngError ? cause : loadFailed(chunk, cause?.message ?? String(cause), cause));
      },
    );
  }

  /** Gone, now: its request aborted, its mount destroyed. */
  function dispose(entry) {
    T.clearTimeout(entry.openTimer);
    T.clearTimeout(entry.holdTimer);
    entry.controller.abort();
    if (entries.get(entry.chunk.id) === entry) entries.delete(entry.chunk.id);
    try {
      entry.mount?.destroy();
    } catch {
      /* a mount that cannot clean up must not stop the rest */
    }
  }

  /** Keep showing what it shows, for at most `handoverMs`. */
  function freeze(entry) {
    if (entry.frozen) return;
    entry.frozen = true;
    entry.forced = false;
    entry.mount.freeze();
    entry.holdTimer = T.setTimeout(() => {
      entry.holdTimer = null;
      if (!alive(entry)) return;
      entry.forced = true;
      reconcile();
    }, handoverMs);
  }

  /** No longer needed. If it is what is on screen, it stays until its successor is; otherwise it goes now. */
  function letGo(entry) {
    if (entry.status === 'ready' && entry.window !== null && entry.settledOnce) {
      entry.evicting = true;
      freeze(entry);
    } else {
      dispose(entry);
    }
  }

  /** The chunks a selection draws from, limited to the nearest when it is very wide. */
  function selectionChunks() {
    if (!selection || !unit) return [];
    const list = forSelection(all, selection, unit);
    if (list.length <= selectionCap) return list;
    const mid = middleOf(selection);
    return [...list].sort((a, b) => distanceFrom(a, mid) - distanceFrom(b, mid)).slice(0, selectionCap);
  }

  /**
   * Bring what is loaded in line with the view and the selection.
   * `final`: things are still -- the unit may change and what is not needed is let go.
   */
  function plan(final) {
    if (destroyed || !view) return;
    let want = forView(all, view, { cap });
    if (final || unit === null) unit = want.unit;
    // Mid-gesture a view that calls for the other unit loads nothing new: the
    // switch is 450 ms away, and what it would fetch meanwhile would be let go.
    else if (want.unit !== unit) want = { unit, load: [] };
    const forSelectionNow = selectionChunks();
    const need = new Map([...want.load, ...forSelectionNow].map((c) => [c.id, c]));
    for (const chunk of need.values()) {
      const entry = entries.get(chunk.id);
      if (!entry) open(chunk);
      else if (entry.evicting) entry.evicting = false; // wanted again before it had gone
    }
    if (final) {
      for (const entry of [...entries.values()]) if (!need.has(entry.chunk.id) && !entry.evicting) letGo(entry);
      return;
    }
    // Not still yet: nothing is let go for being out of view -- except that a
    // drag across many chunks must not hold them all. Past twice the cap, the
    // ones furthest from the view go (never one that is drawing).
    const kept = new Set(forSelectionNow.map((c) => c.id));
    const loose = [...entries.values()].filter((e) => !kept.has(e.chunk.id) && !e.evicting);
    const over = loose.length - cap * 2;
    if (over > 0) {
      const mid = middleOf(view);
      const droppable = loose.filter((e) => !need.has(e.chunk.id) && e.window === null).sort((a, b) => distanceFrom(b.chunk, mid) - distanceFrom(a.chunk, mid));
      for (const entry of droppable.slice(0, over)) dispose(entry);
    }
  }

  // --- what draws --------------------------------------------------------------------------------

  function step() {
    if (!unit) return;
    const live = active().filter((e) => e.chunk.unit === unit);
    const chunksNow = live.map((e) => e.chunk);
    // Is anything that should be drawing not on screen yet?
    let waiting = false;
    if (selection) {
      const candidates = all.filter((c) => {
        const e = entries.get(c.id);
        return e && e.status !== 'failed' && !e.evicting;
      });
      for (const chunk of forSelection(candidates, selection, unit)) {
        const e = entries.get(chunk.id);
        if (e.status !== 'ready' || !e.settled) waiting = true;
      }
    }
    const fromKey = selection ? bucketKeyOfDay(selection.from, unit) : null;
    const toKey = selection ? bucketKeyOfDay(selection.to, unit) : null;
    for (const entry of live) {
      const ranges = selection ? ownedRanges(chunksNow, entry.chunk, fromKey, toKey) : [];
      const next = ranges.length ? { unit, ranges } : null;
      const key = JSON.stringify(next);
      if (next === null && entry.window !== null && entry.settledOnce && waiting && !entry.forced) {
        freeze(entry); // it stops drawing, but not before its successor has something to show
        continue;
      }
      if (key === entry.windowKey && !entry.frozen) continue;
      T.clearTimeout(entry.holdTimer);
      entry.holdTimer = null;
      entry.frozen = false;
      entry.forced = false;
      entry.window = next;
      entry.windowKey = key;
      entry.mount.setWindow(next);
    }
    for (const entry of [...entries.values()]) if (entry.evicting && (!waiting || entry.forced)) dispose(entry);
  }

  function reconcile() {
    if (destroyed) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      let turns = 0;
      do {
        dirty = false;
        step();
      } while (dirty && ++turns < 50);
    } finally {
      running = false;
    }
    emit();
  }

  // --- the histogram -----------------------------------------------------------------------------

  function computeHistogram() {
    histogramTimer = null;
    if (destroyed) return;
    const live = active().filter((e) => e.chunk.unit === unit);
    const chunksNow = live.map((e) => e.chunk);
    const merged = {};
    for (const entry of live) {
      let counts;
      try {
        counts = entry.mount.histogram(viewport) ?? {};
      } catch {
        counts = {};
      }
      for (const key of Object.keys(counts)) {
        if (!counts[key]) continue;
        let owner = null;
        try {
          owner = ownerOf(chunksNow, key);
        } catch {
          continue; // not a bucket key
        }
        // Each bucket once, from the chunk that owns it: two chunks that both
        // have a day disagree about it.
        if (owner && owner.id === entry.chunk.id) merged[key] = counts[key];
      }
    }
    histogram = merged;
    histogramVersion += 1;
    emit();
  }

  function scheduleHistogram() {
    if (destroyed || histogramTimer !== null) return;
    histogramTimer = T.setTimeout(computeHistogram, histogramMs);
  }

  // --- the public face ---------------------------------------------------------------------------

  return {
    /** A fresh picture of the set. */
    get state() {
      return snapshot();
    },

    /** Subscribe to changes of `state`. Returns the unsubscribe. */
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * The span of time on screen, as day keys. `dragging`: a gesture is in
     * flight -- chunks are added (not too often) and nothing else changes.
     */
    setView(window, { dragging: mid = false } = {}) {
      if (destroyed || !window) return;
      view = { from: window.from, to: window.to };
      dragging = Boolean(mid);
      const now = T.now();
      if (unit === null) {
        plan(true);
        lastLoadAt = now;
      } else if (!dragging || now - lastLoadAt >= loadEveryMs) {
        T.clearTimeout(loadTimer);
        loadTimer = null;
        plan(false);
        lastLoadAt = now;
      } else if (loadTimer === null) {
        loadTimer = T.setTimeout(() => {
          loadTimer = null;
          plan(false);
          lastLoadAt = T.now();
          reconcile();
        }, lastLoadAt + loadEveryMs - now);
      }
      lastViewAt = now;
      T.clearTimeout(settleTimer);
      const settle = () => {
        settleTimer = null;
        if (dragging) {
          // The end of the gesture will call again -- usually. A gesture
          // whose end is never reported (a pointer released outside the page,
          // a control that forgets) must not hold the unit and what is loaded
          // for ever: enough silence IS the end.
          const quiet = T.now() - lastViewAt;
          if (quiet < stillMs) {
            settleTimer = T.setTimeout(settle, stillMs - quiet);
            return;
          }
          dragging = false;
        }
        plan(true);
        scheduleHistogram();
        reconcile();
      };
      settleTimer = T.setTimeout(settle, settleMs);
      reconcile();
    },

    /** The span of time to draw, as day keys. */
    setSelection(window) {
      if (destroyed || !window) return;
      selection = { from: window.from, to: window.to };
      if (unit !== null) plan(false);
      reconcile();
    },

    /** What part of the map is on screen: handed to each mount's `histogram()`. */
    setViewport(next) {
      if (destroyed) return;
      viewport = next;
      scheduleHistogram();
    },

    /** Try a failed chunk again. */
    retry(id) {
      const entry = entries.get(id);
      if (destroyed || !entry || entry.status !== 'failed') return;
      entries.delete(id);
      plan(false);
      reconcile();
    },

    /**
     * What is mounted, bottom first (a higher priority draws on top), for an
     * adapter that has layers to collect from them.
     * @returns {{ id: string, chunk: object, mount: ChunkMount, drawing: boolean, outgoing: boolean }[]}
     */
    mounts() {
      return [...entries.values()]
        .filter((e) => e.status === 'ready')
        .sort((a, b) => (a.chunk.priority ?? 0) - (b.chunk.priority ?? 0) || byStart(a, b))
        .map((e) => ({ id: e.chunk.id, chunk: e.chunk, mount: e.mount, drawing: e.window !== null && !e.frozen, outgoing: e.frozen }));
    },

    /** Stop everything: requests aborted, mounts destroyed, timers cleared, callbacks silenced. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const timer of [settleTimer, loadTimer, histogramTimer]) T.clearTimeout(timer);
      settleTimer = loadTimer = histogramTimer = null;
      for (const entry of [...entries.values()]) dispose(entry);
      entries.clear();
      listeners.clear();
    },
  };
}
