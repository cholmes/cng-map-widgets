// Regression tests for the second "known issue" fixed by this pass
// (README's known-issues table): `filter.columns.dropGeometry` used to be
// a no-op -- `resolveOutputColumns` already excluded the geometry column
// from `outputColumns`, but `engine-hyparquet.js`'s `buildBatch` always
// populated `batch.geometry` from the decoded row regardless, and every
// writer wrote from there unconditionally.
//
// The design decision (see `columns.js`'s `geometryNeededForFilter` doc
// comment): `dropGeometry` governs the *output* only. Geometry may still be
// read -- and decoded -- when row-level spatial filtering needs it (no
// bbox covering, or an `intersects`/`clip` filter with a real
// `filterGeometry`); it is simply never allowed to reach `batch.geometry`,
// so no writer ever sees it. This is deliberately not a refusal
// (`FILTER_REQUIRES_ENGINE`): the hyparquet engine's `'intersects'`
// capability already means it can decode geometry, so dropping geometry
// from the *output* never conflicts with a spatial filter that needs the
// *read*.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import './helpers/hyparquet-setup.js';
import * as hyparquet from 'hyparquet';
import { buildArea } from '@cngeo/spec';
import { createHyparquetEngine } from '../src/engine-hyparquet.js';
import { createGeoJsonFormat } from '../src/formats/geojson.js';
import { createGeoParquetFormat } from '../src/formats/geoparquet.js';
import { download } from '../src/download.js';
import { memorySink } from '../src/sinks.js';
import { openFakeHostedParquet, enginePlanFor } from './helpers/fake-parquet-host.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function fetchLocalFile(url) {
  const path = fileURLToPath(new URL(String(url)));
  const buf = await readFile(path);
  return new Response(buf, { status: 200, headers: { 'content-length': String(buf.byteLength), 'accept-ranges': 'bytes' } });
}

const FIXTURE_DATASET = {
  spec: 'cng-dataset/1.0',
  id: 'fixture-geo-metadata',
  source: { kind: 'parquet', url: `file://${FIXTURES}geo-metadata.parquet` },
  table: {
    geometryColumn: 'geometry',
    geometryEncoding: 'WKB',
    crs: 'OGC:CRS84',
    bbox: { kind: 'struct', column: 'bbox' },
    columns: [
      { name: 'id', type: 'string' },
      { name: 'confidence', type: 'float32' },
      { name: 'geometry', type: 'geometry' },
    ],
  },
};

/** A small box around row 'a' only (its bbox is {0,0,1,1}; row 'b' starts at x=2, row 'c' at x=10). */
function areaAroundRowA() {
  return buildArea({
    name: 'row-a-only',
    geometry: { type: 'Polygon', coordinates: [[[-1, -1], [1.5, -1], [1.5, 1.5], [-1, 1.5], [-1, -1]]] },
    source: 'draw',
    features: [],
  });
}

// --- engine level: buildBatch never leaks a geometry that was read only for filtering ----

test('buildBatch: geometry read for internal use is NOT leaked into the batch when outputColumns excludes it', async () => {
  const { handle } = await openFakeHostedParquet({ groups: 1, rowsPerGroup: 5 });
  const engine = createHyparquetEngine();
  const plan = enginePlanFor({
    handle,
    readColumns: ['id', 'n', 'cat', 'geometry'], // geometry IS read
    outputColumns: ['id', 'n', 'cat'], // but dropped from output
  });
  const batches = [];
  await engine.run(plan, async (batch) => batches.push(batch), {});
  assert.ok(batches.length > 0);
  for (const batch of batches) {
    assert.ok(!('geometry' in batch.columns), 'geometry must never appear as a named column either');
    assert.equal(batch.geometry.length, batch.rows);
    assert.ok(batch.geometry.every((g) => g === null), 'batch.geometry must be all-null when outputColumns excludes the geometry column');
  }
});

