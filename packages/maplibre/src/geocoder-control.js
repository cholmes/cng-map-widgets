// @cnmw/maplibre -- GeocoderControl (design doc §5.1, §5.2).
//
// An accessible combobox (ARIA 1.2 combobox-with-listbox pattern):
// <input role="combobox" aria-expanded aria-controls aria-activedescendant>
// + <ul role="listbox"><li role="option"></li></ul>, arrow/enter/escape
// handling, debounce, loading/empty states, and the attribution line
// design call #11 requires.
//
// What this adapter does NOT do (design doc §5.1): fetch an index, rank
// results, simplify geometry, or construct an Area from raw coordinates.
// All of that happens inside the `Geocoder` instance it holds; this class
// is DOM + event wiring only.

import { addAreaLayer } from './area-layer.js';
import { viewportProvider } from './viewport.js';

let instanceCounter = 0;

const CSS = `
.cnmw-geocoder { position: relative; font: 13px/1.4 system-ui, sans-serif; }
.cnmw-geocoder input[role="combobox"] {
  width: 260px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px;
  font: inherit; box-sizing: border-box;
}
.cnmw-geocoder input[role="combobox"]:focus { outline: 2px solid #1a73e8; outline-offset: -1px; }
.cnmw-geocoder .cnmw-listbox {
  position: absolute; top: 100%; left: 0; right: 0; margin: 2px 0 0; padding: 2px;
  list-style: none; background: #fff; border: 1px solid #ccc; border-radius: 4px;
  max-height: 260px; overflow-y: auto; box-shadow: 0 2px 8px rgba(0,0,0,0.15); z-index: 10;
}
.cnmw-geocoder .cnmw-listbox[hidden] { display: none; }
.cnmw-geocoder .cnmw-option { padding: 6px 8px; border-radius: 3px; cursor: pointer; }
.cnmw-geocoder .cnmw-option[aria-selected="true"] { background: #e8f0fe; }
.cnmw-geocoder .cnmw-option-name { font-weight: 500; }
.cnmw-geocoder .cnmw-option-meta { color: #666; font-size: 11px; margin-left: 6px; }
.cnmw-geocoder .cnmw-empty, .cnmw-geocoder .cnmw-loading { padding: 8px; color: #666; }
.cnmw-geocoder .cnmw-attribution { font-size: 10px; color: #888; margin-top: 4px; }
.cnmw-geocoder .cnmw-attribution a { color: inherit; }
`;

