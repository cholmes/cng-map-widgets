// @cng/maplibre -- GeocoderControl (design doc §5.1, §5.2).
//
// An accessible combobox (ARIA 1.2 combobox-with-listbox pattern):
// <input role="combobox" aria-expanded aria-controls aria-activedescendant>
// + <ul role="listbox"><li role="option"></li></ul>, arrow/enter/escape,
// debounce, loading/empty/error states, the design-call-#11 attribution
// line, matched-text highlighting, friendly level labels, two-wave merge
// (no flicker/selection-jump), IME composition gating, adaptive debounce,
// and dark-mode-friendly CSS tokens. The pure decision logic for all of
// that lives in ./combobox-helpers.js so it's unit-testable without a
// DOM; this file is DOM + event wiring only.
//
// What this adapter does NOT do (design doc §5.1): fetch an index, rank
// results, simplify geometry, or construct an Area by hand -- all of
// that stays inside the `Geocoder` instance it holds.

import { normalizeName } from '@cng/spec';
import { addAreaLayer } from './area-layer.js';
import { viewportProvider } from './viewport.js';
import {
  splitMatchHighlight,
  friendlyLevelLabel,
  diffResultsForMerge,
  CompositionGate,
  adaptiveDebounceMs,
} from './combobox-helpers.js';
import { upgradeNoticeReducer, describeUpgradeNotice, HIDDEN_NOTICE_STATE } from './upgrade-notice.js';

let instanceCounter = 0;

// How long the transient "Full detail loaded."/"Keeping simplified
// outline." notice stays up before auto-hiding -- same order of magnitude
// as `_announceGrew`'s moreBadge timeout below, for the same reason: long
// enough to read, short enough not to linger over the next interaction.
const UPGRADE_NOTICE_AUTO_HIDE_MS = 2600;

/**
 * Schedule `fn` off this synchronous event-handler frame (design doc
 * §1.3/§3.2 amendment, "upgradeDisplay" jank mitigation -- see the
 * `'area:upgraded'` handler in `onAdd` for why). `requestIdleCallback` in
 * a browser; `setTimeout(fn, 0)` anywhere that lacks it (older browsers,
 * `node --test`). Mirrors geocoder-core's own `scheduleIdle`
 * (geocoder.js) exactly, duplicated rather than imported: this package
 * does not depend on geocoder-core's internals, only its public events.
 * @param {() => void} fn
 */
function scheduleIdle(fn) {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(fn, { timeout: 500 });
  } else {
    setTimeout(fn, 0);
  }
}

