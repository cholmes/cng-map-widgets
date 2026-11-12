// Regression test for a latent hyparquet@1.33.0 behavior (same root cause
// @cnmw/geocoder-core hit and fixed in commit c3cd2ea): a parquet file
// whose footer carries GeoParquet `geo` key-value metadata (which DuckDB
// writes by default for a native GEOMETRY column) makes hyparquet
// auto-decode that column straight to a GeoJSON object -- independent of
// any `utf8` option -- so raw WKB bytes never reach the caller unless
// `parquetMetadataAsync` is called with `{ geoparquet: false }`. That
// alone is not sufficient, though: once auto-decode is off, the column
// falls back to hyparquet's *other* default -- `utf8: true` -- which
// decodes any untyped BYTE_ARRAY column as a UTF-8 string, mangling the
// binary WKB just as badly. Both flags are needed together
// (`parquet-io.js`'s openParquetFile + readRows), which is what this test
// locks in against two local fixtures generated with the duckdb CLI
// (test/fixtures/geo-metadata.parquet has `geo` kv-metadata; bare.parquet,
// built by casting the same geometry down to a plain BLOB, does not), so
// this never needs the network.
//
// Why the integration test (against the real FTW Liechtenstein file,
// which *does* carry `geo` metadata) didn't catch a regression here on
// its own: it only ever exercised the "has geo metadata" branch. A file
// with no `geo` metadata at all was never read through this package's
// engine until this fixture was added.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import './helpers/hyparquet-setup.js';
import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { openParquetFile, readRows } from '../src/parquet-io.js';
import { pointInGeometry } from '../src/spatial.js';
import { estimate, download } from '../src/index.js';
import { memorySink } from '../src/sinks.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** A `fetch`-shaped stub over a local file, for hyparquet's `asyncBufferFromUrl`. */
function fetchFromFile(path) {
  return async () => {
    const buf = await readFile(path);
    return new Response(buf, { status: 200, headers: { 'content-length': String(buf.byteLength), 'accept-ranges': 'bytes' } });
  };
}

/** Generalized version of fetchFromFile that resolves any `file://` URL under FIXTURES, for a full download()/estimate() run (which builds its own URL from `dataset.source.url`, rather than a path a test closes over). */
async function fetchLocalFile(url) {
  const path = fileURLToPath(new URL(String(url)));
  const buf = await readFile(path);
  return new Response(buf, { status: 200, headers: { 'content-length': String(buf.byteLength), 'accept-ranges': 'bytes' } });
}

