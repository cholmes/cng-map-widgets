// What a PMTiles archive says about its own time axis.
//
// The rule these exist to enforce: never guess from a sampled feature. MVT
// omits zero-valued attributes, so a sampled cell carries only the buckets in
// which something happened THERE; the archive's metadata describes the whole
// table. (The cases follow firms-catalog's archives.test.mjs.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCngError } from '@cngeo/spec';
import { parseJSONish, vectorLayers, bucketColumns, timelineFromMetadata, layerZooms } from '../src/timeline/pmtiles-meta.js';

const fields = (...names) => Object.fromEntries(names.map((n) => [n, 'Number']));
const MONTHLY = {
  vector_layers: [
    { id: 'aggregate', minzoom: 0, maxzoom: 9, fields: fields('a5_cell', 'count', 'count_200011', 'count_200012', 'count_200101', 'count_d', 'count_n', 'count_modis') },
    { id: 'features', minzoom: 10, maxzoom: 12, fields: fields('day', 'frp') },
  ],
};
const invalid = (fn, needle) => assert.throws(fn, (e) => isCngError(e) && e.code === 'TIMELINE_INVALID' && (!needle || e.message.includes(needle)));

test('parseJSONish: an object, a JSON string, and nothing rather than a throw', () => {
  assert.deepEqual(parseJSONish('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJSONish({ a: 1 }), { a: 1 });
  assert.equal(parseJSONish('{oops'), null);
  assert.equal(parseJSONish(undefined), null);
});

test('vectorLayers: at the top level, or inside the `json` blob, or none', () => {
  assert.equal(vectorLayers(MONTHLY).length, 2);
  assert.equal(vectorLayers({ json: JSON.stringify(MONTHLY) }).length, 2);
  assert.deepEqual(vectorLayers({}), []);
  assert.deepEqual(vectorLayers(null), []);
});

test('bucketColumns: the time buckets of a layer, sorted; pivots are not buckets', () => {
  assert.deepEqual(bucketColumns(MONTHLY, { layer: 'aggregate' }), ['200011', '200012', '200101']);
  assert.deepEqual(bucketColumns(MONTHLY, { layer: 'features' }), []);
  assert.deepEqual(bucketColumns(MONTHLY, { layer: 'nope' }), []);
  const other = { vector_layers: [{ id: 'cells', fields: fields('n_20240102', 'n_20240101', 'n_total', 'count_20240101') }] };
  assert.deepEqual(bucketColumns(other, { layer: 'cells', prefix: 'n_' }), ['20240101', '20240102']);
});

test('a declared axis is used, and wins over the columns actually listed', () => {
  const declared = { unit: 'month', min: '200011', max: '202609', buckets: 311 };
  const out = timelineFromMetadata({ ...MONTHLY, 'cng:timeline': declared });
  assert.equal(out.declared, true);
  assert.deepEqual([out.unit, out.min, out.max, out.buckets], ['month', '200011', '202609', 311]);
  assert.deepEqual(out.columns, ['200011', '200012', '200101'], 'the columns present are still reported');
  assert.equal(out.layer, 'aggregate');
});

test('`cng:timeline` is read first, then `firms:timeline`; either may be a JSON string', () => {
  const firms = JSON.stringify({ unit: 'day', key_format: 'count_YYYYMMDD', min: '20200101', max: '20201231', buckets: 366 });
  const daily = { vector_layers: [{ id: 'aggregate', fields: fields('count_20200101') }] };
  assert.deepEqual(timelineFromMetadata({ ...daily, 'firms:timeline': firms }).max, '20201231');
  const both = timelineFromMetadata({ ...daily, 'firms:timeline': firms, 'cng:timeline': { unit: 'day', min: '20200101', max: '20200630' } });
  assert.equal(both.max, '20200630');
  assert.equal(both.buckets, 182, 'the span, when the declaration does not count them');
});

test('with no declaration the axis is rebuilt from the declared field list', () => {
  const out = timelineFromMetadata(MONTHLY);
  assert.equal(out.declared, false);
  assert.deepEqual([out.unit, out.min, out.max, out.buckets], ['month', '200011', '200101', 3]);
  const daily = timelineFromMetadata({ vector_layers: [{ id: 'cells', fields: fields('count_20240103', 'count_20240101') }] });
  assert.deepEqual([daily.unit, daily.min, daily.max, daily.layer], ['day', '20240101', '20240103', 'cells']);
});

test('a declaration that cannot be an axis is ignored in favour of the columns', () => {
  const out = timelineFromMetadata({ ...MONTHLY, 'cng:timeline': { unit: 'week', min: '200011' } });
  assert.equal(out.declared, false);
  assert.equal(out.unit, 'month');
});

test('the layer and the prefix can be said', () => {
  const md = { vector_layers: [{ id: 'a', fields: fields('count_202401') }, { id: 'b', fields: fields('n_20240101', 'n_20240105') }] };
  assert.equal(timelineFromMetadata(md).layer, 'a', 'the first layer that has bucket columns');
  const b = timelineFromMetadata(md, { layer: 'b', prefix: 'n_' });
  assert.deepEqual([b.unit, b.min, b.max], ['day', '20240101', '20240105']);
});

test('no declaration and no bucket columns is TIMELINE_INVALID; so are mixed key widths', () => {
  invalid(() => timelineFromMetadata({ vector_layers: [{ id: 'features', fields: fields('day') }] }), 'time');
  invalid(() => timelineFromMetadata({}), 'time');
  invalid(() => timelineFromMetadata({ vector_layers: [{ id: 'x', fields: fields('count_202001', 'count_20200101') }] }), 'both');
});

test('layerZooms: a layer\'s zoom range from the archive, when it says', () => {
  assert.deepEqual(layerZooms(MONTHLY, 'aggregate'), { minzoom: 0, maxzoom: 9 });
  assert.deepEqual(layerZooms(MONTHLY, 'features'), { minzoom: 10, maxzoom: 12 });
  assert.equal(layerZooms(MONTHLY, 'nope'), null);
  assert.deepEqual(layerZooms({ vector_layers: [{ id: 'x', fields: {} }] }, 'x'), { minzoom: null, maxzoom: null });
});