// Dark mode (prefers-color-scheme): every color is a custom property on
// `.cnmw-geocoder`. A host page overrides any `--cnmw-*` token by
// redeclaring it on an ancestor (inherited) or on `.cnmw-geocoder` with
// higher cascade priority; nothing below reads a computed value.
const CSS = `
.cnmw-geocoder, .cnmw-attribution-ctrl {
  --cnmw-bg: #fff; --cnmw-ink: #1a1a1a; --cnmw-border: #ccc; --cnmw-focus: #1a73e8;
  --cnmw-meta: #666; --cnmw-selected-bg: #e8f0fe; --cnmw-highlight-ink: inherit;
  --cnmw-highlight-bg: #fff3b0; --cnmw-shadow: rgba(0,0,0,0.15); --cnmw-error: #b3261e;
  --cnmw-error-bg: #fdecea; --cnmw-badge-bg: #f1f1ef; --cnmw-badge-ink: #777;
  position: relative; font: 13px/1.4 system-ui, sans-serif; color: var(--cnmw-ink); color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  .cnmw-geocoder, .cnmw-attribution-ctrl {
    --cnmw-bg: #1e1f22; --cnmw-ink: #e8e8e6; --cnmw-border: #46484d; --cnmw-focus: #7ab2f5;
    --cnmw-meta: #a3a3a0; --cnmw-selected-bg: #2a3a52; --cnmw-highlight-bg: #5a4a12;
    --cnmw-shadow: rgba(0,0,0,0.5); --cnmw-error: #ff8a80; --cnmw-error-bg: #3a2323;
    --cnmw-badge-bg: #2d2f33; --cnmw-badge-ink: #b0b0ac;
  }
}
.cnmw-geocoder input[role="combobox"] {
  width: 260px; padding: 8px 10px; border: 1px solid var(--cnmw-border); border-radius: 4px;
  font: inherit; box-sizing: border-box; background: var(--cnmw-bg); color: var(--cnmw-ink);
}
.cnmw-geocoder input[role="combobox"]:focus { outline: 2px solid var(--cnmw-focus); outline-offset: -1px; }
.cnmw-geocoder .cnmw-listbox {
  position: absolute; top: 100%; left: 0; right: 0; margin: 2px 0 0; padding: 2px; list-style: none;
  background: var(--cnmw-bg); border: 1px solid var(--cnmw-border); border-radius: 4px;
  max-height: 260px; overflow-y: auto; box-shadow: 0 2px 8px var(--cnmw-shadow); z-index: 10;
}
.cnmw-geocoder .cnmw-listbox[hidden] { display: none; }
.cnmw-geocoder .cnmw-option { padding: 6px 8px; border-radius: 3px; cursor: pointer; }
.cnmw-geocoder .cnmw-option[aria-selected="true"] { background: var(--cnmw-selected-bg); }
.cnmw-geocoder .cnmw-option-new { animation: cnmw-fade-in 0.6s ease-out; }
@keyframes cnmw-fade-in { from { background: var(--cnmw-selected-bg); } to { background: transparent; } }
.cnmw-geocoder .cnmw-option-name { font-weight: 500; }
.cnmw-geocoder mark.cnmw-match { background: var(--cnmw-highlight-bg); color: var(--cnmw-highlight-ink); border-radius: 2px; padding: 0 1px; }
.cnmw-geocoder .cnmw-alt-badge, .cnmw-geocoder .cnmw-raw-badge {
  font-size: 10px; color: var(--cnmw-badge-ink); background: var(--cnmw-badge-bg);
  border-radius: 3px; padding: 1px 4px; margin-left: 4px; vertical-align: middle;
}
.cnmw-geocoder .cnmw-option-meta { color: var(--cnmw-meta); font-size: 11px; margin-left: 6px; }
.cnmw-geocoder .cnmw-more { color: var(--cnmw-meta); cursor: default; }
.cnmw-geocoder .cnmw-empty, .cnmw-geocoder .cnmw-loading, .cnmw-geocoder .cnmw-searching { padding: 8px; color: var(--cnmw-meta); }
.cnmw-geocoder .cnmw-fuzzy-note {
  padding: 4px 8px 5px; color: var(--cnmw-meta); font-size: 11px; font-style: italic; cursor: default;
  border-bottom: 1px solid var(--cnmw-border); margin-bottom: 2px;
}
.cnmw-geocoder .cnmw-error {
  padding: 8px; color: var(--cnmw-error); background: var(--cnmw-error-bg);
  display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: default;
}
.cnmw-geocoder .cnmw-retry {
  font: inherit; font-size: 11px; color: inherit; background: transparent; border: 1px solid currentColor;
  border-radius: 3px; padding: 2px 8px; cursor: pointer; flex: none;
}
.cnmw-geocoder .cnmw-spinner {
  display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px;
  border: 2px solid var(--cnmw-border); border-top-color: var(--cnmw-focus); border-radius: 50%;
  animation: cnmw-spin 0.8s linear infinite;
}
@keyframes cnmw-spin { to { transform: rotate(360deg); } }
.cnmw-geocoder .cnmw-more-badge { font-size: 11px; color: var(--cnmw-meta); margin-top: 2px; }
.cnmw-geocoder .cnmw-more-badge[hidden] { display: none; }
/* Compact attribution (2026-11-13): a bottom-left ⓘ toggle + pill on the
   map itself, modeled on MapLibre's own compact attribution control --
   replaces the old full-width text line that ran over the map. The host
   lives in MapLibre's bottom-left control corner so corner stacking is
   handled for us; bottom-right is MapLibre's own attribution. */
/* Column layout, pill above the ⓘ: expanding upward keeps the pill off
   whatever page chrome sits along the bottom edge (status bars etc.). */
.cnmw-attribution-ctrl { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.cnmw-attribution-toggle {
  width: 24px; height: 24px; border-radius: 50%; flex: none; cursor: pointer;
  font: 700 13px/1 Georgia, 'Times New Roman', serif; font-style: italic;
  color: var(--cnmw-meta); background: var(--cnmw-bg); border: 1px solid var(--cnmw-border);
  box-shadow: 0 1px 4px var(--cnmw-shadow); padding: 0;
}
.cnmw-attribution-toggle:hover, .cnmw-attribution-toggle:focus { color: var(--cnmw-ink); }
.cnmw-attribution-toggle:focus { outline: 2px solid var(--cnmw-focus); outline-offset: 1px; }
.cnmw-attribution-ctrl .cnmw-attribution {
  font-size: 11px; color: var(--cnmw-meta); background: var(--cnmw-bg);
  border: 1px solid var(--cnmw-border); border-radius: 12px; box-shadow: 0 1px 4px var(--cnmw-shadow);
  padding: 4px 10px; max-width: min(70vw, 480px); overflow-wrap: break-word;
}
.cnmw-attribution-ctrl .cnmw-attribution[hidden] { display: none; }
.cnmw-attribution a { color: inherit; }
.cnmw-geocoder .cnmw-sharealike { font-size: 9px; border: 1px solid var(--cnmw-border); border-radius: 2px; padding: 0 3px; margin-left: 2px; }
@media (prefers-reduced-motion: reduce) { .cnmw-geocoder .cnmw-option-new { animation: none; } }
.cnmw-geocoder .cnmw-upgrade-notice {
  margin-top: 4px; padding: 4px 6px; border-radius: 4px; background: var(--cnmw-badge-bg); color: var(--cnmw-meta);
  font-size: 11px; display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.cnmw-geocoder .cnmw-upgrade-notice[hidden] { display: none; }
.cnmw-geocoder .cnmw-upgrade-notice-cancel {
  font: inherit; font-size: 13px; line-height: 1; color: inherit; background: transparent; border: none;
  cursor: pointer; padding: 0 2px; border-radius: 2px; flex: none;
}
.cnmw-geocoder .cnmw-upgrade-notice-cancel[hidden] { display: none; }
.cnmw-geocoder .cnmw-upgrade-notice-cancel:hover, .cnmw-geocoder .cnmw-upgrade-notice-cancel:focus { color: var(--cnmw-ink); }
.cnmw-geocoder .cnmw-upgrade-notice-cancel:focus { outline: 2px solid var(--cnmw-focus); outline-offset: -1px; }
`;

