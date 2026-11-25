// The `render` column: what a catalog index would have to say about each
// collection for a search result to become a map layer WITHOUT fetching the
// collection's JSON. And `resolve()`, which uses it when it is there and
// fetches when it is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { validateLayerSpec } from '@cngeo/spec';
import { layersFromCollection } from '../src/layers-from-collection.js';
import { renderFromLayers, layersFromRender, RENDER_FIELDS } from '../src/render-column.js';
import { CatalogIndex } from '../src/catalog-index.js';
import { itemsHost } from './helpers/fake-items.js';
import { buildIndex, collectionJson, COLLECTIONS, INDEX_URL, hrefOf } from './helpers/fake-index.js';

const FIXTURES = readdirSync(new URL('./fixtures/', import.meta.url)).filter((n) => n.endsWith('.collection.json'));
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const find = (index, key) => index.entries.find((e) => e.key === hrefOf(COLLECTIONS.find((c) => c.key === key)));

/** A catalog entry for a collection, as the index would hold it, with `render` built from its layers. */
function entryFor(collection, baseUrl) {
  const layers = layersFromCollection(collection, { baseUrl });
  const first = layers[0];
  return {
    layers,
    entry: {
      key: baseUrl,
      id: collection.id,
      title: collection.title ?? collection.id,
      href: baseUrl,
      license: collection.license ?? null,
      bbox: first.bbox ?? null,
      start: first.temporal?.[0] ?? null,
      end: first.temporal?.[1] ?? null,
      thumbnail: first.thumbnail ?? null,
      attribution: first.attribution,
      render: renderFromLayers(layers, { title: collection.title ?? collection.id }),
    },
  };
}

// --- the shape ---------------------------------------------------------------------------------

test('renderFromLayers then layersFromRender gives the same kind, id, title and source, for each real collection', () => {
  assert.equal(FIXTURES.length, 6);
  for (const name of FIXTURES) {
    const collection = fixture(name);
    const baseUrl = `https://example.org/${collection.id}/collection.json`;
    const { layers, entry } = entryFor(collection, baseUrl);
    const back = layersFromRender(entry);
    assert.equal(back.length, layers.length, name);
    back.forEach((spec, i) => {
      assert.deepEqual(validateLayerSpec(spec), spec, `${name}: a valid LayerSpec`);
      assert.deepEqual([spec.kind, spec.id, spec.title, spec.source], [layers[i].kind, layers[i].id, layers[i].title, layers[i].source], name);
      assert.deepEqual(spec.attribution, layers[i].attribution, `${name}: credit comes with it`);
      assert.deepEqual(spec.bbox, layers[i].bbox, name);
    });
  }
});

test('a render entry is small and flat: nine fields, no attribution, no extent, no description', () => {
  const { entry } = entryFor(fixture('unosat-damage-sites.collection.json'), 'https://example.org/c/collection.json');
  assert.deepEqual(Object.keys(entry.render[0]), RENDER_FIELDS);
  assert.deepEqual(RENDER_FIELDS, ['kind', 'id', 'title', 'url', 'style', 'layers', 'display_asset', 'items', 'reason']);
  assert.ok(JSON.stringify(entry.render).length < 450, `${JSON.stringify(entry.render).length} characters`);
  // A title is stored only when it differs from the collection's own.
  assert.equal(entry.render[0].title, null);
});

test('an unsupported layer keeps its reason; a table its address', () => {
  const specs = [
    { spec: 'cng-layer/1.0', id: 'z', title: 'Z', kind: 'unsupported', source: { reason: 'Only zarr assets were found.', assetTypes: ['application/vnd+zarr'] }, attribution: [] },
    { spec: 'cng-layer/1.0', id: 't', title: 'T', kind: 'table', source: { url: 'https://example.org/t.parquet' }, attribution: [] },
  ];
  const render = renderFromLayers(specs);
  assert.equal(render[0].reason, 'Only zarr assets were found.');
  assert.equal(render[1].url, 'https://example.org/t.parquet');
  const back = layersFromRender({ key: 'https://example.org/c.json', href: 'https://example.org/c.json', title: 'C', render, attribution: null, license: 'CC0-1.0' });
  assert.equal(back[0].source.reason, 'Only zarr assets were found.');
  assert.deepEqual(back[1].source, { url: 'https://example.org/t.parquet' });
});

test('with no attribution column, a layer is credited with the collection title and licence rather than nothing', () => {
  const { entry } = entryFor(fixture('worldpop-jamaica-children-5-9.collection.json'), 'https://example.org/c/collection.json');
  const [spec] = layersFromRender({ ...entry, attribution: null });
  assert.deepEqual(spec.attribution, [{ text: entry.title, license: entry.license, shareAlike: false, share_alike: false }]);
});

test('layersFromRender returns [] for no render, and throws LAYER_INVALID for one that cannot be a layer', () => {
  assert.deepEqual(layersFromRender({ key: 'k', href: 'https://example.org/c.json', title: 'C', render: null }), []);
  assert.throws(() => layersFromRender({ key: 'k', href: 'https://example.org/c.json', title: 'C', render: [{ kind: 'cog', id: 'c', url: 's3://bucket/a.tif' }] }), (e) => e.code === 'LAYER_INVALID');
});

