// What the Phase 3 review found in CatalogIndex, each pinned by the test that
// failed before its fix: links relative to the index, a host that never
// answers, a catalog hidden by the one-entry-per-collection rule, and text
// search that neither folded accents nor kept fuzzy matching in its place.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import MiniSearch from 'minisearch';
import { CatalogIndex } from '../src/catalog-index.js';
import { setMinisearchModules, clearMinisearchModules } from '../src/minisearch-loader.js';
import { itemsHost } from './helpers/fake-items.js';
import { buildIndex, catalogJson, collectionJson, COLLECTIONS, INDEX_URL, CATALOG_URL, hrefOf } from './helpers/fake-index.js';

beforeEach(() => {
  clearMinisearchModules();
  setMinisearchModules({ MiniSearch });
});

const ids = (r) => r.results.map((x) => x.id);
const facet = (r, name) => Object.fromEntries(r.facets[name].map((f) => [f.value, f.count]));
const collectionRow = (rows, id) => rows.find((r) => r.type === 'Collection' && r.id === id);
const ROADS = COLLECTIONS.find((c) => c.key === 'roads');

async function loaded(opts, resources = {}, indexOptions = {}) {
  const host = itemsHost({ [INDEX_URL]: buildIndex(opts), ...resources });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch, ...indexOptions });
  await index.load();
  return { index, host };
}

// --- links relative to the index (the spec: "href is absolute, or relative to the index file") ---

test('an href relative to the index file is resolved against it, and so the collection can be fetched', async () => {
  const absolute = 'https://registry.invalid/v0.1/kenya/roads/collection.json';
  const { index, host } = await loaded(
    {
      withRender: false,
      edit: (rows) => {
        const row = collectionRow(rows, 'roads');
        row.href = './kenya/roads/collection.json';
        row.parents = [{ id: 'kenya', href: '../kenya/catalog.json' }];
      },
    },
    { [absolute]: collectionJson(ROADS) },
  );
  const roads = index.entries.find((e) => e.id === 'roads');
  assert.equal(roads.href, absolute);
  assert.equal(roads.key, absolute);
  assert.equal(roads.parents[0].href, 'https://registry.invalid/kenya/catalog.json');
  host.reset();
  const resolved = await index.resolve(roads);
  assert.deepEqual(host.log.map((r) => r.url), [absolute]);
  assert.equal(resolved.drawable.length, 1);
});

test('a relative thumbnail is resolved against the index too', async () => {
  const { index } = await loaded({ withRender: true, edit: (rows) => { collectionRow(rows, 'roads').thumbnail = 'thumbs/roads.png'; } });
  assert.equal(index.entries.find((e) => e.id === 'roads').thumbnail, 'https://registry.invalid/v0.1/thumbs/roads.png');
});

test('a row whose href is not http(s) is left out, not offered as something to fetch', async () => {
  const { index } = await loaded({ edit: (rows) => { collectionRow(rows, 'tonga').href = 'javascript:alert(1)'; } });
  assert.equal(index.entries.length, 7);
  assert.equal(index.entries.some((e) => e.id === 'tonga'), false);
});

// --- a host that never answers ----------------------------------------------------------------------

test('a collection whose host never answers fails after the time limit, and can be tried again', async () => {
  const real = itemsHost({ [INDEX_URL]: buildIndex(), [hrefOf(ROADS)]: collectionJson(ROADS) });
  let hang = true;
  // It ignores its signal: the limit must not depend on being obeyed.
  const fetch = (url, init) => (hang && String(url) === hrefOf(ROADS) ? new Promise(() => {}) : real.fetch(url, init));
  const index = new CatalogIndex(INDEX_URL, { fetch, timeoutMs: 300 });
  await index.load();
  const roads = index.entries.find((e) => e.id === 'roads');
  const started = Date.now();
  await assert.rejects(index.resolve(roads), (e) => {
    assert.equal(e.code, 'LAYER_LOAD_FAILED');
    assert.equal(e.retryable, true);
    assert.match(e.message, /Roads of Kenya/);
    assert.match(e.message, /did not answer/);
    return true;
  });
  assert.ok(Date.now() - started < 5000);
  hang = false;
  assert.equal((await index.resolve(roads)).drawable.length, 1, 'the hung attempt was not kept');
});

test('a catalog.json whose host never answers fails NETWORK after the time limit', async () => {
  const fetch = () => new Promise(() => {});
  const index = new CatalogIndex(CATALOG_URL, { fetch, timeoutMs: 100 });
  await assert.rejects(index.load(), (e) => e.code === 'NETWORK' && e.retryable === true && /did not answer/.test(e.message));
});

