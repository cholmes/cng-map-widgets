// Regression tests for the second "known issue" fixed by this pass
// (README's known-issues table): `filter.columns.dropGeometry` used to be
// a no-op for the *output* -- `resolveOutputColumns` already excluded the
// geometry column correctly, but `engine-hyparquet.js`'s `buildBatch`
// always populated `batch.geometry` regardless, and every writer wrote
// from there.
//
// The fix's design decision (documented on `geometryNeededForFilter` in
// `../src/columns.js`): `dropGeometry` is an *output* instruction, never a
// promise that the engine won't read geometry internally. Geometry is
// still read -- and the read decoded -- whenever row-level spatial
// filtering needs the real geometry to decide a match (no bbox covering at
// all, or an `intersects`/`clip` filter with a real `filterGeometry`); it
// is simply never allowed to reach the output. This file tests the
// decision function and the read/output column resolution directly;
// `engine-hyparquet.test.js`-adjacent coverage of `buildBatch` and the
// format writers' honoring of a dropped geometry column live in
// `drop-geometry.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutputColumns, resolveReadColumns, geometryNeededForFilter } from '../src/columns.js';

test('resolveOutputColumns: dropGeometry excludes the geometry column from the output projection', () => {
  const cols = resolveOutputColumns({ dropGeometry: true }, ['id', 'confidence', 'geometry'], 'geometry');
  assert.ok(!cols.includes('geometry'));
  assert.deepEqual(cols.sort(), ['confidence', 'id']);
});

test('resolveOutputColumns: without dropGeometry, the geometry column is always present even if not in allColumns', () => {
  const cols = resolveOutputColumns(undefined, ['id'], 'geometry');
  assert.ok(cols.includes('geometry'));
});

// --- geometryNeededForFilter --------------------------------------------

const BBOX_FILTER = { mode: 'bbox' };
const INTERSECTS_FILTER = { mode: 'intersects' };
const CLIP_FILTER = { mode: 'clip' };
const STRUCT_COVERING = { kind: 'struct', column: 'bbox' };
const NO_COVERING = { kind: 'none' };

test('geometryNeededForFilter: no area at all -> never needed, regardless of mode/covering', () => {
  assert.equal(geometryNeededForFilter(null, STRUCT_COVERING, INTERSECTS_FILTER), false);
  assert.equal(geometryNeededForFilter(null, NO_COVERING, INTERSECTS_FILTER), false);
});

test('geometryNeededForFilter: an area with no bbox covering at all -> needed even in bbox mode (rowBBox must decode geometry)', () => {
  const area = { filterGeometry: null };
  assert.equal(geometryNeededForFilter(area, NO_COVERING, BBOX_FILTER), true);
  assert.equal(geometryNeededForFilter(area, undefined, BBOX_FILTER), true);
});

test('geometryNeededForFilter: bbox mode with a real covering -> not needed; covering statistics are enough', () => {
  const area = { filterGeometry: { type: 'Polygon', coordinates: [] } };
  assert.equal(geometryNeededForFilter(area, STRUCT_COVERING, BBOX_FILTER), false);
});

test('geometryNeededForFilter: intersects mode with a real filterGeometry and a covering -> needed for the exact test', () => {
  const area = { filterGeometry: { type: 'Polygon', coordinates: [] } };
  assert.equal(geometryNeededForFilter(area, STRUCT_COVERING, INTERSECTS_FILTER), true);
});

test('geometryNeededForFilter: clip mode behaves like intersects (runs intersects first)', () => {
  const area = { filterGeometry: { type: 'Polygon', coordinates: [] } };
  assert.equal(geometryNeededForFilter(area, STRUCT_COVERING, CLIP_FILTER), true);
});

test('geometryNeededForFilter: intersects mode degraded to bbox (no filterGeometry) -> not needed', () => {
  const area = { filterGeometry: null };
  assert.equal(geometryNeededForFilter(area, STRUCT_COVERING, INTERSECTS_FILTER), false);
});

// --- resolveReadColumns ---------------------------------------------------

test('resolveReadColumns: geometry excluded from output AND not needed for filtering -> excluded from the read too', () => {
  const outputColumns = ['id']; // dropGeometry already removed it
  const cols = resolveReadColumns(outputColumns, { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } }, null, [], 'geometry', false);
  assert.ok(!cols.includes('geometry'), 'geometry must not be fetched over the network when nothing needs it');
});

test('resolveReadColumns: geometry excluded from output BUT needed for filtering -> still read (just never output)', () => {
  const outputColumns = ['id']; // dropGeometry already removed it
  const cols = resolveReadColumns(outputColumns, { spec: 'cng-filter/1.0', spatial: { mode: 'intersects' } }, null, [], 'geometry', true);
  assert.ok(cols.includes('geometry'), 'geometry must still be read so the intersects test can run');
  assert.ok(!outputColumns.includes('geometry'), 'and must remain absent from the output column list');
});

test('resolveReadColumns: geometry present in outputColumns (no dropGeometry) -> always read regardless of needsGeometryForFilter', () => {
  const outputColumns = ['id', 'geometry'];
  const cols = resolveReadColumns(outputColumns, { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } }, null, [], 'geometry', false);
  assert.ok(cols.includes('geometry'));
});

test('resolveReadColumns: defaults to including geometry when the caller omits needsGeometryForFilter (backward compatible)', () => {
  const cols = resolveReadColumns(['id'], { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } }, null, [], 'geometry');
  assert.ok(cols.includes('geometry'));
});
