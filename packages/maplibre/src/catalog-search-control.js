// @cngeo/maplibre -- CatalogSearchControl: find collections in a catalog and
// add them to the map.
//
// A MapLibre IControl: a search box, an "only this map area" switch, menus
// for the catalog's facets (which catalog, which licence, and -- when the
// index says -- what kind of thing), and result cards. Hovering a card shows
// the collection's extent on the map. "Add to map" resolves the collection to
// layers and hands the drawable ones to the LayerManager; when some or all of
// it cannot be drawn, the card says what and why.
//
// It is a view of `createCatalogSearchModel` (catalog-search-model.js), which
// holds all the state and has no DOM. The index is injected -- a
// `CatalogIndex` from `@cngeo/stac` -- because this package does not import
// that one.
//
// Everything that comes from a remote document (titles, descriptions, ids,
// licences, error messages) reaches the DOM through `textContent`; a
// thumbnail becomes an `src` only when it is http(s).

import { createCatalogSearchModel, catalogStatusOf, extentsGeoJson } from './catalog-search-model.js';
import { areaFromBounds } from './imagery-search-model.js';
import { TOKENS_LIGHT, TOKENS_DARK } from './layer-control-theme.js';

export const EXTENT_SOURCE = 'cng-layer-catalog-extent';
export const EXTENT_FILL = 'cng-layer-catalog-extent--fill';
export const EXTENT_LINE = 'cng-layer-catalog-extent--line';

const DEBOUNCE_MS = 200;

/** What a result draws as, in a word or two. */
export const KIND_LABELS = Object.freeze({
  'pmtiles-vector': 'Vector tiles',
  cog: 'Image',
  scenes: 'Imagery scenes',
  geojson: 'Vector',
  timeline: 'Time series',
  table: 'Table',
  unsupported: 'Not drawable',
});

const CSS = `
.cng-catalog-search {${TOKENS_LIGHT}
  color-scheme: light dark; font: 13px/1.4 system-ui, sans-serif; color: var(--cng-ink); background: var(--cng-bg);
  width: 320px; max-width: calc(100vw - 20px); border-radius: 4px; box-shadow: 0 0 0 1px var(--cng-border), 0 2px 10px var(--cng-shadow);
  display: flex; flex-direction: column; max-height: 78vh; /* then set from the map's own height; see _fit() */
}
@media (prefers-color-scheme: dark) { .cng-catalog-search {${TOKENS_DARK} } }
.cng-catalog-search * { box-sizing: border-box; }
.cng-cs-header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--cng-border); }
.cng-cs-header h3 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; }
.cng-cs-toggle { border: 0; background: none; color: var(--cng-meta); cursor: pointer; font: inherit; padding: 2px 6px; border-radius: 3px; }
.cng-cs-toggle:hover { color: var(--cng-ink); }
.cng-catalog-search.is-collapsed .cng-cs-body { display: none; }
.cng-catalog-search.is-collapsed .cng-cs-header { border-bottom: 0; }
.cng-cs-body { display: flex; flex-direction: column; min-height: 0; }
.cng-cs-form { padding: 8px 10px; display: grid; gap: 6px; border-bottom: 1px solid var(--cng-border); }
.cng-cs-form input[type="search"], .cng-cs-form select {
  font: inherit; color: var(--cng-ink); background: var(--cng-bg); border: 1px solid var(--cng-border); border-radius: 3px; padding: 4px 6px; width: 100%; min-width: 0;
}
.cng-catalog-search :focus-visible { outline: 2px solid var(--cng-focus); outline-offset: 1px; }
.cng-cs-check { display: flex; align-items: center; gap: 6px; }
.cng-cs-facets { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cng-cs-facets label { display: grid; gap: 2px; min-width: 0; }
.cng-cs-facets label[hidden] { display: none; }
.cng-cs-label { font-size: 11px; color: var(--cng-meta); }
.cng-cs-status { padding: 6px 10px; color: var(--cng-meta); font-size: 12px; min-height: 1.4em; }
.cng-cs-status.is-error { color: var(--cng-error); background: var(--cng-error-bg); }
.cng-cs-results { list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; }
.cng-cs-card { display: grid; grid-template-columns: 1fr; gap: 3px; padding: 8px 10px; border-top: 1px solid var(--cng-border); }
.cng-cs-card.has-thumb { grid-template-columns: 56px 1fr; column-gap: 8px; }
.cng-cs-card.is-hovered { background: var(--cng-selected-bg); }
.cng-cs-thumb { width: 56px; height: 56px; border-radius: 3px; background: var(--cng-badge-bg); object-fit: cover; grid-row: span 4; }
.cng-cs-title { font-weight: 600; overflow-wrap: anywhere; }
.cng-cs-meta { color: var(--cng-meta); font-size: 12px; overflow-wrap: anywhere; }
.cng-cs-badge { display: inline-block; font-size: 10px; color: var(--cng-badge-ink); background: var(--cng-badge-bg); border-radius: 3px; padding: 0 5px; margin-right: 4px; }
.cng-cs-desc { font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cng-cs-btn { font: inherit; border: 1px solid var(--cng-border); background: var(--cng-bg); color: var(--cng-ink); border-radius: 3px; padding: 2px 8px; cursor: pointer; justify-self: start; margin-top: 2px; }
.cng-cs-btn:disabled { color: var(--cng-meta); cursor: default; }
.cng-cs-note { font-size: 12px; color: var(--cng-meta); }
.cng-cs-note.is-error { color: var(--cng-error); }
.cng-cs-note:empty { display: none; }
`;

