// @cngeo/extract-core -- GitHub issue #4: the `geoparquet` format must
// (1) stream row groups to the sink instead of buffering the whole file,
// and (2) keep nested columns as native Parquet structs/lists instead of
// the JSON strings hyparquet-writer infers for an object or array.
//
// The dataset here is STAC-GeoParquet-shaped: a `bbox` struct, an `assets`
// struct of structs, a `links` list<struct> and a `stac_extensions`
// list<string>, written across several batches and read back with
// hyparquet -- an independent reader of what this writer wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import './helpers/hyparquet-setup.js';
import { createGeoParquetFormat } from '../src/formats/geoparquet.js';
import { unionSourceSchemas } from '../src/download.js';
import { effectiveCeiling, UNBOUNDED_BYTES } from '../src/ceiling.js';

const str = (name) => ({ name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' });
const dbl = (name) => ({ name, type: 'DOUBLE', repetition_type: 'OPTIONAL' });

/** The source footer schema, as hyparquet reports it: flat and depth-first. */
const SOURCE_SCHEMA = [
  { name: 'schema', num_children: 6 },
  { ...str('id'), repetition_type: 'REQUIRED' },
  // REQUIRED at the source: the writer must relax the column itself to OPTIONAL.
  { name: 'bbox', repetition_type: 'REQUIRED', num_children: 4 },
  dbl('xmin'),
  dbl('ymin'),
  dbl('xmax'),
  dbl('ymax'),
  { name: 'assets', repetition_type: 'OPTIONAL', num_children: 1 },
  { name: 'visual', repetition_type: 'OPTIONAL', num_children: 2 },
  str('href'),
  { name: 'roles', repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 },
  { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
  str('element'),
  { name: 'links', repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 },
  { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
  { name: 'element', repetition_type: 'OPTIONAL', num_children: 2 },
  str('rel'),
  str('href'),
  { name: 'stac_extensions', repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 },
  { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
  str('element'),
  { name: 'geometry', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' },
];

const OUTPUT_SCHEMA = [
  { name: 'id', type: 'string' },
  { name: 'bbox', type: 'struct' },
  { name: 'assets', type: 'struct' },
  { name: 'links', type: 'list' },
  { name: 'stac_extensions', type: 'list' },
  { name: 'geometry', type: 'geometry' },
];

function itemRow(i) {
  return {
    id: `item-${i}`,
    bbox: { xmin: i, ymin: i + 0.5, xmax: i + 1, ymax: i + 1.5 },
    assets: { visual: { href: `https://example.test/${i}.tif`, roles: ['data', 'visual'] } },
    links: [
      { rel: 'self', href: `https://example.test/items/${i}` },
      { rel: 'parent', href: 'https://example.test/collection' },
    ],
    stac_extensions: i % 2 ? ['https://stac-extensions.github.io/eo/v1.1.0/schema.json'] : [],
    geometry: { type: 'Point', coordinates: [i, i + 0.5] },
  };
}

/** A `FeatureBatch` of rows `[from, to)`, the shape engine-hyparquet.js's `buildBatch` produces. */
function batchOf(from, to) {
  const rows = Array.from({ length: to - from }, (_, k) => itemRow(from + k));
  const columns = {};
  for (const name of ['id', 'bbox', 'assets', 'links', 'stac_extensions']) columns[name] = rows.map((r) => r[name]);
  return { rows: rows.length, columns, geometry: rows.map((r) => r.geometry) };
}

/** A sink writer that records every chunk, and how many had arrived at each moment asked. */
function recordingWriter() {
  const chunks = [];
  return {
    chunks,
    write: async (chunk) => {
      chunks.push(chunk);
    },
    bytes() {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.byteLength;
      }
      return out;
    },
  };
}

function ctxFor(writer, extra = {}) {
  return { writer, schema: OUTPUT_SCHEMA, geometryColumn: 'geometry', crs: 'OGC:CRS84', options: { rowGroupSize: 4 }, attribution: [], sourceSchema: SOURCE_SCHEMA, ...extra };
}

async function readBack(bytes) {
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const metadata = await parquetMetadataAsync(file, { geoparquet: false });
  const rows = await parquetReadObjects({ file, metadata, compressors, utf8: false });
  return { metadata, rows };
}

/** Top-level column -> its schema tree node. */
function columnsOf(metadata) {
  return new Map(parquetSchema(metadata).children.map((c) => [c.element.name, c]));
}

test('nested columns are written as native structs and lists, not JSON strings', async () => {
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer));
  await formatWriter.writeBatch(batchOf(0, 5));
  await formatWriter.writeBatch(batchOf(5, 10));
  const result = await formatWriter.close();
  assert.equal(result.rows, 10);

  const { metadata, rows } = await readBack(writer.bytes());
  assert.equal(result.bytes, writer.bytes().byteLength, 'reported bytes are the bytes delivered');
  assert.equal(rows.length, 10);

  // The schema: groups, not BYTE_ARRAY/JSON leaves.
  const cols = columnsOf(metadata);
  for (const name of ['bbox', 'assets', 'links', 'stac_extensions']) {
    const el = cols.get(name).element;
    assert.equal(el.type, undefined, `${name} must be a group, not a ${el.type} leaf`);
    assert.notEqual(el.converted_type, 'JSON', `${name} was written as JSON`);
    assert.ok(el.num_children > 0);
  }
  assert.equal(cols.get('links').element.converted_type, 'LIST');
  assert.equal(cols.get('stac_extensions').element.converted_type, 'LIST');
  assert.equal(cols.get('bbox').element.repetition_type, 'OPTIONAL', 'a REQUIRED source column is relaxed to OPTIONAL');

  // The values: objects and arrays, equal to what went in.
  for (const [i, row] of rows.entries()) {
    const want = itemRow(i);
    assert.equal(typeof row.bbox, 'object');
    assert.deepEqual(row.bbox, want.bbox);
    assert.deepEqual(row.assets, want.assets);
    assert.ok(Array.isArray(row.links));
    assert.deepEqual(row.links, want.links);
    assert.ok(Array.isArray(row.stac_extensions));
    assert.deepEqual(row.stac_extensions, want.stac_extensions);
    assert.equal(row.id, want.id);
  }
});

test('row groups reach the sink as they are written, before close()', async () => {
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer));

  await formatWriter.writeBatch(batchOf(0, 3)); // 3 buffered: under the row-group size of 4
  assert.equal(writer.chunks.length, 0, 'nothing is written before a row group fills');

  await formatWriter.writeBatch(batchOf(3, 10)); // fills two groups (rows 0-3, 4-7), leaves 2
  const beforeClose = writer.chunks.length;
  const bytesBeforeClose = writer.bytes().byteLength;
  assert.ok(beforeClose >= 2, `expected at least two row groups delivered before close(), saw ${beforeClose} chunks`);
  assert.ok(bytesBeforeClose > 0);

  await formatWriter.close();
  assert.ok(writer.chunks.length > beforeClose, 'close() delivers the last group and the footer');

  const { metadata, rows } = await readBack(writer.bytes());
  assert.equal(metadata.row_groups.length, 3);
  assert.deepEqual(metadata.row_groups.map((rg) => Number(rg.num_rows)), [4, 4, 2]);
  assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 10 }, (_, i) => `item-${i}`));
});

