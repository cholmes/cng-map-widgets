import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImagerySearchModel, footprintsGeoJson, areaFromBounds, whereFromFilters, statusOf, defaultTimeWindow } from '../src/imagery-search-model.js';

/** A bound that also lets through a row with no value in that column. */
const orUnknown = (predicate) => ({ op: 'or', args: [{ col: predicate.col, op: 'is_null' }, predicate] });

// The model is the control's state with no DOM: what is being searched for,
// what came back, what is hovered, what has been added. The search itself is
// injected -- anything shaped like @cngeo/stac's ImagerySearch -- because
// this package does not import that one.

const PROFILE = {
  id: 's2',
  title: 'Sentinel-2',
  attribution: [{ text: 'ESA', license: 'CC-BY-SA-3.0-IGO', shareAlike: true }],
  filters: [
    { column: 'eo:cloud_cover', label: 'Cloud cover (%)', kind: 'max', type: 'double' },
    { column: 'platform', label: 'Platform', kind: 'enum', type: 'string' },
    { column: 'naip:year', label: 'Year', kind: 'range', type: 'int64' },
    { column: 'sun', label: 'Sun elevation', kind: 'min', type: 'double' },
  ],
};
const scene = (id, extra = {}) => ({ id, datetime: '2025-06-01T00:00:00.000Z', start: null, end: null, bbox: [0, 0, 1, 1], geometry: null, properties: {}, thumbnail: null, self: null, ...extra });
const specOf = (s) => ({ spec: 'cng-layer/1.0', id: `s2:${s.id}`, title: s.id, kind: 'cog', source: { url: `https://example.org/${s.id}.tif` }, attribution: [], group: 's2' });

/** An ImagerySearch stand-in. Each `search()` is held until the test lets it go. */
function stubSearch(overrides = {}) {
  const calls = [];
  const stub = {
    profile: PROFILE,
    calls,
    cancelled: 0,
    warm: async () => {},
    search(query) {
      let release;
      const call = { query, superseded: false };
      const done = new Promise((resolve) => (release = resolve));
      // Like the real one: a new search supersedes the one in flight.
      for (const earlier of calls) if (!earlier.settled) earlier.supersede();
      call.supersede = () => {
        call.superseded = true;
        call.settled = true;
        release({ scenes: [], truncated: false, matched: 0, partial: false, plan: null, superseded: true });
      };
      call.finish = (scenes, more = {}) => {
        call.settled = true;
        release({ scenes, truncated: false, matched: scenes.length, partial: false, plan: { files: { total: 1, selected: 1 }, rowGroups: { total: 4, selected: 2 }, prune: [], requests: 3, warnings: [] }, ...more });
      };
      call.fail = (error) => {
        call.settled = true;
        release(Promise.reject(error));
      };
      calls.push(call);
      return done;
    },
    cancel() {
      stub.cancelled += 1;
      for (const call of calls) if (!call.settled) call.supersede();
    },
    layerSpecFor: async (s) => specOf(s),
    ...overrides,
  };
  return stub;
}

