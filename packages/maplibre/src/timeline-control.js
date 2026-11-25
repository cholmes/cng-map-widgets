// @cngeo/maplibre -- TimelineControl: a histogram of time under the map.
//
// A MapLibre IControl across the bottom of the map: a canvas track of what
// the map holds over time, a draggable selection that decides what the map
// draws, spans to jump to, two date inputs, and play / pause.
//
// It drives ONE timeline layer in a LayerManager (`kind: 'timeline'`), which
// it can add itself. Everything it decides lives elsewhere and is tested
// there: which chunks load and draw (`@cngeo/timeline`'s chunk set, through
// the layer's session), the track (`TimelineCanvas`), playback
// (`createPlayback`), and what the panel says (`timeline-model.js`). This
// file is wiring and DOM; a browser checks it (examples/timeline-firms).
//
// Remote text (a layer's title, an error's words) reaches the DOM through
// `textContent` only.

import { timelineStatusOf, presetsFor, inputsFor, trackNews, unboundStatus, liveness } from './timeline-model.js';
import { TOKENS_LIGHT, TOKENS_DARK } from './layer-control-theme.js';

const CSS = `
.cng-timeline {${TOKENS_LIGHT}
  color-scheme: light dark; font: 12px/1.3 system-ui, sans-serif; color: var(--cng-ink); background: var(--cng-bg);
  border-radius: 4px; box-shadow: 0 0 0 1px var(--cng-border), 0 2px 10px var(--cng-shadow);
  box-sizing: border-box; padding: 6px 8px 4px; display: flex; flex-direction: column; gap: 4px;
  width: 320px; /* then the map's own width; see _fit() */
}
@media (prefers-color-scheme: dark) { .cng-timeline {${TOKENS_DARK} } }
/* \`theme: 'dark' | 'light'\` says it outright, whatever the system prefers: the track is a canvas and cannot follow a media query. */
.cng-timeline.is-light {${TOKENS_LIGHT} color-scheme: light; }
.cng-timeline.is-dark {${TOKENS_DARK} color-scheme: dark; }
.cng-timeline * { box-sizing: border-box; }
.cng-tl-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.cng-tl-title { font-weight: 600; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cng-tl-group { display: inline-flex; align-items: center; gap: 2px; }
.cng-timeline button, .cng-timeline select, .cng-timeline input {
  font: inherit; color: var(--cng-ink); background: var(--cng-bg); border: 1px solid var(--cng-border); border-radius: 3px; padding: 1px 6px; min-height: 22px;
}
.cng-timeline button { cursor: pointer; }
.cng-timeline button:hover { background: var(--cng-selected-bg); }
.cng-timeline button[aria-pressed="true"] { background: var(--cng-focus); color: var(--cng-on-focus); border-color: var(--cng-focus); }
.cng-timeline button:disabled { color: var(--cng-meta); cursor: default; }
.cng-timeline :focus-visible { outline: 2px solid var(--cng-focus); outline-offset: 1px; }
.cng-tl-play { min-width: 58px; font-weight: 600; }
.cng-tl-status { flex: 1 1 200px; min-width: 0; text-align: right; color: var(--cng-meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cng-tl-status.is-error { color: var(--cng-error); }
.cng-tl-progress { color: var(--cng-meta); font-variant-numeric: tabular-nums; }
.cng-tl-progress:empty, .cng-tl-retry[hidden] { display: none; }
.cng-tl-canvas { display: block; width: 100%; height: 64px; border-radius: 2px; }
.cng-tl-sep { color: var(--cng-meta); }
/* The attribution moves up to sit above the timeline rather than under it. */
.cng-has-timeline .maplibregl-ctrl-bottom-right { bottom: calc(var(--cng-timeline-height, 110px) + 12px); }
`;

function injectCss(doc) {
  if (!doc || doc.getElementById('cng-timeline-css')) return;
  const style = doc.createElement('style');
  style.id = 'cng-timeline-css';
  style.textContent = CSS;
  doc.head.appendChild(style);
}

