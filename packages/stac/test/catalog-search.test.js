// CatalogIndex.search over the fake index (helpers/fake-index.js): eight
// collections chosen so that each filter and the ranking have something to
// tell apart.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import MiniSearch from 'minisearch';
import { buildArea } from '@cngeo/spec';
import { CatalogIndex } from '../src/catalog-index.js';
import { setMinisearchModules, clearMinisearchModules, loadMinisearch, MINISEARCH_URL } from '../src/minisearch-loader.js';
import { itemsHost } from './helpers/fake-items.js';
import { buildIndex, INDEX_URL } from './helpers/fake-index.js';

beforeEach(() => {
  clearMinisearchModules();
  setMinisearchModules({ MiniSearch });
});

const ids = (r) => r.results.map((x) => x.id);
const box = (w, s, e, n) => buildArea({ name: 'view', geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, source: 'draw', features: [] });
const NAIROBI_VIEW = box(36.6, -1.5, 37.2, -1.1);
const facet = (r, name) => Object.fromEntries(r.facets[name].map((f) => [f.value, f.count]));

async function loaded(opts) {
  const host = itemsHost({ [INDEX_URL]: buildIndex(opts) });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  return index;
}

// --- text ---------------------------------------------------------------------------------

test('text finds by title, keyword and description, best first, and by a prefix of the last word', async () => {
  const index = await loaded();
  const roads = await index.search({ text: 'roads' });
  assert.deepEqual(ids(roads), ['roads']);
  assert.equal(roads.total, 1);
  assert.ok(roads.results[0].score > 0);
  // A keyword only: "census" is in one title; "population" only in its keywords.
  assert.deepEqual(ids(await index.search({ text: 'population' })), ['census']);
  // A description only.
  assert.deepEqual(ids(await index.search({ text: 'coral' })), ['fiji']);
  // A title match outranks a description match: "Nairobi" is in two titles and one other description.
  const nairobi = await index.search({ text: 'nairobi' });
  assert.deepEqual(ids(nairobi).slice(0, 2).sort(), ['imagery', 'nairobi']);
  assert.equal(ids(nairobi)[2], 'buildings');
  // The last word may be unfinished, as it is while typing.
  assert.deepEqual(ids(await index.search({ text: 'kenya cens' })), ['census']);
  // Every word has to be there.
  assert.deepEqual(ids(await index.search({ text: 'kenya reefs' })), []);
});

test('a misspelling still finds it', async () => {
  const index = await loaded();
  // Both mention Nairobi and buildings; the one that has them in its title comes first.
  assert.deepEqual(ids(await index.search({ text: 'nairbi buildings' })), ['nairobi', 'buildings']);
});

test('no text matches everything, in title order', async () => {
  const index = await loaded();
  const all = await index.search({});
  assert.equal(all.total, 8);
  assert.deepEqual(ids(all), ['fiji', 'buildings', 'landcover', 'census', 'imagery', 'nairobi', 'roads', 'tonga']);
  assert.ok(all.results.every((r) => r.score === 1 && r.fit === null));
});

// --- area (Review Focus 4) ---------------------------------------------------------------------

test('area keeps what intersects, and a local collection outranks a global one for the same words', async () => {
  const index = await loaded();
  const inView = await index.search({ area: NAIROBI_VIEW });
  assert.deepEqual(ids(inView).sort(), ['buildings', 'census', 'imagery', 'landcover', 'nairobi', 'roads']);
  const buildings = await index.search({ text: 'buildings', area: NAIROBI_VIEW });
  assert.deepEqual(ids(buildings), ['nairobi', 'buildings'], 'the city\'s own buildings before the world\'s');
  const [local, global] = buildings.results;
  assert.ok(local.fit > 0.9, `local fit ${local.fit}`);
  assert.ok(global.fit < 0.01, `global fit ${global.fit}`);
});

test('with no area the same two rank by text alone', async () => {
  const index = await loaded();
  const buildings = await index.search({ text: 'buildings' });
  assert.deepEqual(ids(buildings).sort(), ['buildings', 'nairobi']);
  assert.ok(buildings.results.every((r) => r.fit === null));
  assert.ok(buildings.results[0].score >= buildings.results[1].score);
});

test('an area across the antimeridian matches on both sides, and so does a collection that crosses it', async () => {
  const index = await loaded();
  const pacific = buildArea({
    name: 'pacific',
    geometry: { type: 'MultiPolygon', coordinates: [[[[170, -25], [180, -25], [180, -10], [170, -10], [170, -25]]], [[[-180, -25], [-170, -25], [-170, -10], [-180, -10], [-180, -25]]]] },
    source: 'draw',
    features: [],
  });
  assert.equal(pacific.crossesAntimeridian, true);
  // Fiji's own box crosses 180 (west 177, east -178); Tonga is east of it.
  assert.deepEqual(ids(await index.search({ area: pacific, catalog: 'pacific' })).sort(), ['fiji', 'tonga']);
  // A view on one side only still finds Fiji, by the half of it on that side.
  assert.deepEqual(ids(await index.search({ area: box(178, -18, 179.5, -17), catalog: 'pacific' })), ['fiji']);
  assert.deepEqual(ids(await index.search({ area: box(-179.5, -18, -178.5, -17), catalog: 'pacific' })), ['fiji']);
});

// --- time ----------------------------------------------------------------------------------------