function injectCss(doc) {
  if (!doc || doc.getElementById('cng-catalog-search-css')) return;
  const style = doc.createElement('style');
  style.id = 'cng-catalog-search-css';
  style.textContent = CSS;
  doc.head.appendChild(style);
}

const isHttp = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);
const yearOf = (iso) => (typeof iso === 'string' && iso.length >= 4 ? iso.slice(0, 4) : null);

/** A collection's dates in a few characters: "2020–2021", "since 2023", "". */
function yearsOf(result) {
  const from = yearOf(result.start);
  const to = yearOf(result.end);
  if (from && to) return from === to ? from : `${from}–${to}`;
  if (from) return `since ${from}`;
  return to ? `until ${to}` : '';
}

export class CatalogSearchControl {
  /**
   * @param {Object} options
   * @param {object} options.index   A `CatalogIndex` (`@cngeo/stac`).
   * @param {import('./layer-manager.js').LayerManager} options.manager  Where an added collection's layers go.
   * @param {number} [options.limit]      Most results to show. Default 50.
   * @param {boolean} [options.collapsed] Start closed. Default false.
   * @param {boolean} [options.useView]   Start with "only this map area" on. Default false.
   * @param {string} [options.title]      The panel's heading. Default "Catalog".
   * @param {string} [options.extentColor] Default `#1971c2`.
   */
  constructor(options = {}) {
    if (!options.index || !options.manager) throw new TypeError('CatalogSearchControl needs an index and a LayerManager: new CatalogSearchControl({ index, manager })');
    this._options = options;
    this._manager = options.manager;
    this._color = options.extentColor ?? '#1971c2';
    this._collapsed = options.collapsed ?? false;
    /** The model; its `state` is the truth this panel shows. Replaced if the control is removed and added again. */
    this.model = this._newModel();
    this._cleanup = [];
    this._rendered = {};
  }

  _newModel() {
    const o = this._options;
    const model = createCatalogSearchModel({ index: o.index, manager: o.manager, limit: o.limit });
    if (o.useView) model.setUseView(true);
    return model;
  }

  getDefaultPosition() {
    return 'top-left';
  }