function injectCssOnce() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('cnmw-geocoder-style')) return;
  const style = document.createElement('style');
  style.id = 'cnmw-geocoder-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function debounce(fn, msProvider) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    const ms = typeof msProvider === 'function' ? msProvider() : msProvider;
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Attribution text/url come from the loaded manifest (fetched, not
// authored on this page) -- escape before innerHTML.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Default option rendering: matched-prefix highlighting (the alt-row
 * case too -- `r.name` already *is* the matched variant, e.g. "Zürech"),
 * a friendly level label next to the compact raw `ADM{n}` badge, and a
 * non-interactive "(+N more)" for a collapsed-duplicate group's
 * `moreCount`. Non-interactive because `applyDiversity`/
 * `dedupeByNameCountryLevel` in geocoder-core discard the collapsed rows
 * entirely -- there's nothing to expand into without a core change (see
 * this package's UX-polish report).
 */
function renderDefaultOption(li, r, queryNorm) {
  const nameEl = document.createElement('span');
  nameEl.className = 'cnmw-option-name';
  const segments = splitMatchHighlight(r.name, queryNorm, r.rank?.matchClass);
  for (const seg of segments) {
    if (seg.matched) {
      const mark = document.createElement('mark');
      mark.className = 'cnmw-match';
      mark.textContent = seg.text;
      nameEl.appendChild(mark);
    } else {
      nameEl.appendChild(document.createTextNode(seg.text));
    }
  }
  if (r.rank?.isAlt) {
    const altBadge = document.createElement('span');
    altBadge.className = 'cnmw-alt-badge';
    // r.primaryName: forward-compat hook, not populated by any shipped
    // geocoder-core yet (see report).
    altBadge.title = r.primaryName ? `Matched the alternate name "${r.name}" for ${r.primaryName}` : 'Matched an alternate name/spelling';
    altBadge.textContent = 'alt';
    nameEl.appendChild(document.createTextNode(' '));
    nameEl.appendChild(altBadge);
  }

  const meta = document.createElement('span');
  meta.className = 'cnmw-option-meta';
  const context = r.parentName ?? r.countryName;
  const friendly = friendlyLevelLabel(r.level, r.class);
  const parts = [context, r.country, friendly].filter(Boolean);
  meta.appendChild(document.createTextNode(`— ${parts.join(' · ')} `));
  const rawBadge = document.createElement('span');
  rawBadge.className = 'cnmw-raw-badge';
  rawBadge.textContent = `ADM${r.level}`;
  meta.appendChild(rawBadge);
  if (r.moreCount) {
    const more = document.createElement('span');
    more.className = 'cnmw-more';
    more.textContent = ` (+${r.moreCount} more)`;
    more.title = `${r.moreCount} additional near-identical match${r.moreCount === 1 ? '' : 'es'} collapsed here. Refine your search to tell them apart.`;
    meta.appendChild(more);
  }

  li.appendChild(nameEl);
  li.appendChild(meta);
}

