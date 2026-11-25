// @cngeo/maplibre -- the imagery search panel's state, with no DOM.
//
// What is being searched for (area, dates, property filters, order), what
// came back, what is hovered, and which scenes have been added to the map.
// `ImagerySearchControl` is a view of this; a host with its own UI can drive
// it directly.
//
// The search is INJECTED: anything shaped like `@cngeo/stac`'s
// `ImagerySearch` (`search()`, `layerSpecFor()`, and optionally `warm()`,
// `cancel()`, `profile`). This package does not import that one.

import { buildArea } from '@cngeo/spec';

const DEFAULT_LIMIT = 200;
const isEmpty = (v) => v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v));
const numberOf = (v) => (isEmpty(v) ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Is this filter value "nothing chosen"? */
function isEmptyFilter(value) {
  if (isEmpty(value)) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return isEmpty(value.min) && isEmpty(value.max);
  return false;
}

/**
 * Filter values -> extract-core predicates, in the profile's filter order.
 * `max` is `<=`, `min` is `>=`, `range` is both ends that were given, `enum`
 * is `=` (or `in` for a list). A value that is empty, or not a number where
 * one is needed, sends nothing; so does a column the profile does not offer.
 *
 * **Null means unknown.** A numeric bound also keeps a row with NO value in
 * that column: a scene whose cloud cover was never recorded is not a cloudy
 * scene, and "at most 20%" should not hide it. Choosing a category is
 * different -- an unknown platform is not the platform asked for.
 * @param {{ column: string, kind: string }[]} filters
 * @param {Record<string, unknown>} values
 * @returns {object[]}
 */
export function whereFromFilters(filters, values) {
  const where = [];
  const orUnknown = (predicate) => ({ op: 'or', args: [{ col: predicate.col, op: 'is_null' }, predicate] });
  for (const filter of filters ?? []) {
    const value = values?.[filter.column];
    if (isEmptyFilter(value)) continue;
    const col = filter.column;
    if (filter.kind === 'max' || filter.kind === 'min') {
      const n = numberOf(value);
      if (n !== null) where.push(orUnknown({ col, op: filter.kind === 'max' ? '<=' : '>=', value: n }));
    } else if (filter.kind === 'range') {
      const min = numberOf(value?.min);
      const max = numberOf(value?.max);
      if (min !== null) where.push(orUnknown({ col, op: '>=', value: min }));
      if (max !== null) where.push(orUnknown({ col, op: '<=', value: max }));
    } else if (Array.isArray(value)) {
      where.push({ col, op: 'in', values: value });
    } else {
      where.push({ col, op: '=', value });
    }
  }
  return where;
}

const count = (n) => Number(n).toLocaleString('en-US');
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * What a search panel should say for a state, as plain strings.
 *
 * It reads only what the words depend on -- never the hovered scene or which
 * scenes were added -- so two states that should read the same give equal
 * results, and a view can skip touching the DOM (and a screen reader's live
 * region) when nothing it says has changed.
 *
 * `line` is the message; `progress` changes many times a second while a
 * search reads and is meant for somewhere that is NOT announced; `summary`
 * and `stages` are the plan's narration, with `plan` its identity.
 * @param {object} state A model's `state`.
 * @param {string|null} [notice] Something the view itself has to say first.
 * @returns {{ tone: 'info'|'error', line: string, progress: string, summary: string, stages: string[], plan: object|null }}
 */
export function statusOf(state, notice = null) {
  const n = state.scenes?.length ?? 0;
  let line = '';
  let progress = '';
  if (notice) line = notice;
  else if (state.status === 'error') {
    // The library's message names the step; the cause, when there is one, is
    // usually what a person can act on.
    const cause = state.error?.cause?.message;
    line = `The search failed: ${state.error?.message ?? state.error}${cause ? ` (${cause})` : ''}`;
  } else if (state.status === 'searching') {
    line = 'Searching…';
    const p = state.progress;
    progress = state.plan
      ? `Read ${p ? `${count(p.rowGroupsDone)} of ${plural(p.rowGroupsTotal, 'row group')}` : 'nothing yet'}; ${plural(n, 'scene')} so far.`
      : 'Planning the search…';
  } else if (state.status === 'done') {
    if (n === 0) line = 'No scenes match.';
    else if (state.partial) line = `Showing ${plural(n, 'scene')} from the first ${count(state.matched)} that matched; there are more. Narrow the area or the dates to see them all.`;
    else if (state.truncated) line = `Showing ${count(n)} of ${plural(state.matched, 'matching scene')}.`;
    else line = `${plural(n, 'scene')}.`;
  } else if (state.plan || n > 0) line = `Stopped. ${plural(n, 'scene')} found so far.`;
  else line = 'Search for scenes in this view.';

  const plan = state.status === 'error' ? null : (state.plan ?? null);
  return {
    tone: state.status === 'error' && !notice ? 'error' : 'info',
    line,
    progress,
    // Row groups and files, not `plan.requests`: that figure models one
    // request per row group and the reader makes about four (E14).
    summary: plan ? `Read ${count(plan.rowGroups.selected)} of ${plural(plan.rowGroups.total, 'row group')} in ${count(plan.files.selected)} of ${plural(plan.files.total, 'file')}` : '',
    stages: plan ? (plan.prune ?? []).map((s) => `${s.stage}: ${count(s.before)} → ${count(s.after)} (${s.basis})`) : [],
    plan,
  };
}

/**
 * A first date range for a search panel, as `YYYY-MM-DD` strings: the last
 * `days` of a PARTITIONED archive, or `null` when there should be none.
 *
 * A search with no dates has to plan every part of the dataset. On a deep
 * archive that is every year's footer -- about 8 MB each on Sentinel-2 --
 * before a single scene. A collection that is one file costs the same to
 * search whole, and a default there would only hide most of it.
 * @param {object|null|undefined} profile An imagery profile.
 * @param {{ now?: number, days?: number }} [options]
 * @returns {{ start: string, end: string }|null}
 */
export function defaultTimeWindow(profile, options = {}) {
  const kind = profile?.dataset?.source?.kind;
  if (!kind || kind === 'parquet') return null;
  const now = options.now ?? Date.now();
  const days = options.days ?? 30;
  const [first, last] = Array.isArray(profile.temporal) ? profile.temporal.map((t) => Date.parse(t ?? '')) : [NaN, NaN];
  const end = Number.isFinite(last) ? Math.min(last, now) : now;
  const start = Math.max(end - days * 86_400_000, Number.isFinite(first) ? first : -Infinity);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { start: day(start), end: day(end) };
}

const boxRing = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * A map view as a search `Area`, or `null` when the view takes in the whole
 * world -- which is "search everywhere", not a 360-degree-wide box.
 *
 * MapLibre reports a view across the antimeridian with a longitude beyond
 * +-180 (`[170, s, 190, n]`); that becomes two boxes, one each side.
 * @param {[number, number, number, number]|null|undefined} bounds `[w, s, e, n]`, as `map.getBounds().toArray().flat()`.
 * @returns {import('@cngeo/spec').Area|null}
 */
export function areaFromBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return null;
  const [west, southRaw, east, northRaw] = bounds;
  if (east - west >= 360) return null;
  const south = Math.max(-90, southRaw);
  const north = Math.min(90, northRaw);
  if (!(south < north) || !(west < east)) return null;
  const inRange = west >= -180 && east <= 180;
  const w = inRange ? west : wrapLon(west);
  const e = inRange ? east : wrapLon(east) === -180 ? 180 : wrapLon(east);
  const geometry =
    w <= e
      ? { type: 'Polygon', coordinates: [boxRing(w, south, e, north)] }
      : { type: 'MultiPolygon', coordinates: [[boxRing(w, south, 180, north)], [boxRing(-180, south, e, north)]] };
  return buildArea({ name: 'Map view', geometry, source: 'draw', features: [] });
}

