// @cngeo/maplibre -- LayerControl: the layer panel.
//
// A MapLibre IControl that shows a LayerManager's stack and lets a person
// toggle, fade, reorder, remove, zoom to and add layers. The LayerManager is
// the truth; this is a view of it.
//
// The panel itself is opengeos' maplibre-gl-layer-control, adopted after
// experiments/e12-deck-bundle's Gate B (see layer-control-loader.js for why).
// What this module adds around it:
//   - an adapter, so every LayerSpec is one row and every action lands on the
//     LayerManager (layer-control-adapter.js);
//   - the --cng-* theme with dark mode (layer-control-theme.js);
//   - keyboard and screen-reader access (layer-control-a11y.js);
//   - an Add button that opens add-providers (add-providers.js);
//   - a line under a row when its layer has something to say: a style that
//     could not be loaded, an error.
//
// The upstream control is loaded lazily, so `onAdd` returns an empty element
// and fills it in; `control.ready` resolves when the panel is up.

import { loadLayerControl, ensureLayerControlCss } from './layer-control-loader.js';
import { injectLayerControlTheme } from './layer-control-theme.js';
import { attachPanelA11y } from './layer-control-a11y.js';
import { createControlAdapter, applyPanelOrder } from './layer-control-adapter.js';

const ROW = '.layer-control-item[data-layer-id]';

export class LayerControl {
  /**
   * @param {Object} options
   * @param {import('./layer-manager.js').LayerManager} options.manager
   * @param {{ id: string, label: string, open: Function }[]} [options.addProviders] What the Add button offers.
   *   With none, there is no Add button.
   * @param {string} [options.basemapStyleUrl] The basemap's style URL. Its layers are then grouped under one
   *   "Background" row instead of listed individually.
   * @param {boolean} [options.collapsed] Start with the panel closed. Default false.
   */
  constructor(options = {}) {
    if (!options.manager) throw new TypeError('LayerControl needs a LayerManager: new LayerControl({ manager })');
    this._manager = options.manager;
    this._providers = options.addProviders ?? [];
    this._basemapStyleUrl = options.basemapStyleUrl;
    this._collapsed = options.collapsed ?? false;
    this._inner = null;
    this._cleanup = [];
    this._removed = false;
    /** True while the PANEL is telling us about a reorder, so we do not echo it back. */
    this._fromPanel = false;
    /** Resolves when the panel is on the map. */
    this.ready = Promise.resolve();
  }

  onAdd(map) {
    this._map = map;
    this._removed = false;
    const doc = map.getContainer().ownerDocument;
    this._container = doc.createElement('div');
    this._container.className = 'cng-layer-control';
    this.ready = this._init(map, doc);
    // A failure to load the panel must not become an unhandled rejection for
    // a caller who never awaits `ready`; it is reported on the manager.
    this.ready.catch(() => {});
    return this._container;
  }

  onRemove() {
    this._removed = true;
    for (const fn of this._cleanup.splice(0)) fn();
    this._inner?.onRemove?.();
    this._inner = null;
    this._container?.remove();
    this._popover?.remove();
    this._map = null;
  }

  // --- internals -----------------------------------------------------------

  async _init(map, doc) {
    const { LayerControl: Inner } = await loadLayerControl();
    if (this._removed) return;
    ensureLayerControlCss(doc);
    injectLayerControlTheme(doc);

    const manager = this._manager;
    this._inner = new Inner({
      collapsed: this._collapsed,
      ...(this._basemapStyleUrl ? { basemapStyleUrl: this._basemapStyleUrl } : {}),
      customLayerAdapters: [createControlAdapter(manager)],
      // Our style layers are shown through the adapter, one row per LayerSpec.
      excludeLayers: ['cng-layer-*'],
      onLayerReorder: (order) => {
        this._fromPanel = true;
        try {
          applyPanelOrder(manager, order);
        } finally {
          this._fromPanel = false;
        }
      },
    });
    this._container.appendChild(this._inner.onAdd(map));

    const root = map.getContainer();
    this._cleanup.push(
      attachPanelA11y({
        root,
        move: (id, direction) => this._moveFromKeyboard(id, direction),
        closeMenu: () => this._inner?.hideContextMenu?.(),
      }),
    );
    this._cleanup.push(
      manager.on('change', (event) => {
        if (event.type === 'move' && !this._fromPanel) this._syncPanelOrder();
        if (event.type === 'ready' || event.type === 'error' || event.type === 'add') this._renderNotes(root);
      }),
    );
    // Rows are rebuilt by the panel at will; keep our additions in place.
    // The panel also decides its own row order when it rebuilds (it appends
    // layers as it hears of them), so the order is re-asserted after every
    // rebuild. `_syncPanelOrder` does nothing when the order already agrees,
    // which is what stops this from looping.
    const observer = new MutationObserver(() => {
      this._ensureAddButton(root, doc);
      if (!root.querySelector('.layer-control-item-dragging, .layer-control-drop-placeholder')) this._syncPanelOrder();
      this._renderNotes(root);
    });
    observer.observe(root, { childList: true, subtree: true });
    this._cleanup.push(() => observer.disconnect());
    this._ensureAddButton(root, doc);
    this._syncPanelOrder();
    this._renderNotes(root);
  }

