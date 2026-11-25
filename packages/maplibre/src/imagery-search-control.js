// @cngeo/maplibre -- ImagerySearchControl: find imagery scenes and add them to
// the map.
//
// A MapLibre IControl: a panel with where to search (this view, or an area the
// host supplies), a date range, the property filters the collection offers,
// an order, and result cards; and, on the map, the footprints of what was
// found. Hovering a card highlights its footprint and the reverse. "Add to
// map" hands the scene to the LayerManager as an ordinary `cog` layer.
//
// It is a view of `createImagerySearchModel` (imagery-search-model.js), which
// holds all the state and has no DOM. The search itself is injected -- an
// `ImagerySearch` from `@cngeo/stac` -- because this package does not import
// that one.
//
// Every string that comes from a remote document (a title, an id, a property,
// an error message) reaches the DOM through `textContent`; a thumbnail becomes
// an `src` only when it is http(s).

import { createImagerySearchModel, footprintsGeoJson, areaFromBounds } from './imagery-search-model.js';
import { attributionHtml } from './layer-attribution.js';
import { TOKENS_LIGHT, TOKENS_DARK } from './layer-control-theme.js';

export const FOOTPRINTS_SOURCE = 'cng-layer-imagery-footprints';
export const FOOTPRINTS_FILL = 'cng-layer-imagery-footprints--fill';
export const FOOTPRINTS_LINE = 'cng-layer-imagery-footprints--line';

const CSS = `
.cng-imagery-search {${TOKENS_LIGHT}
  color-scheme: light dark; font: 13px/1.4 system-ui, sans-serif; color: var(--cng-ink); background: var(--cng-bg);
  width: 300px; max-width: calc(100vw - 20px); border-radius: 4px; box-shadow: 0 0 0 1px var(--cng-border), 0 2px 10px var(--cng-shadow);
  display: flex; flex-direction: column; max-height: 78vh; /* then set from the map's own height; see _fit() */
}
@media (prefers-color-scheme: dark) { .cng-imagery-search {${TOKENS_DARK} } }
.cng-imagery-search * { box-sizing: border-box; }
.cng-is-header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--cng-border); }
.cng-is-header h3 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cng-is-toggle { border: 0; background: none; color: var(--cng-meta); cursor: pointer; font: inherit; padding: 2px 6px; border-radius: 3px; }
.cng-is-toggle:hover { color: var(--cng-ink); }
.cng-imagery-search.is-collapsed .cng-is-body { display: none; }
.cng-imagery-search.is-collapsed .cng-is-header { border-bottom: 0; }
.cng-is-body { display: flex; flex-direction: column; min-height: 0; }
.cng-is-form { padding: 8px 10px; display: grid; gap: 6px; border-bottom: 1px solid var(--cng-border); }
.cng-is-form fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.cng-is-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cng-is-filters:empty { display: none; }
.cng-is-filters > .is-wide { grid-column: 1 / -1; }
.cng-is-form legend, .cng-is-label { padding: 0; font-size: 11px; color: var(--cng-meta); }
.cng-is-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.cng-is-row > label { display: flex; align-items: center; gap: 4px; }
.cng-is-field { display: grid; gap: 2px; flex: 1; min-width: 0; }
.cng-is-form input[type="date"], .cng-is-form input[type="number"], .cng-is-form input[type="text"], .cng-is-form select {
  font: inherit; color: var(--cng-ink); background: var(--cng-bg); border: 1px solid var(--cng-border); border-radius: 3px; padding: 3px 5px; width: 100%; min-width: 0;
}
.cng-imagery-search :focus-visible { outline: 2px solid var(--cng-focus); outline-offset: 1px; }
.cng-is-actions { display: flex; gap: 6px; }
.cng-is-btn { font: inherit; border: 1px solid var(--cng-border); background: var(--cng-bg); color: var(--cng-ink); border-radius: 3px; padding: 4px 10px; cursor: pointer; }
.cng-is-btn:disabled { color: var(--cng-meta); cursor: default; }
.cng-is-btn.is-primary { background: var(--cng-focus); border-color: var(--cng-focus); color: var(--cng-on-focus); }
.cng-is-status { padding: 6px 10px; color: var(--cng-meta); font-size: 12px; }
.cng-is-status.is-error { color: var(--cng-error); background: var(--cng-error-bg); }
.cng-is-status details { margin-top: 2px; }
.cng-is-status summary { cursor: pointer; }
.cng-is-status ol { margin: 4px 0 0; padding-left: 18px; }
.cng-is-results { list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; }
.cng-is-card { display: grid; grid-template-columns: 64px 1fr; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--cng-border); }
.cng-is-card.is-hovered { background: var(--cng-selected-bg); }
.cng-is-thumb { width: 64px; height: 64px; border-radius: 3px; background: var(--cng-badge-bg); object-fit: cover; display: block; }
.cng-is-card-main { min-width: 0; display: grid; gap: 2px; align-content: start; }
.cng-is-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cng-is-meta { color: var(--cng-meta); font-size: 12px; overflow-wrap: anywhere; }
.cng-is-card .cng-is-btn { justify-self: start; margin-top: 2px; padding: 2px 8px; }
.cng-is-card-error { color: var(--cng-error); font-size: 12px; }
.cng-is-credit { padding: 6px 10px; border-top: 1px solid var(--cng-border); color: var(--cng-meta); font-size: 11px; }
.cng-is-credit a { color: inherit; }
`;