function fixtureDataset(name) {
  return {
    spec: 'cnmw-dataset/1.0',
    id: `fixture-${name}`,
    source: { kind: 'parquet', url: `file://${FIXTURES}${name}` },
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
}

async function assertKvMetadataHasGeo(path, expected) {
  const buf = await readFile(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const metadata = await hyparquet.parquetMetadataAsync(ab, { geoparquet: false });
  const hasGeo = (metadata.key_value_metadata ?? []).some((kv) => kv.key === 'geo');
  assert.equal(hasGeo, expected, `fixture precondition: ${path} geo kv-metadata present = ${expected}`);
}

test('fixture sanity: geo-metadata.parquet carries GeoParquet "geo" kv-metadata; bare.parquet does not', async () => {
  await assertKvMetadataHasGeo(`${FIXTURES}geo-metadata.parquet`, true);
  await assertKvMetadataHasGeo(`${FIXTURES}bare.parquet`, false);
});

test('raw hyparquet without both fixes: geoparquet:true auto-decodes to an object on the geo-metadata file', async () => {
  const buf = await readFile(`${FIXTURES}geo-metadata.parquet`);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const metadata = await hyparquet.parquetMetadataAsync(ab, { geoparquet: true });
  const rows = await hyparquet.parquetReadObjects({ file: ab, metadata, compressors });
  assert.equal(typeof rows[0].geometry, 'object');
  assert.ok(!(rows[0].geometry instanceof Uint8Array), 'auto-decoded, not raw bytes -- this is the behavior being worked around');
});

test('raw hyparquet with geoparquet:false but WITHOUT utf8:false: the column is wrongly decoded as a string, not restored to raw bytes', async () => {
  const buf = await readFile(`${FIXTURES}bare.parquet`);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const metadata = await hyparquet.parquetMetadataAsync(ab, { geoparquet: false });
  const rows = await hyparquet.parquetReadObjects({ file: ab, metadata, compressors }); // no utf8:false
  assert.equal(typeof rows[0].geometry, 'string', 'hyparquet\'s utf8:true default mangles an untyped BYTE_ARRAY into a string');
});

test('openParquetFile + readRows (both fixes applied): geometry is raw WKB Uint8Array for BOTH a geo-metadata file and a bare one', async () => {
  for (const name of ['geo-metadata.parquet', 'bare.parquet']) {
    const handle = await openParquetFile(`file://${FIXTURES}${name}`, fetchFromFile(`${FIXTURES}${name}`));
    const rows = await readRows(handle, { rowStart: 0, rowEnd: handle.rowGroups[0].numRows, columns: ['id', 'confidence', 'geometry', 'bbox'] });
    assert.equal(rows.length, 3, name);
    for (const row of rows) {
      assert.ok(row.geometry instanceof Uint8Array, `${name}: geometry must be raw WKB bytes, got ${row.geometry?.constructor?.name}`);
      assert.equal(typeof row.id, 'string', `${name}: a real VARCHAR column must still decode as a string`);
      assert.equal(typeof row.bbox.xmin, 'number', `${name}: the bbox STRUCT covering column is unaffected either way`);
    }
  }
});

test('end-to-end estimate()+download() produce correct, matching GeoJSON output for BOTH fixture kinds', async () => {
  for (const name of ['geo-metadata.parquet', 'bare.parquet']) {
    const dataset = fixtureDataset(name);
    const filter = { spec: 'cnmw-filter/1.0', spatial: { mode: 'bbox' } };

    const est = await estimate(dataset, null, filter, { fetch: fetchLocalFile });
    assert.equal(est.rowGroups.total, 1, name);

    const output = { spec: 'cnmw-output/1.0', format: 'geojson', filename: 'out.geojson' };
    const sink = memorySink();
    const handle = download(dataset, null, filter, output, { sink, fetch: fetchLocalFile });
    const result = await handle.result;
    assert.equal(result.rows, 3, name);

    const text = Buffer.concat(sink.chunks.map((c) => Buffer.from(c))).toString('utf8');
    const parsed = JSON.parse(text);
    assert.equal(parsed.features.length, 3, name);
    const byId = Object.fromEntries(parsed.features.map((f) => [f.properties.id, f]));
    assert.equal(byId.a.geometry.type, 'Polygon', name);
    assert.deepEqual(byId.a.geometry.coordinates[0][0], [0, 0], name);
    assert.equal(byId.a.properties.confidence > 0.9, true, name); // 0.95
  }
});

test('engine-hyparquet.js\'s decode path (wkbToGeoJson) produces the same correct geometry for both fixture kinds', async () => {
  const { wkbToGeoJson } = await import('@cnmw/spec');
  for (const name of ['geo-metadata.parquet', 'bare.parquet']) {
    const handle = await openParquetFile(`file://${FIXTURES}${name}`, fetchFromFile(`${FIXTURES}${name}`));
    const rows = await readRows(handle, { rowStart: 0, rowEnd: handle.rowGroups[0].numRows, columns: ['id', 'geometry'] });
    const byId = Object.fromEntries(rows.map((r) => [r.id, wkbToGeoJson(r.geometry)]));
    assert.equal(byId.a.type, 'Polygon');
    // Row 'a' is POLYGON((0 0, 1 0, 1 1, 0 1, 0 0)); (0.5, 0.5) is inside it, (5, 5) is not.
    assert.equal(pointInGeometry([0.5, 0.5], byId.a), true, name);
    assert.equal(pointInGeometry([5, 5], byId.a), false, name);
  }
});
