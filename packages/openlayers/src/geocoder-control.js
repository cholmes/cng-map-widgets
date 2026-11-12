// @cnmw/openlayers -- GeocoderControl (design doc §5.1, §5.2), the OL
// flavour.
//
// Same accessible combobox contract as @cnmw/maplibre's GeocoderControl
// (ARIA 1.2 combobox-with-listbox: <input role="combobox"> + <ul
// role="listbox">, arrow/enter/escape, debounce, loading/empty states,
// the design-call-#11 attribution line) and the same "what an adapter
// must not do" boundary (design doc §5.1): no index fetch, no ranking, no
// simplification, no constructing an Area by hand -- all of that stays
// inside the `Geocoder` instance this control holds.
//
// DUPLICATION NOTE (per task instructions): the design doc (§5.2) places
// the ~150 lines shared between this and @cnmw/maplibre's control in an
// unpublished `packages/_ui` workspace "for later" -- explicitly not
// forcing that split now. Extracting it today would mean editing
// @cnmw/maplibre, which is out of this package's scope while another
// agent may be touching sibling packages concurrently, so this file
// duplicates that combobox logic minimally rather than reaching into
// @cnmw/maplibre. The DOM wiring here is close to line-for-line the same
// as packages/maplibre/src/geocoder-control.js; the only real
// differences are OL's `Control` base class / lifecycle (`setMap`
// instead of `onAdd`/`onRemove`) and the projection bridge threaded
// through `addAreaLayer`/`viewportProvider`.

import Control from 'ol/control/Control.js';

import { addAreaLayer } from './area-layer.js';
import { viewportProvider } from './viewport.js';

let instanceCounter = 0;

const CSS = `
.cnmw-geocoder-ol { position: absolute; top: 10px; left: 10px; font: 13px/1.4 system-ui, sans-serif; }
.cnmw-geocoder-ol input[role="combobox"] {
  width: 260px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px;
  font: inherit; box-sizing: border-box;
}
.cnmw-geocoder-ol input[role="combobox"]:focus { outline: 2px solid #1a73e8; outline-offset: -1px; }
.cnmw-geocoder-ol .cnmw-listbox {
  position: absolute; top: 100%; left: 0; right: 0; margin: 2px 0 0; padding: 2px;
  list-style: none; background: #fff; border: 1px solid #ccc; border-radius: 4px;
  max-height: 260px; overflow-y: auto; box-shadow: 0 2px 8px rgba(0,0,0,0.15); z-index: 10;
}
.cnmw-geocoder-ol .cnmw-listbox[hidden] { display: none; }
.cnmw-geocoder-ol .cnmw-option { padding: 6px 8px; border-radius: 3px; cursor: pointer; }
.cnmw-geocoder-ol .cnmw-option[aria-selected="true"] { background: #e8f0fe; }
.cnmw-geocoder-ol .cnmw-option-name { font-weight: 500; }
.cnmw-geocoder-ol .cnmw-option-meta { color: #666; font-size: 11px; margin-left: 6px; }
.cnmw-geocoder-ol .cnmw-empty, .cnmw-geocoder-ol .cnmw-loading { padding: 8px; color: #666; }
.cnmw-geocoder-ol .cnmw-attribution { font-size: 10px; color: #888; margin-top: 4px; }
.cnmw-geocoder-ol .cnmw-attribution a { color: inherit; }
`;

function injectCssOnce() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('cnmw-ol-geocoder-style')) return;
  const style = document.createElement('style');
  style.id = 'cnmw-ol-geocoder-style';
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
 * context"). Line-for-line the same as @cnmw/maplibre's
 * `renderDefaultOption` -- see the DUPLICATION NOTE at the top of this
 * file for why it's not shared.
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

    const attribution = document.createElement('div');
    attribution.className = 'cnmw-attribution';
    attribution.hidden = true;

    container.appendChild(input);
    container.appendChild(listbox);
    container.appendChild(attribution);

    this._input = input;
    this._listbox = listbox;
    this._attributionEl = attribution;

    const debounceMs = opts.debounceMs ?? 80;
    const runSearch = debounce(() => this._doSearch(), debounceMs);

    input.addEventListener('focus', () => { this.geocoder?.load().catch(() => {}); }, { once: true });
    input.addEventListener('input', runSearch);
    input.addEventListener('keydown', (e) => this._onKeyDown(e));
    listbox.addEventListener('mousedown', (e) => {
      const li = e.target.closest('[role="option"]');
      if (li) {
        e.preventDefault();
        this._onPick(Number(li.dataset.index));
      }
    });
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) this._closeList();
    });
  }

  get area() {
    return this._area;
  }

  /** OL's lifecycle hook: called with the map on `map.addControl()`, and with `null` on removal. */
  setMap(map) {
    super.setMap(map);
    this._outline?.remove();
    this._outline = null;
    if (!map) {
      this._map = null;
      return;
    }
    this._map = map;
    const opts = this._options;
    this._outline = opts.outline === false ? null : addAreaLayer(map, { featureProjection: opts.featureProjection, ...(opts.outline || {}) });
    this._getViewport = opts.useViewport === false ? () => undefined : viewportProvider(map, { featureProjection: opts.featureProjection });
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
      const viewport = this._getViewport ? this._getViewport() : undefined;
      const results = await this.geocoder.search(query, { viewport, limit: this._options.limit });
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
