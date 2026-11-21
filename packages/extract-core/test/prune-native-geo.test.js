// Native Parquet GeospatialStatistics (GeoParquet 2.0 / Parquet GEOMETRY
// logical type) as a pruning source. Verified 2026-11-17 against live data:
// s2-stac-geoparquet carries them on 825/825 row groups, FIRMS on 582/582,
// and fieldmaps subnational on every level -- all of which this reader
// previously treated as `no-covering` and full-scanned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coveringPaths, rowGroupBBoxFromStats, pruneRowGroupsByBBox } from '../src/prune.js';

/** A row group whose geometry column carries native geospatial statistics. */
function rgNative(index, bbox, { numRows = 1000, bytes = 1000, column = 'geometry' } = {}) {
  const columns = new Map();
  columns.set(column, {
    statistics: undefined,
    geoStats: bbox === null ? undefined : { xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3] },
    totalCompressedSize: bytes,
    totalUncompressedSize: bytes * 2,
  });
  return { index, rowStart: index * numRows, rowEnd: index * numRows + numRows, numRows, columns };
}

test('coveringPaths: a native covering resolves to the geometry column, not four stat paths', () => {
  assert.deepEqual(coveringPaths({ kind: 'native', column: 'geometry' }), { native: 'geometry' });
});

test('rowGroupBBoxFromStats reads a bbox from native geospatial statistics', () => {
  const group = rgNative(0, [-75.75, -54.75, -68.35, -48.59]);
  assert.deepEqual(rowGroupBBoxFromStats(group, { native: 'geometry' }), [-75.75, -54.75, -68.35, -48.59]);
});

test('rowGroupBBoxFromStats returns null when the geometry column has no native stats', () => {
  assert.equal(rowGroupBBoxFromStats(rgNative(0, null), { native: 'geometry' }), null);
});

test('pruneRowGroupsByBBox prunes on native statistics and says so in the basis', () => {
  const groups = [
    rgNative(0, [-75.75, -54.75, -68.35, -48.59]), // South America
    rgNative(1, [21.37, 22.0, 46.22, 40.04]),      // eastern Mediterranean
    rgNative(2, [33.9, -4.7, 41.9, 5.5]),          // Kenya
  ];
  const { selected, stage } = pruneRowGroupsByBBox(groups, { kind: 'native', column: 'geometry' }, [[33.0, -5.0, 42.0, 6.0]]);
  assert.deepEqual(selected.map((g) => g.index), [2]);
  assert.equal(stage.before, 3);
  assert.equal(stage.after, 1);
  assert.match(stage.basis, /native/i);
});

test('a row group missing native stats is kept, never silently dropped', () => {
  const groups = [rgNative(0, [33.9, -4.7, 41.9, 5.5]), rgNative(1, null)];
  const { selected } = pruneRowGroupsByBBox(groups, { kind: 'native', column: 'geometry' }, [[-10, 40, 10, 60]]);
  assert.deepEqual(selected.map((g) => g.index), [1], 'the un-prunable row group must survive');
});

test('native stats are used automatically when the descriptor declares no covering', () => {
  // The important case: fieldmaps/s2/FIRMS declare no covering column, so the
  // descriptor resolves to `kind: 'none'`. The stats are still in the footer.
  const groups = [rgNative(0, [-75.75, -54.75, -68.35, -48.59]), rgNative(1, [33.9, -4.7, 41.9, 5.5])];
  const { selected, stage } = pruneRowGroupsByBBox(groups, { kind: 'none' }, [[33.0, -5.0, 42.0, 6.0]], 'geometry');
  assert.deepEqual(selected.map((g) => g.index), [1], 'should fall back to native stats rather than full-scan');
  assert.match(stage.basis, /native/i);
});

test('with no covering, no native stats and no geometry column, everything is selected', () => {
  const groups = [rgNative(0, null), rgNative(1, null)];
  const { selected, stage } = pruneRowGroupsByBBox(groups, { kind: 'none' }, [[0, 0, 1, 1]], 'geometry');
  assert.equal(selected.length, 2);
  assert.match(stage.basis, /full scan/i);
});

// --- safety: native covering is row-GROUP only, never per-row ---
import { geometryNeededForFilter } from '../src/columns.js';

test('geometryNeededForFilter: native covering still needs geometry, like no covering', () => {
  const area = { filterGeometry: null, bboxes: [[0, 0, 1, 1]] };
  // There is no per-row bbox in a native-stats file, so even `mode: 'bbox'`
  // must decode geometry -- treating native like `struct` here would silently
  // compare against undefined and match nothing.
  assert.equal(geometryNeededForFilter(area, { kind: 'native', column: 'geometry' }, { mode: 'bbox' }), true);
  assert.equal(geometryNeededForFilter(area, { kind: 'none' }, { mode: 'bbox' }), true);
  assert.equal(geometryNeededForFilter(area, { kind: 'struct', column: 'bbox' }, { mode: 'bbox' }), false);
});

test('a declared covering that yields no usable bbox falls back to native stats', () => {
  // The live case this was found on: s2-stac-geoparquet declares a `bbox`
  // column, but it is a LIST ([xmin,ymin,xmax,ymax]), not a struct -- so
  // `bbox.xmin` does not exist and every row group reads back null. Before
  // this fallback the stage reported "covering bbox" while pruning 825 -> 825
  // AND suppressed the no-covering warning: the worst of both.
  const groups = [
    rgNative(0, [-75.75, -54.75, -68.35, -48.59]),
    rgNative(1, [33.9, -4.7, 41.9, 5.5]),
  ];
  const { selected, stage } = pruneRowGroupsByBBox(groups, { kind: 'struct', column: 'bbox' }, [[33.0, -5.0, 42.0, 6.0]], 'geometry');
  assert.deepEqual(selected.map((g) => g.index), [1]);
  assert.match(stage.basis, /native/i);
});

test('a usable covering is preferred over native stats', () => {
  const columns = new Map();
  columns.set('bbox.xmin', { statistics: { min_value: 0, max_value: 0 }, totalCompressedSize: 10, totalUncompressedSize: 20 });
  columns.set('bbox.ymin', { statistics: { min_value: 0, max_value: 0 }, totalCompressedSize: 10, totalUncompressedSize: 20 });
  columns.set('bbox.xmax', { statistics: { min_value: 1, max_value: 1 }, totalCompressedSize: 10, totalUncompressedSize: 20 });
  columns.set('bbox.ymax', { statistics: { min_value: 1, max_value: 1 }, totalCompressedSize: 10, totalUncompressedSize: 20 });
  columns.set('geometry', { geoStats: { xmin: 90, ymin: 90, xmax: 91, ymax: 91 }, totalCompressedSize: 10, totalUncompressedSize: 20 });
  const group = { index: 0, rowStart: 0, rowEnd: 1, numRows: 1, columns };
  const { selected, stage } = pruneRowGroupsByBBox([group], { kind: 'struct', column: 'bbox' }, [[0, 0, 1, 1]], 'geometry');
  assert.equal(selected.length, 1);
  assert.equal(stage.basis, 'covering bbox', 'a working covering must win; native is the fallback');
});