test('one batch larger than a row group is split across row groups', async () => {
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer));
  await formatWriter.writeBatch(batchOf(0, 9));
  await formatWriter.close();
  const { metadata } = await readBack(writer.bytes());
  assert.deepEqual(metadata.row_groups.map((rg) => Number(rg.num_rows)), [4, 4, 1]);
});

test('the declared covering struct becomes the covering, instead of four added columns', async () => {
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer, { covering: { kind: 'struct', column: 'bbox' } }));
  await formatWriter.writeBatch(batchOf(0, 6));
  await formatWriter.close();
  const { metadata } = await readBack(writer.bytes());

  const cols = columnsOf(metadata);
  for (const added of ['bbox_xmin', 'bbox_ymin', 'bbox_xmax', 'bbox_ymax']) {
    assert.equal(cols.has(added), false, `${added} should not be added when a bbox struct passes through`);
  }
  const geo = JSON.parse(metadata.key_value_metadata.find((kv) => kv.key === 'geo').value);
  assert.deepEqual(geo.columns.geometry.covering, {
    bbox: { xmin: ['bbox', 'xmin'], ymin: ['bbox', 'ymin'], xmax: ['bbox', 'xmax'], ymax: ['bbox', 'ymax'] },
  });
  assert.deepEqual(geo.columns.geometry.bbox, [0, 0.5, 5, 5.5]);
  assert.deepEqual(geo.columns.geometry.geometry_types, ['Point']);
});