  /**
   * Alt+Arrow on a row. The panel's own move (the one behind its context
   * menu) is used when present: it rebuilds the list and reports the new
   * order back through onLayerReorder. It is a private method of 0.18.3, so
   * fall back to moving in the manager and re-syncing the list.
   */
  _moveFromKeyboard(id, direction) {
    const inner = this._inner;
    const method = direction === 'up' ? 'moveLayerUp' : 'moveLayerDown';
    if (typeof inner?.[method] === 'function') return inner[method](id);
    const list = this._manager.list().map((e) => e.id);
    const at = list.indexOf(id);
    if (at !== -1) this._manager.move(id, at + (direction === 'up' ? 1 : -1));
  }

  /**
   * The manager's order changed from outside the panel (code called
   * `manager.move`). 0.18.3 has no public way to set the list order; it keeps
   * it as the key order of its private `state.layerStates`. Rewrite that and
   * rebuild -- guarded, so a future version that drops either simply leaves
   * the panel's order as it was until the next add or remove.
   */
  _syncPanelOrder() {
    const inner = this._inner;
    const states = inner?.state?.layerStates;
    if (!states || typeof inner.buildLayerItems !== 'function') return;
    const ours = this._manager.list().map((e) => e.id).reverse(); // top first
    const mine = new Set(ours);
    const ordered = {};
    if (states.Background) ordered.Background = states.Background;
    let next = 0;
    for (const id of Object.keys(states)) {
      if (id === 'Background') continue;
      // Slots held by our layers are refilled in the manager's order; anything
      // else the panel lists keeps its place.
      const use = mine.has(id) ? ours[next++] : id;
      if (states[use]) ordered[use] = states[use];
    }
    for (const id of ours) if (!(id in ordered) && states[id]) ordered[id] = states[id];
    if (Object.keys(ordered).join('\n') === Object.keys(states).join('\n')) return;
    inner.state.layerStates = ordered;
    inner.buildLayerItems();
  }

  _ensureAddButton(root, doc) {
    if (!this._providers.length) return;
    const header = root.querySelector('.layer-control-panel-header');
    if (!header || header.querySelector('.cng-layer-add-btn')) return;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'cng-layer-add-btn';
    button.textContent = '+ Add';
    button.setAttribute('aria-label', 'Add a layer');
    button.setAttribute('aria-expanded', 'false');
    header.appendChild(button);

    const popover = doc.createElement('div');
    popover.className = 'cng-layer-add-popover';
    popover.hidden = true;
    header.insertAdjacentElement('afterend', popover);
    this._popover = popover;

    const close = () => {
      popover.hidden = true;
      popover.replaceChildren();
      button.setAttribute('aria-expanded', 'false');
      button.focus();
    };
    const openProvider = (provider) => {
      popover.replaceChildren();
      provider.open({ manager: this._manager, map: this._map, anchor: popover, close });
    };
    button.addEventListener('click', () => {
      if (!popover.hidden) return close();
      popover.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      if (this._providers.length === 1) return openProvider(this._providers[0]);
      for (const provider of this._providers) {
        const choice = doc.createElement('button');
        choice.type = 'button';
        choice.textContent = provider.label;
        choice.addEventListener('click', () => openProvider(provider));
        popover.appendChild(choice);
      }
      popover.querySelector('button')?.focus();
    });
  }

  /** A line under a row whose layer has a note or an error. */
  _renderNotes(root) {
    for (const row of root.querySelectorAll(ROW)) {
      const entry = this._manager.get(row.dataset.layerId);
      const text = entry?.status === 'error' ? entry.error?.message : entry?.status === 'loading' ? 'Loading…' : entry?.note;
      let note = row.querySelector(':scope > .cng-layer-note');
      if (!text) {
        note?.remove();
        continue;
      }
      if (!note) {
        note = row.ownerDocument.createElement('div');
        note.className = 'cng-layer-note';
        row.appendChild(note);
      }
      const status = entry.status === 'error' ? 'error' : 'note';
      if (note.textContent !== text) note.textContent = text;
      if (note.dataset.status !== status) note.dataset.status = status;
    }
  }
}