  onAdd(map) {
    this._map = map;
    const doc = (this._doc = map.getContainer().ownerDocument);
    injectCss(doc);
    // `onRemove` destroys the model; a control added again needs a live one.
    if (this.model.destroyed) this.model = this._newModel();
    this._rendered = {};
    this._drawn = null;

    const root = (this._root = this._el('div', 'maplibregl-ctrl cng-catalog-search'));
    if (this._collapsed) root.classList.add('is-collapsed');
    const header = this._el('div', 'cng-cs-header');
    header.append(this._el('h3', '', this._options.title ?? 'Catalog'));
    const toggle = (this._toggle = this._el('button', 'cng-cs-toggle', this._collapsed ? 'Show' : 'Hide'));
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!this._collapsed));
    toggle.addEventListener('click', () => this._setCollapsed(!root.classList.contains('is-collapsed')));
    header.append(toggle);

    // --- form -------------------------------------------------------------------
    const form = this._el('form', 'cng-cs-form');
    form.setAttribute('role', 'search');
    form.setAttribute('aria-label', 'Catalog search');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this._searchNow();
    });
    const input = (this._input = this._el('input'));
    input.type = 'search';
    input.placeholder = 'Search collections…';
    input.setAttribute('aria-label', 'Search collections');
    input.autocomplete = 'off';
    input.value = this.model.state.text;
    input.addEventListener('input', () => this._searchSoon());
    form.append(input);

    const check = this._el('label', 'cng-cs-check');
    const box = (this._viewBox = this._el('input'));
    box.type = 'checkbox';
    box.checked = this.model.state.useView;
    box.addEventListener('change', () => {
      this.model.setUseView(box.checked);
      this._searchNow();
    });
    check.append(box, doc.createTextNode('Only this map area'));
    form.append(check);

    const facets = this._el('div', 'cng-cs-facets');
    this._facets = {};
    for (const [name, label] of [['catalog', 'Catalog'], ['license', 'Licence'], ['kinds', 'Draws as']]) {
      const wrap = this._el('label');
      wrap.append(this._el('span', 'cng-cs-label', label));
      const select = this._el('select');
      select.addEventListener('change', () => {
        this.model.setFacet(name, select.value || null);
        this._searchNow();
      });
      wrap.append(select);
      facets.append(wrap);
      this._facets[name] = { wrap, select };
    }
    form.append(facets);

    // --- status and results --------------------------------------------------------
    this._status = this._el('div', 'cng-cs-status');
    this._status.setAttribute('role', 'status');
    this._status.setAttribute('aria-live', 'polite');
    this._results = this._el('ul', 'cng-cs-results');
    this._results.setAttribute('aria-label', 'Collections found');
    const body = this._el('div', 'cng-cs-body');
    body.append(form, this._status, this._results);
    root.append(header, body);

    // --- wiring ----------------------------------------------------------------------
    this._cleanup.push(this.model.on('change', () => this._render()));
    this._onMove = () => {
      this._readView();
      if (this.model.state.useView) this._searchSoon();
    };
    this._onStyle = () => this._syncExtent();
    // The panel is as tall as the MAP allows, not the window.
    this._fit = () => {
      const height = map.getContainer().clientHeight;
      if (height > 0) root.style.maxHeight = `${Math.max(220, height - 20)}px`;
    };
    map.on('moveend', this._onMove);
    // After `map.setStyle()` the extent's source and layers are gone:
    // `style.load` is when they can go back, `idle` catches a missed chance.
    map.on('style.load', this._onStyle);
    map.on('idle', this._onStyle);
    map.on('resize', this._fit);
    this._fit();
    this._cleanup.push(() => {
      map.off('moveend', this._onMove);
      map.off('style.load', this._onStyle);
      map.off('idle', this._onStyle);
      map.off('resize', this._fit);
      clearTimeout(this._timer);
    });

    this._readView();
    this._render();
    // Load the index and list what it has, so the panel is never an empty box.
    this.ready = this.model.run();
    return root;
  }

  onRemove() {
    for (const off of this._cleanup.splice(0)) off();
    this.model.destroy();
    const map = this._map;
    if (map) {
      this._manager.setTopLayers?.([], EXTENT_SOURCE);
      for (const id of [EXTENT_LINE, EXTENT_FILL]) if (map.getLayer?.(id)) map.removeLayer(id);
      if (map.getSource?.(EXTENT_SOURCE)) map.removeSource(EXTENT_SOURCE);
    }
    this._root?.remove();
    this._map = null;
  }

  /** Open the panel and put the cursor in its search box. */
  show() {
    if (!this._root) return;
    this._setCollapsed(false);
    this._input.focus();
  }

  /**
   * Search for `text` now (or for what the box holds). Returns when it has finished.
   * @param {string} [text]
   * @returns {Promise<void>}
   */
  search(text) {
    if (typeof text === 'string' && this._input) this._input.value = text;
    return this._searchNow();
  }

  // --- internals ------------------------------------------------------------------------

  _el(tag, className = '', text) {
    const node = this._doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  _setCollapsed(collapsed) {
    this._root.classList.toggle('is-collapsed', collapsed);
    this._toggle.textContent = collapsed ? 'Show' : 'Hide';
    this._toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  _readView() {
    const b = this._map?.getBounds?.();
    if (b) this.model.setArea(areaFromBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]));
  }

  _searchSoon() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._searchNow(), DEBOUNCE_MS);
  }

  _searchNow() {
    clearTimeout(this._timer);
    if (!this._map) return Promise.resolve();
    this.model.setText(this._input.value);
    return this.model.run();
  }

  /** Fill a facet menu from its counts. The chosen value stays in the menu even when nothing else matches it. */
  _renderFacet(name, values, chosen) {
    const { wrap, select } = this._facets[name];
    const Option = this._doc.defaultView.Option;
    const options = [new Option('Any', '')];
    const seen = new Set();
    for (const { value, count } of values) {
      seen.add(value);
      options.push(new Option(`${name === 'kinds' ? (KIND_LABELS[value] ?? value) : value} (${Number(count).toLocaleString('en-US')})`, value));
    }
    if (chosen && !seen.has(chosen)) options.push(new Option(`${name === 'kinds' ? (KIND_LABELS[chosen] ?? chosen) : chosen} (0)`, chosen));
    select.replaceChildren(...options);
    select.value = chosen ?? '';
    // A menu with nothing to choose is noise: the kinds menu, on an index that does not say.
    wrap.hidden = values.length === 0 && !chosen;
  }

  _renderCards(state) {
    const cards = state.results.map((result) => {
      const card = this._el('li', 'cng-cs-card');
      card.dataset.key = result.key;
      if (isHttp(result.thumbnail)) {
        card.classList.add('has-thumb');
        const img = this._el('img', 'cng-cs-thumb');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.src = result.thumbnail;
        card.append(img);
      }
      const title = this._el('div', 'cng-cs-title', result.title);
      title.title = result.id;
      card.append(title);
      const meta = this._el('div', 'cng-cs-meta');
      for (const kind of result.kinds ?? []) meta.append(this._el('span', 'cng-cs-badge', KIND_LABELS[kind] ?? kind));
      meta.append(this._doc.createTextNode([result.catalog, result.license, yearsOf(result)].filter(Boolean).join(' · ')));
      card.append(meta);
      if (result.description) card.append(this._el('div', 'cng-cs-desc', result.description));
      const add = this._el('button', 'cng-cs-btn');
      add.type = 'button';
      add.dataset.role = 'add';
      add.addEventListener('click', () => this.model.add(result.key));
      card.append(add);
      const note = this._el('div', 'cng-cs-note');
      note.setAttribute('role', 'status');
      card.append(note);
      card.addEventListener('mouseenter', () => this.model.hover(result.key));
      card.addEventListener('mouseleave', () => this.model.hover(null));
      card.addEventListener('focusin', () => this.model.hover(result.key));
      card.addEventListener('focusout', () => this.model.hover(null));
      return card;
    });
    this._results.replaceChildren(...cards);
  }

  /** What changes without the list changing: the hovered card, each card's button and note. */
  _patchCards(state) {
    for (const card of this._results.children) {
      const key = card.dataset.key;
      card.classList.toggle('is-hovered', key === state.hovered);
      const button = card.querySelector('[data-role="add"]');
      const added = state.added.has(key);
      const adding = state.adding.has(key);
      const label = added ? 'Added' : adding ? 'Adding…' : 'Add to map';
      if (button.textContent !== label) button.textContent = label;
      button.disabled = added || adding;
      const note = card.querySelector('.cng-cs-note');
      const mine = state.addNote?.id === key ? state.addNote : null;
      const text = mine?.text ?? '';
      if (note.textContent !== text) note.textContent = text;
      note.classList.toggle('is-error', mine?.tone === 'error');
    }
  }

  _render() {
    if (!this._root) return;
    const state = this.model.state;
    // The status line is written only when its words change: it is a live
    // region, and this runs on every hover.
    const said = catalogStatusOf(state);
    if (this._rendered.line !== said.line) this._status.textContent = said.line;
    if (this._rendered.tone !== said.tone) this._status.classList.toggle('is-error', said.tone === 'error');
    this._rendered.line = said.line;
    this._rendered.tone = said.tone;
    if (this._rendered.facets !== state.facets || this._rendered.filters !== JSON.stringify(state.filters)) {
      this._rendered.facets = state.facets;
      this._rendered.filters = JSON.stringify(state.filters);
      for (const name of ['catalog', 'license', 'kinds']) this._renderFacet(name, state.facets[name] ?? [], state.filters[name] ?? null);
    }
    if (this._rendered.results !== state.results) {
      this._rendered.results = state.results;
      this._renderCards(state);
    }
    this._patchCards(state);
    this._syncExtent();
  }

  /**
   * Show the hovered result's extent on the map. Runs on every change of the
   * model, and on `style.load` and `idle` so it survives `map.setStyle()`.
   * MapLibre says whether it can take a source right now by throwing; the
   * next `idle` tries again.
   */
  _syncExtent() {
    const map = this._map;
    if (!map) return;
    try {
      this._placeExtent(map);
    } catch {
      this._drawn = null;
    }
  }

  _placeExtent(map) {
    const state = this.model.state;
    const stale = this._drawn?.results !== state.results || this._drawn?.hovered !== state.hovered;
    const source = map.getSource(EXTENT_SOURCE);
    if (!source) {
      map.addSource(EXTENT_SOURCE, { type: 'geojson', data: extentsGeoJson(state.results, state.hovered) });
      this._drawn = { results: state.results, hovered: state.hovered };
    } else if (stale) {
      source.setData(extentsGeoJson(state.results, state.hovered));
      this._drawn = { results: state.results, hovered: state.hovered };
    }
    if (map.getLayer(EXTENT_FILL) && map.getLayer(EXTENT_LINE)) return;
    const anchor = this._manager.anchor?.();
    const before = anchor && map.getLayer(anchor) ? anchor : undefined;
    // Only the hovered result is drawn: fifty overlapping extents, a third of
    // them the whole world, would say nothing.
    const hovered = ['==', ['get', 'hovered'], true];
    if (!map.getLayer(EXTENT_FILL)) map.addLayer({ id: EXTENT_FILL, type: 'fill', source: EXTENT_SOURCE, filter: hovered, paint: { 'fill-color': this._color, 'fill-opacity': 0.15 } }, before);
    if (!map.getLayer(EXTENT_LINE)) map.addLayer({ id: EXTENT_LINE, type: 'line', source: EXTENT_SOURCE, filter: hovered, paint: { 'line-color': this._color, 'line-width': 2 } }, before);
    // Above the layer stack is the manager's to keep (see LayerManager.setTopLayers).
    this._manager.setTopLayers?.([EXTENT_FILL, EXTENT_LINE], EXTENT_SOURCE);
  }
}

/**
 * A `LayerControl` add-provider that opens a catalog search panel already on
 * the map: "Add" in the layer panel then leads to the catalog.
 * @param {CatalogSearchControl} control
 * @param {{ label?: string }} [options]
 */
export function catalogAddProvider(control, options = {}) {
  return {
    id: 'catalog',
    label: options.label ?? 'Search the catalog…',
    open({ close }) {
      close?.();
      control.show();
    },
  };
}
