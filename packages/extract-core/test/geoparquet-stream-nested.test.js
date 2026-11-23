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

test('a source bbox struct becomes the covering, instead of four added columns', async () => {
  const writer = recordingWriter();
  const formatWriter = await createGeoParquetFormat().open(ctxFor(writer));
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

test('unionSourceSchemas: first declaration of each top-level column wins, subtrees stay intact', () => {
  const a = [{ name: 'schema', num_children: 2 }, str('id'), { name: 'bbox', repetition_type: 'OPTIONAL', num_children: 2 }, dbl('xmin'), dbl('ymin')];
  const b = [{ name: 'schema', num_children: 3 }, { name: 'id', type: 'INT64', repetition_type: 'OPTIONAL' }, str('extra'), { name: 'tags', repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 }, { name: 'list', repetition_type: 'REPEATED', num_children: 1 }, str('element')];
  const union = unionSourceSchemas([a, undefined, b]);
  assert.equal(union[0].num_children, 4);
  assert.deepEqual(union.slice(1).map((e) => e.name), ['id', 'bbox', 'xmin', 'ymin', 'extra', 'tags', 'list', 'element']);
  assert.equal(union[1].type, 'BYTE_ARRAY'); // a's `id`, not b's
  assert.equal(unionSourceSchemas([undefined, []]), undefined);
});