/**
 * Scene footprints as GeoJSON for one map source: each scene's own polygon,
 * else its bbox; a scene with neither is left out. `properties.hovered` marks
 * the one to highlight.
 * @param {object[]} scenes
 * @param {string|null} hoveredId
 */
export function footprintsGeoJson(scenes, hoveredId) {
  const features = [];
  for (const scene of scenes ?? []) {
    const geometry = footprintOf(scene);
    if (!geometry) continue;
    features.push({ type: 'Feature', geometry, properties: { id: scene.id, hovered: scene.id === hoveredId } });
  }
  return { type: 'FeatureCollection', features };
}

function footprintOf(scene) {
  const g = scene?.geometry;
  if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon')) return g;
  const b = scene?.bbox;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return null;
  const [w, s, e, n] = b;
  // West greater than east: the box crosses the antimeridian.
  if (w > e) return { type: 'MultiPolygon', coordinates: [[boxRing(w, s, 180, n)], [boxRing(-180, s, e, n)]] };
  return { type: 'Polygon', coordinates: [boxRing(w, s, e, n)] };
}

/**
 * @param {Object} options
 * @param {object} options.search    An `ImagerySearch` (or anything with its `search` / `layerSpecFor`).
 * @param {object} [options.profile] Its profile. Default `search.profile`.
 * @param {object} options.manager   A `LayerManager`: where an added scene goes.
 * @param {number} [options.limit]   Most scenes to show. Default 200.
 */
