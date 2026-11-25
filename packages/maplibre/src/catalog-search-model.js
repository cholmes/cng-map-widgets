// @cngeo/maplibre -- the catalog search panel's state, with no DOM.
//
// What is being looked for (words, the map area, a licence, a catalog, a
// kind), what was found, which result is hovered, and which have been added
// to the map. `CatalogSearchControl` is a view of this; a host with its own
// UI can drive it directly.
//
// The index is INJECTED: anything shaped like `@cngeo/stac`'s `CatalogIndex`
// (`load()`, `search()`, `resolve()`, `entries`). This package does not
// import that one.

const DEFAULT_LIMIT = 50;
const count = (n) => Number(n).toLocaleString('en-US');
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
const boxRing = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];

/**
 * What a catalog search panel should say for a state. It reads only what the
 * words depend on -- never the hovered result or what was added -- so a view
 * can leave the DOM, and a screen reader's live region, alone when nothing it
 * says has changed.
 * @param {object} state A model's `state`.
 * @returns {{ tone: 'info'|'error', line: string }}
 */
export function catalogStatusOf(state) {
  if (state.status === 'error') return { tone: 'error', line: `The catalog could not be searched: ${state.error?.message ?? state.error}` };
  let line = '';
  if (state.status === 'loading') line = 'Loading the catalog…';
  else if (state.status === 'searching') line = state.count ? `Searching ${plural(state.count, 'collection')}…` : 'Searching…';
  else if (state.status === 'done') {
    const shown = state.results.length;
    if (state.total === 0) line = state.useView ? 'Nothing matches in this map area.' : 'Nothing matches.';
    else if (shown < state.total) line = `Showing ${count(shown)} of ${plural(state.total, 'collection')}.`;
    else line = `${plural(state.total, 'collection')}.`;
  }
  return { tone: 'info', line };
}

/**
 * Result extents as GeoJSON for one map source: a box per result that has a
 * bbox (two, for one across the antimeridian). `properties.hovered` marks the
 * one to show.
 * @param {object[]} results
 * @param {string|null} hoveredKey
 */