function injectCssOnce() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('cnmw-geocoder-style')) return;
  const style = document.createElement('style');
  style.id = 'cnmw-geocoder-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Default dropdown-option rendering (design doc §3.2 amendment, "Dropdown
 * context"): disambiguating secondary text when the loaded index carries
 * it -- Overture's `parentName` ("Rajasthan" for a locality) or
 * geoBoundaries' `countryName` ("Switzerland" alongside the ISO `country`
 * code), in that preference order (never both: a human-readable country
 * name already subsumes the code's job). A collapsed-duplicate row's
 * `moreCount` (set by `applyDiversity` in geocoder-core, e.g. the reported
 * "eight identical Bag/IND/ADM4 rows" bug) is appended as "(+N more)".
 * Falls back to the pre-amendment "{country} · ADM{level}" with no context
 * when the index has neither optional column.
 * @param {HTMLLIElement} li
 * @param {import('@cnmw/geocoder-core').SearchResult} r
 */
function renderDefaultOption(li, r) {
  const name = document.createElement('span');
  name.className = 'cnmw-option-name';
  name.textContent = r.name;

  const meta = document.createElement('span');
  meta.className = 'cnmw-option-meta';
  const context = r.parentName ?? r.countryName;
  const base = `${r.country} · ADM${r.level}`;
  const withMore = r.moreCount ? `${base} (+${r.moreCount} more)` : base;
  meta.textContent = context ? `— ${context} · ${withMore}` : withMore;

  li.appendChild(name);
  li.appendChild(meta);
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

    const attribution = document.createElement('div');
    attribution.className = 'cnmw-attribution';
    attribution.hidden = true;

    container.appendChild(input);
    container.appendChild(listbox);
    container.appendChild(attribution);

    this._input = input;
    this._listbox = listbox;
    this._attributionEl = attribution;

    this._outline = opts.outline === false ? null : addAreaLayer(map, opts.outline || {});
    this._getViewport = opts.useViewport === false ? () => undefined : viewportProvider(map);

    const debounceMs = opts.debounceMs ?? 80;
    const runSearch = debounce(() => this._doSearch(), debounceMs);

    input.addEventListener('focus', () => {
      this.geocoder?.load().catch(() => {});
    }, { once: true });
    input.addEventListener('input', runSearch);
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

    // Progressive select() (design doc §1/§3.2): `'area:upgraded'` fires
    // after `select({ resolution: 'both' })`'s background fetch replaces
    // `filterGeometry` with a full-resolution version. Update the outline
    // (the dashed filter-geometry "ghost" line in area-layer.js) in
    // place -- no re-fit, since `Area.geometry`/bbox never change on an
    // upgrade, only `filterGeometry`. Guarded by `area.id` so a stale
    // upgrade for a since-replaced selection is ignored (belt-and-
    // suspenders: geocoder-core's own generation check already drops it).
    this._unsubscribeUpgrade = this.geocoder?.on('area:upgraded', ({ area }) => {
      if (this._area && area.id === this._area.id) {
        this._area = area;
        this._outline?.setArea(area);
        this._emit('upgrade', { area });
      }
    });

    return container;
  }

  onRemove() {
    if (this._onDocumentClick) {
      document.removeEventListener('click', this._onDocumentClick);
      this._onDocumentClick = null;
    }
    this._unsubscribeUpgrade?.();
    this._outline?.remove();
    this._map = null;
  }

  async _doSearch() {
    const query = this._input.value;
    if (!this.geocoder) return;
    if (query.length === 0) {
      this._renderResults([]);
      return;
    }
    this._setLoading(true);
    try {
      const viewport = this._getViewport();
      const results = await this.geocoder.search(query, {
        viewport,
        limit: this._options.limit,
      });
      this._renderResults(results);
      this._emit('results', results);
    } catch (err) {
      this._emit('error', err);
    } finally {
      this._setLoading(false);
    }
  }

  _setLoading(isLoading) {
    this._input.setAttribute('aria-busy', String(isLoading));
  }

  _renderResults(results) {
    this._results = results;
    this._activeIndex = -1;
    const listbox = this._listbox;
    listbox.innerHTML = '';

    if (results.length === 0) {
      const query = this._input.value;
      if (query.length > 0) {
        const empty = document.createElement('li');
        empty.className = 'cnmw-empty';
        empty.textContent = 'No matches.';
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
      li.setAttribute('aria-selected', 'false');
      if (this._options.renderItem) {
        const rendered = this._options.renderItem(r);
        if (typeof rendered === 'string') li.innerHTML = rendered;
        else li.appendChild(rendered);
      } else {
        renderDefaultOption(li, r);
      }
      listbox.appendChild(li);
    });
    listbox.hidden = false;
    this._input.setAttribute('aria-expanded', 'true');
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
    } else if (e.key === 'Enter') {
      if (this._activeIndex >= 0) {
        e.preventDefault();
        this._onPick(this._activeIndex);
      }
    } else if (e.key === 'Escape') {
      this._closeList();
    }
  }

  _setActive(index) {
    const options = this._listbox.querySelectorAll('[role="option"]');
    options.forEach((el, i) => el.setAttribute('aria-selected', String(i === index)));
    this._activeIndex = index;
    const active = options[index];
    if (active) {
      this._input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
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
      .map((a) => (a.url ? `<a href="${a.url}" target="_blank" rel="noopener">${a.text}</a>` : a.text))
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
