// @cngeo/maplibre -- what the timeline panel says and offers, with no DOM.
//
// Its status words, its preset spans and what its date inputs hold are all
// functions of a timeline session's state. They are here, tested, so that the
// control is only a view of them.
//
// `timeline` in these signatures is `@cngeo/timeline`'s exports -- handed in,
// because this package loads that one only when a timeline is used.

const count = (n) => Number(n).toLocaleString('en-US');

/** The selection as bucket indices of the axis, clipped to it; null when there is no axis or selection. */
function selectionIndices(state, T) {
  const { axis, selection } = state;
  if (!axis || !selection) return null;
  const bucket = (day) => (axis.unit === 'month' ? day.slice(0, 6) : day);
  const origin = T.keyIndex(axis.min, axis.unit);
  const last = T.keyIndex(axis.max, axis.unit) - origin;
  const from = Math.max(0, T.keyIndex(bucket(selection.from), axis.unit) - origin);
  const to = Math.min(last, T.keyIndex(bucket(selection.to), axis.unit) - origin);
  return to < from ? null : { from, to, origin };
}

/** What the bars inside the selection add up to. */
export function selectionTotal(state, T) {
  const sel = selectionIndices(state, T);
  if (!sel) return 0;
  let total = 0;
  for (const [key, value] of Object.entries(state.histogram ?? {})) {
    let i;
    try {
      i = T.keyIndex(key, state.axis.unit) - sel.origin;
    } catch {
      continue; // a key of the other unit, left over from before a change of unit
    }
    if (i >= sel.from && i <= sel.to) total += value;
  }
  return total;
}

/** How many buckets of the selection nothing loaded covers. */
export function notLoadedBuckets(state, T) {
  const sel = selectionIndices(state, T);
  if (!sel) return 0;
  let missing = 0;
  for (const [g0, g1] of state.gaps ?? []) missing += Math.max(0, Math.min(g1, sel.to) - Math.max(g0, sel.from) + 1);
  return missing;
}

/** "20 Nov 2024 – 25 Nov 2024", or one date when it is one bucket. */
function rangeLabel(state, T) {
  const unit = state.axis.unit;
  const bucket = (day) => (unit === 'month' ? day.slice(0, 6) : day);
  const a = T.formatKey(bucket(state.selection.from), unit);
  const b = T.formatKey(bucket(state.selection.to), unit);
  return a === b ? a : `${a} – ${b}`;
}

/**
 * What a timeline panel should say for a session's state. It reads the
 * selection, never the view, so panning the track says nothing new and a
 * live region is left alone.
 *
 * @param {object} state  A session's (or chunk set's) `state`.
 * @param {{ timeline: object, metricLabel?: string, tiles?: { selected: number, loaded: number } }} options
 * @returns {{ tone: 'info'|'error', line: string }}
 */
export function timelineStatusOf(state, { timeline: T, metricLabel = 'features', tiles } = {}) {
  if (!state?.axis || !state.selection) return { tone: 'info', line: 'Loading…' };
  const parts = [rangeLabel(state, T)];
  const loading = state.partial || state.pending?.length > 0;
  if (loading) {
    parts.push(tiles && tiles.selected > 0 && tiles.loaded < tiles.selected ? `loading ${count(tiles.loaded)} of ${count(tiles.selected)} tiles…` : 'loading…');
  } else {
    parts.push(`${count(selectionTotal(state, T))} ${metricLabel} in view`);
    // A total over a selection that is partly not loaded is honest for what
    // is loaded and wrong for what was asked: say which.
    const missing = notLoadedBuckets(state, T);
    if (missing > 0) parts.push(`${count(missing)} ${state.axis.unit}${missing === 1 ? '' : 's'} not loaded`);
  }
  if (state.failed?.length) {
    const why = state.failed.map((f) => String(f.error?.message ?? f.error ?? f.id)).join('; ');
    return { tone: 'error', line: `${why} · ${parts.join(' · ')}` };
  }
  return { tone: 'info', line: parts.join(' · ') };
}

const PRESETS = {
  day: [['7d', '7 days', 7], ['30d', '30 days', 30], ['90d', '90 days', 90], ['1y', '1 year', 365]],
  month: [['1y', '1 year', 12], ['5y', '5 years', 60], ['10y', '10 years', 120]],
};