function stubManager() {
  const listeners = new Set();
  const manager = {
    added: [],
    async add(spec) {
      manager.added.push(spec);
      return { id: spec.id, status: 'ready' };
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (event) => listeners.forEach((fn) => fn(event)),
    listeners,
  };
  return manager;
}

const AREA = { type: 'Area', name: 'somewhere', bboxes: [[0, 0, 1, 1]] };

// --- what a run sends -------------------------------------------------------------------

test('run() searches with the current area, time, filters and sort', async () => {
  const search = stubSearch();
  const model = createImagerySearchModel({ search, profile: PROFILE, manager: stubManager(), limit: 50 });
  model.setArea(AREA);
  model.setTime({ start: '2025-06-01T00:00:00Z', end: '2025-07-01T00:00:00Z' });
  model.setFilter('eo:cloud_cover', 20);
  model.setFilter('platform', 'sentinel-2b');
  model.setFilter('naip:year', { min: 2022, max: 2024 });
  model.setFilter('sun', 30);
  model.setSort({ by: 'eo:cloud_cover', order: 'asc' });
  const running = model.run();
  assert.equal(model.state.status, 'searching');
  const { query } = search.calls[0];
  assert.equal(query.area, AREA);
  assert.deepEqual(query.time, { start: '2025-06-01T00:00:00Z', end: '2025-07-01T00:00:00Z', closed: '[)' });
  assert.deepEqual(query.where, [
    orUnknown({ col: 'eo:cloud_cover', op: '<=', value: 20 }),
    { col: 'platform', op: '=', value: 'sentinel-2b' },
    orUnknown({ col: 'naip:year', op: '>=', value: 2022 }),
    orUnknown({ col: 'naip:year', op: '<=', value: 2024 }),
    orUnknown({ col: 'sun', op: '>=', value: 30 }),
  ]);
  assert.deepEqual(query.sort, { by: 'eo:cloud_cover', order: 'asc' });
  assert.equal(query.limit, 50);
  search.calls[0].finish([scene('a'), scene('b')]);
  await running;
  assert.equal(model.state.status, 'done');
  assert.deepEqual(model.state.scenes.map((s) => s.id), ['a', 'b']);
  assert.equal(model.state.plan.requests, 3);
});

test('a filter set to its empty value is not sent', async () => {
  const search = stubSearch();
  const model = createImagerySearchModel({ search, profile: PROFILE, manager: stubManager() });
  model.setFilter('eo:cloud_cover', 20);
  model.setFilter('eo:cloud_cover', '');
  model.setFilter('platform', null);
  model.setFilter('naip:year', { min: undefined, max: 2024 });
  model.setFilter('sun', Number.NaN);
  model.setTime({ start: '', end: null });
  model.run();
  const { query } = search.calls[0];
  assert.deepEqual(query.where, [orUnknown({ col: 'naip:year', op: '<=', value: 2024 })]);
  assert.equal(query.time, undefined);
  assert.equal(query.area, null);
  assert.deepEqual(model.state.filters, { 'naip:year': { min: undefined, max: 2024 } });
});

test('whereFromFilters: numbers typed as text are numbers; a column the profile does not offer is ignored', () => {
  assert.deepEqual(whereFromFilters(PROFILE.filters, { 'eo:cloud_cover': '15', platform: ['a', 'b'], unknown: 3 }), [
    orUnknown({ col: 'eo:cloud_cover', op: '<=', value: 15 }),
    { col: 'platform', op: 'in', values: ['a', 'b'] },
  ]);
  assert.deepEqual(whereFromFilters(PROFILE.filters, { 'eo:cloud_cover': 'abc', platform: [] }), []);
});

// The design asks for "null means unknown" (Phase 2 review, I6): a scene whose
// cloud cover was never recorded is not a cloudy scene, and "at most 20%"
// must not hide it. Checked against the real predicate evaluator.
test('a numeric filter keeps a scene whose value is unknown; choosing a category does not', async () => {
  const { evaluateWhere } = await import('@cngeo/extract-core');
  const where = whereFromFilters(PROFILE.filters, { 'eo:cloud_cover': 20, platform: 'sentinel-2b' });
  const keeps = (row) => evaluateWhere(where, row);
  assert.equal(keeps({ 'eo:cloud_cover': 5, platform: 'sentinel-2b' }), true);
  assert.equal(keeps({ 'eo:cloud_cover': 60, platform: 'sentinel-2b' }), false);
  assert.equal(keeps({ 'eo:cloud_cover': null, platform: 'sentinel-2b' }), true, 'unknown cloud cover is kept');
  assert.equal(keeps({ platform: 'sentinel-2b' }), true, 'so is a missing one');
  assert.equal(keeps({ 'eo:cloud_cover': 5, platform: null }), false, 'an unknown platform is not the platform asked for');
});

// --- what the panel says -------------------------------------------------------------------

test('statusOf: what the panel says in each state', () => {
  const base = { status: 'idle', scenes: [], truncated: false, partial: false, matched: 0, plan: null, progress: null, error: undefined };
  const plan = { files: { total: 12, selected: 1 }, rowGroups: { total: 825, selected: 21 }, prune: [{ stage: 'part-time', before: 12, after: 1, basis: 'time window' }], requests: 22, warnings: [] };
  assert.equal(statusOf(base).line, 'Search for scenes in this view.');
  assert.equal(statusOf(base, 'No area is selected.').line, 'No area is selected.');
  assert.equal(statusOf({ ...base, status: 'searching' }).line, 'Searching…');
  assert.equal(statusOf({ ...base, status: 'searching' }).progress, 'Planning the search…');
  assert.equal(statusOf({ ...base, status: 'searching', plan, progress: { rowGroupsDone: 3, rowGroupsTotal: 21 }, scenes: [scene('a')] }).progress, 'Read 3 of 21 row groups; 1 scene so far.');
  assert.equal(statusOf({ ...base, status: 'done' }).line, 'No scenes match.');
  assert.equal(statusOf({ ...base, status: 'done', scenes: [scene('a'), scene('b')], matched: 2 }).line, '2 scenes.');
  assert.equal(statusOf({ ...base, status: 'done', scenes: [scene('a')], matched: 1234, truncated: true }).line, 'Showing 1 of 1,234 matching scenes.');
  assert.match(statusOf({ ...base, status: 'done', scenes: [scene('a')], matched: 5000, truncated: true, partial: true }).line, /from the first 5,000 that matched; there are more\. Narrow/);
  const failed = statusOf({ ...base, status: 'error', error: Object.assign(new Error('Failed to read parquet row data.'), { cause: new Error('The request timed out after 60 s') }) });
  assert.equal(failed.tone, 'error');
  assert.equal(failed.line, 'The search failed: Failed to read parquet row data. (The request timed out after 60 s)');
  // Stopped part-way: say so, rather than inviting a first search above a half-finished one.
  assert.equal(statusOf({ ...base, status: 'idle', plan, scenes: [scene('a')] }).line, 'Stopped. 1 scene found so far.');
  const withPlan = statusOf({ ...base, status: 'done', scenes: [scene('a')], matched: 1, plan });
  assert.equal(withPlan.summary, 'Read 21 of 825 row groups in 1 of 12 files');
  assert.deepEqual(withPlan.stages, ['part-time: 12 → 1 (time window)']);
  assert.equal(withPlan.plan, plan);
});

// Phase 2 review, I5: the status was rebuilt on every change of the model, so
// hovering a card closed the open narration and re-announced the same line.
test('statusOf: hovering, adding and highlighting do not change what the panel says', () => {
  const state = { status: 'done', scenes: [scene('a'), scene('b')], truncated: false, partial: false, matched: 2, plan: null, progress: null, error: undefined, hovered: null, added: new Set(), adding: new Set() };
  const before = statusOf(state);
  const after = statusOf({ ...state, hovered: 'a', added: new Set(['b']), adding: new Set(['a']), addError: { id: 'a', error: new Error('x') } });
  assert.deepEqual(after, before);
});

// --- a sensible first date range ---------------------------------------------------------------

test('defaultTimeWindow: the last 30 days of a partitioned archive; nothing for a single file', () => {
  const partitioned = { dataset: { source: { kind: 'portolan-collection', url: 'https://example.org/c.json' } }, temporal: ['2015-10-22T10:16:59Z', '2026-11-25T01:46:18Z'] };
  const now = Date.parse('2026-11-25T12:00:00Z');
  assert.deepEqual(defaultTimeWindow(partitioned, { now }), { start: '2026-10-26', end: '2026-11-25' });
  // An archive that ended: its own last 30 days, not today's.
  assert.deepEqual(defaultTimeWindow({ ...partitioned, temporal: ['2015-01-01T00:00:00Z', '2020-03-10T00:00:00Z'] }, { now }), { start: '2020-02-09', end: '2020-03-10' });
  // Open-ended, or a bad end: up to today.
  assert.deepEqual(defaultTimeWindow({ ...partitioned, temporal: ['2015-01-01T00:00:00Z', null] }, { now }), { start: '2026-10-26', end: '2026-11-25' });
  // Never before the archive begins.
  assert.deepEqual(defaultTimeWindow({ ...partitioned, temporal: ['2026-11-20T00:00:00Z', null] }, { now }), { start: '2026-11-20', end: '2026-11-25' });
  // One file is cheap to search whole, and a default would hide most of it.
  assert.equal(defaultTimeWindow({ dataset: { source: { kind: 'parquet', url: 'https://example.org/items.parquet' } }, temporal: partitioned.temporal }, { now }), null);
  assert.equal(defaultTimeWindow(null, { now }), null);
});

// --- one search at a time ---------------------------------------------------------------

test("a second run supersedes the first; only the second's scenes land", async () => {
  const search = stubSearch();
  const model = createImagerySearchModel({ search, profile: PROFILE, manager: stubManager() });
  const first = model.run();
  const second = model.run();
  // The first search, superseded, still tries to deliver.
  search.calls[0].query.onScenes([scene('stale')]);
  await first;
  assert.deepEqual(model.state.scenes, []);
  assert.equal(model.state.status, 'searching');
  search.calls[1].query.onScenes([scene('x')]);
  assert.deepEqual(model.state.scenes.map((s) => s.id), ['x'], 'scenes stream in while searching');
  search.calls[1].finish([scene('y'), scene('x')]);
  await second;
  assert.deepEqual(model.state.scenes.map((s) => s.id), ['y', 'x'], 'the sorted answer replaces what streamed');
  assert.equal(model.state.status, 'done');
});

test('a failed search is an error state, not a rejection, and a later run clears it', async () => {
  const search = stubSearch();
  const model = createImagerySearchModel({ search, profile: PROFILE, manager: stubManager() });
  const running = model.run();
  search.calls[0].fail(Object.assign(new Error('offline'), { code: 'NETWORK' }));
  await running;
  assert.equal(model.state.status, 'error');
  assert.equal(model.state.error.code, 'NETWORK');
  const again = model.run();
  assert.equal(model.state.error, undefined);
  search.calls[1].finish([]);
  await again;
  assert.equal(model.state.status, 'done');
});

test('cancel() stops the search in flight and returns to what was shown', async () => {
  const search = stubSearch();
  const model = createImagerySearchModel({ search, profile: PROFILE, manager: stubManager() });
  const running = model.run();
  model.cancel();
  await running;
  assert.equal(search.cancelled, 1);
  assert.equal(model.state.status, 'idle');
});

test('changes are announced, and destroy() stops them and the search', async () => {
  const search = stubSearch();
  const manager = stubManager();
  const model = createImagerySearchModel({ search, profile: PROFILE, manager });
  let changes = 0;
  model.on('change', () => changes++);
  model.hover('a');
  model.hover('a'); // no change, no event
  assert.equal(changes, 1);
  assert.equal(model.state.hovered, 'a');
  const running = model.run();
  model.destroy();
  await running;
  const seen = changes;
  model.hover('b');
  assert.equal(changes, seen);
  assert.equal(search.cancelled, 1);
  assert.equal(manager.listeners.size, 0);
});

// --- adding a scene to the map ---------------------------------------------------------------

async function modelWith(scenes, overrides) {
  const search = stubSearch(overrides);
  const manager = stubManager();
  const model = createImagerySearchModel({ search, profile: PROFILE, manager });
  const running = model.run();
  search.calls[0].finish(scenes);
  await running;
  return { search, manager, model };
}

test("add() resolves the scene's LayerSpec and adds it to the manager once", async () => {
  const { manager, model } = await modelWith([scene('a'), scene('b')]);
  await Promise.all([model.add('a'), model.add('a')]);
  await model.add('a');
  assert.deepEqual(manager.added.map((s) => s.id), ['s2:a']);
  assert.deepEqual([...model.state.added], ['a']);
  assert.equal(model.state.adding.size, 0);
});

test('a failed add records the error on the model and leaves `added` unchanged', async () => {
  const failure = Object.assign(new Error('The files of scene "a" could not be worked out'), { code: 'SCENE_ASSETS_UNAVAILABLE' });
  const { manager, model } = await modelWith([scene('a')], { layerSpecFor: async () => Promise.reject(failure) });
  await model.add('a');
  assert.deepEqual(manager.added, []);
  assert.equal(model.state.added.size, 0);
  assert.equal(model.state.adding.size, 0);
  assert.deepEqual(model.state.addError, { id: 'a', error: failure });
  assert.equal(model.state.status, 'done', 'the results are still good');
});

test('a scene the manager already holds counts as added; one it removes can be added again', async () => {
  const { manager, model } = await modelWith([scene('a')]);
  manager.add = async () => {
    throw Object.assign(new Error('duplicate'), { code: 'LAYER_INVALID', context: { reason: 'duplicate', id: 's2:a' } });
  };
  await model.add('a');
  assert.deepEqual([...model.state.added], ['a']);
  assert.equal(model.state.addError, undefined);
  manager.emit({ type: 'remove', id: 's2:a' });
  assert.equal(model.state.added.size, 0);
});

// Phase 2 review, M3. LayerManager keeps a layer that failed to load in its
// list, in `error`. A second click on that scene then met "duplicate id" --
// which the model read as "already added" and labelled the card "Added".
test('a scene whose layer is in the stack in error is tried again, not called added', async () => {
  const { manager, model } = await modelWith([scene('a')]);
  const entries = new Map();
  let attempts = 0;
  manager.get = (id) => entries.get(id) ?? null;
  manager.remove = (id) => entries.delete(id);
  manager.add = async (spec) => {
    attempts += 1;
    if (entries.has(spec.id)) throw Object.assign(new Error('duplicate'), { code: 'LAYER_INVALID', context: { reason: 'duplicate', id: spec.id } });
    if (attempts === 1) {
      entries.set(spec.id, { id: spec.id, status: 'error', error: new Error('404') });
      throw Object.assign(new Error('could not be drawn'), { code: 'LAYER_LOAD_FAILED' });
    }
    entries.set(spec.id, { id: spec.id, status: 'ready' });
    return entries.get(spec.id);
  };
  await model.add('a');
  assert.equal(model.state.added.size, 0);
  assert.equal(model.state.addError.error.code, 'LAYER_LOAD_FAILED');
  await model.add('a');
  assert.deepEqual([...model.state.added], ['a'], 'the second try replaced the failed layer');
  assert.equal(model.state.addError, undefined);
  assert.equal(entries.get('s2:a').status, 'ready');
});

// A COG that cannot be opened is reported by the manager some time AFTER add() resolved.
test('a layer that fails after it was added stops being "added", and its card says why', async () => {
  const { manager, model } = await modelWith([scene('a')]);
  await model.add('a');
  assert.deepEqual([...model.state.added], ['a']);
  const failure = Object.assign(new Error('"a" could not be drawn: 404'), { code: 'LAYER_LOAD_FAILED' });
  manager.get = () => ({ id: 's2:a', status: 'error', error: failure });
  manager.emit({ type: 'error', id: 's2:a' });
  assert.equal(model.state.added.size, 0);
  assert.deepEqual(model.state.addError, { id: 'a', error: failure });
});

// --- changing the order ----------------------------------------------------------------------------

// Phase 2 review, M2: choosing an order did nothing until the next Search.
test('setSort reorders what is shown at once, without another search, when everything that matched is shown', async () => {
  const sorted = [];
  const { search, model } = await modelWith([scene('a'), scene('b')], {
    sort: (scenes, sort) => {
      sorted.push(sort);
      return [...scenes].reverse();
    },
  });
  model.setSort({ by: 'eo:cloud_cover', order: 'asc' });
  assert.deepEqual(model.state.scenes.map((s) => s.id), ['b', 'a']);
  assert.deepEqual(sorted, [{ by: 'eo:cloud_cover', order: 'asc' }]);
  assert.equal(search.calls.length, 1, 'no second search');
});

test('setSort searches again when only some of what matched is shown: the top N by another order are other scenes', async () => {
  const search = stubSearch({ sort: (scenes) => scenes });
  const model = createImagerySearchModel({ search, profile: PROFILE, manager: stubManager() });
  const running = model.run();
  search.calls[0].finish([scene('a')], { truncated: true, matched: 900 });
  await running;
  model.setSort({ by: 'eo:cloud_cover', order: 'asc' });
  assert.equal(search.calls.length, 2);
  assert.deepEqual(search.calls[1].query.sort, { by: 'eo:cloud_cover', order: 'asc' });
  assert.equal(model.state.status, 'searching');
});

test('setSort before any search just records the choice', () => {
  const search = stubSearch();
  const model = createImagerySearchModel({ search, profile: PROFILE, manager: stubManager() });
  model.setSort({ by: 'datetime', order: 'asc' });
  assert.equal(search.calls.length, 0);
  assert.deepEqual(model.state.sort, { by: 'datetime', order: 'asc' });
});

test('add() of an id that is not in the results does nothing', async () => {
  const { manager, model } = await modelWith([scene('a')]);
  await model.add('zzz');
  assert.deepEqual(manager.added, []);
});

// --- footprints ---------------------------------------------------------------------------------

test('footprintsGeoJson uses the geometry, falls back to the bbox, and skips a scene with neither', () => {
  const polygon = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
  const fc = footprintsGeoJson([scene('a', { geometry: polygon }), scene('b', { bbox: [10, 20, 11, 21] }), scene('c', { bbox: null }), scene('d', { geometry: { type: 'Point', coordinates: [0, 0] }, bbox: [5, 5, 6, 6] })], 'b');
  assert.equal(fc.type, 'FeatureCollection');
  assert.deepEqual(fc.features.map((f) => [f.properties.id, f.properties.hovered]), [['a', false], ['b', true], ['d', false]]);
  assert.equal(fc.features[0].geometry, polygon);
  assert.deepEqual(fc.features[1].geometry, { type: 'Polygon', coordinates: [[[10, 20], [11, 20], [11, 21], [10, 21], [10, 20]]] });
  assert.equal(fc.features[2].geometry.type, 'Polygon', 'a point cannot be a footprint: its bbox is used');
});

test('footprintsGeoJson: a bbox across the antimeridian becomes two boxes, not one around the world', () => {
  const [feature] = footprintsGeoJson([scene('wrap', { bbox: [179, 0, -179, 1] })], null).features;
  assert.equal(feature.geometry.type, 'MultiPolygon');
  assert.deepEqual(feature.geometry.coordinates.map((p) => [p[0][0][0], p[0][1][0]]), [[179, 180], [-180, -179]]);
});

// --- the map view as a search area -------------------------------------------------------------

test('areaFromBounds: a view is an Area; the whole world is no area at all', () => {
  const area = areaFromBounds([36, -2, 37.5, -1]);
  assert.equal(area.type, 'Area');
  assert.deepEqual(area.bboxes, [[36, -2, 37.5, -1]]);
  assert.equal(area.provenance.source, 'draw');
  assert.equal(areaFromBounds([-200, -80, 200, 80]), null);
  assert.equal(areaFromBounds([-180, -85, 180, 85]), null);
  assert.equal(areaFromBounds(null), null);
  assert.equal(areaFromBounds([1, 2, NaN, 4]), null);
});

test('areaFromBounds: a view across the antimeridian searches both sides', () => {
  // MapLibre reports such a view with a longitude beyond 180.
  const area = areaFromBounds([170, -20, 190, -10]);
  assert.equal(area.crossesAntimeridian, true);
  assert.deepEqual(area.bboxes.map((b) => [b[0], b[2]]).sort((a, b) => a[0] - b[0]), [[-180, -170], [170, 180]]);
  const west = areaFromBounds([-190, -20, -170, -10]);
  assert.deepEqual(west.bboxes.map((b) => [b[0], b[2]]).sort((a, b) => a[0] - b[0]), [[-180, -170], [170, 180]]);
});

test('areaFromBounds: latitudes are clamped to what data can have', () => {
  assert.deepEqual(areaFromBounds([0, -95, 10, 95]).bboxes, [[0, -90, 10, 90]]);
});
