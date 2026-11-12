// @cnmw/maplibre -- GeocoderControl (design doc §5.1, §5.2).
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

let instanceCounter = 0;

// Dark mode (prefers-color-scheme): every color is a custom property on
// `.cnmw-geocoder`. A host page overrides any `--cnmw-*` token by
// redeclaring it on an ancestor (inherited) or on `.cnmw-geocoder` with
// higher cascade priority; nothing below reads a computed value.
const CSS = `
.cnmw-geocoder {
  --cnmw-bg: #fff; --cnmw-ink: #1a1a1a; --cnmw-border: #ccc; --cnmw-focus: #1a73e8;
  --cnmw-meta: #666; --cnmw-selected-bg: #e8f0fe; --cnmw-highlight-ink: inherit;
  --cnmw-highlight-bg: #fff3b0; --cnmw-shadow: rgba(0,0,0,0.15); --cnmw-error: #b3261e;
  --cnmw-error-bg: #fdecea; --cnmw-badge-bg: #f1f1ef; --cnmw-badge-ink: #777;
  position: relative; font: 13px/1.4 system-ui, sans-serif; color: var(--cnmw-ink); color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  .cnmw-geocoder {
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
.cnmw-geocoder .cnmw-attribution { font-size: 10px; color: var(--cnmw-meta); margin-top: 4px; }
.cnmw-geocoder .cnmw-attribution a { color: inherit; }
.cnmw-geocoder .cnmw-sharealike { font-size: 9px; border: 1px solid var(--cnmw-border); border-radius: 2px; padding: 0 3px; margin-left: 2px; }
@media (prefers-reduced-motion: reduce) { .cnmw-geocoder .cnmw-option-new { animation: none; } }
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

    const attribution = document.createElement('div');
    attribution.className = 'cnmw-attribution';
    attribution.hidden = true;

    container.appendChild(input);
    container.appendChild(listbox);
    container.appendChild(moreBadge);
    container.appendChild(attribution);

    this._input = input;
    this._listbox = listbox;
    this._moreBadge = moreBadge;
    this._attributionEl = attribution;

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

    // Progressive select(): 'area:upgraded' fires once select({resolution:
    // 'both'})'s background fetch replaces filterGeometry. Update the
    // outline in place (no re-fit; geometry/bbox never change). Guarded
    // by area.id so a stale upgrade for a since-replaced selection drops.
    this._unsubscribeUpgrade = this.geocoder?.on('area:upgraded', ({ area }) => {
      if (this._area && area.id === this._area.id) {
        this._area = area;
        this._outline?.setArea(area);
        this._emit('upgrade', { area });
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
    this._unsubscribeUpgrade?.();
    this._unsubscribeResults?.();
    this._outline?.remove();
    this._map = null;
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
   * @param {import('@cnmw/geocoder-core').SearchResult[]} results
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
    this._attributionEl.hidden = false;
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
