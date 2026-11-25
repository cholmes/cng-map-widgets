// @cngeo/timeline -- the canvas timeline.
//
// One track: a histogram of bucket values, a draggable selection with two
// handles, wheel and pinch zoom, drag to pan, a label strip of calendar
// ticks. It is handed an axis and values and reports back, IN DAY KEYS, what
// the person is looking at and what they have selected -- so its owner never
// needs to know whether the buckets under it are days or months.
//
// The only part of this package that touches the DOM. Ported from
// firms-catalog's apps/firms-explorer/timeline.js (the `Timeline` class).

import { bucketKeyOfDay, dayRangeOfKey, formatKey } from './keys.js';
import {
  bucketAt, clampDomain, clampSelection, coordToX, domainBuckets, makeAxis, makeSeries, moveSelection,
  panDomain, quantize, rampColor, liftForTrack, resizeSelection, seriesFromBuckets, sumRange, ticks,
  xToCoord, zoomDomain, COUNT_RAMP,
} from './axis.js';

/** Colours for a dark surround. A canvas cannot read a CSS variable, so they are handed in. */
export const TIMELINE_THEME_DARK = Object.freeze({
  track: '#0b0f15', line: '#2b3440', grid: 'rgba(43,52,64,.55)', hatch: 'rgba(148,163,184,.22)',
  text: '#e6edf3', textDim: '#8b949e', accent: '#f78166',
  outside: 'rgba(13,17,23,.62)', notch: 'rgba(13,17,23,.85)',
  rule: 'rgba(230,237,243,.30)', ruleHalf: 'rgba(230,237,243,.14)',
  labelBack: 'rgba(11,15,21,.82)', tipBack: 'rgba(18,23,31,.92)', hover: 'rgba(230,237,243,.28)',
  /** Lift the darkest bar colours off the track (see `liftForTrack`). */
  liftBars: true,
});

/** Colours for a light surround. */
export const TIMELINE_THEME_LIGHT = Object.freeze({
  track: '#f6f8fa', line: '#d0d7de', grid: 'rgba(208,215,222,.6)', hatch: 'rgba(87,96,106,.25)',
  text: '#1f2328', textDim: '#656d76', accent: '#cf4a22',
  outside: 'rgba(246,248,250,.7)', notch: 'rgba(255,255,255,.9)',
  rule: 'rgba(31,35,40,.30)', ruleHalf: 'rgba(31,35,40,.14)',
  labelBack: 'rgba(255,255,255,.85)', tipBack: 'rgba(255,255,255,.95)', hover: 'rgba(31,35,40,.28)',
  liftBars: false,
});

const HANDLE_W = 6; // drawn width of a selection handle
const FIT_MARGIN = 0.12; // breathing room either side when fitting the view to the selection
const AXIS_H = 15; // label strip under the track
const GRIP = 6; // px either side of an edge that grabs the handle
const WHEEL = 0.0035; // zoom per wheel unit
const PINCH = 0.012; // ctrl+wheel arrives in much smaller units
const FONT = 'ui-sans-serif,-apple-system,"Segoe UI",sans-serif';

const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));
const raf = (fn) => (globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16)))(fn);

