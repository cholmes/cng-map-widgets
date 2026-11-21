import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coveringPaths, rowGroupBBoxFromStats, pruneRowGroupsByBBox, pruneRowGroupsByTime, readBytesForRowGroups } from '../src/prune.js';

/** Build a synthetic RowGroupInfo (shape matches parquet-io.js's decodeRowGroups output). */
function rg(index, numRows, stats) {
  const columns = new Map();
  for (const [path, { min, max, bytes }] of Object.entries(stats)) {
    columns.set(path, { statistics: { min_value: min, max_value: max }, totalCompressedSize: bytes ?? 1000, totalUncompressedSize: (bytes ?? 1000) * 2 });
  }
  return { index, rowStart: index * numRows, rowEnd: index * numRows + numRows, numRows, columns };
}

test('coveringPaths: struct covering with default field names', () => {
  assert.deepEqual(coveringPaths({ kind: 'struct', column: 'bbox' }), {
    xmin: 'bbox.xmin',
    ymin: 'bbox.ymin',
    xmax: 'bbox.xmax',
    ymax: 'bbox.ymax',
  });
});

test('coveringPaths: columns covering uses the declared top-level names', () => {
  assert.deepEqual(coveringPaths({ kind: 'columns', xmin: 'x0', ymin: 'y0', xmax: 'x1', ymax: 'y1' }), {
    xmin: 'x0',
    ymin: 'y0',
    xmax: 'x1',
    ymax: 'y1',
  });
});

test('coveringPaths: none covering returns null', () => {
  assert.equal(coveringPaths({ kind: 'none' }), null);
  assert.equal(coveringPaths(undefined), null);
});

test('rowGroupBBoxFromStats reads all four corners from struct sub-column statistics', () => {
  const group = rg(0, 1000, {
    'bbox.xmin': { min: -5, max: -5 },
    'bbox.ymin': { min: 10, max: 10 },
    'bbox.xmax': { min: -1, max: -1 },
    'bbox.ymax': { min: 20, max: 20 },
  });
  const paths = coveringPaths({ kind: 'struct', column: 'bbox' });
  assert.deepEqual(rowGroupBBoxFromStats(group, paths), [-5, 10, -1, 20]);
});

test('rowGroupBBoxFromStats returns null when any corner statistic is missing', () => {
  const group = rg(0, 1000, { 'bbox.xmin': { min: -5, max: -1 } }); // missing ymin/xmax/ymax
  const paths = coveringPaths({ kind: 'struct', column: 'bbox' });
  assert.equal(rowGroupBBoxFromStats(group, paths), null);
});

test('pruneRowGroupsByBBox: keeps only row groups whose covering bbox intersects an area bbox', () => {
  const groups = [
    rg(0, 100, { 'bbox.xmin': { min: 0, max: 1 }, 'bbox.ymin': { min: 0, max: 1 }, 'bbox.xmax': { min: 1, max: 2 }, 'bbox.ymax': { min: 1, max: 2 } }), // near origin
    rg(1, 100, { 'bbox.xmin': { min: 50, max: 51 }, 'bbox.ymin': { min: 50, max: 51 }, 'bbox.xmax': { min: 51, max: 52 }, 'bbox.ymax': { min: 51, max: 52 } }), // far away
  ];
  const covering = { kind: 'struct', column: 'bbox' };
  const result = pruneRowGroupsByBBox(groups, covering, [[0, 0, 5, 5]]);
  assert.deepEqual(result.selected.map((g) => g.index), [0]);
  assert.equal(result.stage.before, 2);
  assert.equal(result.stage.after, 1);
  assert.equal(result.stage.basis, 'covering bbox');
});

test('pruneRowGroupsByBBox: no covering -> full scan, honest basis message', () => {
  const groups = [rg(0, 100, {}), rg(1, 100, {})];
  const result = pruneRowGroupsByBBox(groups, { kind: 'none' }, [[0, 0, 5, 5]]);
  assert.equal(result.selected.length, 2);
  assert.equal(result.stage.basis, 'no covering — full scan');
});