const SPEEDS = [0.5, 1, 2, 4, 8, 16];

export class TimelineControl {
  /**
   * @param {Object} options
   * @param {import('./layer-manager.js').LayerManager} options.manager
   * @param {string|object} options.layer  The id of a timeline layer in the manager, or a `LayerSpec` to add.
   * @param {string} [options.metricLabel]  What the bars count: "detections". Default "features".
   * @param {boolean} [options.autoplay]    Start playing. Default false; never with reduced motion asked for.
   * @param {number} [options.speed]        Steps a second. Default 4.
   * @param {boolean} [options.loop]        Default false.
   * @param {'auto'|'dark'|'light'} [options.theme]  The track's colours. Default follows the system.
   */
  constructor(options = {}) {
    if (!options.manager || !options.layer) throw new TypeError('TimelineControl needs a LayerManager and a timeline layer: new TimelineControl({ manager, layer })');
    this._options = options;
    this._manager = options.manager;
    this._layerId = typeof options.layer === 'string' ? options.layer : options.layer.id;
    this._metric = options.metricLabel ?? 'features';
    /** The layer's session, once it is on the map. */
    this.session = null;
    /** Resolves when the timeline is bound to its layer (or could not be). */
    this.ready = Promise.resolve();
    this._cleanup = [];
    this._bound = [];
    this._said = {};
    /** What the track last showed: `{ view, selection, dragging }`, the baseline for `trackNews`. */
    this._shown = null;
  }

  getDefaultPosition() {
    return 'bottom-left';
  }

  onAdd(map) {
    this._map = map;
    const doc = (this._doc = map.getContainer().ownerDocument);
    const win = (this._win = doc.defaultView);
    injectCss(doc);
    this._said = {};

    const root = (this._root = this._el('div', 'maplibregl-ctrl cng-timeline'));
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Timeline');
    const bar = this._el('div', 'cng-tl-bar');
    this._title = this._el('span', 'cng-tl-title');

    // Play, and how fast.
    const playGroup = this._el('span', 'cng-tl-group');
    this._play = this._button('Play', () => this._playback?.toggle());
    this._play.classList.add('cng-tl-play');
    this._play.setAttribute('aria-pressed', 'false');
    this._speed = this._el('select');
    this._speed.setAttribute('aria-label', 'Playback speed');
    this._speed.addEventListener('change', () => this._playback?.setSpeed(Number(this._speed.value)));
    const back = this._button('‹', () => this._playback?.stepBy(-1), 'Step back');
    const forward = this._button('›', () => this._playback?.stepBy(1), 'Step forward');
    playGroup.append(back, this._play, forward, this._speed);

    // The view: spans, zoom, fit.
    this._presets = this._el('span', 'cng-tl-group');
    this._presets.setAttribute('aria-label', 'Show');
    const zoom = this._el('span', 'cng-tl-group');
    zoom.append(
      this._button('−', () => this._canvas?.zoomBy(0.5), 'Zoom out in time'),
      this._button('+', () => this._canvas?.zoomBy(2), 'Zoom in in time'),
      this._button('Fit', () => this._canvas?.fitToSelection(), 'Fit the view to the selection'),
    );

    // The selection, as two dates.
    const dates = this._el('span', 'cng-tl-group');
    this._from = this._el('input');
    this._to = this._el('input');
    this._from.setAttribute('aria-label', 'Selection from');
    this._to.setAttribute('aria-label', 'Selection to');
    for (const input of [this._from, this._to]) input.addEventListener('change', () => this._onDates());
    dates.append(this._from, this._el('span', 'cng-tl-sep', '–'), this._to);

    this._progress = this._el('span', 'cng-tl-progress');
    this._retry = this._button('Retry', () => {
      for (const f of this.session?.state.failed ?? []) this.session.retry(f.id);
    });
    this._retry.classList.add('cng-tl-retry');
    this._retry.hidden = true;
    this._status = this._el('span', 'cng-tl-status', 'Loading…');
    this._status.setAttribute('role', 'status');
    this._status.setAttribute('aria-live', 'polite');
    bar.append(this._title, playGroup, this._presets, zoom, dates, this._retry, this._progress, this._status);

    this._canvasEl = this._el('canvas', 'cng-tl-canvas');
    // A role, or a screen reader has nothing to hang the label on. The date
    // inputs and the step buttons beside it do the same job without a pointer.
    this._canvasEl.setAttribute('role', 'application');
    this._canvasEl.setAttribute('aria-label', 'Timeline. Arrow keys move the selection; shift and arrow keys resize it; F fits the view to it.');
    root.append(bar, this._canvasEl);

    // As wide as the map, and the attribution lifted above it.
    this._fit = () => {
      const width = map.getContainer().clientWidth;
      if (width > 0) root.style.width = `${Math.max(240, width - 20)}px`;
      map.getContainer().style.setProperty('--cng-timeline-height', `${root.offsetHeight || 110}px`);
      this._canvas?.resize();
    };
    map.getContainer().classList.add('cng-has-timeline');
    map.on('resize', this._fit);
    const dark = win.matchMedia?.('(prefers-color-scheme: dark)');
    const onScheme = () => this._applyTheme();
    dark?.addEventListener?.('change', onScheme);
    // The layer may be removed, or put back, behind this control.
    const offManager = this._manager.on('change', (event) => {
      if (event?.id !== this._layerId) return;
      const session = this._manager.handle(this._layerId);
      if (session !== this.session) this._attach(session);
    });
    this._cleanup.push(() => {
      map.off('resize', this._fit);
      dark?.removeEventListener?.('change', onScheme);
      offManager?.();
      map.getContainer().classList.remove('cng-has-timeline');
      map.getContainer().style.removeProperty('--cng-timeline-height');
    });

    this._applyTheme();
    this.ready = this._start();
    win.requestAnimationFrame?.(() => this._fit?.());
    return root;
  }