function injectCss(doc) {
  if (!doc || doc.getElementById('cng-imagery-search-css')) return;
  const style = doc.createElement('style');
  style.id = 'cng-imagery-search-css';
  style.textContent = CSS;
  doc.head.appendChild(style);
}

const isHttp = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);
const dayOf = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : null);
const count = (n) => Number(n).toLocaleString('en-US');
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

/** A scene's date as text: one day, or the span it covers. */
function sceneDate(scene) {
  const at = dayOf(scene.datetime);
  if (at) return at;
  const from = dayOf(scene.start);
  const to = dayOf(scene.end);
  if (from && to && from !== to) return `${from} – ${to}`;
  return from ?? to ?? '';
}

function formatValue(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  return String(value);
}

export class ImagerySearchControl {
  /**
   * @param {Object} options
   * @param {object} options.search   An `ImagerySearch` (`@cngeo/stac`).
   * @param {object} [options.profile]  Its profile. Default `search.profile`.
   * @param {import('./layer-manager.js').LayerManager} options.manager  Where an added scene goes.
   * @param {() => (import('@cngeo/spec').Area|null)} [options.area]  The host's selected area, read at search
   *   time. With it, the panel offers "Selected area" beside "This view".
   * @param {{ start?: string, end?: string }} [options.time]  Initial dates, `YYYY-MM-DD`.
   * @param {number} [options.limit]   Most scenes to show. Default 200.
   * @param {boolean} [options.collapsed]  Start closed. Default false.
   * @param {string} [options.footprintColor]  Default `#e8590c`.
   */
  constructor(options = {}) {
    if (!options.search || !options.manager) throw new TypeError('ImagerySearchControl needs a search and a LayerManager: new ImagerySearchControl({ search, manager })');
    this._options = options;
    this._manager = options.manager;
    this._color = options.footprintColor ?? '#e8590c';
    this._collapsed = options.collapsed ?? false;
    this._mode = 'view';
    /** The model; its `state` is the truth this panel shows. */
    this.model = createImagerySearchModel({ search: options.search, profile: options.profile, manager: options.manager, limit: options.limit });
    this._cleanup = [];
    this._rendered = { scenes: null, profile: null };
    this._hoverFromMap = false;
  }

  getDefaultPosition() {
    return 'top-left';
  }