test('pruneRowGroupsByBBox: no area -> selects everything (no area supplied)', () => {
  const groups = [rg(0, 100, { 'bbox.xmin': { min: 0, max: 1 }, 'bbox.ymin': { min: 0, max: 1 }, 'bbox.xmax': { min: 1, max: 2 }, 'bbox.ymax': { min: 1, max: 2 } })];
  const result = pruneRowGroupsByBBox(groups, { kind: 'struct', column: 'bbox' }, null);
  assert.equal(result.selected.length, 1);
  assert.equal(result.stage.basis, 'no area supplied');
});

test('pruneRowGroupsByBBox: a row group missing statistics cannot be pruned (kept, honest)', () => {
  const groups = [rg(0, 100, {}), rg(1, 100, { 'bbox.xmin': { min: 50, max: 51 }, 'bbox.ymin': { min: 50, max: 51 }, 'bbox.xmax': { min: 51, max: 52 }, 'bbox.ymax': { min: 51, max: 52 } })];
  const result = pruneRowGroupsByBBox(groups, { kind: 'struct', column: 'bbox' }, [[0, 0, 5, 5]]);
  // group 0 has no stats so it must be kept; group 1 has stats and is far away, pruned.
  assert.deepEqual(result.selected.map((g) => g.index), [0]);
});

test('pruneRowGroupsByBBox: antimeridian-split area (two bboxes) matches either side', () => {
  const groups = [rg(0, 100, { 'bbox.xmin': { min: -179, max: -178 }, 'bbox.ymin': { min: -19, max: -18 }, 'bbox.xmax': { min: -178, max: -177 }, 'bbox.ymax': { min: -18, max: -17 } })];
  const areaBBoxes = [[170, -20, 180, -10], [-180, -20, -170, -10]];
  const result = pruneRowGroupsByBBox(groups, { kind: 'struct', column: 'bbox' }, areaBBoxes);
  assert.equal(result.selected.length, 1);
});

test('pruneRowGroupsByTime: prunes row groups whose time-column stats fall outside the window', () => {
  const groups = [
    rg(0, 100, { acq: { min: '2026-01-01T00:00:00Z', max: '2026-01-31T00:00:00Z' } }),
    rg(1, 100, { acq: { min: '2026-08-01T00:00:00Z', max: '2026-08-31T00:00:00Z' } }),
  ];
  const result = pruneRowGroupsByTime(groups, 'acq', { start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z', closed: '[)' });
  assert.deepEqual(result.selected.map((g) => g.index), [1]);
});

test('pruneRowGroupsByTime: no time filter is a no-op', () => {
  const groups = [rg(0, 100, {})];
  const result = pruneRowGroupsByTime(groups, 'acq', undefined);
  assert.equal(result.selected.length, 1);
  assert.equal(result.stage.basis, 'no time filter');
});

test('pruneRowGroupsByTime: missing statistics keeps the row group (cannot prune honestly)', () => {
  const groups = [rg(0, 100, {})];
  const result = pruneRowGroupsByTime(groups, 'acq', { start: '2026-01-01', end: '2026-02-01' });
  assert.equal(result.selected.length, 1);
});

test('readBytesForRowGroups: exact sum of total_compressed_size for the named top-level columns', () => {
  const groups = [
    rg(0, 100, { geometry: { min: 0, max: 0, bytes: 5000 }, confidence: { min: 0, max: 0, bytes: 200 } }),
    rg(1, 100, { geometry: { min: 0, max: 0, bytes: 7000 }, confidence: { min: 0, max: 0, bytes: 300 } }),
  ];
  const result = readBytesForRowGroups(groups, ['geometry']);
  assert.deepEqual(result, { min: 12000, max: 12000, estimate: 12000, exact: true });
  const both = readBytesForRowGroups(groups, ['geometry', 'confidence']);
  assert.equal(both.estimate, 12500);
});
