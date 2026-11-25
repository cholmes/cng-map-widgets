// @cngeo/timeline -- chunks, and the rules for a set of them.
//
// Time-chunked data is published as files that each cover a span: a year of
// days, a month of days, a rolling week, a whole record by month. A CHUNK
// DESCRIPTOR says where one is and what it covers. Nothing here opens a file:
// these functions answer "what does this set of spans imply", so that question
// can be tested without a map, a DOM or a network.
//
// Three rules, each earned by a bug in the app this was extracted from
// (firms-catalog's firms-explorer, mounted.js and archives.js):
//
//   - The AXIS is the union of the chunks, and may be wider than what is
//     loaded. What is not loaded is a GAP, drawn as not loaded -- an empty bar
//     would say "nothing happened", a different and usually false claim.
//   - What is LOADED follows the view; what DRAWS follows the selection.
//   - Where chunks overlap they disagree (a rolling week rebuilt hourly over a
//     year rebuilt daily), so each bucket has one OWNER: the higher
//     `priority`, then the narrower span.
//
// That app's chunks were calendar years, and several of its rules said so.
// These do not: a chunk's span is whatever its descriptor says.

import { CngError } from '@cngeo/spec';
import { bucketKeyOfDay, dayKeyOfDate, dayRangeOfKey, indexKey, keyIndex, unitOfKey } from './keys.js';

/**
 * @typedef {Object} ChunkDescriptor
 * @property {string} id       Unique in its set.
 * @property {string} start    First day covered, `YYYYMMDD`.
 * @property {string} end      Last day covered, `YYYYMMDD`, inclusive.
 * @property {'day'|'month'} unit   The size of the buckets INSIDE it. Its span is `start`..`end`, whatever that is.
 * @property {string} format   Which `ChunkFormat` reads it (`'pmtiles'`).
 * @property {string} url
 * @property {number} [priority]  Higher wins where chunks overlap. Default 0.
 */

/** Finest first. */
const UNITS = ['day', 'month'];
const invalid = (message, context) => new CngError(message, 'TIMELINE_INVALID', { retryable: false, context });
const day = (key) => keyIndex(key, 'day');

