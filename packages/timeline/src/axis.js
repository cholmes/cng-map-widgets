// @cngeo/timeline -- the axis, and the arithmetic of a view and a selection on it.
//
// An axis is a run of buckets of one unit. A DOMAIN is the part of it on
// screen, in fractional bucket coordinates (bucket i covers [i, i+1)). A
// SELECTION is an inclusive range of whole buckets. Everything here is pure.
//
// Ported from firms-catalog's apps/firms-explorer/timeline.js.

import { CngError } from '@cngeo/spec';
import { civilFromDays, daysFromCivil, indexKey, keyIndex } from './keys.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const invalid = (message, context) => new CngError(message, 'TIMELINE_INVALID', { retryable: false, context });

/**
 * The drawable axis for a declaration `{ unit, min, max, buckets? }`.
 *
 * Read from a declaration and never from a sampled feature: MVT omits
 * zero-valued attributes, so a sampled cell carries only the buckets in which
 * something happened there.
 */
export function makeAxis(decl) {
  if (!decl || typeof decl !== 'object') throw invalid('the timeline declaration is missing', {});
  const unit = decl.unit;
  if (unit !== 'day' && unit !== 'month') throw invalid(`the timeline declares an unknown unit ${JSON.stringify(unit)}`, { unit });
  const origin = keyIndex(decl.min, unit);
  const last = keyIndex(decl.max, unit);
  if (last < origin) throw invalid(`the timeline's min ${decl.min} is after its max ${decl.max}`, { min: decl.min, max: decl.max });
  const count = last - origin + 1;
  return {
    unit,
    min: decl.min,
    max: decl.max,
    origin,
    count,
    // What the data says it carries. It differs from `count` only when the
    // data is sparse -- a month with nothing anywhere has no column -- and
    // the axis still has to draw that gap, so the calendar span wins and the
    // declaration is kept for the caller to report.
    declaredBuckets: decl.buckets === null || decl.buckets === undefined ? count : decl.buckets,
    keyAt: (i) => indexKey(origin + i, unit),
    indexOf: (key) => keyIndex(key, unit) - origin,
  };
}

// --------------------------------------------------------------------- domain

// Two buckets is the floor. Zooming to a single bucket leaves nothing to pan
// against, since every x maps to the same bucket.
export const MIN_SPAN = 2;

/** Bucket coordinate under a pixel. */
export function xToCoord(x, domain, width) {
  return domain[0] + (width > 0 ? x / width : 0) * (domain[1] - domain[0]);
}

/** Pixel for a bucket coordinate. */
export function coordToX(t, domain, width) {
  const span = domain[1] - domain[0];
  return span > 0 ? ((t - domain[0]) / span) * width : 0;
}

/** The bucket under a pixel. */
export function bucketAt(x, domain, width) {
  return Math.floor(xToCoord(x, domain, width));
}

/**
 * Keep the domain inside the data, preserving its span. Clamping shifts rather
 * than truncates, so that panning into the edge slides to a stop instead of
 * silently zooming out.
 */
export function clampDomain(domain, count, minSpan = MIN_SPAN) {
  const full = Math.max(count, 1);
  const floor = Math.min(minSpan, full);
  let span = domain[1] - domain[0];
  if (!(span > 0)) span = floor;
  span = Math.min(Math.max(span, floor), full);
  let lo = domain[0];
  if (!(lo >= 0)) lo = 0;
  if (lo + span > full) lo = full - span;
  return [lo, lo + span];
}

/**
 * Zoom about a cursor. `factor > 1` zooms in. The bucket coordinate under `x`
 * is held fixed; clamping at the ends of the data is the one thing allowed to
 * break that.
 */
export function zoomDomain(domain, x, width, factor, count, minSpan = MIN_SPAN) {
  const span = domain[1] - domain[0];
  const f = width > 0 ? Math.min(Math.max(x / width, 0), 1) : 0;
  const anchor = domain[0] + f * span;
  const full = Math.max(count, 1);
  const next = Math.min(Math.max(span / factor, Math.min(minSpan, full)), full);
  const lo = anchor - f * next;
  return clampDomain([lo, lo + next], count, minSpan);
}

/** Drag the track: moving the pointer right brings earlier buckets into view. */
export function panDomain(domain, dx, width, count, minSpan = MIN_SPAN) {
  const span = domain[1] - domain[0];
  const shift = width > 0 ? (-dx * span) / width : 0;
  return clampDomain([domain[0] + shift, domain[1] + shift], count, minSpan);
}