test('time keeps what overlaps; an open-ended collection matches a later window; one with no dates matches none', async () => {
  const index = await loaded();
  assert.deepEqual(ids(await index.search({ time: { start: '2021-06-01T00:00:00Z', end: '2022-06-01T00:00:00Z' } })), ['buildings']);
  assert.deepEqual(ids(await index.search({ time: { start: '2030-01-01T00:00:00Z', end: '2031-01-01T00:00:00Z' } })).sort(), ['buildings', 'imagery', 'nairobi']);
  assert.deepEqual(ids(await index.search({ time: { end: '2018-12-31T00:00:00Z' } })).sort(), ['landcover', 'tonga']);
  assert.equal(ids(await index.search({ time: { start: '1990-01-01T00:00:00Z' } })).includes('fiji'), false);
});

// --- facets ----------------------------------------------------------------------------------------

test('license, catalog and kinds filter; kinds needs a render column', async () => {
  const plain = await loaded();
  assert.deepEqual(ids(await plain.search({ license: 'ODbL-1.0' })).sort(), ['buildings', 'nairobi']);
  assert.deepEqual(ids(await plain.search({ catalog: ['pacific', 'global'] })).sort(), ['buildings', 'fiji', 'landcover', 'tonga']);
  // No `render` column: nothing is known to be a COG, so nothing matches, and there is no kinds facet to offer.
  const none = await plain.search({ kinds: 'cog' });
  assert.equal(none.total, 0);
  assert.deepEqual((await plain.search({})).facets.kinds, []);

  const enriched = await loaded({ withRender: true });
  assert.deepEqual(ids(await enriched.search({ kinds: 'cog' })), ['landcover']);
  assert.deepEqual(ids(await enriched.search({ kinds: ['table', 'scenes'] })).sort(), ['census', 'imagery']);
  assert.deepEqual(facet(await enriched.search({}), 'kinds'), { 'pmtiles-vector': 4, cog: 1, table: 1, scenes: 1, unsupported: 1 });
});

test('facet counts ignore their own filter and respect the others', async () => {
  const index = await loaded();
  const all = await index.search({});
  assert.deepEqual(facet(all, 'license'), { 'CC-BY-4.0': 5, 'ODbL-1.0': 2, 'CC0-1.0': 1 });
  assert.deepEqual(all.facets.license[0], { value: 'CC-BY-4.0', count: 5 }, 'most frequent first');
  assert.deepEqual(facet(all, 'catalog'), { kenya: 4, global: 2, pacific: 2 });

  const odbl = await index.search({ license: 'ODbL-1.0' });
  // Its own facet still shows what else could be chosen...
  assert.deepEqual(facet(odbl, 'license'), { 'CC-BY-4.0': 5, 'ODbL-1.0': 2, 'CC0-1.0': 1 });
  // ...and the others count only what the choice left.
  assert.deepEqual(facet(odbl, 'catalog'), { kenya: 1, global: 1 });

  const kenyaText = await index.search({ text: 'buildings', catalog: 'kenya' });
  assert.deepEqual(ids(kenyaText), ['nairobi']);
  assert.deepEqual(facet(kenyaText, 'catalog'), { kenya: 1, global: 1 }, 'the text narrows every facet');
  assert.deepEqual(facet(kenyaText, 'license'), { 'ODbL-1.0': 1 });
});

test('limit cuts results, total does not', async () => {
  const index = await loaded();
  const cut = await index.search({ limit: 3 });
  assert.equal(cut.results.length, 3);
  assert.equal(cut.total, 8);
});

// --- one search at a time (Review Focus 2) ----------------------------------------------------------

test('a superseded search resolves empty and marked', async () => {
  const index = await loaded();
  const first = index.search({ text: 'roads' });
  const second = index.search({ text: 'reefs' });
  assert.deepEqual(await first, { results: [], total: 0, facets: { license: [], catalog: [], kinds: [] }, superseded: true });
  assert.deepEqual(ids(await second), ['fiji']);
});

test('search() loads the index itself when load() was not called', async () => {
  const host = itemsHost({ [INDEX_URL]: buildIndex() });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  assert.deepEqual(ids(await index.search({ text: 'tonga' })), ['tonga']);
});

// --- the text-search module ---------------------------------------------------------------------------

test('the text index is built once, and not at all for a search with no words', async () => {
  let built = 0;
  class Counting extends MiniSearch {
    constructor(options) {
      super(options);
      built += 1;
    }
  }
  setMinisearchModules({ MiniSearch: Counting });
  const index = await loaded();
  await index.search({ area: NAIROBI_VIEW });
  assert.equal(built, 0);
  await index.search({ text: 'roads' });
  await index.search({ text: 'reefs' });
  assert.equal(built, 1);
});

test('loadMinisearch: from the pinned URL unless one was handed in; a failed load is tried again', async () => {
  clearMinisearchModules();
  const asked = [];
  let fail = true;
  const importer = async (url) => {
    asked.push(url);
    if (fail) throw new Error('offline');
    return { default: MiniSearch };
  };
  await assert.rejects(loadMinisearch({ importer }), (e) => e.code === 'NETWORK' && e.retryable === true);
  fail = false;
  assert.equal(await loadMinisearch({ importer }), MiniSearch);
  assert.equal(await loadMinisearch({ importer }), MiniSearch);
  assert.deepEqual(asked, [MINISEARCH_URL, MINISEARCH_URL]);
  assert.match(MINISEARCH_URL, /minisearch@7\.2\.0\//);
  assert.throws(() => setMinisearchModules({}), TypeError);
});