test('a catalog.json is still followed, within its limit', async () => {
  const host = itemsHost({ [CATALOG_URL]: catalogJson(), [INDEX_URL]: buildIndex() });
  const index = new CatalogIndex(CATALOG_URL, { fetch: host.fetch, timeoutMs: 5000 });
  await index.load();
  assert.equal(index.entries.length, 8);
});

// --- one collection registered under two catalogs ------------------------------------------------------
//
// Live: every one of `harmonized-field-data`'s 79 collections is also listed,
// earlier, under `global-data`. Keeping only the first row made that whole
// catalog vanish -- no entries, no facet row, nothing to filter by.

const twice = {
  edit: (rows) => {
    rows.push({ ...collectionRow(rows, 'roads'), 'portolan_registry:id': 'harmonized', parents: [{ id: 'harmonized', href: 'https://data.invalid/harmonized/catalog.json' }] });
  },
};

test('a collection listed under two catalogs is one entry that belongs to both', async () => {
  const { index } = await loaded(twice);
  assert.equal(index.entries.length, 8);
  assert.equal(index.duplicates, 1);
  const roads = index.entries.find((e) => e.id === 'roads');
  assert.equal(roads.catalog, 'kenya', 'the first it was listed under');
  assert.deepEqual(roads.catalogs, ['kenya', 'harmonized']);
  assert.deepEqual(index.entries.find((e) => e.id === 'fiji').catalogs, ['pacific']);
});

test('either catalog finds it, and both are counted in the facet', async () => {
  const { index } = await loaded(twice);
  assert.deepEqual(ids(await index.search({ catalog: 'harmonized' })), ['roads']);
  assert.ok(ids(await index.search({ catalog: 'kenya' })).includes('roads'));
  const all = await index.search({});
  assert.equal(all.total, 8);
  assert.deepEqual(facet(all, 'catalog'), { kenya: 4, global: 2, pacific: 2, harmonized: 1 });
});

// --- text: accents, and fuzzy matching only as a last resort -----------------------------------------------

const german = {
  edit: (rows) => {
    const base = collectionRow(rows, 'fiji');
    rows.push({ ...base, id: 'baeume', href: 'https://data.invalid/berlin/baeume/collection.json', title: 'Baumbestand Berlin', description: 'Alle Bäume an Berliner Straßen.', keywords: ['Bäume'] });
    rows.push({ ...base, id: 'raeume', href: 'https://data.invalid/berlin/raeume/collection.json', title: 'Kühle Räume', description: 'Kühle Räume für heiße Tage.', keywords: [] });
    rows.push({ ...base, id: 'bati', href: 'https://data.invalid/paris/bati/collection.json', title: 'Bâtiments de Paris', description: 'Emprise du bâti.', keywords: [] });
  },
};

test('a word typed without its accents finds the accented word, as a whole word and as a beginning', async () => {
  const { index } = await loaded(german);
  assert.deepEqual(ids(await index.search({ text: 'baume' })), ['baeume']);
  assert.deepEqual(ids(await index.search({ text: 'batim' })), ['bati'], 'an unfinished, unaccented word');
  assert.deepEqual(ids(await index.search({ text: 'Bâtiments' })), ['bati'], 'and the accented spelling still does');
  assert.deepEqual(ids(await index.search({ text: 'kuhle raume' })), ['raeume']);
});

test('a short word brings no near-misses with it', async () => {
  const { index } = await loaded(german);
  // "Räume" is one letter from "Bäume": a different word entirely.
  assert.deepEqual(ids(await index.search({ text: 'bäume' })), ['baeume']);
  assert.deepEqual(ids(await index.search({ text: 'räume' })), ['raeume']);
});

test('a longer word still finds its singular or plural', async () => {
  // Fuzzy matching only as a last resort lost this: "buildings" stopped
  // finding a collection called "Building" (live: 153 results became 75).
  const { index } = await loaded({
    edit: (rows) => {
      rows.push({ ...collectionRow(rows, 'fiji'), id: 'overture-building', href: 'https://data.invalid/overture/building/collection.json', title: 'Building', description: 'Footprints.', keywords: [] });
    },
  });
  assert.ok(ids(await index.search({ text: 'buildings' })).includes('overture-building'));
  assert.ok(ids(await index.search({ text: 'footprint' })).includes('overture-building'));
});

test('a misspelling is still forgiven when nothing matches as typed', async () => {
  const { index } = await loaded(german);
  assert.deepEqual(ids(await index.search({ text: 'nairbi buildings' })), ['nairobi', 'buildings']);
  assert.deepEqual(ids(await index.search({ text: 'batimentz' })), ['bati']);
});
