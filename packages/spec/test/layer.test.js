import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_SPEC, LAYER_KINDS, RENDERABLE_KINDS, validateLayerSpec, layerSlug } from '../src/layer.js';

const ok = { spec: 'cng-layer/1.0', id: 'a', title: 'A', kind: 'cog', source: { url: 'https://x/y.tif' }, attribution: [] };

test('the contract version and kinds are what the design names', () => {
  assert.equal(LAYER_SPEC, 'cng-layer/1.0');
  assert.deepEqual([...LAYER_KINDS], ['pmtiles-vector', 'cog', 'scenes', 'geojson', 'timeline', 'table', 'unsupported']);
  assert.deepEqual([...RENDERABLE_KINDS], ['pmtiles-vector', 'cog', 'scenes', 'geojson', 'timeline']);
  assert.throws(() => LAYER_KINDS.push('wms'));
});

test('a minimal spec validates and comes back as a copy', () => {
  const out = validateLayerSpec(ok);
  assert.deepEqual(out, ok);
  assert.notEqual(out, ok);
  assert.notEqual(out.source, ok.source);
});

test('title defaults to id; attribution defaults to []', () => {
  const out = validateLayerSpec({ spec: 'cng-layer/1.0', id: 'a', kind: 'cog', source: { url: 'https://x/y.tif' } });
  assert.equal(out.title, 'a');
  assert.deepEqual(out.attribution, []);
});

for (const [name, patch, field] of [
  ['wrong spec version', { spec: 'cng-layer/2.0' }, 'spec'],
  ['empty id', { id: '' }, 'id'],
  ['unknown kind', { kind: 'wms' }, 'kind'],
  ['cog without a url', { source: {} }, 'source.url'],
  ['relative url', { source: { url: './y.tif' } }, 'source.url'],
  ['bbox with w > e', { bbox: [10, 0, -10, 5] }, 'bbox'],
  ['bbox with a NaN', { bbox: [0, 0, NaN, 5] }, 'bbox'],
  ['attribution that is not an array', { attribution: 'CC-BY' }, 'attribution'],
]) {
  test(`refuses: ${name}`, () => {
    assert.throws(
      () => validateLayerSpec({ ...ok, ...patch }),
      (e) => e.code === 'LAYER_INVALID' && e.retryable === false && e.context.field === field,
    );
  });
}

test('refuses a non-object', () => {
  assert.throws(() => validateLayerSpec(null), (e) => e.code === 'LAYER_INVALID' && e.context.field === 'spec');
});

test('pmtiles-vector needs a url and a layers array', () => {
  assert.throws(
    () => validateLayerSpec({ ...ok, kind: 'pmtiles-vector', source: { url: 'https://x/t.pmtiles' } }),
    (e) => e.code === 'LAYER_INVALID' && e.context.field === 'source.layers',
  );
  const out = validateLayerSpec({ ...ok, kind: 'pmtiles-vector', source: { url: 'https://x/t.pmtiles', layers: ['roads'] } });
  assert.deepEqual(out.source.layers, ['roads']);
});

test('geojson accepts inline data or a url, not neither', () => {
  validateLayerSpec({ ...ok, kind: 'geojson', source: { data: { type: 'FeatureCollection', features: [] } } });
  validateLayerSpec({ ...ok, kind: 'geojson', source: { url: 'https://x/a.geojson' } });
  assert.throws(() => validateLayerSpec({ ...ok, kind: 'geojson', source: {} }), (e) => e.context.field === 'source');
});

test('scenes needs a collection url and an items description', () => {
  validateLayerSpec({ ...ok, kind: 'scenes', source: { collectionUrl: 'https://x/collection.json', items: { kind: 'partitioned' } } });
  assert.throws(
    () => validateLayerSpec({ ...ok, kind: 'scenes', source: { collectionUrl: 'https://x/collection.json', items: { kind: 'parquet' } } }),
    (e) => e.context.field === 'source.items.url',
  );
});

test('unsupported carries a reason and the asset types found', () => {
  const out = validateLayerSpec({ ...ok, kind: 'unsupported', source: { reason: 'zarr', assetTypes: ['application/vnd+zarr'] } });
  assert.equal(out.source.reason, 'zarr');
  assert.throws(() => validateLayerSpec({ ...ok, kind: 'unsupported', source: {} }), (e) => e.context.field === 'source.reason');
});

test('a valid bbox and temporal pass through', () => {
  const out = validateLayerSpec({ ...ok, bbox: [-10, -5, 10, 5], temporal: ['2020-01-01T00:00:00Z', null] });
  assert.deepEqual(out.bbox, [-10, -5, 10, 5]);
  assert.deepEqual(out.temporal, ['2020-01-01T00:00:00Z', null]);
});

// Layer documents come from remote catalogs. Anything that may end up in an
// href or an <img src> has to be http(s) before a UI ever sees it.
test('refuses a thumbnail or an attribution url that is not http(s)', () => {
  assert.throws(() => validateLayerSpec({ ...ok, thumbnail: 'javascript:alert(1)' }), (e) => e.code === 'LAYER_INVALID' && e.context.field === 'thumbnail');
  assert.throws(
    () => validateLayerSpec({ ...ok, attribution: [{ text: 'x', url: 'javascript:alert(1)' }] }),
    (e) => e.code === 'LAYER_INVALID' && e.context.field === 'attribution.url',
  );
  const fine = validateLayerSpec({ ...ok, thumbnail: 'https://x/t.jpg', attribution: [{ text: 'x', url: 'https://x/licence' }, { text: 'no url' }] });
  assert.equal(fine.thumbnail, 'https://x/t.jpg');
});

test('every url is checked, including a geojson url given beside inline data', () => {
  assert.throws(
    () => validateLayerSpec({ ...ok, kind: 'geojson', source: { data: { type: 'FeatureCollection', features: [] }, url: 'ftp://x/a.geojson' } }),
    (e) => e.context.field === 'source.url',
  );
});

test('a source that cannot be copied is refused as invalid, not with a raw error', () => {
  assert.throws(() => validateLayerSpec({ ...ok, source: { url: 'https://x/y.tif', onload() {} } }), (e) => e.code === 'LAYER_INVALID' && e.context.field === 'source');
});

test('layerSlug keeps ids usable as MapLibre ids', () => {
  assert.equal(layerSlug('a/b c:d'), 'a-b-c-d');
  assert.equal(layerSlug('ok_id-1'), 'ok_id-1');
  assert.equal(layerSlug('naip:overview_national'), 'naip-overview_national');
});