function friendlyErrorMessage(err) {
  if (err?.code === 'GEOCODER_NOT_LOADED') return 'Still loading the index…';
  if (err?.name === 'AbortError') return 'Search cancelled.';
  if (err?.message) return `Search failed: ${err.message}`;
  return 'Search failed — check your connection and try again.';
}

export class GeocoderControl {
  /** @param {import('./types.js').GeocoderControlOptions} [options] */
  constructor(options = {}) {
    this._options = options;
    this.geocoder = options.geocoder; // may be supplied by the demo page (avoids a bundler dependency on geocoder-core here)
    this._area = null;
    this._listeners = new Map();
    this._results = [];
    this._activeIndex = -1;
    this._instanceId = `cnmw-geocoder-${++instanceCounter}`;
    this._compositionGate = new CompositionGate();
    this._searchRequestId = 0;
    this._lastQueryNorm = '';
    this._lastRenderedQuery = null;
    // "upgradeDisplay" notice (design doc §1.3/§3.2 amendment): see
    // ./upgrade-notice.js for the state machine this drives.
    this._upgradeNoticeState = HIDDEN_NOTICE_STATE;
    this._upgradeNoticeTimer = null;
  }

  get area() {
    return this._area;
  }

  /** @param {import('maplibre-gl').Map} map */
  onAdd(map) {
    this._map = map;
    injectCssOnce();

    const opts = this._options;
    const container = document.createElement('div');
    container.className = 'cnmw-geocoder maplibregl-ctrl';

    const input = document.createElement('input');
    input.type = 'text';
    input.role = 'combobox';
    input.placeholder = opts.placeholder ?? 'Search for a place…';
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', `${this._instanceId}-listbox`);
    input.id = `${this._instanceId}-input`;

    const listbox = document.createElement('ul');
    listbox.role = 'listbox';
    listbox.id = `${this._instanceId}-listbox`;
    listbox.className = 'cnmw-listbox';
    listbox.hidden = true;

    const moreBadge = document.createElement('div');
    moreBadge.className = 'cnmw-more-badge';
    moreBadge.setAttribute('role', 'status');
    moreBadge.setAttribute('aria-live', 'polite');
    moreBadge.hidden = true;

    // Compact attribution (2026-11-13, replaces the design-call-#11
    // full-width line): a ⓘ button + expandable pill, mounted in the
    // map's bottom-left control corner -- NOT in this control's own
    // container, so a long citation never runs over the map. See
    // _renderAttribution and _mountAttribution.
    const attribution = document.createElement('div');
    attribution.className = 'cnmw-attribution';
    attribution.id = `${this._instanceId}-attribution`;
    attribution.hidden = true;

    // "upgradeDisplay" notice: shown while `select({ resolution: 'both' })`'s
    // background full-res fetch is in flight, with a Cancel affordance
    // that calls `geocoder.cancelUpgrade()`. See ./upgrade-notice.js.
    const upgradeNotice = document.createElement('div');
    upgradeNotice.className = 'cnmw-upgrade-notice';
    upgradeNotice.setAttribute('role', 'status');
    upgradeNotice.setAttribute('aria-live', 'polite');
    upgradeNotice.hidden = true;
    const upgradeNoticeText = document.createElement('span');
    const upgradeNoticeCancel = document.createElement('button');
    upgradeNoticeCancel.type = 'button';
    upgradeNoticeCancel.className = 'cnmw-upgrade-notice-cancel';
    upgradeNotice.appendChild(upgradeNoticeText);
    upgradeNotice.appendChild(upgradeNoticeCancel);

    container.appendChild(input);
    container.appendChild(listbox);
    container.appendChild(moreBadge);
    container.appendChild(upgradeNotice);
    this._mountAttribution(map, attribution);

    this._input = input;
    this._listbox = listbox;
    this._moreBadge = moreBadge;
    this._attributionEl = attribution;
    this._upgradeNoticeEl = upgradeNotice;
    this._upgradeNoticeTextEl = upgradeNoticeText;
    this._upgradeNoticeCancelEl = upgradeNoticeCancel;

    upgradeNoticeCancel.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.geocoder?.cancelUpgrade();
    });

    this._outline = opts.outline === false ? null : addAreaLayer(map, opts.outline || {});
    this._getViewport = opts.useViewport === false ? () => undefined : viewportProvider(map);

    // Adaptive debounce: recomputed every keystroke since
    // geocoder.info.strategy is usually unknown on the first one.
    const runSearch = debounce(() => this._doSearch(), () => adaptiveDebounceMs(this.geocoder?.info?.strategy, opts.debounceMs));

    input.addEventListener('focus', () => {
      this.geocoder?.load().catch(() => {});
    }, { once: true });
    // IME composition gating: never search mid-composition (中文/日本語 etc).
    input.addEventListener('compositionstart', () => this._compositionGate.start());
    input.addEventListener('compositionend', () => {
      this._compositionGate.end();
      runSearch();
    });
    input.addEventListener('input', (e) => {
      if (this._compositionGate.shouldSuppress(e)) return;
      runSearch();
    });
    input.addEventListener('keydown', (e) => this._onKeyDown(e));
    listbox.addEventListener('mousedown', (e) => {
      const li = e.target.closest('[role="option"]');
      if (li) {
        e.preventDefault();
        this._onPick(Number(li.dataset.index));
      }
    });
    this._onDocumentClick = (e) => {
      if (!container.contains(e.target)) this._closeList();
    };
    document.addEventListener('click', this._onDocumentClick);

    // "upgradeDisplay" notice (design doc §1.3/§3.2 amendment): a new
    // select() always resets it, whatever resolution it asked for --
    // 'select' fires synchronously *before* 'area:upgrading' for that same
    // call (see geocoder.js), so this never races the next handler below.
    this._unsubscribeSelect = this.geocoder?.on('select', () => {
      this._dispatchUpgradeNotice({ type: 'select' });
    });
    this._unsubscribeUpgrading = this.geocoder?.on('area:upgrading', ({ estimate }) => {
      this._dispatchUpgradeNotice({ type: 'upgrading', estimate });
    });
    this._unsubscribeUpgradeCancelled = this.geocoder?.on('area:upgrade-cancelled', ({ area }) => {
      if (this._area && area.id === this._area.id) {
        this._dispatchUpgradeNotice({ type: 'cancelled' });
        this._emit('upgrade-cancelled', { area });
      }
    });

    // Progressive select(): 'area:upgraded' fires once select({resolution:
    // 'both'})'s background fetch replaces filterGeometry (and, with
    // `upgradeDisplay: true`, swaps `Area.geometry` to full-res too).
    // Update the outline in place (no re-fit; `bbox`/`bboxes` are
    // otherwise unaffected by this swap -- see geocoder.js). Guarded by
    // area.id so a stale upgrade for a since-replaced selection drops.
    this._unsubscribeUpgrade = this.geocoder?.on('area:upgraded', ({ area }) => {
      if (this._area && area.id === this._area.id) {
        this._area = area;
        this._dispatchUpgradeNotice({ type: 'upgraded' });
        // Deferred, not synchronous: with `upgradeDisplay: true`, `area.
        // geometry` here can be the full-resolution geometry (Canada ADM0
        // is ~500K vertices) -- MapLibre's GeoJSONSource#setData() has to
        // structured-clone that object over to its tiling worker, which is
        // itself a measurable main-thread cost at that size (see this
        // package's README / the demo's long-task report). Running it on
        // the next idle slot instead of inside this synchronous event
        // handler keeps that cost from landing on top of whatever the user
        // is doing *right now* (typing, dragging the map) -- it cannot
        // make the swap itself cheaper, only choose a better moment for it.
        scheduleIdle(() => {
          if (this._area !== area) return; // superseded (a new pick, or close()) while this was queued
          this._outline?.setArea(area);
          this._emit('upgrade', { area });
        });
      }
    });

    // Two-wave smoothness: _doSearch renders the wave it directly
    // awaits, but a second ('final') wave can land after that call has
    // already returned -- this subscription is the only thing that ever
    // gets it to the DOM. geocoder-core's Emitter calls handlers
    // synchronously, so for a *single*-wave search this same event also
    // fires once, synchronously, *during* the search() call this very
    // control is awaiting -- i.e. before _doSearch's own direct render
    // has run and before `_lastRenderedQuery` has been updated to this
    // query. Requiring `query === _lastRenderedQuery` is what tells a
    // genuine late second wave (query already rendered once) apart from
    // that same-wave echo (query not rendered yet) -- without it, every
    // ordinary search would spuriously "merge" against whatever was on
    // screen from the *previous* query and announce a false "N more".
    this._unsubscribeResults = this.geocoder?.on('results', ({ query, results, wave }) => {
      if (wave !== 'final') return;
      if (query !== this._input.value) return;
      if (query !== this._lastRenderedQuery) return;
      this._renderResults(results, { merge: true });
    });

    return container;
  }

  onRemove() {
    if (this._onDocumentClick) {
      document.removeEventListener('click', this._onDocumentClick);
      this._onDocumentClick = null;
    }
    if (this._onAttributionOutsideClick) {
      document.removeEventListener('click', this._onAttributionOutsideClick);
      this._onAttributionOutsideClick = null;
    }
    this._attributionHost?.remove();
    this._attributionHost = null;
    clearTimeout(this._upgradeNoticeTimer);
    this._unsubscribeSelect?.();
    this._unsubscribeUpgrading?.();
    this._unsubscribeUpgradeCancelled?.();
    this._unsubscribeUpgrade?.();
    this._unsubscribeResults?.();
    this._outline?.remove();
    this._map = null;
  }

  /**
   * Apply one event to the upgrade-notice state machine
   * (`upgradeNoticeReducer`, ./upgrade-notice.js) and re-render. Also owns
   * the transient states' auto-hide timer -- the only timing concern in
   * this whole feature, kept here rather than in the pure reducer so that
   * module stays trivially testable without fake timers.
   * @param {{ type: string, estimate?: object }} event
   */
  _dispatchUpgradeNotice(event) {
    this._upgradeNoticeState = upgradeNoticeReducer(this._upgradeNoticeState, event);
    this._renderUpgradeNotice();
    clearTimeout(this._upgradeNoticeTimer);
    if (this._upgradeNoticeState.phase === 'upgraded' || this._upgradeNoticeState.phase === 'cancelled') {
      this._upgradeNoticeTimer = setTimeout(() => this._dispatchUpgradeNotice({ type: 'timeout' }), UPGRADE_NOTICE_AUTO_HIDE_MS);
    }
  }

  _renderUpgradeNotice() {
    const strings = this._options.upgradeNoticeStrings;
    const described = describeUpgradeNotice(this._upgradeNoticeState, strings);
    if (!described) {
      this._upgradeNoticeEl.hidden = true;
      return;
    }
    this._upgradeNoticeTextEl.textContent = described.text;
    this._upgradeNoticeCancelEl.hidden = !described.showCancel;
    this._upgradeNoticeCancelEl.textContent = strings?.cancelLabel ?? '×';
    this._upgradeNoticeCancelEl.setAttribute('aria-label', strings?.cancelTitle ?? 'Cancel and keep the simplified outline');
    this._upgradeNoticeCancelEl.title = strings?.cancelTitle ?? 'Cancel and keep the simplified outline';
    this._upgradeNoticeEl.hidden = false;
  }

  async _doSearch() {
    const query = this._input.value;
    if (!this.geocoder) return;
    // A later keystroke always wins: a slow/stale in-flight search must
    // never clobber a faster, more-recent render. geocoder-core resolves
    // a superseded search() to [], which would otherwise land here and
    // blank out the newer, correct list.
    const requestId = ++this._searchRequestId;
    if (query.length === 0) {
      this._renderResults([]);
      return;
    }
    // "Loading places…" (cold index) vs "Searching…" (index ready, query
    // in flight) -- distinct from the post-search "No matches for 'x'".
    this._showLoadingState(this.geocoder.state === 'ready' ? 'searching' : 'loading');
    this._setLoading(true);
    try {
      const viewport = this._getViewport();
      const results = await this.geocoder.search(query, {
        viewport,
        limit: this._options.limit,
      });
      if (requestId !== this._searchRequestId) return;
      this._lastQueryNorm = normalizeName(query);
      this._renderResults(results);
      this._lastRenderedQuery = query;
      this._emit('results', results);
    } catch (err) {
      if (requestId !== this._searchRequestId) return;
      this._renderError(err);
      this._emit('error', err);
    } finally {
      if (requestId === this._searchRequestId) this._setLoading(false);
    }
  }

  _setLoading(isLoading) {
    this._input.setAttribute('aria-busy', String(isLoading));
  }

  _showLoadingState(kind) {
    const listbox = this._listbox;
    listbox.innerHTML = '';
    const li = document.createElement('li');
    li.className = kind === 'loading' ? 'cnmw-loading' : 'cnmw-searching';
    li.setAttribute('aria-hidden', 'true'); // decorative; aria-busy on the input already covers screen readers
    const spinner = document.createElement('span');
    spinner.className = 'cnmw-spinner';
    li.appendChild(spinner);
    li.appendChild(document.createTextNode(kind === 'loading' ? 'Loading places…' : 'Searching…'));
    listbox.appendChild(li);
    listbox.hidden = false;
    this._input.setAttribute('aria-expanded', 'true');
  }

  _renderError(err) {
    const listbox = this._listbox;
    listbox.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'cnmw-error';
    const msg = document.createElement('span');
    msg.textContent = friendlyErrorMessage(err);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'cnmw-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._doSearch();
    });
    li.appendChild(msg);
    li.appendChild(retry);
    listbox.appendChild(li);
    listbox.hidden = false;
    this._input.setAttribute('aria-expanded', 'true');
    this._input.removeAttribute('aria-activedescendant');
  }

  /**
   * @param {import('@cng/geocoder-core').SearchResult[]} results
   * @param {{ merge?: boolean }} [opts] merge: true is the two-wave path:
   *   preserve aria-activedescendant's target by featureId (not index --
   *   the final wave can reorder), never reset _activeIndex just because
   *   a second wave landed, and flag newly-added rows for a subtle fade
   *   instead of a jarring full reset.
   */
  _renderResults(results, { merge = false } = {}) {
    const previousActiveFeatureId = merge && this._activeIndex >= 0 ? this._results[this._activeIndex]?.featureId : undefined;
    const diff = merge ? diffResultsForMerge(this._results, results) : null;

    this._results = results;
    if (!merge) this._activeIndex = -1;
    const listbox = this._listbox;
    listbox.innerHTML = '';

    if (results.length === 0) {
      const query = this._input.value;
      if (query.length > 0) {
        const empty = document.createElement('li');
        empty.className = 'cnmw-empty';
        empty.textContent = `No matches for "${query}".`;
        listbox.appendChild(empty);
        listbox.hidden = false;
        this._input.setAttribute('aria-expanded', 'true');
      } else {
        this._closeList();
      }
      this._input.removeAttribute('aria-activedescendant');
      return;
    }

    // Fuzzy results only ever appear when the prefix search found nothing
    // (geocoder-core's gazet-inspired fallback), so one caption covers the
    // whole list. role="presentation" keeps it out of _setActive's
    // [role="option"] index space and the mousedown picker.
    if (results[0]?.rank?.matchClass === 'fuzzy') {
      const note = document.createElement('li');
      note.className = 'cnmw-fuzzy-note';
      note.setAttribute('role', 'presentation');
      note.textContent = 'No exact matches — showing close matches.';
      listbox.appendChild(note);
    }

    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.id = `${this._instanceId}-option-${i}`;
      li.role = 'option';
      li.className = 'cnmw-option';
      li.dataset.index = String(i);
      li.dataset.featureId = r.featureId;
      li.setAttribute('aria-selected', 'false');
      if (diff?.addedFeatureIds.has(r.featureId)) li.classList.add('cnmw-option-new');
      if (this._options.renderItem) {
        const rendered = this._options.renderItem(r);
        if (typeof rendered === 'string') li.innerHTML = rendered;
        else li.appendChild(rendered);
      } else {
        renderDefaultOption(li, r, this._lastQueryNorm);
      }
      listbox.appendChild(li);
    });
    listbox.hidden = false;
    this._input.setAttribute('aria-expanded', 'true');

    if (merge && previousActiveFeatureId) {
      const newIndex = results.findIndex((r) => r.featureId === previousActiveFeatureId);
      if (newIndex >= 0) this._setActive(newIndex, { scroll: false });
      else {
        this._activeIndex = -1;
        this._input.removeAttribute('aria-activedescendant');
      }
    }
    if (merge && diff?.grew) this._announceGrew(diff.addedFeatureIds.size);
  }

  // Subtle, transient status line (also the screen-reader announcement
  // via role=status/aria-live) when a second wave grows the list.
  _announceGrew(n) {
    if (n <= 0) return;
    this._moreBadge.textContent = `+${n} more result${n === 1 ? '' : 's'} found`;
    this._moreBadge.hidden = false;
    clearTimeout(this._moreBadgeTimer);
    this._moreBadgeTimer = setTimeout(() => {
      this._moreBadge.hidden = true;
    }, 2200);
  }

  _closeList() {
    this._listbox.hidden = true;
    this._input.setAttribute('aria-expanded', 'false');
    this._input.removeAttribute('aria-activedescendant');
    this._activeIndex = -1;
  }

  _onKeyDown(e) {
    const n = this._results.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n === 0) return;
      this._setActive((this._activeIndex + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n === 0) return;
      this._setActive((this._activeIndex - 1 + n) % n);
    } else if (e.key === 'Home') {
      if (n === 0 || this._listbox.hidden) return;
      e.preventDefault();
      this._setActive(0);
    } else if (e.key === 'End') {
      if (n === 0 || this._listbox.hidden) return;
      e.preventDefault();
      this._setActive(n - 1);
    } else if (e.key === 'Enter') {
      if (this._activeIndex >= 0) {
        e.preventDefault();
        this._onPick(this._activeIndex);
      }
    } else if (e.key === 'Escape') {
      // Closes, then clears: first press dismisses an open dropdown
      // without touching what was typed; a second press (nothing open)
      // clears the input. Never touches an already-selected Area.
      if (!this._listbox.hidden) {
        this._closeList();
      } else if (this._input.value) {
        this._input.value = '';
        this._renderResults([]);
        this._emit('clear', undefined);
      }
    }
  }

  /** @param {number} index @param {{ scroll?: boolean }} [opts] */
  _setActive(index, { scroll = true } = {}) {
    const options = this._listbox.querySelectorAll('[role="option"]');
    options.forEach((el, i) => el.setAttribute('aria-selected', String(i === index)));
    this._activeIndex = index;
    const active = options[index];
    if (active) {
      this._input.setAttribute('aria-activedescendant', active.id);
      if (scroll) active.scrollIntoView({ block: 'nearest' });
    }
  }

  async _onPick(index) {
    const result = this._results[index];
    if (!result) return;
    this._closeList();
    this._input.value = result.name;
    try {
      const area = await this.geocoder.select(result);
      this.setArea(area);
      this._emit('select', { result, area });
    } catch (err) {
      this._emit('error', err);
    }
  }

  /** @param {import('@cng/spec').Area|null} area */
  setArea(area) {
    this._area = area;
    this._outline?.setArea(area);
    if (area && (this._options.fitBounds ?? true)) {
      const fitOpts = this._options.fitBounds === true || this._options.fitBounds === undefined ? {} : this._options.fitBounds;
      this._outline?.fit(fitOpts);
    }
    this._renderAttribution(area);
  }

  /**
   * Mount the compact attribution widget (ⓘ toggle + pill) into the map's
   * bottom-left control corner. Lifecycle: created in onAdd, removed in
   * onRemove. The pill starts collapsed; a new selection collapses it
   * again; a click anywhere outside collapses it.
   * @param {import('maplibre-gl').Map} map
   * @param {HTMLElement} pill the `.cnmw-attribution` content element
   */
  _mountAttribution(map, pill) {
    const host = document.createElement('div');
    host.className = 'maplibregl-ctrl cnmw-attribution-ctrl';
    host.hidden = true;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cnmw-attribution-toggle';
    toggle.setAttribute('aria-label', 'Data attribution');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', pill.id);
    toggle.textContent = 'i';
    host.appendChild(pill);
    host.appendChild(toggle);
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._setAttributionExpanded(pill.hidden);
    });
    this._onAttributionOutsideClick = (e) => {
      if (!host.contains(e.target)) this._setAttributionExpanded(false);
    };
    document.addEventListener('click', this._onAttributionOutsideClick);
    // The bottom-left control corner exists as soon as the Map does;
    // falling back to the map container keeps a headless/mocked map from
    // crashing the control.
    const corner = map.getContainer().querySelector('.maplibregl-ctrl-bottom-left') ?? map.getContainer();
    corner.appendChild(host);
    this._attributionHost = host;
    this._attributionToggle = toggle;
  }

  _setAttributionExpanded(expanded) {
    if (!this._attributionEl || !this._attributionToggle) return;
    this._attributionEl.hidden = !expanded;
    this._attributionToggle.setAttribute('aria-expanded', String(expanded));
  }

  _renderAttribution(area) {
    if (!this._attributionHost) return; // not added to a map yet
    if (this._options.showAttribution === false) {
      this._attributionHost.hidden = true;
      return;
    }
    const attribution = area?.provenance?.attribution ?? [];
    if (attribution.length === 0) {
      this._attributionHost.hidden = true;
      this._setAttributionExpanded(false);
      return;
    }
    // Share-alike (design call #11, ODbL/Overture) gets a small tag;
    // CC-BY (geoBoundaries) renders as before, untagged.
    this._attributionEl.innerHTML = attribution
      .map((a) => {
        const label = a.url
          ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.text)}</a>`
          : escapeHtml(a.text);
        // `a.shareAlike` is the documented AreaAttribution field (design
        // doc §1.2); `a.share_alike` is what a manifest's raw JSON
        // actually carries through unconverted today (geocoder-core
        // passes manifest.attribution straight into provenance -- see
        // this package's UX-polish report for the ask to normalize it
        // at the source). Checking both keeps this correct either way.
        const tag = a.shareAlike ?? a.share_alike
          ? ` <span class="cnmw-sharealike" title="Share-alike license: data derived from this source must be republished under the same terms">ODbL</span>`
          : '';
        return label + tag;
      })
      .join(' · ');
    // Show the ⓘ; the pill itself starts (and, on a new selection,
    // returns to) collapsed.
    this._attributionHost.hidden = false;
    this._setAttributionExpanded(false);
  }

  clear() {
    this._input.value = '';
    this._renderResults([]);
    this.setArea(null);
  }

  focus() {
    this._input?.focus();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event)?.delete(handler);
  }

  _emit(event, payload) {
    for (const handler of this._listeners.get(event) ?? []) handler(payload);
  }
}