export class TimelineCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [options]
   * @param {(event: { view: { from: string, to: string }, selection: { from: string, to: string }, unit: string,
   *   dragging: boolean, overflowDays: number }) => void} [options.onChange]
   *   Day keys. `dragging` is true while a gesture is in flight; the last event of a gesture has it false.
   *   `overflowDays` is non-zero when a zoom out asked for more time than the axis has.
   * @param {[number, string][]} [options.ramp]  Bar colours by value. Default `COUNT_RAMP`.
   * @param {string} [options.metricLabel]  What the bars count, for the hover label. Default "features".
   * @param {object} [options.theme]  Default `TIMELINE_THEME_DARK`.
   * @param {string} [options.prefix]  The prefix bucket columns carry in `setValues()`. Default `count_`.
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = options.onChange || (() => {});
    this.ramp = options.ramp || COUNT_RAMP;
    this.metricLabel = options.metricLabel || 'features';
    this.theme = { ...TIMELINE_THEME_DARK, ...options.theme };
    this.prefix = options.prefix ?? 'count_';

    this.axis = null;
    this.series = makeSeries([]);
    // Bucket ranges inside the axis that nothing loaded covers, as [from, to]
    // index pairs. Drawn hatched rather than as zero-height bars: a flat bar
    // says "nothing here", a different claim from "not loaded yet".
    this.gaps = [];
    this.domain = [0, 1];
    this.selection = { from: 0, to: 0 };
    this.hover = null;
    this.overflowDays = 0;

    this.width = 0;
    this.height = 0;
    this._frame = 0;
    this._drag = null;
    this._pointers = new Map();
    this._pinch = null;
    this._destroyed = false;

    canvas.style.touchAction = 'none'; // this owns pinch and drag
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;

    this._on = {
      wheel: (e) => this._onWheel(e),
      pointerdown: (e) => this._onDown(e),
      pointermove: (e) => this._onMove(e),
      pointerup: (e) => this._onUp(e),
      pointercancel: (e) => this._onUp(e),
      pointerleave: () => {
        this.hover = null;
        this.draw();
      },
      keydown: (e) => this._onKey(e),
    };
    for (const [type, fn] of Object.entries(this._on)) canvas.addEventListener(type, fn, type === 'wheel' ? { passive: false } : undefined);

    this._ro = globalThis.ResizeObserver ? new globalThis.ResizeObserver(() => this.resize()) : null;
    this._ro?.observe(canvas);
    this.resize();
  }

  destroy() {
    this._destroyed = true;
    for (const [type, fn] of Object.entries(this._on)) this.canvas.removeEventListener(type, fn);
    this._ro?.disconnect();
  }

  // ------------------------------------------------------------------ the axis

  /**
   * Give it an axis: `{ unit, min, max }`.
   *
   * `keep`: hold the same real dates in view and selected across the change
   * -- for when the unit under a view changes (days to months as it widens).
   * Says nothing through `onChange`: whoever called asked for it.
   */
  setAxis(decl, { keep = false } = {}) {
    const view = keep ? this.viewDays() : null;
    const selected = keep ? this.selectionDays() : null;
    this.axis = makeAxis(decl);
    this.series = makeSeries(new Float64Array(this.axis.count));
    this.gaps = [];
    if (view && selected) {
      this._placeView(view.from, view.to);
      this._placeSelection(selected.from, selected.to);
    } else {
      this._open(5, 100);
    }
    this.draw();
  }

  /**
   * Open on the most recent activity rather than the whole record: selecting
   * everything shows an average and hides every event in it, and leaves the
   * handles pinned to the frame. In real time, so it means the same on a
   * daily and a monthly axis.
   */
  openAt({ selectDays = 5, viewDays = 100 } = {}) {
    if (!this.axis) return;
    this._open(selectDays, viewDays);
    this._emit();
    this.draw();
  }

  _open(selectDays, viewDays) {
    const per = this.axis.unit === 'month' ? 30.44 : 1;
    const c = this.axis.count;
    const sel = Math.max(1, Math.round(selectDays / per));
    const win = Math.max(sel + 1, Math.round(viewDays / per));
    this.domain = clampDomain([c - win, c], c);
    this.selection = clampSelection({ from: c - sel, to: c - 1 }, this.axisBounds());
  }

  /** The bucket values: `{ key: value }`, keys bare or carrying the column prefix. */
  setValues(buckets) {
    if (!this.axis) return;
    this.series = seriesFromBuckets(this.axis, buckets, { prefix: this.prefix });
    this.draw();
  }

  /** Ranges of the axis that nothing loaded covers, as `[from, to]` bucket indices. */
  setGaps(ranges) {
    this.gaps = Array.isArray(ranges) ? ranges : [];
    this.draw();
  }

  setTheme(theme) {
    this.theme = { ...TIMELINE_THEME_DARK, ...theme };
    this.draw();
  }

  setRamp(ramp) {
    this.ramp = ramp || COUNT_RAMP;
    this.draw();
  }

  // ------------------------------------------------------- the view and selection

  /** Bucket range the person can drag a selection edge to: what is on screen. */
  bounds() {
    return this.axis ? domainBuckets(this.domain, this.axis.count) : [0, 0];
  }

  /**
   * Bucket range a selection must stay inside no matter what: the whole axis.
   * Panning and zooming leave the selection alone; re-clamping it to the view
   * would drag the filter along with it.
   */
  axisBounds() {
    return this.axis ? [0, this.axis.count - 1] : [0, 0];
  }

  _days(i0, i1) {
    const unit = this.axis.unit;
    return { from: dayRangeOfKey(this.axis.keyAt(i0), unit)[0], to: dayRangeOfKey(this.axis.keyAt(i1), unit)[1] };
  }

  /** What is on screen, as day keys: every day of every bucket the view touches. Null with no axis. */
  viewDays() {
    if (!this.axis) return null;
    const [i0, i1] = domainBuckets(this.domain, this.axis.count);
    return this._days(i0, i1);
  }

  /** What is selected, as day keys. Null with no axis. */
  selectionDays() {
    if (!this.axis) return null;
    return this._days(this.selection.from, this.selection.to);
  }

  _index(dayKey) {
    return this.axis.indexOf(bucketKeyOfDay(dayKey, this.axis.unit));
  }

  _placeView(from, to) {
    let a = this._index(from);
    let b = this._index(to);
    if (a > b) [a, b] = [b, a];
    this.domain = clampDomain([a, b + 1], this.axis.count);
  }

  _placeSelection(from, to) {
    let a = this._index(from);
    let b = this._index(to);
    if (a > b) [a, b] = [b, a];
    this.selection = clampSelection({ from: a, to: b }, this.axisBounds());
  }

  /** Show these days. Dates off the axis are brought onto it, keeping the span. */
  setViewDays(from, to) {
    if (!this.axis) return;
    this._placeView(from, to);
    this._emit();
    this.draw();
  }

  /**
   * Select these days. Reversed dates are swapped rather than refused: typing
   * the later date first is an ordinary way to fill two fields.
   */
  setSelectionDays(from, to) {
    if (!this.axis) return;
    this._placeSelection(from, to);
    this._emit();
    this.draw();
  }

  /** Show the last `n` buckets, for preset spans. */
  setSpan(n) {
    if (!this.axis) return;
    const c = this.axis.count;
    this.domain = clampDomain([c - n, c], c);
    this._emit();
    this.draw();
  }

  /** Fit the view to the selection, with a margin so the handles can be seen and grabbed. */
  fitToSelection() {
    if (!this.axis) return;
    const { from, to } = this.selection;
    const pad = Math.max(1, Math.round((to - from + 1) * FIT_MARGIN));
    this.domain = clampDomain([from - pad, to + 1 + pad], this.axis.count);
    this._emit();
    this.draw();
  }

  zoomAt(x, factor) {
    if (!this.axis) return;
    // Zooming out at full extent is how a person asks for more time than this
    // axis has. The clamp is right to refuse it, but the request -- and how
    // much was asked for -- is a signal, so it is recorded before it is lost.
    const span = this.domain[1] - this.domain[0];
    const over = factor < 1 && span >= this.axis.count;
    this.overflowDays = over ? Math.round(span / factor) * (this.axis.unit === 'month' ? 30.44 : 1) : 0;
    this.domain = zoomDomain(this.domain, x, this.width, factor, this.axis.count);
    this._emit();
    this.draw();
  }

  /** Zoom about the selection, not the middle of the track: the buttons are for a closer look at what is selected. */
  zoomBy(factor) {
    const mid = this.axis ? coordToX((this.selection.from + this.selection.to + 1) / 2, this.domain, this.width) : this.width / 2;
    this.zoomAt(Math.min(Math.max(mid, 0), this.width), factor);
  }

  /** The whole axis, in view. */
  showAll() {
    if (!this.axis) return;
    this.domain = [0, this.axis.count];
    this._emit();
    this.draw();
  }

  _follow() {
    const { from, to } = this.selection;
    let [lo, hi] = this.domain;
    if (to + 1 > hi) {
      lo += to + 1 - hi;
      hi = to + 1;
    }
    if (from < lo) {
      hi -= lo - from;
      lo = from;
    }
    this.domain = clampDomain([lo, hi], this.axis.count);
  }

  /**
   * Move the selection `n` buckets, taking the view with it when it would
   * leave. Returns false, and moves nothing, when it would go off the axis.
   */
  shift(n) {
    if (!this.axis) return false;
    const from = this.selection.from + n;
    const to = this.selection.to + n;
    if (from < 0 || to > this.axis.count - 1) return false;
    this.selection = { from, to };
    this._follow();
    this._emit();
    this.draw();
    return true;
  }

  /** Put the selection on the first buckets of the axis, at its present width. */
  toStart() {
    if (!this.axis) return;
    const width = this.selection.to - this.selection.from;
    this.selection = clampSelection({ from: 0, to: width }, this.axisBounds());
    this._follow();
    this._emit();
    this.draw();
  }

  resize() {
    const dpr = globalThis.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.width = Math.max(0, Math.round(r.width));
    this.height = Math.max(0, Math.round(r.height));
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // One paint per frame: wheel and pointermove fire far faster than the
  // display, and each paint walks the whole track.
  draw() {
    if (this._frame || this._destroyed) return;
    this._frame = raf(() => {
      this._frame = 0;
      if (!this._destroyed) this._paint();
    });
  }

  _emit() {
    if (!this.axis) return;
    this.onChange({
      view: this.viewDays(),
      selection: this.selectionDays(),
      unit: this.axis.unit,
      // True while a pointer gesture is in flight. A listener doing expensive
      // work can wait for the event that has it false, which always comes.
      dragging: this._drag !== null || this._pinch !== null,
      overflowDays: this.overflowDays || 0,
    });
  }

  // --------------------------------------------------------------------- paint

  _paint() {
    const { ctx, theme } = this;
    const W = this.width;
    const H = this.height;
    if (!(W > 0) || !(H > 0)) return;
    const trackH = Math.max(0, H - AXIS_H);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = theme.track;
    ctx.fillRect(0, 0, W, trackH);
    if (!this.axis) return;

    const cols = this._columns();
    const tk = ticks(this.axis, this.domain, W);

    // Gridlines first, so bars sit on top of them.
    for (const t of tk) {
      const x = Math.round(coordToX(t.index, this.domain, W)) + 0.5;
      ctx.strokeStyle = t.major ? theme.line : theme.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, trackH);
      ctx.stroke();
    }

    // Hatching goes down before the bars, so a span that is half loaded shows
    // its bars over the hatch rather than the hatch hiding them.
    for (const [g0, g1] of this.gaps) {
      const x0 = coordToX(g0, this.domain, W);
      const x1 = coordToX(g1 + 1, this.domain, W);
      if (x1 <= 0 || x0 >= W) continue;
      const a = Math.max(0, x0);
      const b = Math.min(W, x1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(a, 0, b - a, trackH);
      ctx.clip();
      ctx.strokeStyle = theme.hatch;
      ctx.lineWidth = 1;
      // 45 degrees, every 7px. Diagonal so it cannot be mistaken for the
      // vertical gridlines or for one-pixel bars.
      for (let x = a - trackH; x < b + trackH; x += 7) {
        ctx.beginPath();
        ctx.moveTo(x, trackH);
        ctx.lineTo(x + trackH, 0);
        ctx.stroke();
      }
      ctx.restore();
    }

    let max = 0;
    for (const c of cols) if (c.value > max) max = c.value;
    const body = trackH - 2;
    for (const c of cols) {
      if (c.value <= 0) continue;
      // A one-pixel floor: a bucket with one feature and a bucket with none
      // must not look the same.
      const h = Math.max(1, Math.round((c.value / max) * body));
      // Height is the column total, so the area under the bars is conserved
      // as pixel columns swallow more buckets. Colour is the per-bucket mean,
      // which does not change with zoom.
      const colour = rampColor(this.ramp, c.value / (c.i1 - c.i0 + 1));
      ctx.fillStyle = theme.liftBars ? liftForTrack(colour) : colour;
      ctx.fillRect(c.x, trackH - h - 1, c.w, h);
    }

    this._paintScale(trackH, max);
    this._paintSelection(trackH);

    ctx.strokeStyle = theme.line;
    ctx.strokeRect(0.5, 0.5, W - 1, trackH - 1);

    ctx.font = `10px ${FONT}`;
    ctx.textBaseline = 'top';
    for (const t of tk) {
      const x = coordToX(t.index, this.domain, W);
      // A tick exactly on the left edge is still worth labelling: it names
      // the year the axis starts in.
      if (x < 0 || x > W - 4) continue;
      ctx.fillStyle = t.major ? theme.text : theme.textDim;
      ctx.fillText(t.label, x + 3, trackH + 2);
    }

    if (this.hover !== null) this._paintHover(trackH, cols);
  }

  /**
   * The bars for the current domain: quantized over the whole buckets the
   * domain touches and positioned by the fractional domain, so a partly
   * visible bucket at either end is drawn in the right place and clipped.
   */
  _columns() {
    const W = this.width;
    const [i0, i1] = domainBuckets(this.domain, this.axis.count);
    const n = i1 - i0 + 1;
    const px = W / (this.domain[1] - this.domain[0]);
    const x0 = coordToX(i0, this.domain, W);
    const cols = quantize(n * px, n);
    for (const c of cols) {
      c.x += x0;
      c.i0 += i0;
      c.i1 += i0;
      c.value = sumRange(this.series, c.i0, c.i1);
    }
    return cols;
  }

  _selectionPixels() {
    const W = this.width;
    return [coordToX(this.selection.from, this.domain, W), coordToX(this.selection.to + 1, this.domain, W)];
  }

  /**
   * Where the two handles are grabbed and drawn. An edge scrolled off the
   * track is pinned flush to the frame rather than left unreachable.
   */
  _handlePixels() {
    const W = this.width;
    const [sx0, sx1] = this._selectionPixels();
    const pin = (sx, edge) => ({ x: Math.min(Math.max(sx, 0), W), edge, pinned: sx < 0 || sx > W });
    return [pin(sx0, 'from'), pin(sx1, 'to')];
  }

  _paintSelection(trackH) {
    const { ctx, theme } = this;
    const W = this.width;
    const [sx0, sx1] = this._selectionPixels();
    // Dim outside rather than tint inside: tinting shifts every bar colour and
    // the timeline stops agreeing with the map.
    ctx.fillStyle = theme.outside;
    if (sx0 > 0) ctx.fillRect(0, 0, Math.min(sx0, W), trackH);
    if (sx1 < W) ctx.fillRect(Math.max(sx1, 0), 0, W - Math.max(sx1, 0), trackH);

    const a = Math.max(0, Math.min(sx0, W));
    const b = Math.max(0, Math.min(sx1, W));
    // An outline too: dimming alone is invisible when the selection covers
    // the whole view.
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(a + 0.5, 0.5, Math.max(1, b - a - 1), trackH - 1);

    const gh = Math.min(22, Math.round(trackH * 0.55));
    const gy = Math.round((trackH - gh) / 2);
    for (const h of this._handlePixels()) {
      const inward = h.edge === 'from' ? 1 : -1;
      const x = Math.round(h.pinned ? h.x + (inward * HANDLE_W) / 2 : h.x);
      ctx.fillStyle = theme.accent;
      ctx.fillRect(x - HANDLE_W / 2, 0, HANDLE_W, trackH);
      // Two notches, the conventional "this is a grab handle" mark.
      ctx.fillStyle = theme.notch;
      ctx.fillRect(x - 2, gy, 1, gh);
      ctx.fillRect(x + 1, gy, 1, gh);
    }
  }

  /**
   * The vertical scale: two rules across the track, and what they are worth.
   *
   * The bars are normalised to the tallest one in view, which makes the shape
   * of a span readable whatever its size -- and hides something. When a busier
   * chunk loads, every bar already on screen shrinks to make room for the new
   * peak; with no number on the chart that reads as the data having gone
   * away. A peak label going from 38 to 222k is the rescale announcing itself.
   */
  _paintScale(trackH, max) {
    const { ctx, theme } = this;
    const W = this.width;
    if (!(max > 0) || trackH < 34) return;
    const body = trackH - 2;
    ctx.save();
    ctx.font = `9px ${FONT}`;
    ctx.textBaseline = 'bottom';
    for (const frac of [1, 0.5]) {
      const y = Math.round(trackH - 1 - frac * body) + 0.5;
      ctx.strokeStyle = frac === 1 ? theme.rule : theme.ruleHalf;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      const label = fmtNum(max * frac);
      const w = ctx.measureText(label).width;
      // Under its rule rather than over it when there is no room above: the
      // peak's rule sits a pixel and a half from the top.
      const above = y - 11 >= 0;
      ctx.setLineDash([]);
      ctx.fillStyle = theme.labelBack;
      ctx.fillRect(2, above ? y - 11 : y, w + 6, 11);
      ctx.fillStyle = frac === 1 ? theme.text : theme.textDim;
      ctx.fillText(label, 5, above ? y - 1 : y + 10);
    }
    ctx.restore();
  }

  _paintHover(trackH, cols) {
    const { ctx, theme } = this;
    const W = this.width;
    const i = bucketAt(this.hover, this.domain, W);
    if (i < 0 || i >= this.axis.count) return;
    ctx.fillStyle = theme.hover;
    ctx.fillRect(Math.round(this.hover), 0, 1, trackH);
    const col = cols.find((c) => i >= c.i0 && i <= c.i1);
    // When a pixel column covers several buckets the label names the range it
    // summed, so the number and the label agree.
    const unit = this.axis.unit;
    const span = col && col.i1 > col.i0 ? `${formatKey(this.axis.keyAt(col.i0), unit)} – ${formatKey(this.axis.keyAt(col.i1), unit)}` : formatKey(this.axis.keyAt(i), unit);
    const label = `${span}   ${fmtNum(col ? col.value : sumRange(this.series, i, i))} ${this.metricLabel}`;
    ctx.font = `10px ${FONT}`;
    const w = ctx.measureText(label).width + 10;
    const x = Math.min(Math.max(this.hover + 8, 2), W - w - 2);
    ctx.fillStyle = theme.tipBack;
    ctx.fillRect(x, 3, w, 15);
    ctx.strokeStyle = theme.line;
    ctx.strokeRect(x + 0.5, 3.5, w - 1, 14);
    ctx.fillStyle = theme.text;
    ctx.textBaseline = 'top';
    ctx.fillText(label, x + 5, 6);
  }

  // --------------------------------------------------------------- interaction

  _x(e) {
    return e.clientX - this.canvas.getBoundingClientRect().left;
  }

  _y(e) {
    return e.clientY - this.canvas.getBoundingClientRect().top;
  }

  /**
   * What a press grabs. Pan has to stay reachable at every zoom, so the label
   * strip always pans, and so does the inside of a selection whose handles are
   * both off the track.
   */
  hitTest(x, y) {
    if (y !== null && y !== undefined && y > this.height - AXIS_H) return 'pan';
    const [h0, h1] = this._handlePixels();
    if (Math.abs(x - h0.x) <= GRIP) return 'from';
    if (Math.abs(x - h1.x) <= GRIP) return 'to';
    if (x > h0.x && x < h1.x) return h0.pinned && h1.pinned ? 'pan' : 'body';
    return 'pan';
  }

  _onWheel(e) {
    if (!this.axis) return;
    e.preventDefault();
    // deltaMode is lines on Firefox and pages on some remotes; normalise or a
    // single notch zooms three orders of magnitude.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = (e.deltaY || 0) * unit;
    const dx = (e.deltaX || 0) * unit;
    // A two-finger swipe arrives as a wheel event carrying deltaX. Route it to
    // pan and leave deltaY to zoom -- but pick ONE per event: a swipe is never
    // perfectly horizontal. ctrl means pinch, however it is angled.
    if (!e.ctrlKey && Math.abs(dx) > Math.abs(dy)) {
      this.domain = panDomain(this.domain, -dx, this.width, this.axis.count);
      this._emit();
      this.draw();
      return;
    }
    this.zoomAt(this._x(e), Math.exp(-dy * (e.ctrlKey ? PINCH : WHEEL)));
  }

  _onDown(e) {
    if (!this.axis) return;
    this.canvas.focus();
    this._pointers.set(e.pointerId, this._x(e));
    // Capture after the pointer is registered: setPointerCapture throws for a
    // pointer the browser does not think is down, and a throw here must cost
    // only the capture, not the gesture.
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* uncaptured */
    }
    if (this._pointers.size === 2) {
      const [a, b] = [...this._pointers.values()];
      this._pinch = { dist: Math.abs(a - b) || 1 };
      this._drag = null;
      return;
    }
    const x = this._x(e);
    // Shift starts a fresh selection wherever the pointer is; a plain drag pans.
    const mode = e.shiftKey ? 'draw' : this.hitTest(x, this._y(e));
    if (mode === 'draw') {
      const i = bucketAt(x, this.domain, this.width);
      this.selection = clampSelection({ from: i, to: i }, this.bounds());
      this._drag = { mode, x, anchor: i, domain: this.domain.slice(), selection: { ...this.selection }, coord: 0 };
      this._emit();
      this.draw();
      return;
    }
    this._drag = {
      mode, x, edge: mode === 'from' || mode === 'to' ? mode : null,
      domain: this.domain.slice(), selection: { ...this.selection },
      coord: xToCoord(x, this.domain, this.width),
    };
  }

  _onMove(e) {
    if (!this.axis) return;
    const x = this._x(e);
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, x);

    if (this._pinch && this._pointers.size === 2) {
      const [a, b] = [...this._pointers.values()];
      const dist = Math.abs(a - b) || 1;
      this.zoomAt((a + b) / 2, dist / this._pinch.dist);
      this._pinch.dist = dist;
      return;
    }

    const d = this._drag;
    this.hover = x;
    if (!d) {
      const hit = this.hitTest(x, this._y(e));
      this.canvas.style.cursor = hit === 'from' || hit === 'to' ? 'ew-resize' : hit === 'body' ? 'grab' : 'default';
      this.draw();
      return;
    }
    if (d.mode === 'draw') {
      // Dragging either way from the anchor is normal: order the pair.
      const i = bucketAt(x, this.domain, this.width);
      const [lo, hi] = i < d.anchor ? [i, d.anchor] : [d.anchor, i];
      this.selection = clampSelection({ from: lo, to: hi }, this.bounds());
    } else if (d.mode === 'pan') {
      this.domain = panDomain(d.domain, x - d.x, this.width, this.axis.count);
    } else if (d.mode === 'body') {
      const delta = Math.round(xToCoord(x, this.domain, this.width) - d.coord);
      this.selection = moveSelection(d.selection, delta, this.bounds());
    } else {
      const r = resizeSelection(this.selection, d.edge, bucketAt(x, this.domain, this.width), this.bounds());
      d.edge = r.edge;
      this.selection = { from: r.from, to: r.to };
    }
    this._emit();
    this.draw();
  }

  _onUp(e) {
    const was = this._drag !== null || this._pinch !== null;
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinch = null;
    if (this._pointers.size === 0) this._drag = null;
    // One more event when the gesture ends. Every event during a drag says
    // `dragging: true`, and without this there was never one that said false
    // -- so a listener waiting for the gesture to finish waited for ever.
    if (was && this._pointers.size === 0) this._emit();
  }

  _onKey(e) {
    if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      this.fitToSelection();
      return;
    }
    if (!this.axis) return;
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    if (e.shiftKey) {
      const to = Math.max(this.selection.from, this.selection.to + step);
      this.selection = clampSelection({ from: this.selection.from, to }, this.bounds());
    } else {
      this.selection = moveSelection(this.selection, step, this.bounds());
    }
    this._emit();
    this.draw();
  }
}