/**
 * The spans a panel offers for an axis: the ones shorter than the axis, and
 * always "All". `buckets` is how many buckets the view should show; null is
 * the whole axis.
 * @returns {{ id: string, label: string, buckets: number|null }[]}
 */
export function presetsFor(axis, T) {
  if (!axis) return [];
  const length = T.keyIndex(axis.max, axis.unit) - T.keyIndex(axis.min, axis.unit) + 1;
  return [...(PRESETS[axis.unit] ?? []).filter(([, , buckets]) => buckets < length).map(([id, label, buckets]) => ({ id, label, buckets })), { id: 'all', label: 'All', buckets: null }];
}

/**
 * What the two date inputs hold: `<input type="date">` on a daily axis,
 * `type="month"` on a monthly one, bounded by the axis. Null with no axis.
 */
export function inputsFor(state, T) {
  if (!state?.axis || !state.selection) return null;
  const unit = state.axis.unit;
  const bucket = (day) => (unit === 'month' ? day.slice(0, 6) : day);
  return {
    type: unit === 'month' ? 'month' : 'date',
    from: T.keyToISO(bucket(state.selection.from), unit),
    to: T.keyToISO(bucket(state.selection.to), unit),
    min: T.keyToISO(state.axis.min, unit),
    max: T.keyToISO(state.axis.max, unit),
  };
}

const sameWindow = (a, b) => Boolean(a && b) && a.from === b.from && a.to === b.to;

/**
 * Which parts of a track event the session has not heard: the track's last
 * known `{ view, selection, dragging }` against the event.
 *
 * The track speaks whole buckets and the session holds exact days, so a part
 * the track did not change must not be sent back: on the monthly track, a
 * zoom would overwrite an exact five-day selection with its whole month. The
 * end of a gesture is news about the view even when nothing else moved --
 * whoever loads for the view is waiting for `dragging: false`.
 *
 * @returns {{ view: boolean, selection: boolean }}
 */
export function trackNews(last, event) {
  if (!last) return { view: true, selection: true };
  return {
    view: !sameWindow(last.view, event.view) || Boolean(last.dragging) !== Boolean(event.dragging),
    selection: !sameWindow(last.selection, event.selection),
  };
}

/**
 * What a panel with no session says, from the layer manager's entry for its
 * layer (or none). A layer that FAILED is on the map, as an error: its own
 * message is the thing to show, not "not on the map".
 * @returns {{ tone: 'info'|'error', line: string }}
 */
export function unboundStatus(entry, layerId) {
  if (!entry) return { tone: 'error', line: `There is no layer "${layerId}" on the map.` };
  if (entry.status === 'error') return { tone: 'error', line: entry.error?.message ?? `"${entry.title ?? layerId}" could not be loaded.` };
  if (entry.status === 'loading') return { tone: 'info', line: `Loading "${entry.title ?? layerId}"…` };
  return { tone: 'error', line: `"${entry.title ?? layerId}" is not a timeline layer.` };
}

/**
 * `aria-live` for the status line. Off while playing: it is rewritten on
 * every step, which is a sentence several times a second to a screen reader.
 * What it says when playback stops is announced.
 */
export const liveness = (playback) => (playback?.playing ? 'off' : 'polite');

/**
 * The panel's state, following a timeline session: `{ status, presets,
 * inputs, unit }`. `on('change')` fires when any of them is different.
 * @param {{ session: object, metricLabel?: string }} options
 */
export function createTimelineModel({ session, metricLabel }) {
  const T = session.timeline;
  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();
  const build = () => {
    const state = session.state;
    return {
      status: timelineStatusOf(state, { timeline: T, metricLabel, tiles: session.tiles?.() }),
      presets: presetsFor(state.axis, T),
      inputs: inputsFor(state, T),
      unit: state.unit,
    };
  };
  let last = JSON.stringify(build());
  const off = session.on('change', () => {
    const next = build();
    const signature = JSON.stringify(next);
    if (signature === last) return;
    last = signature;
    for (const fn of [...listeners]) fn(next);
  });
  return {
    get state() {
      return build();
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      off?.();
      listeners.clear();
    },
  };
}
