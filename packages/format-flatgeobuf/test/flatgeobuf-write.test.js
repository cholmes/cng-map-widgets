// Writes batches through `createFlatGeobufFormat`, validates the bytes
// with `ogrinfo -al -so` and, where installed, DuckDB's spatial `ST_Read`
// -- the same bar every other format package in this project uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as flatgeobufGeojson from 'flatgeobuf/geojson';
import { createFlatGeobufFormat } from '../src/flatgeobuf-writer.js';

function hasCli(bin, args = ['--version']) {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_OGRINFO = hasCli('ogrinfo');
const HAS_DUCKDB = hasCli('duckdb', ['-c', 'SELECT 1']);

function wkbPoint(x, y) {
  const buf = new Uint8Array(21);
  const view = new DataView(buf.buffer);
  buf[0] = 1;
  view.setUint32(1, 1, true);
  view.setFloat64(5, x, true);
  view.setFloat64(13, y, true);
  return buf;
}

async function writeToTmpFile(batches, options = {}) {
  const format = createFlatGeobufFormat(flatgeobufGeojson);
  let written;
  const ctx = {
    writer: { write: (buf) => { written = buf; }, close: async () => {} },
    schema: options.schema ?? [],
    geometryColumn: 'geometry',
    crs: options.crs ?? 'EPSG:4326',
    options: {},
    attribution: [],
  };
  const writer = await format.open(ctx);
  for (const batch of batches) await writer.writeBatch(batch);
  const result = await writer.close();
  const dir = mkdtempSync(join(tmpdir(), 'cng-fgb-'));
  const path = join(dir, 'out.fgb');
  writeFileSync(path, Buffer.from(written));
  return { ...result, path };
}

test('flatgeobuf format: Point layer -- ogrinfo reads it cleanly, feature count/geometry/CRS/attributes correct', async () => {
  const schema = [{ name: 'name', type: 'string' }, { name: 'pop', type: 'int32' }, { name: 'geometry', type: 'geometry' }];
  const batch = {
    rows: 2,
    columns: { name: ['Vaduz', 'Schaan'], pop: [5696, 6162] },
    geometry: [wkbPoint(9.5215, 47.141), wkbPoint(9.5064, 47.1662)],
  };
  const { rows, path } = await writeToTmpFile([batch], { schema });
  assert.equal(rows, 2);

  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', '-so', path]).toString();
    assert.match(out, /using driver `FlatGeobuf' successful/);
    assert.match(out, /Geometry: Point/);
    assert.match(out, /Feature Count: 2/);
    assert.match(out, /EPSG",4326/);
  }
  if (HAS_DUCKDB) {
    // flatgeobuf's GeoJSON serializer infers a column's FlatGeobuf schema
    // type from the sampled JS values, and GeoJSON itself makes no
    // int/float distinction -- `pop` round-trips as a double (6162.0),
    // not an integer. Honest behavior of the wrapped package, not a bug
    // in this plugin; documented in README.md's "what you give up" list.
    const csv = execFileSync('duckdb', ['-csv', '-c', `INSTALL spatial; LOAD spatial; SELECT name, pop, ST_AsText(geom) FROM ST_Read('${path}') ORDER BY name;`]).toString().trim().split('\n');
    assert.deepEqual(csv.slice(1), ['Schaan,6162.0,POINT (9.5064 47.1662)', 'Vaduz,5696.0,POINT (9.5215 47.141)']);
  }
});

test('flatgeobuf format: MultiPolygon layer -- geometry decoded correctly', async () => {
  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      [[[10, 10], [11, 10], [11, 11], [10, 10]]],
    ],
  };
  const schema = [{ name: 'name', type: 'string' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 1, columns: { name: ['two-parts'] }, geometry: [multi] };
  const { path } = await writeToTmpFile([batch], { schema });

  if (HAS_DUCKDB) {
    const csv = execFileSync('duckdb', ['-csv', '-c', `INSTALL spatial; LOAD spatial; SELECT ST_NumGeometries(geom) FROM ST_Read('${path}');`]).toString().trim().split('\n');
    assert.equal(csv[1], '2');
  }
});

test('flatgeobuf format: a non-4326 crs is refused with FORMAT_CAPABILITY', async () => {
  const format = createFlatGeobufFormat(flatgeobufGeojson);
  const ctx = {
    writer: { write: () => {}, close: async () => {} },
    schema: [{ name: 'geometry', type: 'geometry' }],
    geometryColumn: 'geometry',
    crs: 'EPSG:3857',
    options: {},
    attribution: [],
  };
  await assert.rejects(format.open(ctx), (err) => {
    assert.equal(err.code, 'FORMAT_CAPABILITY');
    return true;
  });
});

test('(environment check) ogrinfo and duckdb are both available, so the assertions above actually ran', () => {
  assert.equal(HAS_OGRINFO, true, 'ogrinfo not found -- flatgeobuf validation was skipped, not actually run');
  assert.equal(HAS_DUCKDB, true, 'duckdb not found -- flatgeobuf validation was skipped, not actually run');
});