test('buildBatch: geometry IS populated in the batch when outputColumns includes it (no regression for the normal path)', async () => {
  const { handle } = await openFakeHostedParquet({ groups: 1, rowsPerGroup: 5 });
  const engine = createHyparquetEngine();
  const plan = enginePlanFor({ handle, outputColumns: ['id', 'n', 'cat', 'geometry'] });
  const batches = [];
  await engine.run(plan, async (batch) => batches.push(batch), {});
  const allGeom = batches.flatMap((b) => b.geometry);
  assert.ok(allGeom.every((g) => g instanceof Uint8Array), 'geometry must still flow through when not dropped');
});

// --- geojson writer: a dropped geometry column writes geometry: null ----

test('geojson format: dropGeometry (batch.geometry all-null) writes "geometry": null for every feature', async () => {
  const format = createGeoJsonFormat();
  let written = '';
  const ctx = {
    writer: { write: (buf) => { written += Buffer.from(buf).toString('utf8'); }, close: () => {} },
    schema: [{ name: 'id', type: 'string' }], // geometryColumn absent: dropGeometry
    geometryColumn: 'geometry',
    crs: 'OGC:CRS84',
    options: {},
    attribution: [],
  };
  const writer = await format.open(ctx);
  await writer.writeBatch({ rows: 2, columns: { id: ['a', 'b'] }, geometry: [null, null] });
  await writer.close();
  const parsed = JSON.parse(written);
  assert.equal(parsed.features.length, 2);
  for (const f of parsed.features) assert.equal(f.geometry, null);
});

// --- geoparquet writer: a dropped geometry column is omitted entirely, with no `geo` kv-metadata ----

test('geoparquet format: dropGeometry omits the geometry column AND the "geo" kv-metadata entirely', async () => {
  const format = createGeoParquetFormat();
  let written;
  const ctx = {
    writer: { write: (buf) => { written = buf; }, close: () => {} },
    schema: [{ name: 'id', type: 'string' }], // geometryColumn absent: dropGeometry
    geometryColumn: 'geometry',
    crs: 'OGC:CRS84',
    options: {},
    attribution: [],
  };
  const writer = await format.open(ctx);
  await writer.writeBatch({ rows: 2, columns: { id: ['a', 'b'] }, geometry: [null, null] });
  const { rows } = await writer.close();
  assert.equal(rows, 2);
  assert.ok(written instanceof Uint8Array);

  const metadata = await hyparquet.parquetMetadataAsync(written.buffer.slice(written.byteOffset, written.byteOffset + written.byteLength), { geoparquet: false });
  const columnNames = metadata.schema.slice(1).map((e) => e.name);
  assert.deepEqual(columnNames, ['id'], 'no geometry column, no bbox_* covering columns');
  const hasGeo = (metadata.key_value_metadata ?? []).some((kv) => kv.key === 'geo');
  assert.equal(hasGeo, false, 'no "geo" GeoParquet key-value metadata for a dataset with no geometry at all');
});

test('geoparquet format: WITHOUT dropGeometry, the geometry column and "geo" metadata are present (no regression)', async () => {
  const format = createGeoParquetFormat();
  let written;
  const ctx = {
    writer: { write: (buf) => { written = buf; }, close: () => {} },
    schema: [{ name: 'id', type: 'string' }, { name: 'geometry', type: 'geometry' }],
    geometryColumn: 'geometry',
    crs: 'OGC:CRS84',
    options: {},
    attribution: [],
  };
  const writer = await format.open(ctx);
  // A zero-row batch is enough to exercise close()'s column shaping
  // without needing a real WKB decode.
  await writer.writeBatch({ rows: 0, columns: { id: [] }, geometry: [] });
  const { rows } = await writer.close();
  assert.equal(rows, 0);

  const metadata = await hyparquet.parquetMetadataAsync(written.buffer.slice(written.byteOffset, written.byteOffset + written.byteLength), { geoparquet: false });
  const columnNames = metadata.schema.slice(1).map((e) => e.name);
  assert.ok(columnNames.includes('geometry'), 'geometry column must be present when not dropped');
  assert.ok(columnNames.includes('bbox_xmin'), 'covering columns must be present when not dropped');
  const hasGeo = (metadata.key_value_metadata ?? []).some((kv) => kv.key === 'geo');
  assert.equal(hasGeo, true);
});

