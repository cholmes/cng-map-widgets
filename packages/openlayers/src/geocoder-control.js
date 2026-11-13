// @cnmw/openlayers -- GeocoderControl (design doc §5.1, §5.2), the OL
// flavour.
//
// Same accessible combobox contract as @cnmw/maplibre's GeocoderControl
// (ARIA 1.2 combobox-with-listbox, debounce, loading/empty/error states,
// the design-call-#11 attribution line, matched highlighting, friendly
// level labels, two-wave merge, IME gating, dark-mode CSS tokens) and the
// same "no index fetch/ranking/simplification/Area-building here" rule.
//
// DUPLICATION NOTE: per the design doc (§5.2), the shared combobox lines
// between this and @cnmw/maplibre's control live in an unpublished
// `packages/_ui` workspace "for later", not forced now -- this file
// duplicates that logic (incl. ./combobox-helpers.js) rather than
// reaching into @cnmw/maplibre. Real differences: OL's `Control` base
// class / `setMap` lifecycle instead of `onAdd`/`onRemove`, and the
// projection bridge threaded through addAreaLayer/viewportProvider.

import Control from 'ol/control/Control.js';
import { normalizeName } from '@cnmw/spec';

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

// See @cnmw/maplibre's geocoder-control.js for the rationale -- identical
// here, duplicated rather than imported (this package doesn't depend on
// @cnmw/maplibre's internals, only its public events).
const UPGRADE_NOTICE_AUTO_HIDE_MS = 2600;

function scheduleIdle(fn) {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(fn, { timeout: 500 });
  } else {
    setTimeout(fn, 0);
  }
}