// --- resolve (Review Focus 3 and 5) ----------------------------------------------------------------

function hosts(opts) {
  const resources = { [INDEX_URL]: buildIndex(opts) };
  for (const c of COLLECTIONS) resources[hrefOf(c)] = collectionJson(c);
  return itemsHost(resources);
}

test('resolve uses render when present and makes no request', async () => {
  const host = hosts({ withRender: true });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  host.reset();
  const resolved = await index.resolve(find(index, 'roads'));
  assert.deepEqual(host.log, []);
  assert.equal(resolved.source, 'render');
  assert.equal(resolved.layers.length, 1);
  const [spec] = resolved.drawable;
  assert.deepEqual(validateLayerSpec(spec), spec);
  assert.equal(spec.kind, 'pmtiles-vector');
  assert.deepEqual(spec.source, { url: 'https://data.invalid/kenya/roads/roads.pmtiles', layers: ['roads'], style: { url: 'https://data.invalid/kenya/roads/style.json' } });
  assert.equal(spec.title, 'Roads of Kenya');
  assert.deepEqual(spec.bbox, [33.9, -4.7, 41.9, 5.5]);
  assert.deepEqual(spec.temporal, ['2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z']);
  assert.equal(spec.thumbnail, 'https://data.invalid/kenya/roads/thumbnail.png');
  assert.deepEqual(spec.attribution, [{ text: 'Kenya Roads Board', license: 'CC-BY-4.0', url: 'https://roads.invalid/', shareAlike: false, share_alike: false }]);
  assert.deepEqual(resolved.undrawable, []);
});

test('resolve fetches the collection when the index has no render column, once', async () => {
  const host = hosts();
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  host.reset();
  const roads = find(index, 'roads');
  const [a, b] = await Promise.all([index.resolve(roads), index.resolve(roads)]);
  const c = await index.resolve(roads);
  assert.equal(host.requestsTo(roads.href), 1);
  assert.equal(a.source, 'collection');
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(a.drawable[0].kind, 'pmtiles-vector');
  assert.equal(a.drawable[0].source.url, 'https://data.invalid/kenya/roads/roads.pmtiles');
  assert.equal(a.drawable[0].attribution[0].text, 'Test publisher');
});

test('resolve sorts layers into drawable and undrawable, each with a reason a person can read', async () => {
  const host = hosts({ withRender: true });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  const census = await index.resolve(find(index, 'census'));
  assert.deepEqual(census.drawable, []);
  assert.deepEqual(census.undrawable.map((u) => [u.kind, u.title]), [['table', 'Kenya census tables']]);
  assert.match(census.undrawable[0].reason, /table/i);
  const tonga = await index.resolve(find(index, 'tonga'));
  assert.deepEqual(tonga.undrawable.map((u) => [u.kind, u.reason]), [['unsupported', 'Only zarr assets were found.']]);
  const imagery = await index.resolve(find(index, 'imagery'));
  assert.equal(imagery.undrawable[0].kind, 'scenes');
  assert.match(imagery.undrawable[0].reason, /imagery/i);
  // What counts as drawable is the caller's to say.
  const withScenes = await index.resolve(find(index, 'imagery'), { drawableKinds: ['scenes'] });
  assert.equal(withScenes.drawable.length, 1);
});

test('a collection whose JSON is gone rejects LAYER_LOAD_FAILED naming it, and can be tried again', async () => {
  const resources = { [INDEX_URL]: buildIndex() };
  const host = itemsHost(resources);
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  const roads = find(index, 'roads');
  await assert.rejects(index.resolve(roads), (e) => {
    assert.equal(e.code, 'LAYER_LOAD_FAILED');
    assert.equal(e.retryable, true);
    assert.equal(e.context.collection, 'roads');
    assert.equal(e.context.url, roads.href);
    assert.equal(e.context.status, 404);
    assert.match(e.message, /Roads of Kenya/);
    return true;
  });
  resources[roads.href] = collectionJson(COLLECTIONS[0]);
  assert.equal((await index.resolve(roads)).drawable.length, 1);
});

test('a document that is not a collection rejects LAYER_LOAD_FAILED too, not a crash', async () => {
  const resources = { [INDEX_URL]: buildIndex(), [hrefOf(COLLECTIONS[0])]: { hello: 'world' } };
  const index = new CatalogIndex(INDEX_URL, { fetch: itemsHost(resources).fetch });
  await index.load();
  await assert.rejects(index.resolve(find(index, 'roads')), (e) => e.code === 'LAYER_LOAD_FAILED' && e.context.collection === 'roads');
});

test('a malformed render value is ignored and the collection is fetched instead', async () => {
  const host = hosts({ withRender: true });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  const roads = { ...find(index, 'roads'), render: [{ kind: 'pmtiles-vector', id: 'roads', url: 'not a url' }] };
  const resolved = await index.resolve(roads);
  assert.equal(resolved.source, 'collection');
  assert.equal(host.requestsTo(roads.href), 1);
});