// --- end to end: download() with dropGeometry, with and without a spatial filter that needs geometry ---

test('download() with dropGeometry and NO spatial filter: output has no geometry, all 3 rows present', async () => {
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' }, columns: { dropGeometry: true } };
  const output = { spec: 'cng-output/1.0', format: 'geojson', filename: 'out.geojson' };
  const sink = memorySink();
  const handle = download(FIXTURE_DATASET, null, filter, output, { sink, fetch: fetchLocalFile });
  const result = await handle.result;
  assert.equal(result.rows, 3);
  const parsed = JSON.parse(Buffer.concat(sink.chunks.map((c) => Buffer.from(c))).toString('utf8'));
  assert.equal(parsed.features.length, 3);
  for (const f of parsed.features) assert.equal(f.geometry, null);
});

test('download() with dropGeometry AND an intersects filter that needs geometry: filtering still works correctly, output still has no geometry', async () => {
  const area = areaAroundRowA();
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'intersects' }, columns: { dropGeometry: true } };
  const output = { spec: 'cng-output/1.0', format: 'geojson', filename: 'out.geojson' };
  const sink = memorySink();
  const handle = download(FIXTURE_DATASET, area, filter, output, { sink, fetch: fetchLocalFile });
  const result = await handle.result;
  // Only row 'a' (bbox {0,0,1,1}) falls inside the area; 'b' and 'c' do not.
  // This can only be correct if geometry/bbox were actually read and used
  // to filter, even though the output drops geometry entirely.
  assert.equal(result.rows, 1);
  const parsed = JSON.parse(Buffer.concat(sink.chunks.map((c) => Buffer.from(c))).toString('utf8'));
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0].properties.id, 'a');
  assert.equal(parsed.features[0].geometry, null);
});

test('download() with dropGeometry to geoparquet: the written file has no geometry column and no "geo" metadata', async () => {
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' }, columns: { dropGeometry: true } };
  const output = { spec: 'cng-output/1.0', format: 'geoparquet', filename: 'out.parquet' };
  const sink = memorySink();
  const handle = download(FIXTURE_DATASET, null, filter, output, { sink, fetch: fetchLocalFile });
  const result = await handle.result;
  assert.equal(result.rows, 3);

  const buf = Buffer.concat(sink.chunks.map((c) => Buffer.from(c)));
  const metadata = await hyparquet.parquetMetadataAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { geoparquet: false });
  const columnNames = metadata.schema.slice(1).map((e) => e.name);
  assert.ok(!columnNames.includes('geometry'));
  assert.ok(!columnNames.some((n) => n.startsWith('bbox_')));
  const hasGeo = (metadata.key_value_metadata ?? []).some((kv) => kv.key === 'geo');
  assert.equal(hasGeo, false);
});

test('download() output-bytes estimate does not inflate for a dropped geometry (ceiling honesty)', async () => {
  // Without the geometry-term fix, a dropGeometry request would still model
  // ~the same outputBytes as a normal download, because
  // estimateGeoJsonBytes/estimateGeoParquetBytes added the geometry term
  // unconditionally. With the fix, the estimate should be noticeably
  // smaller for the same rows.
  const withGeom = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };
  const dropped = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' }, columns: { dropGeometry: true } };
  const output = { spec: 'cng-output/1.0', format: 'geojson', filename: 'out.geojson' };

  const h1 = download(FIXTURE_DATASET, null, withGeom, output, { sink: memorySink(), fetch: fetchLocalFile });
  const est1 = await h1.estimate;
  await h1.result;

  const h2 = download(FIXTURE_DATASET, null, dropped, output, { sink: memorySink(), fetch: fetchLocalFile });
  const est2 = await h2.estimate;
  await h2.result;

  assert.ok(est2.outputBytes.estimate < est1.outputBytes.estimate, `dropGeometry estimate (${est2.outputBytes.estimate}) should be smaller than the normal estimate (${est1.outputBytes.estimate})`);
});
