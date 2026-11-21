// Regression test for the first "known issue" fixed by this pass (README's
// known-issues table): `estimate.js`'s `inferTableFromSchema` used to
// flatten a struct column's children into the top-level column list
// (`metadata.schema.slice(1).map((e) => e.name)`, which walks every thrift
// `SchemaElement` in file order, parent *and* children, with no regard for
// `num_children` nesting). For a dataset with a `bbox: {xmin, ymin, xmax,
// ymax}` struct covering and no declared `table:` metadata, that put
// `xmin`/`ymin`/`xmax`/`ymax` into `table.columns` as if they were four
// extra top-level columns, and a read that projected them failed with
// "parquet column not found" because they are not real top-level parquet
// columns -- only `bbox` is.
//
// `test/fixtures/{geo-metadata,bare}.parquet` (shared with
// geoparquet-decode.test.js) are real DuckDB-written files with exactly
// this shape: `id`, `confidence`, `geometry`, `bbox: {xmin, ymin, xmax,
// ymax}`. Every test here uses a `DatasetDescriptor` with **no `table`**,
// forcing `inferTableFromSchema` to run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import './helpers/hyparquet-setup.js';
import { openParquetFile } from '../src/parquet-io.js';
import { inferTableFromSchema, estimate } from '../src/estimate.js';
import { download } from '../src/download.js';
import { memorySink } from '../src/sinks.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function fetchLocalFile(url) {
  const path = fileURLToPath(new URL(String(url)));
  const buf = await readFile(path);
  return new Response(buf, { status: 200, headers: { 'content-length': String(buf.byteLength), 'accept-ranges': 'bytes' } });
}

function undeclaredDataset(name) {
  return {
    spec: 'cng-dataset/1.0',
    id: `fixture-${name}-undeclared`,
    source: { kind: 'parquet', url: `file://${FIXTURES}${name}` },
    // deliberately no `table:` -- the whole point of this test file.
  };
}

test('inferTableFromSchema keeps a struct column as ONE top-level column, not its flattened children', async () => {
  for (const name of ['geo-metadata.parquet', 'bare.parquet']) {
    const handle = await openParquetFile(`file://${FIXTURES}${name}`, fetchLocalFile);
    const table = inferTableFromSchema(handle.metadata);

    const names = table.columns.map((c) => c.name);
    assert.deepEqual(names.sort(), ['bbox', 'confidence', 'geometry', 'id'].sort(), name);
    assert.ok(!names.includes('xmin'), `${name}: a struct child must not appear as a top-level column`);
    assert.ok(!names.includes('ymax'), name);

    assert.deepEqual(table.bbox, { kind: 'struct', column: 'bbox' }, name);
    assert.equal(table.geometryColumn, 'geometry', name);

    const bboxEntry = table.columns.find((c) => c.name === 'bbox');
    assert.equal(bboxEntry.type, 'struct', name);
  }
});

test('inferTableFromSchema: a struct that is not named "bbox" is still kept as one column, and bbox covering is "none"', () => {
  const schema = [
    { name: 'root', num_children: 3 },
    { name: 'id', type: 'BYTE_ARRAY' },
    { name: 'extent', num_children: 4 }, // a struct, but not called "bbox"
    { name: 'xmin', type: 'DOUBLE' },
    { name: 'ymin', type: 'DOUBLE' },
    { name: 'xmax', type: 'DOUBLE' },
    { name: 'ymax', type: 'DOUBLE' },
    { name: 'geometry', type: 'BYTE_ARRAY' },
  ];
  const table = inferTableFromSchema({ schema });
  assert.deepEqual(table.columns.map((c) => c.name), ['id', 'extent', 'geometry']);
  assert.deepEqual(table.bbox, { kind: 'none' });
});

test('inferTableFromSchema: a two-level-nested struct is skipped as one subtree (recursion, not just one level)', () => {
  // root -> [id, meta{a, nested{x, y}, b}, geometry]
  const schema = [
    { name: 'root', num_children: 3 },
    { name: 'id', type: 'BYTE_ARRAY' },
    { name: 'meta', num_children: 3 },
    { name: 'a', type: 'INT32' },
    { name: 'nested', num_children: 2 },
    { name: 'x', type: 'DOUBLE' },
    { name: 'y', type: 'DOUBLE' },
    { name: 'b', type: 'INT32' },
    { name: 'geometry', type: 'BYTE_ARRAY' },
  ];
  const table = inferTableFromSchema({ schema });
  assert.deepEqual(table.columns.map((c) => c.name), ['id', 'meta', 'geometry']);
  assert.equal(table.columns.find((c) => c.name === 'meta').type, 'struct');
});

test('estimate() against an undeclared-table struct-bbox fixture no longer throws "parquet column not found"', async () => {
  for (const name of ['geo-metadata.parquet', 'bare.parquet']) {
    const dataset = undeclaredDataset(name);
    const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };
    const est = await estimate(dataset, null, filter, { fetch: fetchLocalFile });
    assert.equal(est.rowGroups.total, 1, name);
    assert.equal(est.rows.max, 3, name);
    // `bbox` is the covering column, excluded from the *output* projection
    // by default (`includeBbox` defaults false) -- it is read, not output.
    // What matters here is that estimation completed at all: before this
    // fix, the inferred table's flattened `xmin`/`ymin`/`xmax`/`ymax`
    // "columns" made the read ask hyparquet for columns that do not exist.
    assert.deepEqual(est.columns.sort(), ['confidence', 'geometry', 'id'].sort(), name);
  }
});

test('download() an undeclared-table struct-bbox fixture to GeoJSON succeeds end to end (previously failed the read)', async () => {
  for (const name of ['geo-metadata.parquet', 'bare.parquet']) {
    const dataset = undeclaredDataset(name);
    const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };
    const output = { spec: 'cng-output/1.0', format: 'geojson', filename: 'out.geojson' };
    const sink = memorySink();
    const handle = download(dataset, null, filter, output, { sink, fetch: fetchLocalFile });
    const result = await handle.result;
    assert.equal(result.rows, 3, name);

    const text = Buffer.concat(sink.chunks.map((c) => Buffer.from(c))).toString('utf8');
    const parsed = JSON.parse(text);
    assert.equal(parsed.features.length, 3, name);
    for (const f of parsed.features) {
      assert.ok(f.geometry, name); // geometry round-tripped through the inferred (unflattened) column
    }
  }
});

test('the inferred struct covering is wired through coveringPaths, not just structurally present', async () => {
  const { coveringPaths } = await import('../src/prune.js');
  const handle = await openParquetFile(`file://${FIXTURES}geo-metadata.parquet`, fetchLocalFile);
  const table = inferTableFromSchema(handle.metadata);
  assert.deepEqual(coveringPaths(table.bbox), {
    xmin: 'bbox.xmin',
    ymin: 'bbox.ymin',
    xmax: 'bbox.xmax',
    ymax: 'bbox.ymax',
  });
});
