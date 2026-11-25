import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogSearchModel, catalogStatusOf, extentsGeoJson } from '../src/catalog-search-model.js';

// The catalog search panel's state, with no DOM. The index is injected --
// anything shaped like @cngeo/stac's CatalogIndex (`load`, `search`,
// `resolve`) -- because this package does not import that one.

const result = (key, extra = {}) => ({ key, id: key, title: `Title of ${key}`, description: '', href: `https://data.invalid/${key}/collection.json`, license: 'CC-BY-4.0', keywords: [], catalog: 'kenya', bbox: [36, -2, 38, 0], start: null, end: null, kinds: [], thumbnail: null, score: 1, fit: null, ...extra });
const layer = (id, kind = 'pmtiles-vector') => ({ spec: 'cng-layer/1.0', id, title: id, kind, source: { url: `https://data.invalid/${id}.pmtiles` }, attribution: [] });
const FACETS = { license: [{ value: 'CC-BY-4.0', count: 2 }], catalog: [{ value: 'kenya', count: 2 }], kinds: [] };

/** A CatalogIndex stand-in. Each `search()` is held until the test lets it go. */
function stubIndex(overrides = {}) {
  const calls = [];
  const index = {
    entries: new Array(42).fill(null),
    hasRender: false,
    calls,
    loads: 0,
    async load() {
      index.loads += 1;
    },
    search(query) {
      let release;
      const done = new Promise((resolve) => (release = resolve));
      for (const earlier of calls) if (!earlier.settled) earlier.supersede();
      const call = {
        query,
        settled: false,
        supersede() {
          call.settled = true;
          release({ results: [], total: 0, facets: { license: [], catalog: [], kinds: [] }, superseded: true });
        },
        finish(results, more = {}) {
          call.settled = true;
          release({ results, total: results.length, facets: FACETS, ...more });
        },
        fail(error) {
          call.settled = true;
          release(Promise.reject(error));
        },
      };
      calls.push(call);
      return done;
    },
    async resolve(r) {
      return { layers: [layer(`${r.key}-tiles`)], source: 'collection', drawable: [layer(`${r.key}-tiles`)], undrawable: [] };
    },
    ...overrides,
  };
  return index;
}