test('without a bbox struct in the output, the four covering columns are still added', async () => {
  const schema = OUTPUT_SCHEMA.filter((c) => c.name !== 'bbox');
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer, { schema }));
  const batch = batchOf(0, 6);
  delete batch.columns.bbox;
  await formatWriter.writeBatch(batch);
  await formatWriter.close();
  const { metadata, rows } = await readBack(writer.bytes());

  const geo = JSON.parse(metadata.key_value_metadata.find((kv) => kv.key === 'geo').value);
  assert.deepEqual(geo.columns.geometry.covering.bbox.xmin, ['bbox_xmin']);
  assert.equal(rows[2].bbox_xmin, 2);
  assert.equal(rows[2].bbox_ymax, 2.5);
});

test('with no source schema, inference is the fallback and the file still reads', async () => {
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer, { sourceSchema: undefined }));
  await formatWriter.writeBatch(batchOf(0, 10));
  await formatWriter.close();
  const { metadata, rows } = await readBack(writer.bytes());
  assert.equal(rows.length, 10);
  assert.equal(metadata.row_groups.length, 3); // streaming does not depend on the source schema
  assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 10 }, (_, i) => `item-${i}`));
});

test('null nested values and null geometry round-trip', async () => {
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer));
  const batch = batchOf(0, 3);
  batch.columns.bbox[1] = null;
  batch.columns.assets[1] = null;
  batch.columns.links[1] = null;
  batch.columns.stac_extensions[1] = undefined;
  batch.geometry[1] = null;
  await formatWriter.writeBatch(batch);
  await formatWriter.close();
  const { rows } = await readBack(writer.bytes());
  assert.equal(rows[1].bbox ?? null, null);
  assert.equal(rows[1].assets ?? null, null);
  assert.equal(rows[1].links ?? null, null);
  assert.equal(rows[1].geometry ?? null, null);
  assert.deepEqual(rows[2].links, itemRow(2).links);
});

test('zero rows still produces a valid file with the declared columns', async () => {
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer));
  const result = await formatWriter.close();
  assert.equal(result.rows, 0);
  const { metadata, rows } = await readBack(writer.bytes());
  assert.equal(rows.length, 0);
  const cols = columnsOf(metadata);
  for (const name of ['id', 'bbox', 'assets', 'links', 'stac_extensions', 'geometry']) assert.ok(cols.has(name), `missing ${name}`);
});

test('zstd is refused at open(), before anything is read or written', async () => {
  const writer = recordingWriter();
  await assert.rejects(
    createGeoParquetFormat().open(ctxFor(writer, { options: { compression: 'zstd' } })),
    (err) => err.code === 'FORMAT_CAPABILITY',
  );
  assert.equal(writer.chunks.length, 0);
});

test('the format declares itself streaming, so the ceiling treats it like geojson', () => {
  const format = createGeoParquetFormat();
  assert.equal(format.streaming, true);
  assert.equal(format.capabilities.memoryFactor, 0);
  assert.equal(format.capabilities.nestedColumns, true);
  assert.equal(effectiveCeiling({ format, sink: { kind: 'filesystem' } }).outputBytes, UNBOUNDED_BYTES);
});

test('unionSourceSchemas: columns the parts agree on are kept whole; a column whose shape differs is left out', () => {
  const bboxAB = [{ name: 'bbox', repetition_type: 'OPTIONAL', num_children: 2 }, dbl('xmin'), dbl('ymin')];
  const a = [{ name: 'schema', num_children: 3 }, str('id'), ...bboxAB, { name: 'assets', repetition_type: 'OPTIONAL', num_children: 1 }, str('visual')];
  const b = [
    { name: 'schema', num_children: 5 },
    str('id'),
    ...bboxAB,
    // Same column, one more field than part a declares.
    { name: 'assets', repetition_type: 'OPTIONAL', num_children: 2 },
    str('visual'),
    str('B04'),
    str('extra'),
    { name: 'tags', repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 },
    { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
    str('element'),
  ];
  const union = unionSourceSchemas([a, undefined, b]);
  assert.deepEqual(union.slice(1).map((e) => e.name), ['id', 'bbox', 'xmin', 'ymin', 'extra', 'tags', 'list', 'element']);
  assert.equal(union[0].num_children, 4);
  assert.equal(union.some((e) => e.name === 'assets'), false, 'a column the parts disagree on must not take one part\'s shape');

  // A flat column whose physical type differs is a conflict too.
  const c = [{ name: 'schema', num_children: 1 }, { name: 'id', type: 'INT64', repetition_type: 'OPTIONAL' }];
  assert.equal(unionSourceSchemas([a, c]).some((e) => e.name === 'id'), false);
  assert.equal(unionSourceSchemas([undefined, []]), undefined);
});

// --- second review (PR #5) ------------------------------------------------

test('a struct that merely LOOKS like a covering is not used as one', async () => {
  // `bbox` here is not the declared covering (no ctx.covering), so the four
  // computed columns must still be written from the geometry itself.
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer));
  await formatWriter.writeBatch(batchOf(0, 6));
  await formatWriter.close();
  const { metadata, rows } = await readBack(writer.bytes());
  const geo = JSON.parse(metadata.key_value_metadata.find((kv) => kv.key === 'geo').value);
  assert.deepEqual(geo.columns.geometry.covering.bbox.xmin, ['bbox_xmin']);
  assert.equal(rows[3].bbox_xmin, 3); // the point's own x, not the struct's
  assert.deepEqual(rows[3].bbox, itemRow(3).bbox); // and the struct still round-trips
});