// Dark mode: see @cnmw/maplibre's geocoder-control.js for the override
// hook rationale; identical token set here under the `-ol` class names.
const CSS = `
.cnmw-geocoder-ol {
  --cnmw-bg: #fff;
  --cnmw-ink: #1a1a1a;
  --cnmw-border: #ccc;
  --cnmw-focus: #1a73e8;
  --cnmw-meta: #666;
  --cnmw-selected-bg: #e8f0fe;
  --cnmw-highlight-ink: inherit;
  --cnmw-highlight-bg: #fff3b0;
  --cnmw-shadow: rgba(0,0,0,0.15);
  --cnmw-error: #b3261e;
  --cnmw-error-bg: #fdecea;
  --cnmw-badge-bg: #f1f1ef;
  --cnmw-badge-ink: #777;
  position: absolute; top: 10px; left: 10px; font: 13px/1.4 system-ui, sans-serif; color: var(--cnmw-ink);
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  .cnmw-geocoder-ol {
    --cnmw-bg: #1e1f22;
    --cnmw-ink: #e8e8e6;
    --cnmw-border: #46484d;
    --cnmw-focus: #7ab2f5;
    --cnmw-meta: #a3a3a0;
    --cnmw-selected-bg: #2a3a52;
    --cnmw-highlight-bg: #5a4a12;
    --cnmw-shadow: rgba(0,0,0,0.5);
    --cnmw-error: #ff8a80;
    --cnmw-error-bg: #3a2323;
    --cnmw-badge-bg: #2d2f33;
    --cnmw-badge-ink: #b0b0ac;
  }
}
.cnmw-geocoder-ol input[role="combobox"] {
  width: 260px; padding: 8px 10px; border: 1px solid var(--cnmw-border); border-radius: 4px;
  font: inherit; box-sizing: border-box; background: var(--cnmw-bg); color: var(--cnmw-ink);
}
.cnmw-geocoder-ol input[role="combobox"]:focus { outline: 2px solid var(--cnmw-focus); outline-offset: -1px; }
.cnmw-geocoder-ol .cnmw-listbox {
  position: absolute; top: 100%; left: 0; right: 0; margin: 2px 0 0; padding: 2px;
  list-style: none; background: var(--cnmw-bg); border: 1px solid var(--cnmw-border); border-radius: 4px;
  max-height: 260px; overflow-y: auto; box-shadow: 0 2px 8px var(--cnmw-shadow); z-index: 10;
}
.cnmw-geocoder-ol .cnmw-listbox[hidden] { display: none; }
.cnmw-geocoder-ol .cnmw-option { padding: 6px 8px; border-radius: 3px; cursor: pointer; }
.cnmw-geocoder-ol .cnmw-option[aria-selected="true"] { background: var(--cnmw-selected-bg); }
.cnmw-geocoder-ol .cnmw-option-new { animation: cnmw-ol-fade-in 0.6s ease-out; }
@keyframes cnmw-ol-fade-in { from { background: var(--cnmw-selected-bg); } to { background: transparent; } }
.cnmw-geocoder-ol .cnmw-option-name { font-weight: 500; }
.cnmw-geocoder-ol mark.cnmw-match {
  background: var(--cnmw-highlight-bg); color: var(--cnmw-highlight-ink); border-radius: 2px; padding: 0 1px;
}
.cnmw-geocoder-ol .cnmw-alt-badge, .cnmw-geocoder-ol .cnmw-raw-badge {
  font-size: 10px; color: var(--cnmw-badge-ink); background: var(--cnmw-badge-bg);
  border-radius: 3px; padding: 1px 4px; margin-left: 4px; vertical-align: middle;
}
.cnmw-geocoder-ol .cnmw-option-meta { color: var(--cnmw-meta); font-size: 11px; margin-left: 6px; }
.cnmw-geocoder-ol .cnmw-more { color: var(--cnmw-meta); cursor: default; }
.cnmw-geocoder-ol .cnmw-empty, .cnmw-geocoder-ol .cnmw-loading, .cnmw-geocoder-ol .cnmw-searching {
  padding: 8px; color: var(--cnmw-meta);
}
.cnmw-geocoder-ol .cnmw-fuzzy-note {
  padding: 4px 8px 5px; color: var(--cnmw-meta); font-size: 11px; font-style: italic; cursor: default;
  border-bottom: 1px solid var(--cnmw-border); margin-bottom: 2px;
}
.cnmw-geocoder-ol .cnmw-error {
  padding: 8px; color: var(--cnmw-error); background: var(--cnmw-error-bg);
  display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: default;
}
.cnmw-geocoder-ol .cnmw-retry {
  font: inherit; font-size: 11px; color: inherit; background: transparent; border: 1px solid currentColor;
  border-radius: 3px; padding: 2px 8px; cursor: pointer; flex: none;
}
.cnmw-geocoder-ol .cnmw-spinner {
  display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px;
  border: 2px solid var(--cnmw-border); border-top-color: var(--cnmw-focus); border-radius: 50%;
  animation: cnmw-ol-spin 0.8s linear infinite;
}
@keyframes cnmw-ol-spin { to { transform: rotate(360deg); } }
.cnmw-geocoder-ol .cnmw-more-badge {
  font-size: 11px; color: var(--cnmw-meta); margin-top: 2px; transition: opacity 0.3s ease;
}
.cnmw-geocoder-ol .cnmw-more-badge[hidden] { display: none; }
.cnmw-geocoder-ol .cnmw-attribution { font-size: 10px; color: var(--cnmw-meta); margin-top: 4px; }
.cnmw-geocoder-ol .cnmw-attribution a { color: inherit; }
.cnmw-geocoder-ol .cnmw-sharealike {
  font-size: 9px; border: 1px solid var(--cnmw-border); border-radius: 2px; padding: 0 3px; margin-left: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .cnmw-geocoder-ol .cnmw-option-new { animation: none; }
  .cnmw-geocoder-ol .cnmw-spinner { animation-duration: 1.6s; }
}
.cnmw-geocoder-ol .cnmw-upgrade-notice {
  margin-top: 4px; padding: 4px 6px; border-radius: 4px; background: var(--cnmw-badge-bg); color: var(--cnmw-meta);
  font-size: 11px; display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.cnmw-geocoder-ol .cnmw-upgrade-notice[hidden] { display: none; }
.cnmw-geocoder-ol .cnmw-upgrade-notice-cancel {
  font: inherit; font-size: 13px; line-height: 1; color: inherit; background: transparent; border: none;
  cursor: pointer; padding: 0 2px; border-radius: 2px; flex: none;
}
.cnmw-geocoder-ol .cnmw-upgrade-notice-cancel[hidden] { display: none; }
.cnmw-geocoder-ol .cnmw-upgrade-notice-cancel:hover, .cnmw-geocoder-ol .cnmw-upgrade-notice-cancel:focus { color: var(--cnmw-ink); }
.cnmw-geocoder-ol .cnmw-upgrade-notice-cancel:focus { outline: 2px solid var(--cnmw-focus); outline-offset: -1px; }
`;