/** The whole buckets the domain touches, as inclusive axis indices. */
export function domainBuckets(domain, count) {
  const i0 = Math.max(0, Math.floor(domain[0]));
  const i1 = Math.min(count - 1, Math.ceil(domain[1]) - 1);
  return [i0, Math.max(i0, i1)];
}

// ------------------------------------------------------------------ selection

/**
 * Hold the selection inside `bounds` (inclusive bucket indices), keeping its
 * width where the bounds are wide enough. Squashing a dragged selection
 * against the edge instead of sliding it makes it impossible to get back.
 */
export function clampSelection(sel, bounds) {
  const [b0, b1] = bounds;
  let from = Math.round(sel.from);
  let to = Math.round(sel.to);
  if (to < from) [from, to] = [to, from];
  const width = Math.min(to - from, b1 - b0);
  from = Math.min(Math.max(from, b0), b1 - width);
  return { from, to: from + width };
}

export function moveSelection(sel, delta, bounds) {
  return clampSelection({ from: sel.from + delta, to: sel.to + delta }, bounds);
}

/**
 * Drag one edge to a bucket. Dragging an edge past the other flips which
 * handle is live, so the returned `edge` is what the drag must follow.
 */
export function resizeSelection(sel, edge, index, bounds) {
  const [b0, b1] = bounds;
  const i = Math.min(Math.max(Math.round(index), b0), b1);
  let from = edge === 'from' ? i : sel.from;
  let to = edge === 'to' ? i : sel.to;
  let active = edge;
  if (to < from) {
    [from, to] = [to, from];
    active = edge === 'from' ? 'to' : 'from';
  }
  return { from, to, edge: active };
}

// -------------------------------------------------------- series and bar cost

/**
 * Prefix sums over the bucket values: every pixel column is then one
 * subtraction, and a repaint costs the track's width, not the axis's length.
 */
export function makeSeries(values) {
  const n = values.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (values[i] || 0);
  return { n, prefix };
}

/** Total over the inclusive bucket range, clipped to the series. */
export function sumRange(series, i0, i1) {
  const a = Math.max(0, Math.floor(i0));
  const b = Math.min(series.n - 1, Math.floor(i1));
  return b < a ? 0 : series.prefix[b + 1] - series.prefix[a];
}

/**
 * Bucket values from a `{ key: value }` mapping. A key may carry the data's
 * column prefix (`count_20240105`); anything that is not a bucket of this
 * axis -- a sensor or day/night column, a key of the other unit -- is ignored.
 */
export function seriesFromBuckets(axis, buckets, { prefix = 'count_' } = {}) {
  const v = new Float64Array(axis.count);
  for (const [k, value] of Object.entries(buckets || {})) {
    const key = prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k;
    let i;
    try {
      i = axis.indexOf(key);
    } catch {
      continue;
    }
    if (i >= 0 && i < axis.count) v[i] = value;
  }
  return makeSeries(v);
}

/**
 * The bars to draw for `count` buckets across a track `width` pixels wide.
 *
 * Bars quantize to pixel columns, not to buckets: with at least as many
 * buckets as pixels each column is one pixel and aggregates the buckets under
 * it; with fewer, each bucket gets a bar `floor(W/N)` wide at `floor(i*W/N)`.
 * Either way at most `W` entries.
 */
export function quantize(width, count) {
  const W = Math.floor(width);
  const N = Math.floor(count);
  if (!(W > 0) || !(N > 0)) return [];
  const cols = [];
  if (N >= W) {
    for (let p = 0; p < W; p++) {
      const i0 = Math.floor((p * N) / W);
      const i1 = Math.floor(((p + 1) * N) / W) - 1;
      cols.push({ x: p, w: 1, i0, i1: Math.max(i0, i1) });
    }
  } else {
    const bw = Math.floor(W / N);
    for (let i = 0; i < N; i++) cols.push({ x: Math.floor((i * W) / N), w: bw, i0: i, i1: i });
  }
  return cols;
}

// ---------------------------------------------------------------------- ticks

// A label needs this much room before the next one, or they collide.
const MIN_LABEL_PX = 54;
// Month-axis steps, in months. Every one divides the absolute month ordinal
// evenly, so ticks land on January (or on quarters) with no alignment pass.
const MONTH_STEPS = [1, 3, 12, 24, 60, 120, 600];
// Day-axis steps wider than a week, in months.
const DAY_MONTH_STEPS = [1, 3, 12, 60];