  onRemove() {
    this._detach();
    for (const off of this._cleanup.splice(0)) off();
    this._root?.remove();
    this._map = null;
    this._fit = null;
  }

  play() {
    this._playback?.play();
  }

  pause() {
    this._playback?.pause();
  }

  /** True while it is playing. */
  get playing() {
    return Boolean(this._playback?.state.playing);
  }

  // --- internals ------------------------------------------------------------------------

  _el(tag, className = '', text) {
    const node = this._doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  _button(text, onClick, label) {
    const button = this._el('button', '', text);
    button.type = 'button';
    if (label) {
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    button.addEventListener('click', onClick);
    return button;
  }

  _say(line, tone = 'info') {
    // Written only when the words change: it is a live region.
    if (this._said.line !== line) this._status.textContent = line;
    if (this._said.tone !== tone) this._status.classList.toggle('is-error', tone === 'error');
    this._status.title = line;
    this._said = { line, tone };
  }

  /** Add the layer if it was given as a spec, then bind to it. Never rejects: a failure is said in the panel. */
  async _start() {
    const map = this._map;
    try {
      const given = this._options.layer;
      if (typeof given === 'object' && !this._manager.get(given.id)) await this._manager.add(given);
      if (this._map !== map) return; // removed while the layer was loading
      const session = this._manager.handle(this._layerId);
      if (!session) {
        const said = unboundStatus(this._manager.get(this._layerId), this._layerId);
        this._say(said.line, said.tone);
        return;
      }
      this._attach(session);
    } catch (error) {
      if (this._map === map) this._say(error?.message ?? String(error), 'error');
    }
  }

  _detach() {
    for (const off of this._bound.splice(0)) off();
    this._playback?.destroy();
    this._canvas?.destroy();
    this._playback = null;
    this._canvas = null;
    this.session = null;
    this._shown = null;
    // Nothing to retry, and no tiles to count, without a session.
    if (this._retry) this._retry.hidden = true;
    if (this._progress) this._progress.textContent = '';
    this._status?.setAttribute('aria-live', 'polite');
  }

  _attach(session) {
    this._detach();
    if (!session || !this._map) {
      // What the layer manager knows: a layer that failed is on the map, as
      // an error, and its own message is the thing to say.
      if (this._root) {
        const said = unboundStatus(this._manager.get(this._layerId), this._layerId);
        this._say(said.line, said.tone);
      }
      return;
    }
    const T = session.timeline;
    this.session = session;
    this._title.textContent = session.title ?? '';
    this._axisKey = '';
    this._applying = false;
    this._shown = null;

    this._canvas = new T.TimelineCanvas(this._canvasEl, {
      metricLabel: this._metric,
      prefix: session.source?.aggregate?.prefix,
      onChange: (event) => {
        if (this._applying) return;
        // Only what the track CHANGED goes to the session, whose dates are
        // exact where the track's are whole buckets (see `trackNews`).
        const news = trackNews(this._shown, event);
        this._shown = { view: event.view, selection: event.selection, dragging: event.dragging };
        if (news.view) session.setView(event.view, { dragging: event.dragging });
        if (news.selection) session.setSelection(event.selection);
      },
    });
    this._applyTheme();

    const reducedMotion = Boolean(this._win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    this._playback = T.createPlayback({
      step: (direction) => (direction === 'restart' ? (this._canvas.toStart(), true) : this._canvas.shift(direction)),
      // Hold while the chunk the selection is moving into is still arriving.
      ready: () => {
        const s = session.state;
        return s.pending.length === 0 && s.outgoing.length === 0;
      },
      speed: this._options.speed ?? 4,
      loop: this._options.loop ?? false,
      reducedMotion,
    });
    const speeds = SPEEDS.filter((s) => !reducedMotion || s <= 1);
    this._speed.replaceChildren(...speeds.map((s) => new this._win.Option(`${s}×`, String(s))));
    this._speed.value = String(this._playback.state.speed);
    if (this._speed.selectedIndex < 0) this._speed.selectedIndex = speeds.length - 1;
    const onPlayback = (state) => {
      this._play.textContent = state.playing ? 'Pause' : 'Play';
      this._play.setAttribute('aria-pressed', String(state.playing));
      // Not announced step by step; what it says when it stops, is.
      this._status.setAttribute('aria-live', liveness(state));
    };
    this._bound.push(this._playback.on('change', onPlayback));
    onPlayback(this._playback.state);

    this._bound.push(session.on('change', (state) => this._sync(state)));
    // Tile progress is not an event: look while something is loading.
    const tick = this._win.setInterval(() => this._renderProgress(), 500);
    this._bound.push(() => this._win.clearInterval(tick));

    this._sync(session.state);
    this._fit?.();
    if (this._options.autoplay && !reducedMotion) this._playback.play();
  }

  /** The panel and its track in one scheme: the system's, unless `theme` says which. */
  _applyTheme() {
    if (!this._root) return;
    const wanted = this._options.theme ?? 'auto';
    const dark = wanted === 'dark' || (wanted === 'auto' && Boolean(this._win.matchMedia?.('(prefers-color-scheme: dark)').matches));
    this._root.classList.toggle('is-dark', wanted === 'dark');
    this._root.classList.toggle('is-light', wanted === 'light');
    const T = this.session?.timeline;
    if (T && this._canvas) this._canvas.setTheme(dark ? T.TIMELINE_THEME_DARK : T.TIMELINE_THEME_LIGHT);
  }

  /** Bring the track and the panel in line with the session. */
  _sync(state) {
    const canvas = this._canvas;
    if (!canvas || !state.axis) return;
    const T = this.session.timeline;
    const key = `${state.axis.unit}|${state.axis.min}|${state.axis.max}`;
    if (key !== this._axisKey) {
      this._axisKey = key;
      const unit = state.axis.unit;
      // A new axis -- the first, or the other unit. The SESSION's dates are
      // the exact ones (the track's are whole buckets), so the track takes
      // them from there: a five-day selection that went out to months comes
      // back as the same five days.
      this._applying = true;
      try {
        canvas.setAxis(state.axis);
        if (state.view) canvas.setViewDays(state.view.from, state.view.to);
        if (state.selection) canvas.setSelectionDays(state.selection.from, state.selection.to);
      } finally {
        this._applying = false;
      }
      // What the track now shows is the baseline its next event is read against.
      this._shown = { view: canvas.viewDays(), selection: canvas.selectionDays(), dragging: false };
      this._renderPresets(state);
      // Where the new axis cannot hold them -- a monthly record that ends
      // before the days that were selected -- the track shows the nearest it
      // can, and the session is told, so the map draws what the track says.
      const whole = (w) => ({ from: T.dayRangeOfKey(T.bucketKeyOfDay(w.from, unit), unit)[0], to: T.dayRangeOfKey(T.bucketKeyOfDay(w.to, unit), unit)[1] });
      const same = (a, b) => a.from === b.from && a.to === b.to;
      const selected = canvas.selectionDays();
      const viewed = canvas.viewDays();
      if (state.selection && !same(whole(state.selection), selected)) this.session.setSelection(selected);
      if (state.view && !same(whole(state.view), viewed)) this.session.setView(viewed);
    }
    canvas.setValues(state.histogram);
    canvas.setGaps(state.gaps);
    // The bars count a whole view of cells where a cell on the map counts
    // one: the same ramp, stretched to the tallest bar.
    const stops = Array.isArray(this.session.source?.stops) ? this.session.source.stops : T.COUNT_RAMP;
    const peak = Math.max(0, ...Object.values(state.histogram ?? {}));
    const top = stops[stops.length - 1][0];
    canvas.setRamp(peak > top ? stops.map(([threshold, colour]) => [(threshold * peak) / top, colour]) : stops);

    const said = timelineStatusOf(state, { timeline: T, metricLabel: this._metric });
    this._say(said.line, said.tone);
    this._retry.hidden = !state.failed.length;
    this._renderInputs(state);
    this._renderProgress();
  }

  _renderProgress() {
    const state = this.session?.state;
    if (!state) return;
    const loading = state.partial || state.pending.length > 0;
    const tiles = loading ? this.session.tiles?.() : null;
    const text = tiles && tiles.selected > 0 && tiles.loaded < tiles.selected ? `${tiles.loaded}/${tiles.selected} tiles` : '';
    if (this._progress.textContent !== text) this._progress.textContent = text;
  }

  _renderPresets(state) {
    const T = this.session.timeline;
    const buttons = presetsFor(state.axis, T).map((preset) =>
      this._button(preset.label, () => {
        if (preset.buckets === null) this._canvas?.showAll();
        else this._canvas?.setSpan(preset.buckets);
      }),
    );
    this._presets.replaceChildren(...buttons);
  }

  _renderInputs(state) {
    const inputs = inputsFor(state, this.session.timeline);
    if (!inputs) return;
    for (const [input, value] of [[this._from, inputs.from], [this._to, inputs.to]]) {
      if (input.type !== inputs.type) input.type = inputs.type;
      input.min = inputs.min;
      input.max = inputs.max;
      // Not while it is being typed in: the selection it drives would write back over the typing.
      if (this._doc.activeElement !== input && input.value !== value) input.value = value;
    }
  }

  _onDates() {
    const session = this.session;
    const canvas = this._canvas;
    if (!session || !canvas?.axis) return;
    const T = session.timeline;
    const unit = canvas.axis.unit;
    const from = T.isoToKey(this._from.value, unit);
    const to = T.isoToKey(this._to.value, unit);
    if (!from || !to) return; // half typed
    const [a, b] = from <= to ? [from, to] : [to, from];
    canvas.setSelectionDays(T.dayRangeOfKey(a, unit)[0], T.dayRangeOfKey(b, unit)[1]);
    const view = canvas.viewDays();
    const selected = canvas.selectionDays();
    if (selected.from < view.from || selected.to > view.to) canvas.fitToSelection();
  }
}