function injectCssOnce() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('cnmw-ol-geocoder-style')) return;
  const style = document.createElement('style');
  style.id = 'cnmw-ol-geocoder-style';
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Default dropdown-option rendering; line-for-line the same as
// @cnmw/maplibre's renderDefaultOption (see the DUPLICATION NOTE above).
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

export class GeocoderControl extends Control {
  /** @param {import('./types.js').OlGeocoderControlOptions} [options] */
  constructor(options = {}) {
    injectCssOnce();
    const container = document.createElement('div');
    container.className = 'cnmw-geocoder-ol ol-unselectable ol-control';
    super({ element: container, target: options.target });

    this._options = options;
    this.geocoder = options.geocoder; // host supplies it, same reasoning as @cnmw/maplibre
    this._area = null;
    this._listeners = new Map();
    this._results = [];
    this._activeIndex = -1;
    this._instanceId = `cnmw-ol-geocoder-${++instanceCounter}`;
    this._compositionGate = new CompositionGate();
    this._searchRequestId = 0;
    this._lastQueryNorm = '';
    this._lastRenderedQuery = null;
    this._upgradeNoticeState = HIDDEN_NOTICE_STATE;
    this._upgradeNoticeTimer = null;

    this._buildDom(container);
  }

  _buildDom(container) {
    const opts = this._options;
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

    const attribution = document.createElement('div');
    attribution.className = 'cnmw-attribution';
    attribution.hidden = true;

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
    container.appendChild(attribution);
    container.appendChild(upgradeNotice);

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

    const runSearch = debounce(() => this._doSearch(), () => adaptiveDebounceMs(this.geocoder?.info?.strategy, opts.debounceMs));

    input.addEventListener('focus', () => { this.geocoder?.load().catch(() => {}); }, { once: true });
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
  }

  get area() {
    return this._area;
  }