export function extentsGeoJson(results, hoveredKey) {
  const features = [];
  for (const r of results ?? []) {
    const b = r?.bbox;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) continue;
    const [w, s, e, n] = b;
    const geometry = w > e ? { type: 'MultiPolygon', coordinates: [[boxRing(w, s, 180, n)], [boxRing(-180, s, e, n)]] } : { type: 'Polygon', coordinates: [boxRing(w, s, e, n)] };
    features.push({ type: 'Feature', geometry, properties: { key: r.key, hovered: r.key === hoveredKey } });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * @param {Object} options
 * @param {object} options.index    A `CatalogIndex` (or anything with its `load` / `search` / `resolve`).
 * @param {object} options.manager  A `LayerManager`: where an added collection's layers go.
 * @param {number} [options.limit]  Most results to show. Default 50.
 */
export function createCatalogSearchModel(options) {
  const { index, manager } = options;
  const limit = options.limit ?? DEFAULT_LIMIT;
  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();
  /** layer id -> result key, and result key -> its layer ids, for what this model added. */
  const keyOfLayer = new Map();
  const layersOfKey = new Map();
  let generation = 0;
  let loaded = false;
  let destroyed = false;

  const state = {
    /** @type {'idle'|'loading'|'searching'|'done'|'error'} */
    status: 'idle',
    /** @type {object[]} */
    results: [],
    total: 0,
    facets: { license: [], catalog: [], kinds: [] },
    /** How many collections the index holds; 0 until it has loaded. */
    count: 0,
    /** Whether the index says what each collection draws as. */
    hasRender: false,
    text: '',
    /** Search only what intersects `area`. */
    useView: false,
    /** @type {object|null} The map's area, kept current by the view; used when `useView` is on. */
    area: null,
    /** @type {{ license?: string, catalog?: string, kinds?: string }} */
    filters: {},
    /** @type {string|null} */
    hovered: null,
    /** @type {Set<string>} Result keys with at least one layer on the map. */
    added: new Set(),
    /** @type {Set<string>} */
    adding: new Set(),
    /** @type {{ id: string, tone: 'info'|'error', text: string }|null} What the last add has to say, if anything. */
    addNote: null,
    /** @type {any} */
    error: undefined,
  };

  const emit = () => {
    if (destroyed) return;
    for (const fn of [...listeners]) fn(state);
  };
  const track = (key, layerId) => {
    keyOfLayer.set(layerId, key);
    if (!layersOfKey.has(key)) layersOfKey.set(key, new Set());
    layersOfKey.get(key).add(layerId);
    state.added.add(key);
  };

  const offManager = manager?.on?.('change', (event) => {
    if (!event || !keyOfLayer.has(event.id)) return;
    const key = keyOfLayer.get(event.id);
    if (event.type !== 'remove' && event.type !== 'error') return;
    // Gone from the map, or failed after it was added: either way it is no
    // longer one of this result's layers. A result stays "added" while any is.
    keyOfLayer.delete(event.id);
    const rest = layersOfKey.get(key);
    rest?.delete(event.id);
    if (!rest?.size) {
      layersOfKey.delete(key);
      state.added.delete(key);
    }
    if (event.type === 'error') state.addNote = { id: key, tone: 'error', text: manager.get?.(event.id)?.error?.message ?? 'A layer could not be drawn.' };
    emit();
  });

  /** One layer onto the map. Resolves true when it is there (now, or already). */
  async function addLayer(spec) {
    try {
      await manager.add(spec);
      return true;
    } catch (error) {
      if (!(error?.code === 'LAYER_INVALID' && error?.context?.reason === 'duplicate')) throw error;
      // Already in the stack. If it is there as a layer that failed to load,
      // this is "try again": replace it. Otherwise it is simply there.
      if (manager.get?.(spec.id)?.status !== 'error') return true;
      manager.remove?.(spec.id);
      await manager.add(spec);
      return true;
    }
  }

  return {
    state,

    /** Subscribe to changes. Returns the unsubscribe. */
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    setText(text) {
      state.text = typeof text === 'string' ? text : '';
      emit();
    },

    /** Search only what intersects the map area (`setArea`). */
    setUseView(on) {
      state.useView = Boolean(on);
      emit();
    },

    /** The map's current area. Stored always; used only while `useView` is on. */
    setArea(area) {
      state.area = area ?? null;
    },

    /** Choose a facet value (`license`, `catalog`, `kinds`), or clear it with null. */
    setFacet(name, value) {
      if (value === null || value === undefined || value === '') delete state.filters[name];
      else state.filters[name] = value;
      emit();
    },

    hover(key) {
      const next = key ?? null;
      if (state.hovered === next) return;
      state.hovered = next;
      emit();
    },

    /**
     * Search with the current settings; the index is loaded first if it has
     * not been. A new run supersedes the one in flight. Never rejects: a
     * failure is `state.status === 'error'` with `state.error`.
     */
    async run() {
      const mine = ++generation;
      const current = () => mine === generation && !destroyed;
      Object.assign(state, { status: loaded ? 'searching' : 'loading', error: undefined });
      emit();
      try {
        if (!loaded) {
          await index.load();
          loaded = true;
          state.count = index.entries?.length ?? 0;
          state.hasRender = Boolean(index.hasRender);
          if (!current()) return;
          state.status = 'searching';
          emit();
        }
        const found = await index.search({
          text: state.text.trim(),
          area: state.useView ? state.area : null,
          ...state.filters,
          limit,
        });
        if (!current() || found?.superseded) return;
        Object.assign(state, { status: 'done', results: found.results, total: found.total, facets: found.facets });
        if (state.hovered && !found.results.some((r) => r.key === state.hovered)) state.hovered = null;
      } catch (error) {
        if (!current()) return;
        Object.assign(state, { status: 'error', error });
      }
      emit();
    },

    /**
     * Add a found collection to the map: every layer of it that can be drawn.
     * Never rejects, and never does nothing in silence: when some or all of
     * it could not be added, `state.addNote` says what and why.
     */
    async add(key) {
      const result = state.results.find((r) => r.key === key);
      if (!result || state.added.has(key) || state.adding.has(key)) return;
      state.adding.add(key);
      if (state.addNote?.id === key) state.addNote = null;
      emit();
      try {
        const { drawable, undrawable } = await index.resolve(result);
        const notAdded = undrawable.map((u) => `${u.title} — ${u.reason}`);
        let added = 0;
        let failed = false;
        for (const spec of drawable) {
          try {
            await addLayer(spec);
            track(key, spec.id);
            added += 1;
          } catch (error) {
            failed = true;
            notAdded.push(`${spec.title ?? spec.id} — ${error?.message ?? error}`);
          }
        }
        if (added === 0 && !failed) state.addNote = { id: key, tone: 'info', text: `Nothing to add. ${undrawable.map((u) => u.reason).join(' ')}`.trim() };
        else if (added === 0) state.addNote = { id: key, tone: 'error', text: notAdded.join('; ') };
        else if (notAdded.length) state.addNote = { id: key, tone: failed ? 'error' : 'info', text: `Added ${plural(added, 'layer')}. Not added: ${notAdded.join('; ')}` };
      } catch (error) {
        state.addNote = { id: key, tone: 'error', text: error?.message ?? String(error) };
      } finally {
        state.adding.delete(key);
      }
      emit();
    },

    /** Stop listening and announcing. The index is the host's to close. */
    destroy() {
      if (destroyed) return;
      generation += 1;
      destroyed = true;
      offManager?.();
      listeners.clear();
    },

    /** True once `destroy()` has run. */
    get destroyed() {
      return destroyed;
    },
  };
}
