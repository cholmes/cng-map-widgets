import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLayerSpec } from '@cngeo/spec';
import { specsFromUrl } from '../src/add-providers.js';

// "Paste a URL" -> LayerSpecs. The collection case is INJECTED
// (`layersFromCollection` from @cngeo/stac is passed in): @cngeo/maplibre
// must not import @cngeo/stac itself.

const jsonFetch = (body, { status = 200 } = {}) => async (url) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  async json() {
    if (typeof body === 'string') return JSON.parse(body);
    return body;
  },
});
const never = async () => {
  throw new Error('fetch should not have been called');
};

test('a .pmtiles url gives one pmtiles-vector spec whose layers are discovered from the archive', async () => {
  const specs = await specsFromUrl('https://example.org/data/My%20Parcels.pmtiles', { fetch: never });
  assert.equal(specs.length, 1);
  assert.deepEqual(validateLayerSpec(specs[0]), specs[0]);
  assert.equal(specs[0].kind, 'pmtiles-vector');
  assert.equal(specs[0].source.url, 'https://example.org/data/My%20Parcels.pmtiles');
  assert.deepEqual(specs[0].source.layers, []); // empty: the renderer reads the names from the archive
  assert.equal(specs[0].title, 'My Parcels');
});

test('a .tif url (with a query string) gives one cog spec', async () => {
  const specs = await specsFromUrl('https://example.org/img/scene.TIF?sig=abc', { fetch: never });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].kind, 'cog');
  assert.equal(specs[0].source.url, 'https://example.org/img/scene.TIF?sig=abc');
  assert.equal(specs[0].title, 'scene');
});

test('a collection url is fetched and handed to layersFromCollection with its own url as the base', async () => {
  const collection = { type: 'Collection', id: 'c' };
  const calls = [];
  const specs = await specsFromUrl('https://example.org/c/collection.json', {
    fetch: jsonFetch(collection),
    layersFromCollection: (doc, options) => {
      calls.push([doc, options]);
      return [{ spec: 'cng-layer/1.0', id: 'c', title: 'C', kind: 'cog', source: { url: 'https://example.org/c/c.tif' }, attribution: [] }];
    },
  });
  assert.deepEqual(calls, [[collection, { baseUrl: 'https://example.org/c/collection.json' }]]);
  assert.equal(specs[0].id, 'c');
});

test('a GeoJSON url becomes a geojson spec carrying the data', async () => {
  const data = { type: 'FeatureCollection', features: [] };
  const specs = await specsFromUrl('https://example.org/aoi.geojson', { fetch: jsonFetch(data) });
  assert.equal(specs[0].kind, 'geojson');
  assert.deepEqual(specs[0].source.data, data);
  assert.equal(specs[0].title, 'aoi');
});

test('two urls that differ only in their folder get different ids', async () => {
  const [a] = await specsFromUrl('https://example.org/2020/scene.tif', { fetch: never });
  const [b] = await specsFromUrl('https://example.org/2021/scene.tif', { fetch: never });
  assert.notEqual(a.id, b.id);
});

test('a collection url with no layersFromCollection supplied says what is missing', async () => {
  await assert.rejects(
    specsFromUrl('https://example.org/c/collection.json', { fetch: jsonFetch({ type: 'Collection', id: 'c' }) }),
    (e) => e.code === 'LAYER_UNSUPPORTED' && /layersFromCollection/.test(e.message),
  );
});

test('a non-JSON response rejects with LAYER_LOAD_FAILED', async () => {
  await assert.rejects(
    specsFromUrl('https://example.org/page', { fetch: jsonFetch('<!doctype html><title>404</title>') }),
    (e) => e.code === 'LAYER_LOAD_FAILED' && e.retryable === true,
  );
});

test('an HTTP error rejects with LAYER_LOAD_FAILED naming the status', async () => {
  await assert.rejects(
    specsFromUrl('https://example.org/missing.json', { fetch: jsonFetch({}, { status: 404 }) }),
    (e) => e.code === 'LAYER_LOAD_FAILED' && /404/.test(e.message),
  );
});

test('JSON that is neither a collection nor GeoJSON is refused as unsupported', async () => {
  await assert.rejects(
    specsFromUrl('https://example.org/thing.json', { fetch: jsonFetch({ type: 'Catalog', id: 'root' }) }),
    (e) => e.code === 'LAYER_UNSUPPORTED' && /Catalog/.test(e.message),
  );
});

test('something that is not an http(s) url is refused before any fetch', async () => {
  await assert.rejects(specsFromUrl('not a url', { fetch: never }), (e) => e.code === 'LAYER_INVALID');
  await assert.rejects(specsFromUrl('file:///etc/passwd', { fetch: never }), (e) => e.code === 'LAYER_INVALID');
});