test('a row group is flushed on buffered geometry bytes, not only on row count', async () => {
  const writer = recordingWriter();
  // Far under the row bound, but each geometry is ~16 KB and the byte bound is 64 KB.
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer, { options: { rowGroupSize: 50_000, rowGroupBytes: 64 * 1024 } }));
  const ring = Array.from({ length: 1000 }, (_, k) => [Math.cos(k / 159), Math.sin(k / 159)]);
  ring.push(ring[0]);
  const big = { type: 'Polygon', coordinates: [ring] };
  // One row per batch: the byte bound is checked between appends.
  for (let i = 0; i < 20; i++) {
    const batch = batchOf(i, i + 1);
    batch.geometry[0] = big;
    await formatWriter.writeBatch(batch);
  }
  assert.ok(writer.chunks.length >= 2, `expected row groups at the sink before close(), saw ${writer.chunks.length}`);
  await formatWriter.close();
  const { metadata, rows } = await readBack(writer.bytes());
  assert.ok(metadata.row_groups.length >= 3, `expected several byte-bounded row groups, got ${metadata.row_groups.length}`);
  assert.equal(rows.length, 20);
});

test('a non-numeric rowGroupSize is refused at open(), not turned into an empty file', async () => {
  for (const bad of [[1000, 100000], Number.NaN, '5000', 0, -3]) {
    await assert.rejects(
      createGeoParquetFormat().open(ctxFor(recordingWriter(), { options: { rowGroupSize: bad } })),
      (err) => err.code === 'FORMAT_CAPABILITY' && /rowGroupSize/.test(err.message),
      `rowGroupSize ${JSON.stringify(bad)} should be refused`,
    );
  }
  await assert.rejects(
    createGeoParquetFormat().open(ctxFor(recordingWriter(), { options: { rowGroupBytes: 'big' } })),
    (err) => err.code === 'FORMAT_CAPABILITY' && /rowGroupBytes/.test(err.message),
  );
});

test('nested shapes hyparquet-writer cannot re-encode fall back to JSON instead of failing the download', async () => {
  const sourceSchema = [
    { name: 'schema', num_children: 5 },
    str('id'),
    // legacy two-level list: a REPEATED leaf directly under the LIST group
    { name: 'legacy', repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 },
    { name: 'array', type: 'INT32', repetition_type: 'REPEATED' },
    // a top-level REPEATED group
    { name: 'rep', repetition_type: 'REPEATED', num_children: 1 },
    str('v'),
    // a map with integer keys
    { name: 'imap', repetition_type: 'OPTIONAL', converted_type: 'MAP', num_children: 1 },
    { name: 'key_value', repetition_type: 'REPEATED', num_children: 2 },
    { name: 'key', type: 'INT32', repetition_type: 'REQUIRED' },
    str('value'),
    { name: 'geometry', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' },
  ];
  const schema = [{ name: 'id', type: 'string' }, { name: 'legacy', type: 'list' }, { name: 'rep', type: 'list' }, { name: 'imap', type: 'map' }, { name: 'geometry', type: 'geometry' }];
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer, { schema, sourceSchema }));
  await formatWriter.writeBatch({
    rows: 2,
    columns: { id: ['a', 'b'], legacy: [[1, 2], [3]], rep: [[{ v: 'x' }], []], imap: [{ 1: 'one' }, { 2: 'two' }] },
    geometry: [{ type: 'Point', coordinates: [0, 0] }, { type: 'Point', coordinates: [1, 1] }],
  });
  await formatWriter.close(); // threw for all three shapes before the fallback
  const { rows } = await readBack(writer.bytes());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
  // Written as JSON, so every value is still there.
  assert.deepEqual(rows[0].legacy, [1, 2]);
  assert.deepEqual(rows[0].imap, { 1: 'one' });
});

