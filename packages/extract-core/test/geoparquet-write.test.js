// Regression test for a write-side half of the FIRMS (E6) blocker: a
// GeoParquet-2.0 source (native Parquet GEOMETRY logical type -- FIRMS,
// s2-stac-geoparquet) hands this package already-decoded GeoJSON geometry
// objects, not raw WKB bytes (see ../src/wkb-geometry.js's module doc).
// `createGeoParquetFormat()`'s writer wrote `batch.geometry[i]` straight
// into its own BYTE_ARRAY geometry column, which crashed hyparquet-writer
// ("parquet expected Uint8Array value, got object") the moment a real
// point dataset's rows reached it -- found running this package's own E6
// stress test, downloading real FIRMS detections to GeoParquet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import './helpers/hyparquet-setup.js';
import { createGeoParquetFormat } from '../src/formats/geoparquet.js';

function hasDuckdb() {
  try {
    execFileSync('duckdb', ['-c', 'SELECT 1'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SCHEMA = [
  { name: 'id', type: 'string' },
  { name: 'geometry', type: 'geometry' },
];

test('geoparquet format: writes a batch whose geometry is an already-decoded GeoJSON Point (GeoParquet 2.0 native-logical-type source)', async () => {
  const format = createGeoParquetFormat();
  const writer = { write: () => {}, close: () => {} };
  const ctx = {
    writer,
    schema: SCHEMA,
    geometryColumn: 'geometry',
    crs: 'OGC:CRS84',
    options: {},
    attribution: [],
  };
  const formatWriter = await format.open(ctx);

  // The exact shape engine-hyparquet.js's `buildBatch` produces, except
  // `geometry[i]` here is a decoded object instead of WKB bytes -- i.e.
  // exactly what a GeoParquet-2.0 native-GEOMETRY-type source hands back.
  const batch = {
    rows: 2,
    columns: { id: ['a', 'b'] },
    geometry: [{ type: 'Point', coordinates: [-122.27, 37.81] }, { type: 'Point', coordinates: [1, 2] }],
  };

  // Must not throw "expected Uint8Array value, got object".
  await assert.doesNotReject(() => formatWriter.writeBatch(batch));

  let written;
  const capture = { write: (buf) => { written = buf; }, close: () => {} };
  const ctx2 = { ...ctx, writer: capture };
  const formatWriter2 = await format.open(ctx2);
  await formatWriter2.writeBatch(batch);
  const { rows, bytes } = await formatWriter2.close();
  assert.equal(rows, 2);
  assert.ok(bytes > 0);
  assert.ok(written instanceof Uint8Array);

  if (hasDuckdb()) {
    const tmpPath = `/tmp/cng-geoparquet-write-test-${process.pid}.parquet`;
    writeFileSync(tmpPath, written);
    try {
      const out = execFileSync('duckdb', [
        '-csv',
        '-c',
        `INSTALL spatial; LOAD spatial; SELECT count(*), count(*) FILTER (WHERE ST_GeometryType(geometry) = 'POINT') FROM '${tmpPath}';`,
      ]).toString();
      const lastLine = out.trim().split('\n').pop();
      assert.equal(lastLine, '2,2');
    } finally {
      unlinkSync(tmpPath);
    }
  }
});

// Regression test for the other write-side bug found in the same stress
// test: s2-stac-geoparquet declares `_hilbert` as `uint32`, with real
// values across the full 0..2^32-1 range. `TYPE_MAP` previously had no
// entry for `uint32`, so the column got no declared physical type at all
// and hyparquet-writer fell back to *inferring* one from sampled values --
// landing on signed INT32 from early small values, then throwing
// ("parquet expected int32 value, got 2164471400") on a later value past
// the signed INT32 range. The fix widens `uint8`/`uint16`/`uint32` to a
// physical type guaranteed to hold their full range (INT32/INT32/INT64),
// and -- a second bug this surfaced -- hyparquet-writer's INT64 physical
// type demands a real BigInt, not a Number, so values declared `uint32`
// must be coerced before writing (a genuine `int64` column already arrives
// as BigInt from hyparquet's reader; a `uint32` column never had a
// 64-bit *source* physical type, so it never did).
test('geoparquet format: writes a uint32 column whose values exceed the signed INT32 range without overflowing or throwing', async () => {
  const format = createGeoParquetFormat();
  const schema = [
    { name: 'id', type: 'string' },
    { name: '_hilbert', type: 'uint32' },
    { name: 'geometry', type: 'geometry' },
  ];
  let written;
  const ctx = {
    writer: { write: (buf) => { written = buf; }, close: () => {} },
    schema,
    geometryColumn: 'geometry',
    crs: 'OGC:CRS84',
    options: {},
    attribution: [],
  };
  const formatWriter = await format.open(ctx);
  const batch = {
    rows: 2,
    // 2,164,471,400 is the exact real value from s2-stac-geoparquet that
    // broke this: it exceeds signed INT32_MAX (2,147,483,647) but is well
    // within the real uint32 range (max 4,294,967,295).
    columns: { id: ['a', 'b'], _hilbert: [2_164_471_400, 42] },
    geometry: [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, null],
  };
  await assert.doesNotReject(() => formatWriter.writeBatch(batch));
  const { rows } = await formatWriter.close();
  assert.equal(rows, 2);
  assert.ok(written instanceof Uint8Array);

  if (hasDuckdb()) {
    const tmpPath = `/tmp/cng-geoparquet-write-uint32-test-${process.pid}.parquet`;
    writeFileSync(tmpPath, written);
    try {
      const out = execFileSync('duckdb', ['-csv', '-c', `SELECT _hilbert FROM '${tmpPath}' ORDER BY id;`]).toString();
      assert.deepEqual(out.trim().split('\n').slice(1), ['2164471400', '42']);
    } finally {
      unlinkSync(tmpPath);
    }
  }
});
