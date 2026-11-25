// The timeline's cell logic: what a selection sums, what colour that is, when
// a point is in the window, and the tile cache that answers "how many, per
// bucket, in view" -- all without deck.gl. (The cases follow firms-catalog's
// deck-cells.test.mjs; the property names are now configuration.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECK_TILE_SIZE, tileZoom, localToLngLat, featureBounds, lngOverlaps, windowPlan, countFor, fillFor, dayNumberOf, pointFilter, TileCache } from '../src/timeline/tile-cells.js';

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);
const STOPS = [[1, '#2c3d5a'], [5, '#3f6d8f'], [20, '#59a1a0']];

test('tile zoom floors, as MapLibre does', () => {
  assert.deepEqual([tileZoom(4.4), tileZoom(4.5), tileZoom(4.99), tileZoom(5)], [4, 4, 4, 5]);
  close(DECK_TILE_SIZE, 512 * Math.SQRT2);
});

test('tile-local coordinates become longitude and latitude, mercator in y', () => {
  const bbox = { west: 0, east: 45, north: 40.979898069620134, south: 0 };
  assert.equal(localToLngLat(0, 0, bbox)[0], 0);
  close(localToLngLat(0, 0, bbox)[1], bbox.north);
  close(localToLngLat(1, 1, bbox)[0], 45);
  close(localToLngLat(1, 1, bbox)[1], 0);
  close(localToLngLat(0.5, 0, bbox)[0], 22.5);
  const mid = localToLngLat(0, 0.5, bbox)[1];
  assert.ok(mid > 20.5 && mid < 22.5, `half way down in mercator is ${mid}, not the 20.49 a straight line gives`);
  const b = featureBounds({ geometry: { type: 'Polygon', coordinates: [[[0.25, 0.25], [0.75, 0.25], [0.75, 0.5], [0.25, 0.5], [0.25, 0.25]]] } }, bbox);
  close(b.w, 11.25);
  close(b.e, 33.75);
  assert.ok(b.n > b.s);
});

test('longitudes overlap cyclically, so world copies do not drop cells off the edge', () => {
  assert.equal(lngOverlaps(10, 20, 15, 30), true);
  assert.equal(lngOverlaps(10, 20, 30, 40), false);
  assert.equal(lngOverlaps(170, 179, -190, -175), true, 'a view that has wrapped past the antimeridian');
  assert.equal(lngOverlaps(10, 20, -180, 180), true);
  assert.equal(lngOverlaps(10, 20, -400, 400), true);
});

// --- what a window sums -------------------------------------------------------------------------

test('windowPlan: the columns of the window that the archive has', () => {
  const columns = new Set(['20240101', '20240102', '20240104']);
  const plan = windowPlan({ columns, window: { unit: 'day', ranges: [['20240101', '20240103']] } });
  assert.deepEqual(plan.keys, ['count_20240101', 'count_20240102'], 'the third has no column: nothing happened anywhere that day');
  assert.equal(plan.buckets, 3, 'but it still counts toward how wide the window is');
  assert.equal(countFor(plan, { count_20240101: 30, count_20240102: 20, count_20240104: 50, count: 100 }), 50);
  assert.equal(countFor(plan, { count: 5 }), 0, 'MVT leaves out zero-valued attributes');
});

test('windowPlan: two runs, months, another prefix, and nothing', () => {
  const columns = new Set(['202401', '202402', '202403', '202404']);
  const two = windowPlan({ columns, window: { unit: 'month', ranges: [['202401', '202401'], ['202403', '202404']] } });
  assert.deepEqual(two.keys, ['count_202401', 'count_202403', 'count_202404']);
  assert.equal(two.buckets, 3);
  const other = windowPlan({ columns: new Set(['20240101']), window: { unit: 'day', ranges: [['20240101', '20240101']] }, prefix: 'n_' });
  assert.deepEqual(other.keys, ['n_20240101']);
  const none = windowPlan({ columns, window: null });
  assert.deepEqual(none.keys, []);
  assert.equal(countFor(none, { count_202401: 9 }), 0);
  const unknown = windowPlan({ columns: null, window: { unit: 'month', ranges: [['202401', '202402']] } });
  assert.deepEqual(unknown.keys, ['count_202401', 'count_202402'], 'with no column list, every bucket of the window is asked for');
  assert.notEqual(two.signature, none.signature);
  assert.equal(windowPlan({ columns, window: { unit: 'month', ranges: [['202401', '202401'], ['202403', '202404']] } }).signature, two.signature);
});

// --- colours -------------------------------------------------------------------------------------