test('a column with no declared type takes its type from the source footer, and survives nulls after the first group', async () => {
  const sourceSchema = [
    { name: 'schema', num_children: 4 },
    str('id'),
    str('note'),
    { name: 'count', type: 'INT32', repetition_type: 'REQUIRED' },
    { name: 'geometry', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' },
  ];
  // `table` omitted upstream: every flat column arrives typed 'unknown'.
  const schema = [{ name: 'id', type: 'unknown' }, { name: 'note', type: 'unknown' }, { name: 'count', type: 'unknown' }, { name: 'geometry', type: 'geometry' }];
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer, { schema, sourceSchema, options: { rowGroupSize: 2 } }));
  const point = { type: 'Point', coordinates: [0, 0] };
  // First row group: `note` is all null, `count` has no null.
  await formatWriter.writeBatch({ rows: 2, columns: { id: ['a', 'b'], note: [null, null], count: [1, 2] }, geometry: [point, point] });
  // Second: `note` turns out to be a string, `count` has a null.
  await formatWriter.writeBatch({ rows: 2, columns: { id: ['c', 'd'], note: ['hello', null], count: [null, 4] }, geometry: [point, point] });
  await formatWriter.close();
  const { metadata, rows } = await readBack(writer.bytes());
  assert.equal(metadata.row_groups.length, 2);
  assert.equal(rows[2].note, 'hello'); // a string, not raw bytes
  assert.equal(rows[2].count ?? null, null);
  assert.equal(rows[3].count, 4);
  const cols = columnsOf(metadata);
  assert.equal(cols.get('note').element.converted_type, 'UTF8');
  assert.equal(cols.get('count').element.repetition_type, 'OPTIONAL');
});

test('with no source schema an inferred column is still nullable in later row groups', async () => {
  const schema = [{ name: 'id', type: 'string' }, { name: 'count', type: 'unknown' }, { name: 'geometry', type: 'geometry' }];
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer, { schema, sourceSchema: undefined, options: { rowGroupSize: 2 } }));
  const point = { type: 'Point', coordinates: [0, 0] };
  await formatWriter.writeBatch({ rows: 2, columns: { id: ['a', 'b'], count: [1, 2] }, geometry: [point, point] });
  await formatWriter.writeBatch({ rows: 2, columns: { id: ['c', 'd'], count: [null, 4] }, geometry: [point, point] });
  await formatWriter.close(); // threw "expected integer value, got null" when inferred REQUIRED
  const { rows } = await readBack(writer.bytes());
  assert.deepEqual(rows.map((r) => r.count ?? null), [1, 2, null, 4]);
});

test('re-extracting a file that already has bbox_* columns reuses them and does not duplicate the names', async () => {
  const schema = [
    { name: 'id', type: 'string' },
    { name: 'bbox_xmin', type: 'float64' },
    { name: 'bbox_ymin', type: 'float64' },
    { name: 'bbox_xmax', type: 'float64' },
    { name: 'bbox_ymax', type: 'float64' },
    { name: 'geometry', type: 'geometry' },
  ];
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer, { schema, sourceSchema: undefined }));
  await formatWriter.writeBatch({
    rows: 2,
    columns: { id: ['a', 'b'], bbox_xmin: [0, 1], bbox_ymin: [0, 1], bbox_xmax: [0, 1], bbox_ymax: [0, 1] },
    geometry: [{ type: 'Point', coordinates: [0, 0] }, { type: 'Point', coordinates: [1, 1] }],
  });
  await formatWriter.close();
  const { metadata, rows } = await readBack(writer.bytes());
  const names = parquetSchema(metadata).children.map((c) => c.element.name);
  assert.deepEqual(names, ['id', 'bbox_xmin', 'bbox_ymin', 'bbox_xmax', 'bbox_ymax', 'geometry']);
  const geo = JSON.parse(metadata.key_value_metadata.find((kv) => kv.key === 'geo').value);
  assert.deepEqual(geo.columns.geometry.covering.bbox.xmax, ['bbox_xmax']);
  assert.equal(rows[1].bbox_xmin, 1);
});