function* monthStarts(fromDay, toDay) {
  let [y, m] = civilFromDays(Math.floor(fromDay));
  let d = daysFromCivil(y, m, 1);
  while (d <= toDay) {
    yield [d, y, m];
    if (++m > 12) {
      m = 1;
      y += 1;
    }
    d = daysFromCivil(y, m, 1);
  }
}

/**
 * Labelled ticks for the visible domain, in axis-relative bucket indices.
 * Generated from the calendar rather than by scanning the visible buckets, so
 * the work is proportional to the labels drawn, not to the span.
 * @returns {{ index: number, label: string, major: boolean }[]}
 */
export function ticks(axis, domain, width) {
  const span = domain[1] - domain[0];
  if (!(span > 0) || !(width > 0)) return [];
  const px = width / span;
  const a0 = axis.origin + domain[0];
  const a1 = axis.origin + domain[1];
  const out = [];
  const push = (abs, label, major) => {
    if (abs >= a0 && abs < a1) out.push({ index: abs - axis.origin, label, major });
  };

  if (axis.unit === 'month') {
    const step = MONTH_STEPS.find((s) => s * px >= MIN_LABEL_PX) || MONTH_STEPS[MONTH_STEPS.length - 1];
    for (let i = Math.ceil(a0 / step) * step; i < a1; i += step) {
      const y = Math.floor(i / 12);
      const m = i - y * 12 + 1;
      push(i, step >= 12 ? String(y) : m === 1 ? `${MON[0]} ${y}` : MON[m - 1], m === 1);
    }
    return out;
  }

  if (px >= MIN_LABEL_PX) {
    for (let i = Math.ceil(a0); i < a1; i++) {
      const [, m, d] = civilFromDays(i);
      push(i, d === 1 ? `${MON[m - 1]} ${d}` : String(d), d === 1);
    }
    return out;
  }
  if (px * 7 >= MIN_LABEL_PX) {
    // A day-of-month grid, not a rolling week: ticks that drift with the
    // domain make the axis look like it is sliding under the bars.
    for (const [start, , m] of monthStarts(a0, a1)) {
      for (const d of [1, 8, 15, 22]) push(start + d - 1, d === 1 ? MON[m - 1] : String(d), d === 1);
    }
    return out;
  }
  const step = DAY_MONTH_STEPS.find((s) => s * 30.44 * px >= MIN_LABEL_PX) || DAY_MONTH_STEPS[DAY_MONTH_STEPS.length - 1];
  for (const [start, y, m] of monthStarts(a0, a1)) {
    if (step >= 12) {
      if (m === 1 && y % (step / 12) === 0) push(start, String(y), true);
    } else if ((m - 1) % step === 0) {
      push(start, m === 1 ? String(y) : MON[m - 1], m === 1);
    }
  }
  return out;
}

// -------------------------------------------------------------------- palette

/** A count ramp, cold to hot: `[threshold, colour]`, ascending. The default for bars and for cells. */
export const COUNT_RAMP = Object.freeze([
  [1, '#2c3d5a'], [5, '#3f6d8f'], [20, '#59a1a0'], [75, '#a8c268'],
  [250, '#f2b134'], [1000, '#e8722c'], [4000, '#d1382a'],
]);

/** The colour of the highest stop a value reaches; the first stop's below that. */
export function rampColor(stops, v) {
  let c = stops[0][1];
  for (const [t, col] of stops) if (v >= t) c = col;
  return c;
}

/**
 * The same colour, lifted off a dark track.
 *
 * A ramp shared with the map means the same count in both places, but the
 * two are read against different backgrounds: a dark blue that reads easily
 * as hundreds of pixels of map cell is nearly invisible as a two-pixel bar on
 * a near-black track, and a quiet month looked like a month with no data. So
 * the bottom of the ramp is lifted to a luminance floor -- only the bottom,
 * scaling the channels together to keep the hue and the ordering.
 */
const MIN_LUMA = 82;
const lifted = new Map();
export function liftForTrack(hex) {
  let out = lifted.get(hex);
  if (out) return out;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = luma > 0 && luma < MIN_LUMA ? MIN_LUMA / luma : 1;
  const ch = (v) => Math.min(255, Math.round(v * k));
  out = k === 1 ? hex : `#${[ch(r), ch(g), ch(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  lifted.set(hex, out);
  return out;
}