function stubManager() {
  const listeners = new Set();
  const entries = new Map();
  const manager = {
    added: [],
    entries,
    async add(spec) {
      if (entries.has(spec.id)) throw Object.assign(new Error('duplicate'), { code: 'LAYER_INVALID', context: { reason: 'duplicate', id: spec.id } });
      // As the real manager: two ids that become one name on the map clash too ("a b" and "a/b").
      const slug = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const clash = [...entries.keys()].find((id) => slug(id) === slug(spec.id));
      if (clash) throw Object.assign(new Error(`too close to "${clash}"`), { code: 'LAYER_INVALID', context: { reason: 'duplicate', id: spec.id, clashesWith: clash } });
      entries.set(spec.id, { id: spec.id, spec, status: 'ready' });
      manager.added.push(spec.id);
      return entries.get(spec.id);
    },
    get: (id) => entries.get(id) ?? null,
    remove(id) {
      entries.delete(id);
      manager.emit({ type: 'remove', id });
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

const AREA = { type: 'Area', name: 'view', bboxes: [[36, -2, 38, 0]] };

async function searched(results, overrides) {
  const index = stubIndex(overrides);
  const manager = stubManager();
  const model = createCatalogSearchModel({ index, manager });
  const running = model.run();
  await new Promise((r) => setTimeout(r, 0)); // the model loads the index first, then asks
  index.calls.at(-1).finish(results);
  await running;
  return { index, manager, model };
}

// --- searching ------------------------------------------------------------------------------

test('run() searches with the text, the view area when asked, and the chosen facets', async () => {
  const index = stubIndex();
  const model = createCatalogSearchModel({ index, manager: stubManager(), limit: 25 });
  model.setText('  buildings ');
  model.setArea(AREA);
  model.setFacet('license', 'ODbL-1.0');
  model.setFacet('catalog', 'kenya');
  model.setFacet('kinds', 'cog');
  const first = model.run();
  await new Promise((r) => setTimeout(r, 0));
  // The area is the map's, kept up to date -- but used only when "this map area" is on.
  assert.deepEqual(index.calls[0].query, { text: 'buildings', area: null, license: 'ODbL-1.0', catalog: 'kenya', kinds: 'cog', limit: 25 });
  model.setUseView(true);
  const second = model.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(index.calls[1].query.area, AREA);
  model.setFacet('license', null);
  const third = model.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(index.calls[2].query.license, undefined);
  index.calls[2].finish([result('a')]);
  await Promise.all([first, second, third]);
  assert.equal(model.state.status, 'done');
  assert.deepEqual(model.state.results.map((r) => r.key), ['a']);
  assert.equal(model.state.total, 1);
  assert.deepEqual(model.state.facets, FACETS);
});

test('a second run supersedes the first', async () => {
  const index = stubIndex();
  const model = createCatalogSearchModel({ index, manager: stubManager() });
  const first = model.run();
  await new Promise((r) => setTimeout(r, 0));
  const second = model.run();
  await new Promise((r) => setTimeout(r, 0));
  index.calls[1].finish([result('new')]);
  await Promise.all([first, second]);
  assert.deepEqual(model.state.results.map((r) => r.key), ['new']);
});

test('the index is loaded once, and the model knows how big it is', async () => {
  const { index, model } = await searched([result('a')]);
  const again = model.run();
  await new Promise((r) => setTimeout(r, 0));
  index.calls.at(-1).finish([result('a')]);
  await again;
  assert.equal(index.loads, 1);
  assert.equal(model.state.count, 42);
});

test('a failed search is an error state, not a rejection', async () => {
  const index = stubIndex();
  const model = createCatalogSearchModel({ index, manager: stubManager() });
  const running = model.run();
  await new Promise((r) => setTimeout(r, 0));
  index.calls[0].fail(Object.assign(new Error('offline'), { code: 'NETWORK' }));
  await running;
  assert.equal(model.state.status, 'error');
  assert.equal(model.state.error.code, 'NETWORK');
});

test('an index that will not load is an error state too, and the next run tries again', async () => {
  let fail = true;
  const index = stubIndex({
    async load() {
      if (fail) throw Object.assign(new Error('not an index'), { code: 'CATALOG_INDEX_INVALID' });
    },
  });
  const model = createCatalogSearchModel({ index, manager: stubManager() });
  await model.run();
  assert.equal(model.state.status, 'error');
  assert.equal(model.state.error.code, 'CATALOG_INDEX_INVALID');
  fail = false;
  const again = model.run();
  await new Promise((r) => setTimeout(r, 0));
  index.calls[0].finish([result('a')]);
  await again;
  assert.equal(model.state.status, 'done');
});

// --- adding to the map (Review Focus 3) ----------------------------------------------------------

test('add() adds every drawable layer once and marks the result added', async () => {
  const { manager, model } = await searched([result('a')], {
    async resolve(r) {
      return { layers: [], source: 'render', drawable: [layer(`${r.key}-tiles`), layer(`${r.key}-image`, 'cog')], undrawable: [] };
    },
  });
  await Promise.all([model.add('a'), model.add('a')]);
  await model.add('a');
  assert.deepEqual(manager.added, ['a-tiles', 'a-image']);
  assert.deepEqual([...model.state.added], ['a']);
  assert.equal(model.state.adding.size, 0);
  assert.equal(model.state.addNote, null);
});

test('add() of a result with nothing drawable adds nothing and says why', async () => {
  const { manager, model } = await searched([result('census')], {
    async resolve() {
      return { layers: [], source: 'render', drawable: [], undrawable: [{ id: 'census', title: 'Kenya census tables', kind: 'table', reason: 'A table with no geometry: there is nothing to draw on a map.' }] };
    },
  });
  await model.add('census');
  assert.deepEqual(manager.added, []);
  assert.equal(model.state.added.size, 0);
  assert.deepEqual(model.state.addNote, { id: 'census', tone: 'info', text: 'Nothing to add. A table with no geometry: there is nothing to draw on a map.' });
});

test('add() of a partly drawable result adds what it can and names the rest', async () => {
  const { manager, model } = await searched([result('mixed')], {
    async resolve(r) {
      return { layers: [], source: 'collection', drawable: [layer(`${r.key}-tiles`)], undrawable: [{ id: 'm2', title: 'Scenes of mixed', kind: 'scenes', reason: 'An imagery collection: its scenes are found with the imagery search, not drawn as one layer.' }] };
    },
  });
  await model.add('mixed');
  assert.deepEqual(manager.added, ['mixed-tiles']);
  assert.deepEqual([...model.state.added], ['mixed']);
  assert.equal(model.state.addNote.id, 'mixed');
  assert.match(model.state.addNote.text, /^Added 1 layer\. Not added: Scenes of mixed — An imagery collection/);
});

test('a failed resolve is reported on the result, and can be tried again', async () => {
  let fail = true;
  const { manager, model } = await searched([result('a')], {
    async resolve(r) {
      if (fail) throw Object.assign(new Error('Couldn\'t read "Title of a": its collection document returned HTTP 404.'), { code: 'LAYER_LOAD_FAILED' });
      return { layers: [], source: 'collection', drawable: [layer(`${r.key}-tiles`)], undrawable: [] };
    },
  });
  await model.add('a');
  assert.equal(model.state.added.size, 0);
  assert.deepEqual(model.state.addNote, { id: 'a', tone: 'error', text: 'Couldn\'t read "Title of a": its collection document returned HTTP 404.' });
  fail = false;
  await model.add('a');
  assert.deepEqual(manager.added, ['a-tiles']);
  assert.equal(model.state.addNote, null);
});

test('a layer the map refuses is named, and the result is not called added', async () => {
  const { manager, model } = await searched([result('a')]);
  manager.add = async () => {
    throw Object.assign(new Error('"a-tiles" could not be drawn: 404'), { code: 'LAYER_LOAD_FAILED' });
  };
  await model.add('a');
  assert.equal(model.state.added.size, 0);
  assert.equal(model.state.addNote.tone, 'error');
  assert.match(model.state.addNote.text, /could not be drawn: 404/);
});

test('a layer already on the map counts as added; one removed from the map can be added again', async () => {
  const { manager, model } = await searched([result('a')]);
  await manager.add(layer('a-tiles'));
  await model.add('a');
  assert.deepEqual([...model.state.added], ['a']);
  manager.remove('a-tiles');
  assert.equal(model.state.added.size, 0);
  await model.add('a');
  assert.deepEqual([...model.state.added], ['a']);
});

// --- Review (Phase 3), Critical 1 -------------------------------------------------------------
//
// A layer's id is its collection's id, and collection ids are not unique
// across catalogs: the live registry has 23 shared by two or more drawable
// collections (Overture's `place` and TIGER's `place`, two `land_use`...).
// The second one said "Added" and put nothing on the map.

/** An index whose every result resolves to a layer with the SAME id, each from its own file. */
const sameIdIndex = (id = 'place') => ({
  async resolve(r) {
    const spec = { ...layer(id), title: r.title, source: { url: `https://data.invalid/${r.key}/${id}.pmtiles` } };
    return { layers: [spec], source: 'render', drawable: [spec], undrawable: [] };
  },
});

test('two collections that share a layer id are two layers on the map', async () => {
  const { manager, model } = await searched([result('overture', { catalog: 'overture' }), result('tiger', { catalog: 'tiger' })], sameIdIndex());
  await model.add('overture');
  await model.add('tiger');
  assert.equal(manager.added.length, 2, 'both were really added');
  assert.equal(manager.added[0], 'place', 'the first keeps the plain id');
  assert.notEqual(manager.added[1], 'place');
  const sources = manager.added.map((id) => manager.get(id).spec.source.url);
  assert.deepEqual(sources, ['https://data.invalid/overture/place.pmtiles', 'https://data.invalid/tiger/place.pmtiles']);
  assert.deepEqual([...model.state.added].sort(), ['overture', 'tiger']);
  assert.equal(model.state.addNote, null);
});

test('each of the two is removed, and added again, on its own', async () => {
  const { manager, model } = await searched([result('overture', { catalog: 'overture' }), result('tiger', { catalog: 'tiger' })], sameIdIndex());
  await model.add('overture');
  await model.add('tiger');
  manager.remove(manager.added[1]);
  assert.deepEqual([...model.state.added], ['overture']);
  manager.remove('place');
  assert.equal(model.state.added.size, 0);
  await model.add('tiger');
  assert.deepEqual([...model.state.added], ['tiger']);
  assert.equal(manager.get(manager.added.at(-1)).spec.source.url, 'https://data.invalid/tiger/place.pmtiles');
});

test('a layer of the same id put on the map by something else is not mistaken for this one', async () => {
  const { manager, model } = await searched([result('tiger', { catalog: 'tiger' })], sameIdIndex());
  await manager.add({ ...layer('place'), source: { url: 'https://elsewhere.invalid/place.pmtiles' } });
  await model.add('tiger');
  assert.equal(manager.added.length, 2);
  assert.equal(manager.get(manager.added[1]).spec.source.url, 'https://data.invalid/tiger/place.pmtiles');
  assert.deepEqual([...model.state.added], ['tiger']);
});

test('two ids that become one name on the map are two layers too', async () => {
  // The manager refuses "land use" beside "land/use": `get()` finds neither, and the refusal was read as "already there".
  let n = 0;
  const { manager, model } = await searched([result('a'), result('b')], {
    async resolve(r) {
      const spec = { ...layer(n++ === 0 ? 'land/use' : 'land use'), source: { url: `https://data.invalid/${r.key}/landuse.pmtiles` } };
      return { layers: [spec], source: 'render', drawable: [spec], undrawable: [] };
    },
  });
  await model.add('a');
  await model.add('b');
  assert.equal(manager.added.length, 2);
  assert.deepEqual([...model.state.added].sort(), ['a', 'b']);
});

test('the same collection found again (same source) is simply there, and not added twice', async () => {
  const { manager, model } = await searched([result('tiger', { catalog: 'tiger' })], sameIdIndex());
  await manager.add({ ...layer('place'), source: { url: 'https://data.invalid/tiger/place.pmtiles' } });
  await model.add('tiger');
  assert.equal(manager.added.length, 1);
  assert.deepEqual([...model.state.added], ['tiger']);
});

test('a result with two layers stays added until both are removed', async () => {
  const { manager, model } = await searched([result('a')], {
    async resolve(r) {
      return { layers: [], source: 'render', drawable: [layer(`${r.key}-1`), layer(`${r.key}-2`)], undrawable: [] };
    },
  });
  await model.add('a');
  manager.remove('a-1');
  assert.deepEqual([...model.state.added], ['a']);
  manager.remove('a-2');
  assert.equal(model.state.added.size, 0);
});

test('changes are announced; destroy() stops them and lets go of the manager', async () => {
  const { manager, model } = await searched([result('a')]);
  let changes = 0;
  model.on('change', () => changes++);
  model.hover('a');
  model.hover('a');
  assert.equal(changes, 1);
  model.destroy();
  model.hover(null);
  assert.equal(changes, 1);
  assert.equal(manager.listeners.size, 0);
  assert.equal(model.destroyed, true);
});

// --- words and extents ------------------------------------------------------------------------------

test('catalogStatusOf: the words for each state, unchanged by hover or by adding', () => {
  const base = { status: 'idle', results: [], total: 0, count: 0, text: '', useView: false, error: undefined };
  assert.equal(catalogStatusOf({ ...base, status: 'loading' }).line, 'Loading the catalog…');
  assert.equal(catalogStatusOf({ ...base, status: 'searching', count: 6941 }).line, 'Searching 6,941 collections…');
  assert.equal(catalogStatusOf({ ...base, status: 'done', count: 6941 }).line, 'Nothing matches.');
  assert.equal(catalogStatusOf({ ...base, status: 'done', count: 6941, results: [result('a')], total: 1 }).line, '1 collection.');
  assert.equal(catalogStatusOf({ ...base, status: 'done', count: 6941, results: [result('a'), result('b')], total: 153 }).line, 'Showing 2 of 153 collections.');
  assert.equal(catalogStatusOf({ ...base, status: 'done', count: 6941, useView: true, results: [], total: 0 }).line, 'Nothing matches in this map area.');
  const failed = catalogStatusOf({ ...base, status: 'error', error: Object.assign(new Error('x is not a collections index'), { code: 'CATALOG_INDEX_INVALID' }) });
  assert.deepEqual(failed, { tone: 'error', line: 'The catalog could not be searched: x is not a collections index' });
  const state = { ...base, status: 'done', count: 10, results: [result('a')], total: 1 };
  assert.deepEqual(catalogStatusOf({ ...state, hovered: 'a', added: new Set(['a']), addNote: { id: 'a', text: 'x' } }), catalogStatusOf(state));
});

test('extentsGeoJson: one box per result with a bbox, the hovered one marked, an antimeridian box split', () => {
  const fc = extentsGeoJson([result('a'), result('nowhere', { bbox: null }), result('fiji', { bbox: [177, -19, -178, -16] })], 'fiji');
  assert.deepEqual(fc.features.map((f) => [f.properties.key, f.properties.hovered, f.geometry.type]), [['a', false, 'Polygon'], ['fiji', true, 'MultiPolygon']]);
  assert.deepEqual(fc.features[0].geometry.coordinates, [[[36, -2], [38, -2], [38, 0], [36, 0], [36, -2]]]);
  assert.deepEqual(fc.features[1].geometry.coordinates.map((p) => [p[0][0][0], p[0][1][0]]), [[177, 180], [-180, -178]]);
});