export function createImagerySearchModel(options) {
  const { search, manager } = options;
  const limit = options.limit ?? DEFAULT_LIMIT;
  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();
  /** layer id -> scene id, for scenes this model added. */
  const layerIds = new Map();
  let generation = 0;
  let destroyed = false;

  const state = {
    /** @type {'idle'|'searching'|'done'|'error'} */
    status: 'idle',
    profile: options.profile ?? search.profile,
    /** @type {object[]} */
    scenes: [],
    truncated: false,
    partial: false,
    matched: 0,
    /** @type {object|null} */
    plan: null,
    /** @type {{ rowGroupsDone: number, rowGroupsTotal: number }|null} */
    progress: null,
    /** @type {any} */
    error: undefined,
    /** @type {{ id: string, error: any }|undefined} */
    addError: undefined,
    /** @type {string|null} */
    hovered: null,
    /** @type {Set<string>} */
    added: new Set(),
    /** @type {Set<string>} */
    adding: new Set(),
    /** @type {object|null} */
    area: null,
    /** @type {{ start?: string, end?: string }|null} */
    time: null,
    /** @type {Record<string, unknown>} */
    filters: {},
    sort: { by: 'datetime', order: 'desc' },
  };

  const emit = () => {
    if (destroyed) return;
    for (const fn of [...listeners]) fn(state);
  };

  const offManager = manager?.on?.('change', (event) => {
    if (!event || !layerIds.has(event.id)) return;
    const sceneId = layerIds.get(event.id);
    if (event.type === 'remove') {
      // Removed from the map (from the layer panel, say): it can be added again.
      state.added.delete(sceneId);
      layerIds.delete(event.id);
    } else if (event.type === 'error') {
      // A file that cannot be opened or drawn is reported some time AFTER
      // `add()` resolved. It is not "added" then, and its card should say why.
      state.added.delete(sceneId);
      state.addError = { id: sceneId, error: manager.get?.(event.id)?.error ?? new Error('The layer could not be drawn.') };
    } else return;
    emit();
  });

  const api = {
    state,

    /** Subscribe to changes. Returns the unsubscribe. */
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Prepare the search (resolve the dataset, settle the profile) before the first run. */
    async warm() {
      await search.warm?.();
      if (search.profile && search.profile !== state.profile) {
        state.profile = search.profile;
        emit();
      }
    },

    setArea(area) {
      state.area = area ?? null;
      emit();
    },

    /** `{ start, end }` as ISO strings; either may be empty. The window is `[start, end)`. */
    setTime(time) {
      const start = isEmpty(time?.start) ? undefined : time.start;
      const end = isEmpty(time?.end) ? undefined : time.end;
      state.time = start || end ? { ...(start ? { start } : {}), ...(end ? { end } : {}) } : null;
      emit();
    },

    /** Set one property filter. An empty value clears it. */
    setFilter(column, value) {
      if (isEmptyFilter(value)) delete state.filters[column];
      else state.filters[column] = value;
      emit();
    },

    /**
     * Choose the order. What is shown is reordered at once: in place when
     * every match is already here (and the search can sort, `search.sort`),
     * otherwise by searching again -- the top N by another order are other
     * scenes, so reshuffling the N on screen would be a wrong answer.
     */
    setSort(sort) {
      state.sort = { by: sort?.by ?? 'datetime', order: sort?.order ?? 'desc' };
      if (state.status === 'done' && state.scenes.length > 0) {
        if (!state.truncated && !state.partial && typeof search.sort === 'function') state.scenes = search.sort(state.scenes, state.sort);
        else {
          api.run();
          return;
        }
      }
      emit();
    },

    hover(id) {
      const next = id ?? null;
      if (state.hovered === next) return;
      state.hovered = next;
      emit();
    },

    /**
     * Search with the current settings. A new run supersedes the one in
     * flight. Never rejects: a failure is `state.status === 'error'` with
     * `state.error`.
     */
    async run() {
      const mine = ++generation;
      const current = () => mine === generation && !destroyed;
      Object.assign(state, { status: 'searching', scenes: [], truncated: false, partial: false, matched: 0, plan: null, progress: null, error: undefined, addError: undefined });
      emit();
      const where = whereFromFilters(state.profile?.filters, state.filters);
      try {
        const result = await search.search({
          area: state.area,
          ...(state.time ? { time: { ...state.time, closed: '[)' } } : {}),
          ...(where.length ? { where } : {}),
          sort: state.sort,
          limit,
          onPlan: (plan) => {
            if (!current()) return;
            state.plan = plan;
            emit();
          },
          onProgress: (progress) => {
            if (!current()) return;
            state.progress = { rowGroupsDone: progress.rowGroupsDone, rowGroupsTotal: progress.rowGroupsTotal };
            emit();
          },
          // Unsorted, as read. Shown as they arrive so the map fills in; the
          // resolved answer below replaces them, sorted and cut.
          onScenes: (batch) => {
            if (!current() || state.scenes.length >= limit) return;
            state.scenes = [...state.scenes, ...batch].slice(0, limit);
            emit();
          },
        });
        if (!current() || result?.superseded) return;
        Object.assign(state, {
          status: 'done',
          scenes: result.scenes,
          truncated: Boolean(result.truncated),
          partial: Boolean(result.partial),
          matched: result.matched ?? result.scenes.length,
          plan: result.plan ?? state.plan,
          progress: null,
        });
        if (state.hovered && !result.scenes.some((s) => s.id === state.hovered)) state.hovered = null;
      } catch (error) {
        if (!current()) return;
        Object.assign(state, { status: 'error', error, progress: null });
      }
      emit();
    },

    /** Stop the search in flight. What has arrived so far stays. */
    cancel() {
      if (state.status !== 'searching') return;
      generation += 1;
      search.cancel?.();
      Object.assign(state, { status: 'idle', progress: null });
      emit();
    },

    /**
     * Add one found scene to the map, once. Never rejects: a failure is
     * `state.addError` (`{ id, error }`), and `state.added` is unchanged.
     */
    async add(id) {
      const scene = state.scenes.find((s) => s.id === id);
      if (!scene || state.added.has(id) || state.adding.has(id)) return;
      state.adding.add(id);
      if (state.addError?.id === id) state.addError = undefined;
      emit();
      let spec = null;
      try {
        spec = await search.layerSpecFor(scene);
        await manager.add(spec);
        state.added.add(id);
        layerIds.set(spec.id, id);
      } catch (error) {
        const duplicate = spec && error?.code === 'LAYER_INVALID' && error?.context?.reason === 'duplicate';
        if (!duplicate) state.addError = { id, error };
        else if (manager.get?.(spec.id)?.status === 'error') {
          // In the stack, but as a layer that failed to load (the manager
          // keeps those, to show the error). This click is "try again":
          // replace it, and call it added only if that works.
          try {
            manager.remove?.(spec.id);
            await manager.add(spec);
            state.added.add(id);
            layerIds.set(spec.id, id);
          } catch (again) {
            state.addError = { id, error: again };
          }
        } else {
          // Already in the stack and fine (added before this search was run): that is "added".
          state.added.add(id);
          layerIds.set(spec.id, id);
        }
      } finally {
        state.adding.delete(id);
      }
      emit();
    },

    /** Stop listening, stop announcing, and stop the search in flight. The search object is the host's to close. */
    destroy() {
      if (destroyed) return;
      generation += 1;
      if (state.status === 'searching') search.cancel?.();
      destroyed = true;
      offManager?.();
      listeners.clear();
    },

    /** True once `destroy()` has run: a destroyed model does nothing and must be replaced. */
    get destroyed() {
      return destroyed;
    },
  };
  return api;
}