  onAdd(map) {
    this._map = map;
    const doc = map.getContainer().ownerDocument;
    this._doc = doc;
    injectCss(doc);
    const root = (this._root = this._el('div', 'maplibregl-ctrl cng-imagery-search'));
    if (this._collapsed) root.classList.add('is-collapsed');

    // --- header -----------------------------------------------------------
    const header = this._el('div', 'cng-is-header');
    this._title = this._el('h3', '', '');
    const toggle = this._el('button', 'cng-is-toggle', this._collapsed ? 'Show' : 'Hide');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!this._collapsed));
    toggle.addEventListener('click', () => {
      const collapsed = root.classList.toggle('is-collapsed');
      toggle.textContent = collapsed ? 'Show' : 'Hide';
      toggle.setAttribute('aria-expanded', String(!collapsed));
    });
    header.append(this._title, toggle);

    // --- form ---------------------------------------------------------------
    const form = (this._form = this._el('form', 'cng-is-form'));
    form.setAttribute('aria-label', 'Imagery search');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.search();
    });

    if (typeof this._options.area === 'function') {
      const where = this._el('fieldset');
      where.append(this._el('legend', '', 'Search'));
      const row = this._el('div', 'cng-is-row');
      for (const [value, text] of [['view', 'This view'], ['selected', 'Selected area']]) {
        const label = this._el('label');
        const radio = this._el('input');
        radio.type = 'radio';
        radio.name = 'cng-is-where';
        radio.value = value;
        radio.checked = value === this._mode;
        radio.addEventListener('change', () => (this._mode = value));
        label.append(radio, doc.createTextNode(text));
        row.append(label);
      }
      where.append(row);
      form.append(where);
    }

    const dates = this._el('div', 'cng-is-row');
    this._from = this._dateField(dates, 'From', this._options.time?.start);
    this._to = this._dateField(dates, 'To', this._options.time?.end);
    form.append(dates);

    this._filters = this._el('div', 'cng-is-filters');
    form.append(this._filters);

    const sortField = this._el('label', 'cng-is-field');
    sortField.append(this._el('span', 'cng-is-label', 'Order'));
    this._sort = this._el('select');
    this._sort.addEventListener('change', () => this.model.setSort(JSON.parse(this._sort.value)));
    sortField.append(this._sort);
    form.append(sortField);

    const actions = this._el('div', 'cng-is-actions');
    this._go = this._el('button', 'cng-is-btn is-primary', 'Search');
    this._go.type = 'submit';
    this._stop = this._el('button', 'cng-is-btn', 'Stop');
    this._stop.type = 'button';
    this._stop.hidden = true;
    this._stop.addEventListener('click', () => this.model.cancel());
    actions.append(this._go, this._stop);
    form.append(actions);

    // --- status, results, credit ------------------------------------------------
    this._status = this._el('div', 'cng-is-status');
    this._status.setAttribute('role', 'status');
    this._status.setAttribute('aria-live', 'polite');
    this._results = this._el('ul', 'cng-is-results');
    this._results.setAttribute('aria-label', 'Scenes found');
    this._credit = this._el('div', 'cng-is-credit');

    const body = this._el('div', 'cng-is-body');
    body.append(form, this._status, this._results, this._credit);
    root.append(header, body);

    // --- wiring -------------------------------------------------------------------
    this._cleanup.push(this.model.on('change', () => this._render()));
    this._onMove = (event) => {
      const id = event.features?.[0]?.properties?.id ?? null;
      this._hoverFromMap = true;
      this.model.hover(id);
      this._hoverFromMap = false;
    };
    this._onLeave = () => this.model.hover(null);
    this._onStyle = () => this._syncFootprints();
    // The panel is as tall as the MAP allows, not the window: a map in a
    // small box would otherwise have a panel hanging out of it.
    this._fit = () => {
      const height = map.getContainer().clientHeight;
      if (height > 0) root.style.maxHeight = `${Math.max(220, height - 20)}px`;
    };
    map.on('mousemove', FOOTPRINTS_FILL, this._onMove);
    map.on('mouseleave', FOOTPRINTS_FILL, this._onLeave);
    map.on('styledata', this._onStyle);
    map.on('resize', this._fit);
    this._fit();
    this._cleanup.push(() => {
      map.off('mousemove', FOOTPRINTS_FILL, this._onMove);
      map.off('mouseleave', FOOTPRINTS_FILL, this._onLeave);
      map.off('styledata', this._onStyle);
      map.off('resize', this._fit);
    });
    this._render();
    // Resolve the dataset and settle the profile while the person is still
    // reading the panel. A failure here is reported by the search that follows.
    this.ready = this.model.warm().catch(() => {});
    return root;
  }

  onRemove() {
    for (const off of this._cleanup.splice(0)) off();
    this.model.destroy();
    const map = this._map;
    if (map) {
      this._manager.setTopLayers?.([]);
      for (const id of [FOOTPRINTS_LINE, FOOTPRINTS_FILL]) if (map.getLayer?.(id)) map.removeLayer(id);
      if (map.getSource?.(FOOTPRINTS_SOURCE)) map.removeSource(FOOTPRINTS_SOURCE);
    }
    this._root?.remove();
    this._map = null;
  }

  /**
   * Run a search with what the panel shows now. Returns when it has finished.
   * @returns {Promise<void>}
   */
  async search() {
    const map = this._map;
    if (!map) return;
    let area = null;
    if (this._mode === 'selected') {
      area = this._options.area?.() ?? null;
      if (!area) {
        this._notice = 'No area is selected. Select one, or search this view.';
        this._render();
        return;
      }
    } else {
      const b = map.getBounds();
      area = areaFromBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    }
    this._notice = null;
    this.model.setArea(area);
    // Dates are whole days, and "to" is inclusive: the window ends at the next midnight.
    const start = this._from.value ? `${this._from.value}T00:00:00Z` : undefined;
    const endMs = this._to.value ? Date.parse(`${this._to.value}T00:00:00Z`) : NaN;
    this.model.setTime({ start, end: Number.isFinite(endMs) ? new Date(endMs + 86_400_000).toISOString() : undefined });
    await this.model.run();
  }

  // --- building blocks --------------------------------------------------------------

  _el(tag, className = '', text) {
    const node = this._doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  _dateField(parent, label, value) {
    const field = this._el('label', 'cng-is-field');
    field.append(this._el('span', 'cng-is-label', label));
    const input = this._el('input');
    input.type = 'date';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) input.value = value;
    field.append(input);
    parent.append(field);
    return input;
  }

  _numberInput(label, value, onChange) {
    const input = this._el('input');
    input.type = 'number';
    input.step = 'any';
    input.placeholder = 'any';
    input.setAttribute('aria-label', label);
    if (value !== undefined && value !== null) input.value = String(value);
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  /** The filter inputs and the order menu, from the profile. Rebuilt only when the profile changes. */
  _renderProfile(profile) {
    this._title.textContent = profile?.title ?? profile?.id ?? 'Imagery';
    const values = this.model.state.filters;
    this._filters.replaceChildren();
    const orders = [
      ['Newest first', { by: 'datetime', order: 'desc' }],
      ['Oldest first', { by: 'datetime', order: 'asc' }],
    ];
    for (const filter of profile?.filters ?? []) {
      const field = this._el('div', 'cng-is-field');
      const set = (value) => this.model.setFilter(filter.column, value);
      if (filter.kind === 'range') {
        field.classList.add('is-wide');
        field.append(this._el('span', 'cng-is-label', filter.label));
        const row = this._el('div', 'cng-is-row');
        const current = () => this.model.state.filters[filter.column] ?? {};
        const min = this._numberInput(`${filter.label}, from`, values[filter.column]?.min, (v) => set({ ...current(), min: v }));
        const max = this._numberInput(`${filter.label}, to`, values[filter.column]?.max, (v) => set({ ...current(), max: v }));
        min.style.flex = max.style.flex = '1';
        row.append(min, this._doc.createTextNode('–'), max);
        field.append(row);
      } else if (filter.kind === 'enum' && Array.isArray(filter.values) && filter.values.length) {
        const label = this._el('label', 'cng-is-field');
        label.append(this._el('span', 'cng-is-label', filter.label));
        const select = this._el('select');
        select.append(new this._doc.defaultView.Option('Any', ''));
        for (const v of filter.values) select.append(new this._doc.defaultView.Option(String(v), String(v)));
        select.value = values[filter.column] === undefined ? '' : String(values[filter.column]);
        select.addEventListener('change', () => set(select.value));
        label.append(select);
        field.append(label);
      } else if (filter.kind === 'enum') {
        const label = this._el('label', 'cng-is-field');
        label.append(this._el('span', 'cng-is-label', filter.label));
        const input = this._el('input');
        input.type = 'text';
        input.placeholder = 'any';
        if (typeof values[filter.column] === 'string') input.value = values[filter.column];
        input.addEventListener('input', () => set(input.value.trim()));
        label.append(input);
        field.append(label);
      } else {
        const bound = filter.kind === 'min' ? 'at least' : 'at most';
        const label = this._el('label', 'cng-is-field');
        label.append(this._el('span', 'cng-is-label', `${filter.label}, ${bound}`));
        label.append(this._numberInput(`${filter.label}, ${bound}`, values[filter.column], set));
        field.append(label);
        orders.push([`${filter.kind === 'min' ? 'Highest' : 'Lowest'} ${filter.label.toLowerCase()}`, { by: filter.column, order: filter.kind === 'min' ? 'desc' : 'asc' }]);
      }
      this._filters.append(field);
    }
    this._sort.replaceChildren();
    const chosen = JSON.stringify(this.model.state.sort);
    for (const [text, sort] of orders) {
      const option = new this._doc.defaultView.Option(text, JSON.stringify(sort));
      option.selected = JSON.stringify(sort) === chosen;
      this._sort.append(option);
    }
    this._credit.innerHTML = attributionHtml(profile?.attribution); // escaped, http(s) links only
    this._credit.hidden = !this._credit.textContent;
  }

  _renderStatus(state) {
    const status = this._status;
    status.replaceChildren();
    status.classList.toggle('is-error', state.status === 'error');
    const say = (text) => status.append(this._el('div', '', text));
    if (this._notice) say(this._notice);
    else if (state.status === 'error') {
      // The library's message names the step; the cause, when there is one,
      // is usually what a person can act on ("Failed to fetch").
      const cause = state.error?.cause?.message;
      say(`The search failed: ${state.error?.message ?? state.error}${cause ? ` (${cause})` : ''}`);
    }
    else if (state.status === 'searching') {
      const p = state.progress;
      say(state.plan ? `Reading${p ? ` ${count(p.rowGroupsDone)} of ${count(p.rowGroupsTotal)} row groups` : ''}… ${plural(state.scenes.length, 'scene')} so far.` : 'Planning the search…');
    } else if (state.status === 'done') {
      const n = state.scenes.length;
      if (n === 0) say('No scenes match.');
      else if (state.partial) say(`Showing ${plural(n, 'scene')} from the first ${count(state.matched)} that matched; there are more. Narrow the area or the dates to see them all.`);
      else if (state.truncated) say(`Showing ${count(n)} of ${plural(state.matched, 'matching scene')}.`);
      else say(`${plural(n, 'scene')}.`);
    } else if (!state.scenes.length) say('Search for scenes in this view.');

    const plan = state.plan;
    if (plan && state.status !== 'error') {
      const details = this._el('details');
      // Row groups and files, not `plan.requests`: that figure models one
      // request per row group, and the reader makes one per column chunk
      // (E14 measured 4x on Sentinel-2), so it would understate the work.
      details.append(this._el('summary', '', `Read ${count(plan.rowGroups.selected)} of ${plural(plan.rowGroups.total, 'row group')} in ${count(plan.files.selected)} of ${plural(plan.files.total, 'file')}`));
      const list = this._el('ol');
      for (const stage of plan.prune ?? []) list.append(this._el('li', '', `${stage.stage}: ${count(stage.before)} → ${count(stage.after)} (${stage.basis})`));
      if (list.childElementCount) details.append(list);
      status.append(details);
    }
    this._go.textContent = state.status === 'error' ? 'Try again' : 'Search';
    this._stop.hidden = state.status !== 'searching';
  }

  _renderCards(state) {
    const filters = state.profile?.filters ?? [];
    const cards = state.scenes.map((scene) => {
      const card = this._el('li', 'cng-is-card');
      card.dataset.sceneId = scene.id;
      const thumb = isHttp(scene.thumbnail) ? this._el('img', 'cng-is-thumb') : this._el('div', 'cng-is-thumb');
      if (thumb.tagName === 'IMG') {
        thumb.loading = 'lazy';
        thumb.decoding = 'async';
        thumb.alt = '';
        thumb.referrerPolicy = 'no-referrer';
        thumb.src = scene.thumbnail;
      }
      const main = this._el('div', 'cng-is-card-main');
      const title = typeof scene.properties?.title === 'string' && scene.properties.title ? scene.properties.title : scene.id;
      const heading = this._el('div', 'cng-is-title', title);
      heading.title = scene.id;
      main.append(heading);
      const facts = [sceneDate(scene)];
      for (const filter of filters) {
        const value = scene.properties?.[filter.column];
        if (value !== undefined && value !== null && value !== '') facts.push(`${filter.label}: ${formatValue(value)}`);
      }
      main.append(this._el('div', 'cng-is-meta', facts.filter(Boolean).join(' · ')));
      const add = this._el('button', 'cng-is-btn');
      add.type = 'button';
      add.dataset.role = 'add';
      add.addEventListener('click', () => this.model.add(scene.id));
      main.append(add);
      main.append(this._el('div', 'cng-is-card-error'));
      card.append(thumb, main);
      card.addEventListener('mouseenter', () => this.model.hover(scene.id));
      card.addEventListener('mouseleave', () => this.model.hover(null));
      card.addEventListener('focusin', () => this.model.hover(scene.id));
      card.addEventListener('focusout', () => this.model.hover(null));
      return card;
    });
    this._results.replaceChildren(...cards);
  }

  /** What changes without the list changing: the hovered card, and each card's button. */
  _patchCards(state) {
    for (const card of this._results.children) {
      const id = card.dataset.sceneId;
      const hovered = id === state.hovered;
      if (hovered && !card.classList.contains('is-hovered') && this._hoverFromMap) card.scrollIntoView?.({ block: 'nearest' });
      card.classList.toggle('is-hovered', hovered);
      const button = card.querySelector('[data-role="add"]');
      const added = state.added.has(id);
      const adding = state.adding.has(id);
      button.textContent = added ? 'Added' : adding ? 'Adding…' : 'Add to map';
      button.disabled = added || adding;
      const error = state.addError?.id === id ? state.addError.error : null;
      card.querySelector('.cng-is-card-error').textContent = error ? `Could not add: ${error.message ?? error}` : '';
    }
  }

  _render() {
    if (!this._root) return;
    const state = this.model.state;
    if (this._rendered.profile !== state.profile) {
      this._rendered.profile = state.profile;
      this._renderProfile(state.profile);
    }
    this._renderStatus(state);
    if (this._rendered.scenes !== state.scenes) {
      this._rendered.scenes = state.scenes;
      this._renderCards(state);
    }
    this._patchCards(state);
    this._syncFootprints();
  }

  /**
   * Keep the footprints on the map and current. Runs on every change of the
   * model and on every `styledata`, so it survives `map.setStyle()`; it only
   * touches the map when the data changed or the layers are missing.
   */
  _syncFootprints() {
    const map = this._map;
    if (!map || (map.isStyleLoaded && !map.isStyleLoaded() && !map.getSource?.(FOOTPRINTS_SOURCE))) return;
    const state = this.model.state;
    const key = `${state.hovered ?? ''}`;
    const stale = this._drawn?.scenes !== state.scenes || this._drawn?.hovered !== key;
    let source = map.getSource(FOOTPRINTS_SOURCE);
    if (!source) {
      map.addSource(FOOTPRINTS_SOURCE, { type: 'geojson', data: footprintsGeoJson(state.scenes, state.hovered) });
      this._drawn = { scenes: state.scenes, hovered: key };
      source = map.getSource(FOOTPRINTS_SOURCE);
    } else if (stale) {
      source.setData(footprintsGeoJson(state.scenes, state.hovered));
      this._drawn = { scenes: state.scenes, hovered: key };
    }
    if (map.getLayer(FOOTPRINTS_FILL) && map.getLayer(FOOTPRINTS_LINE)) return;
    const anchor = this._manager.anchor?.();
    const before = anchor && map.getLayer(anchor) ? anchor : undefined;
    const hovered = ['boolean', ['get', 'hovered'], false];
    if (!map.getLayer(FOOTPRINTS_FILL)) {
      // Only the hovered footprint is visibly filled. Scenes overlap heavily
      // -- a month of Sentinel-2 puts a dozen on the same tile -- and even a
      // faint fill on each stacks into a solid colour over the map and over
      // any image added to it (seen live: 27 footprints at 6% hid both). The
      // rest keep a fill too faint to see, so the map can still tell which
      // footprint the pointer is over.
      map.addLayer({ id: FOOTPRINTS_FILL, type: 'fill', source: FOOTPRINTS_SOURCE, paint: { 'fill-color': this._color, 'fill-opacity': ['case', hovered, 0.28, 0.002] } }, before);
    }
    if (!map.getLayer(FOOTPRINTS_LINE)) {
      map.addLayer({ id: FOOTPRINTS_LINE, type: 'line', source: FOOTPRINTS_SOURCE, paint: { 'line-color': this._color, 'line-width': ['case', hovered, 3, 1], 'line-opacity': ['case', hovered, 1, 0.7] } }, before);
    }
    // Keeping them above the stack is the manager's job, not a `moveLayer`
    // here: deck.gl puts an image's layer group directly under whatever it is
    // slotted beneath and moves it back on every update, so the footprints
    // have to BE what the stack is slotted beneath. Declared each time the
    // layers are (re)made -- after `map.setStyle()` they are new layers.
    this._manager.setTopLayers?.([FOOTPRINTS_FILL, FOOTPRINTS_LINE]);
  }
}