  // OL's lifecycle hook: `map` on addControl(), `null` on removal.
  // Click-outside listener + geocoder event subscriptions are
  // registered/torn down here (not in _buildDom, which runs once in the
  // constructor) so discarding the control never leaves a document-level
  // listener pinning it alive forever -- the leak @cnmw/maplibre's
  // onRemove already fixed; this adapter never had the fix at all.
  setMap(map) {
    super.setMap(map);
    this._outline?.remove();
    this._outline = null;
    clearTimeout(this._upgradeNoticeTimer);
    this._unsubscribeSelect?.();
    this._unsubscribeUpgrading?.();
    this._unsubscribeUpgradeCancelled?.();
    this._unsubscribeUpgrade?.();
    this._unsubscribeResults?.();
    if (this._onDocumentClick) {
      document.removeEventListener('click', this._onDocumentClick);
      this._onDocumentClick = null;
    }
    if (!map) {
      this._map = null;
      return;
    }
    this._map = map;
    const opts = this._options;
    this._outline = opts.outline === false ? null : addAreaLayer(map, { featureProjection: opts.featureProjection, ...(opts.outline || {}) });
    this._getViewport = opts.useViewport === false ? () => undefined : viewportProvider(map, { featureProjection: opts.featureProjection });

    this._onDocumentClick = (e) => {
      if (!this.element.contains(e.target)) this._closeList();
    };
    document.addEventListener('click', this._onDocumentClick);

    // Progressive select() + two-wave smoothness: identical wiring to
    // @cnmw/maplibre's `onAdd` -- see that file's comments for the full
    // rationale. Previously missing entirely from this control (OL
    // selections never reflected a background geometry upgrade, and a
    // second search wave never reached the DOM here).
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
    this._unsubscribeUpgrade = this.geocoder?.on('area:upgraded', ({ area }) => {
      if (this._area && area.id === this._area.id) {
        this._area = area;
        this._dispatchUpgradeNotice({ type: 'upgraded' });
        // Deferred jank mitigation -- see @cnmw/maplibre's identical
        // handler for the full rationale (GeoJSONSource#setData() /
        // structured-clone cost at `upgradeDisplay`-scale geometry).
        scheduleIdle(() => {
          if (this._area !== area) return;
          this._outline?.setArea(area);
          this._emit('upgrade', { area });
        });
      }
    });
    // See @cnmw/maplibre's onAdd for why `_lastRenderedQuery` is required
    // here: geocoder-core's Emitter is synchronous, so a single-wave
    // search's own 'results' event fires *during* the search() call this
    // control is awaiting, before _doSearch's direct render has run --
    // without this guard, every ordinary search would spuriously "merge"
    // against the previous query's stale on-screen list.
    this._unsubscribeResults = this.geocoder?.on('results', ({ query, results, wave }) => {
      if (wave !== 'final') return;
      if (query !== this._input.value) return;
      if (query !== this._lastRenderedQuery) return;
      this._renderResults(results, { merge: true });
    });
  }

  async _doSearch() {
    const query = this._input.value;
    if (!this.geocoder) return;
    const requestId = ++this._searchRequestId;
    if (query.length === 0) {
      this._renderResults([]);
      return;
    }
    this._showLoadingState(this.geocoder.state === 'ready' ? 'searching' : 'loading');
    this._setLoading(true);
    try {
      const viewport = this._getViewport ? this._getViewport() : undefined;
      const results = await this.geocoder.search(query, { viewport, limit: this._options.limit });
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
    li.setAttribute('aria-hidden', 'true');
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
      if (!this._listbox.hidden) {
        this._closeList();
      } else if (this._input.value) {
        this._input.value = '';
        this._renderResults([]);
        this._emit('clear', undefined);
      }
    }
  }

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

  /** @param {import('@cnmw/spec').Area|null} area */
  setArea(area) {
    this._area = area;
    this._outline?.setArea(area);
    if (area && (this._options.fitBounds ?? true)) {
      const fitOpts = this._options.fitBounds === true || this._options.fitBounds === undefined ? {} : this._options.fitBounds;
      this._outline?.fit(fitOpts);
    }
    this._renderAttribution(area);
  }

  _renderAttribution(area) {
    if (this._options.showAttribution === false) {
      this._attributionEl.hidden = true;
      return;
    }
    const attribution = area?.provenance?.attribution ?? [];
    if (attribution.length === 0) {
      this._attributionEl.hidden = true;
      return;
    }
    this._attributionEl.innerHTML = attribution
      .map((a) => {
        const label = a.url
          ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.text)}</a>`
          : escapeHtml(a.text);
        // a.shareAlike (documented) vs a.share_alike (what a manifest's
        // raw JSON actually carries through today, unconverted) -- see
        // @cnmw/maplibre's _renderAttribution and this package's
        // UX-polish report.
        const tag = a.shareAlike ?? a.share_alike
          ? ` <span class="cnmw-sharealike" title="Share-alike license: data derived from this source must be republished under the same terms">ODbL</span>`
          : '';
        return label + tag;
      })
      .join(' · ');
    this._attributionEl.hidden = false;
  }

  clear() {
    this._input.value = '';
    this._renderResults([]);
    this.setArea(null);
  }

  // "upgradeDisplay" notice -- identical to @cnmw/maplibre's
  // geocoder-control.js; see that file for the full rationale.
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