test('fillFor: transparent below the first stop, then the highest stop reached', () => {
  assert.deepEqual(fillFor(0, STOPS), [0, 0, 0, 0]);
  assert.deepEqual(fillFor(1, STOPS), [0x2c, 0x3d, 0x5a, 255]);
  assert.deepEqual(fillFor(19, STOPS), [0x3f, 0x6d, 0x8f, 255]);
  assert.deepEqual(fillFor(1e9, STOPS), [0x59, 0xa1, 0xa0, 255]);
  assert.equal(fillFor(1, STOPS), fillFor(2, STOPS), 'the same array back: nothing allocated per cell');
});

// --- points --------------------------------------------------------------------------------------

test('dayNumberOf: a point\'s day, however it was written', () => {
  const jan3 = Date.UTC(2020, 0, 3) / 86400000;
  assert.equal(dayNumberOf({ day: 20200103 }, 'day'), jan3);
  assert.equal(dayNumberOf({ day: '20200103' }, 'day'), jan3);
  assert.equal(dayNumberOf({ acq_date: '2020-01-03' }, 'acq_date'), jan3);
  assert.equal(dayNumberOf({ t: '2020-01-03T23:59:00Z' }, 't'), jan3);
  assert.ok(Number.isNaN(dayNumberOf({}, 'day')));
  assert.ok(Number.isNaN(dayNumberOf({ day: 'soon' }, 'day')));
  // With no zone it is UTC, not this machine's time: or two viewers put one
  // point in two different days.
  const before = process.env.TZ;
  try {
    for (const zone of ['Europe/Berlin', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      assert.equal(dayNumberOf({ t: '2020-01-03T00:00:00' }, 't'), jan3, zone);
      assert.equal(dayNumberOf({ t: '2020-01-03 23:30:00' }, 't'), jan3, zone);
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test('pointFilter: one run is a range the GPU tests; several are tested in JavaScript', () => {
  const day = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;
  const one = pointFilter({ unit: 'day', ranges: [['20200102', '20200105']] }, 'day');
  // Inclusive at both ends: deck.gl tests min <= value <= max.
  assert.deepEqual(one.filterRange, [day(2020, 1, 2), day(2020, 1, 5)]);
  assert.equal(one.getFilterValue({ properties: { day: 20200103 } }), day(2020, 1, 3));
  assert.equal(one.trigger, 'day', 'the accessor does not change with the window: only the range does');
  const single = pointFilter({ unit: 'day', ranges: [['20200103', '20200103']] }, 'day');
  assert.deepEqual(single.filterRange, [day(2020, 1, 3), day(2020, 1, 3)], 'one day is a range of one day');
  const month = pointFilter({ unit: 'month', ranges: [['202002', '202002']] }, 'day');
  assert.deepEqual(month.filterRange, [day(2020, 2, 1), day(2020, 2, 29)], 'a month is all of its days');
  const two = pointFilter({ unit: 'day', ranges: [['20200101', '20200102'], ['20200110', '20200112']] }, 'day');
  assert.deepEqual(two.filterRange, [1, 1], 'in is 1, out is 0');
  assert.equal(two.getFilterValue({ properties: { day: 20200111 } }), 1);
  assert.equal(two.getFilterValue({ properties: { day: 20200105 } }), 0);
  assert.notEqual(two.trigger, one.trigger);
  const none = pointFilter(null, 'day');
  assert.deepEqual(none.filterRange, [1, 0], 'nothing passes');
});

// --- the tile cache --------------------------------------------------------------------------------

const BOX = (west, east) => ({ west, east, north: 10, south: 0 });
const square = (x0, x1) => ({ type: 'Polygon', coordinates: [[[x0, 0.2], [x1, 0.2], [x1, 0.8], [x0, 0.8], [x0, 0.2]]] });
const cell = (id, geometry, counts) => ({ type: 'Feature', geometry, properties: { a5_cell: id, ...counts } });
const point = (x, y, day) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { day } });
const tile = (id, z, bbox, cells, points = []) => ({ id, index: { z }, bbox, content: { cells, points } });

function loaded() {
  const cache = new TileCache({ idProperty: 'a5_cell', timeProperty: 'day' });
  // Cell 1 sits wholly in the western tile; cell 2 is split across the seam.
  cache.add(tile('5-0-0', 5, BOX(0, 10), [cell(1, square(0.1, 0.4), { count_20200101: 10, count_20200103: 1 }), cell(2, square(0.9, 1.0), { count_20200101: 5, count_20200102: 3 })]));
  cache.add(tile('5-1-0', 5, BOX(10, 20), [cell(2, square(0.0, 0.2), { count_20200101: 5, count_20200102: 3 })]));
  return cache;
}
const WHOLE = { w: -1, s: -1, e: 21, n: 11 };

test('a cell split across tiles is counted once', () => {
  const h = loaded().histogram(5, 5, WHOLE);
  assert.equal(h.cells, 2);
  assert.deepEqual(h.buckets, { 20200101: 15, 20200102: 3, 20200103: 1 });
});

test('a cell\'s bounds are the union of its pieces, so it is in a view that holds only one of them', () => {
  const cache = loaded();
  const east = cache.histogram(5, 5, { w: 10.5, s: -1, e: 21, n: 11 });
  assert.equal(east.cells, 1);
  assert.deepEqual(east.buckets, { 20200101: 5, 20200102: 3 });
  const west = cache.histogram(5, 5, { w: 0.5, s: -1, e: 5, n: 11 });
  assert.deepEqual(west.buckets, { 20200101: 10, 20200103: 1 });
});

test('zoom ranges keep two resolutions from being counted together; a removed tile no longer counts', () => {
  const cache = loaded();
  cache.add(tile('7-0-0', 7, BOX(0, 2), [cell(9, square(0.1, 0.4), { count_20200101: 100 })]));
  assert.equal(cache.histogram(5, 5, WHOLE).cells, 2);
  assert.equal(cache.histogram(5, 7, WHOLE).cells, 3);
  assert.deepEqual(cache.histogram(7, 9, WHOLE).buckets, { 20200101: 100 });
  cache.remove({ id: '7-0-0' });
  assert.equal(cache.histogram(5, 7, WHOLE).cells, 2);
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.deepEqual(cache.histogram(0, 20, WHOLE), { buckets: {}, cells: 0 });
});

test('pivot columns and other prefixes are not buckets', () => {
  const cache = new TileCache({ idProperty: 'a5_cell' });
  cache.add(tile('5-0-0', 5, BOX(0, 10), [cell(1, square(0.1, 0.4), { count: 99, count_d: 4, count_modis: 7, count_c20200101: 50, count_20200101: 2, n_20200101: 8 })]));
  assert.deepEqual(cache.histogram(5, 5, WHOLE).buckets, { 20200101: 2 });
  const other = new TileCache({ idProperty: 'a5_cell', prefix: 'n_' });
  other.add(tile('5-0-0', 5, BOX(0, 10), [cell(1, square(0.1, 0.4), { count_20200101: 2, n_20200101: 8 })]));
  assert.deepEqual(other.histogram(5, 5, WHOLE).buckets, { 20200101: 8 });
});

test('with no id property the feature\'s own id is used; with neither, each piece counts', () => {
  const byFeatureId = new TileCache({});
  const withId = (f, id) => ({ ...f, id, properties: { count_20200101: 5 } });
  byFeatureId.add(tile('5-0-0', 5, BOX(0, 10), [withId(cell(0, square(0.9, 1.0), {}), 7)]));
  byFeatureId.add(tile('5-1-0', 5, BOX(10, 20), [withId(cell(0, square(0.0, 0.2), {}), 7)]));
  assert.deepEqual(byFeatureId.histogram(5, 5, WHOLE), { buckets: { 20200101: 5 }, cells: 1 });
  const anonymous = new TileCache({});
  const bare = (geometry) => ({ type: 'Feature', geometry, properties: { count_20200101: 5 } });
  anonymous.add(tile('5-0-0', 5, BOX(0, 10), [bare(square(0.9, 1.0))]));
  anonymous.add(tile('5-1-0', 5, BOX(10, 20), [bare(square(0.0, 0.2))]));
  assert.deepEqual(anonymous.histogram(5, 5, WHOLE), { buckets: { 20200101: 10 }, cells: 2 });
});

test('points in view are counted by their day, or by its month', () => {
  const cache = new TileCache({ timeProperty: 'day' });
  cache.add(tile('11-0-0', 11, BOX(0, 10), [], [point(0.1, 0.5, 20200102), point(0.2, 0.5, '20200102'), point(0.9, 0.5, 20200105), point(0.3, 0.5, null)]));
  assert.deepEqual(cache.pointHistogram(11, 11, { w: 0, s: -1, e: 5, n: 11 }, 'day'), { buckets: { 20200102: 2 }, points: 2 });
  assert.deepEqual(cache.pointHistogram(11, 11, WHOLE, 'month'), { buckets: { 202001: 3 }, points: 3 });
  assert.deepEqual(cache.pointHistogram(5, 9, WHOLE, 'day'), { buckets: {}, points: 0 });
  assert.deepEqual(new TileCache({}).pointHistogram(0, 20, WHOLE, 'day'), { buckets: {}, points: 0 }, 'no time property: no point histogram');
});