function isHttp(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Check a chunk list and return a normalised copy: day keys for dates (ISO
 * dates are accepted, read as their UTC day), defaults filled, sorted by
 * start.
 * @param {object[]} list
 * @returns {ChunkDescriptor[]}
 * @throws {CngError} `TIMELINE_INVALID`
 */
export function validateChunks(list) {
  if (!Array.isArray(list)) throw invalid('A timeline needs a list of chunks.', {});
  if (!list.length) throw invalid('A timeline needs at least one chunk: the list is empty.', {});
  const seen = new Set();
  const out = list.map((raw, n) => {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (!id) throw invalid(`Chunk ${n} has no id.`, { index: n });
    if (seen.has(id)) throw invalid(`Two chunks are called "${id}": a chunk's id must be its own.`, { id });
    seen.add(id);
    const start = dayKeyOfDate(raw.start);
    const end = dayKeyOfDate(raw.end);
    if (!start || !end) throw invalid(`Chunk "${id}" needs a start and an end date (got ${JSON.stringify(raw.start)} and ${JSON.stringify(raw.end)}).`, { id });
    if (start > end) throw invalid(`Chunk "${id}" starts (${start}) after it ends (${end}).`, { id, start, end });
    const unit = raw.unit ?? 'day';
    if (!UNITS.includes(unit)) throw invalid(`Chunk "${id}" has an unknown bucket unit ${JSON.stringify(unit)}: "day" or "month".`, { id, unit });
    if (typeof raw.url !== 'string' || !isHttp(raw.url)) throw invalid(`Chunk "${id}" needs an http(s) url (got ${JSON.stringify(raw.url)}).`, { id });
    const priority = typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : 0;
    return { id, start, end, unit, format: typeof raw.format === 'string' && raw.format ? raw.format : 'pmtiles', url: raw.url, priority };
  });
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * Chunks laid out on a calendar, from a URL template.
 *
 * `period` is `'year'`, `'month'`, `'week'`, `'day'`, or `{ days: n }`. Years
 * and months align to the calendar and are clipped to `start`..`end`; weeks
 * and day-counts run from `start`, the last one clipped. Template tokens:
 * `{YYYY}` `{MM}` `{DD}` (the first day of the chunk's period) and `{start}`
 * `{end}` (the days it covers, `YYYYMMDD`).
 *
 * @param {{ template: string, period: 'year'|'month'|'week'|'day'|{ days: number }, start: string|Date,
 *   end?: string|Date, unit?: 'day'|'month', format?: string, priority?: number }} options
 *   `end` defaults to today (UTC).
 * @returns {ChunkDescriptor[]}
 */
export function chunksFromTemplate(options) {
  const { template, period, unit = 'day', format = 'pmtiles', priority = 0 } = options ?? {};
  if (typeof template !== 'string' || !template) throw invalid('chunksFromTemplate needs a url template.', {});
  const start = dayKeyOfDate(options.start);
  const end = dayKeyOfDate(options.end ?? new Date());
  if (!start || !end) throw invalid(`chunksFromTemplate needs a start date (got ${JSON.stringify(options.start)} and ${JSON.stringify(options.end)}).`, {});
  if (start > end) throw invalid(`The range starts (${start}) after it ends (${end}).`, { start, end });
  const days = period === 'week' ? 7 : period === 'day' ? 1 : typeof period?.days === 'number' ? Math.trunc(period.days) : null;
  if (period !== 'year' && period !== 'month' && !(days >= 1)) throw invalid(`Unknown period ${JSON.stringify(period)}: "year", "month", "week", "day" or { days: n }.`, { period });

  /** @type {{ id: string, from: string, to: string }[]} each chunk's whole period, before clipping */
  const spans = [];
  if (period === 'year') {
    for (let y = +start.slice(0, 4); y <= +end.slice(0, 4); y++) spans.push({ id: String(y).padStart(4, '0'), from: `${String(y).padStart(4, '0')}0101`, to: `${String(y).padStart(4, '0')}1231` });
  } else if (period === 'month') {
    for (let m = keyIndex(start.slice(0, 6), 'month'); m <= keyIndex(end.slice(0, 6), 'month'); m++) {
      const key = indexKey(m, 'month');
      const [from, to] = dayRangeOfKey(key, 'month');
      spans.push({ id: key, from, to });
    }
  } else {
    for (let d = day(start); d <= day(end); d += days) spans.push({ id: indexKey(d, 'day'), from: indexKey(d, 'day'), to: indexKey(d + days - 1, 'day') });
  }
  const chunks = spans.map(({ id, from, to }) => {
    const s = from < start ? start : from;
    const e = to > end ? end : to;
    const url = template
      .replaceAll('{YYYY}', from.slice(0, 4))
      .replaceAll('{MM}', from.slice(4, 6))
      .replaceAll('{DD}', from.slice(6, 8))
      .replaceAll('{start}', s)
      .replaceAll('{end}', e);
    return { id, start: s, end: e, unit, format, url, priority };
  });
  return validateChunks(chunks);
}

/** A chunk's span in its own bucket keys. */
export function extentOf(chunk) {
  return { unit: chunk.unit, min: bucketKeyOfDay(chunk.start, chunk.unit), max: bucketKeyOfDay(chunk.end, chunk.unit) };
}

// A chunk's numbers are parsed from its keys once and remembered: the rules
// below are asked about thousands of chunks on every drag of a selection.
/** @type {WeakMap<object, { span: [number, number], days: [number, number] }>} */
const measured = new WeakMap();
function measure(chunk) {
  let m = measured.get(chunk);
  if (!m) {
    m = {
      span: [keyIndex(bucketKeyOfDay(chunk.start, chunk.unit), chunk.unit), keyIndex(bucketKeyOfDay(chunk.end, chunk.unit), chunk.unit)],
      days: [keyIndex(chunk.start, 'day'), keyIndex(chunk.end, 'day')],
    };
    measured.set(chunk, m);
  }
  return m;
}
/** `[first, last]` bucket ordinals of a chunk, in its own unit. */
const span = (chunk) => measure(chunk).span;
const width = (chunk) => measure(chunk).days[1] - measure(chunk).days[0];

/** Does `a` win a bucket both cover? Priority, then the narrower (whoever published it meant that span), then the earlier id. */
function beats(a, b) {
  if ((a.priority ?? 0) !== (b.priority ?? 0)) return (a.priority ?? 0) > (b.priority ?? 0);
  if (width(a) !== width(b)) return width(a) < width(b);
  return a.id < b.id;
}

/** Does the chunk have this bucket? A key of another unit is not one of its buckets. */
export function covers(chunk, key) {
  if (unitOfKey(key) !== chunk.unit) return false;
  const i = keyIndex(key, chunk.unit);
  const [lo, hi] = span(chunk);
  return i >= lo && i <= hi;
}

/**
 * Which chunk a bucket's numbers come from, where several cover it. Null when
 * none does.
 * @param {ChunkDescriptor[]} chunks
 * @param {string} key  A bucket key; its width says its unit.
 */
export function ownerOf(chunks, key) {
  let best = null;
  for (const c of chunks) {
    if (!covers(c, key)) continue;
    if (!best || beats(c, best)) best = c;
  }
  return best;
}

/**
 * The buckets of `fromKey`..`toKey` that `chunk` owns among `chunks`, as
 * inclusive runs of keys. (Usually one run; a higher-priority chunk in the
 * middle of it makes two.)
 * @returns {[string, string][]}
 */
export function ownedRanges(chunks, chunk, fromKey, toKey) {
  const unit = chunk.unit;
  if (unitOfKey(fromKey) !== unit || unitOfKey(toKey) !== unit) return [];
  const [lo, hi] = span(chunk);
  const a = Math.max(lo, keyIndex(fromKey, unit));
  const b = Math.min(hi, keyIndex(toKey, unit));
  if (b < a) return [];
  const rivals = chunks.filter((c) => c.id !== chunk.id && c.unit === unit && beats(c, chunk)).map(span).filter(([rl, rh]) => rl <= b && rh >= a);
  const runs = [];
  let start = null;
  for (let i = a; i <= b; i++) {
    const mine = !rivals.some(([rl, rh]) => i >= rl && i <= rh);
    if (mine && start === null) start = i;
    if (!mine && start !== null) {
      runs.push([indexKey(start, unit), indexKey(i - 1, unit)]);
      start = null;
    }
  }
  if (start !== null) runs.push([indexKey(start, unit), indexKey(b, unit)]);
  return runs;
}

/**
 * The axis a set of chunks implies at one unit: the union of their spans.
 * Chunks of another unit add nothing -- a month drawn as thirty days would
 * invent thirty bars from one number. Null when no chunk has that unit.
 * @returns {{ unit: string, min: string, max: string }|null}
 */
export function axisFor(chunks, unit) {
  const same = chunks.filter((c) => c.unit === unit);
  if (!same.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of same) {
    const [a, b] = span(c);
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  return { unit, min: indexKey(lo, unit), max: indexKey(hi, unit) };
}

/**
 * The parts of an axis no chunk in `chunks` covers, as inclusive `[from, to]`
 * bucket indices of that axis. Ranges, because that is what a painter wants:
 * one hatched rectangle per gap.
 * @param {ChunkDescriptor[]} chunks  What is LOADED.
 * @param {{ unit: string, min: string, max: string }|null} axis
 * @returns {[number, number][]}
 */
export function gapsIn(chunks, axis) {
  if (!axis) return [];
  const origin = keyIndex(axis.min, axis.unit);
  const last = keyIndex(axis.max, axis.unit) - origin;
  const held = chunks
    .filter((c) => c.unit === axis.unit)
    .map((c) => span(c).map((i) => i - origin))
    .filter(([a, b]) => b >= 0 && a <= last)
    .sort((x, y) => x[0] - y[0]);
  const gaps = [];
  let next = 0; // the first bucket not yet known to be covered
  for (const [a, b] of held) {
    if (a > next) gaps.push([next, a - 1]);
    if (b + 1 > next) next = b + 1;
  }
  if (next <= last) gaps.push([next, last]);
  return gaps;
}

const touches = (chunk, from, to) => chunk.start <= to && chunk.end >= from;

/** How many days of `from`..`to` the chunks cover between them. */
function coverage(chunks, from, to) {
  const lo = day(from);
  const hi = day(to);
  const spans = chunks.map((c) => [Math.max(lo, measure(c).days[0]), Math.min(hi, measure(c).days[1])]).filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let next = lo;
  for (const [a, b] of spans) {
    const start = Math.max(a, next);
    if (b >= start) {
      covered += b - start + 1;
      next = b + 1;
    }
  }
  return covered;
}

/**
 * The chunks of `touching` that lie wholly inside another, wider one: overlays
 * (a rolling week inside its year). One pass over them in order of start.
 */
function overlaysOf(touching) {
  const sorted = [...touching].sort((a, b) => measure(a).days[0] - measure(b).days[0] || measure(b).days[1] - measure(a).days[1]);
  const out = new Set();
  let maxEnd = -Infinity; // the furthest end of anything seen so far (all start at or before this one)
  let maxEndEarlier = -Infinity; // ... of anything that starts strictly earlier
  let groupStart = null;
  let groupMaxEnd = -Infinity;
  for (const c of sorted) {
    const [start, end] = measure(c).days;
    if (start !== groupStart) {
      // A new start: everything before it now "starts strictly earlier".
      maxEndEarlier = Math.max(maxEndEarlier, groupMaxEnd);
      groupStart = start;
      groupMaxEnd = -Infinity;
    }
    // Contained by something wider: one that ends later, or one that ends
    // with it and starts earlier.
    if (maxEnd > end || maxEndEarlier >= end) out.add(c);
    if (end > maxEnd) maxEnd = end;
    if (end > groupMaxEnd) groupMaxEnd = end;
  }
  return out;
}

/**
 * A coarser unit has to show this many more days of a window than a finer
 * one before it is the better view of it: one whole coarse bucket. Less than
 * that is the unfinished part of its last bucket -- a monthly archive runs to
 * the 30th where the daily data ends today -- and is no reason to give up days.
 */
const COARSER_MUST_SHOW_DAYS = 32;

/**
 * Which chunks a view needs LOADED, and at which unit.
 *
 * The finest unit whose chunks can show the window within `cap` -- unless a
 * coarser unit would show a whole bucket more of it. Then the coarser unit: a
 * view of six years is not a wider daily view, it is what a monthly overview
 * is for. With no coarser chunk to fall back on, the `cap` chunks nearest the
 * middle of the window load and the rest reads as not loaded.
 *
 * A chunk wholly inside another's span (a rolling week over its year) is an
 * overlay: it loads whenever it touches the window and does not count against
 * the cap, which exists to bound the big ones.
 *
 * @param {ChunkDescriptor[]} chunks  The whole set.
 * @param {{ from: string, to: string }} window  Day keys, inclusive.
 * @param {{ cap?: number }} [options]  Default 3.
 * @returns {{ unit: 'day'|'month', load: ChunkDescriptor[] }}
 */
export function forView(chunks, window, { cap = 3 } = {}) {
  const { from, to } = window;
  const byStart = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1);
  const present = UNITS.filter((u) => chunks.some((c) => c.unit === u));
  const plans = [];
  for (const unit of present) {
    const touching = chunks.filter((c) => c.unit === unit && touches(c, from, to));
    if (!touching.length) continue;
    const inside = overlaysOf(touching);
    const overlays = touching.filter((c) => inside.has(c));
    const base = touching.filter((c) => !inside.has(c));
    plans.push({ unit, base, overlays, fits: base.length <= cap, covered: coverage(touching, from, to) });
  }
  if (!plans.length) return { unit: present[0] ?? 'day', load: [] };
  const fitting = plans.filter((p) => p.fits);
  for (let i = 0; i < fitting.length; i++) {
    const coarser = fitting.slice(i + 1);
    if (coarser.every((p) => p.covered - fitting[i].covered < COARSER_MUST_SHOW_DAYS)) return { unit: fitting[i].unit, load: [...fitting[i].base, ...fitting[i].overlays].sort(byStart) };
  }
  // Nothing fits the cap at any unit: the finest, as much of it as the cap allows.
  const finest = plans[0];
  const middle = (day(from) + day(to)) / 2;
  const distance = (c) => Math.abs((day(c.start) + day(c.end)) / 2 - middle);
  const nearest = [...finest.base].sort((a, b) => distance(a) - distance(b)).slice(0, Math.max(1, cap));
  const kept = finest.overlays.filter((o) => nearest.some((c) => c.start <= o.start && c.end >= o.end));
  return { unit: finest.unit, load: [...nearest, ...kept].sort(byStart) };
}

/**
 * Which chunks a selection DRAWS from: every chunk of `unit` that owns at
 * least one bucket of it. Not "the one that covers it best" -- with chunks
 * smaller than the selection, one chunk is a fraction of what was asked for.
 *
 * @param {ChunkDescriptor[]} chunks  The whole set, or the loaded ones.
 * @param {{ from: string, to: string }} window  Day keys, inclusive.
 * @param {'day'|'month'} unit
 * @returns {ChunkDescriptor[]}
 */
export function forSelection(chunks, window, unit) {
  const candidates = chunks.filter((c) => c.unit === unit && touches(c, window.from, window.to));
  const a = keyIndex(bucketKeyOfDay(window.from, unit), unit);
  const b = keyIndex(bucketKeyOfDay(window.to, unit), unit);
  const owners = ownersWithin(candidates, a, b);
  return candidates.filter((c) => owners.has(c)).sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.id < y.id ? -1 : 1));
}

/**
 * The chunks that own at least one bucket of `a`..`b` (bucket ordinals), all
 * of one unit. A sweep along the buckets with the chunks that cover the
 * present one held in a heap, best first: where a chunk is on top for at
 * least one bucket, it owns that bucket.
 *
 * Asking each chunk in turn whether every other beats it (the first version)
 * was quadratic: 54 seconds for a selection over 9,521 daily chunks, on every
 * move of the selection.
 */
function ownersWithin(candidates, a, b) {
  const ranked = [...candidates].sort((x, y) => (beats(x, y) ? -1 : 1)); // best first: `beats` is a total order
  const events = []; // [position, rank, +1 enters | -1 leaves]
  ranked.forEach((chunk, rank) => {
    const [lo, hi] = span(chunk);
    const from = Math.max(lo, a);
    const to = Math.min(hi, b);
    if (to < from) return;
    events.push([from, rank, 1], [to + 1, rank, -1]);
  });
  events.sort((x, y) => x[0] - y[0]);
  // A min-heap of ranks, with leaving done lazily: a rank that has left is
  // skipped when it reaches the top.
  const heap = [];
  const gone = new Set();
  const push = (rank) => {
    let i = heap.push(rank) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent] <= heap[i]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const last = heap.pop();
    if (!heap.length) return;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let least = i;
      if (left < heap.length && heap[left] < heap[least]) least = left;
      if (right < heap.length && heap[right] < heap[least]) least = right;
      if (least === i) break;
      [heap[least], heap[i]] = [heap[i], heap[least]];
      i = least;
    }
  };
  const owners = new Set();
  for (let e = 0; e < events.length; ) {
    const position = events[e][0];
    for (; e < events.length && events[e][0] === position; e++) {
      if (events[e][2] === 1) push(events[e][1]);
      else gone.add(events[e][1]);
    }
    while (heap.length && gone.has(heap[0])) {
      gone.delete(heap[0]);
      pop();
    }
    // Whoever is on top owns the buckets from here to the next event.
    if (heap.length && position <= b) owners.add(ranked[heap[0]]);
  }
  return owners;
}
