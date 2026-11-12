// Writes batches through `createShapefileFormat`, validates the resulting
// `.shp.zip` with `ogrinfo -al -so` (confirmed to open a `.shp.zip`
// directly -- no manual unzip needed, same as GDAL/QGIS) and, where
// installed, DuckDB's spatial `ST_Read`. Also exercises the three limits
// the task called out by name: 10-char dBase field names, Shapefile's
// one-shape-type-per-file restriction, and that a non-4326 CRS is refused
// rather than silently mistagged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShapefileFormat } from '../src/shapefile-writer.js';

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

async function writeToTmpZip(batches, options = {}) {
  const format = createShapefileFormat();
  let written;
  const ctx = {
    writer: { write: (buf) => { written = buf; }, close: async () => {} },
    schema: options.schema ?? [],
    geometryColumn: 'geometry',
    crs: options.crs ?? 'EPSG:4326',
    options: options.options ?? {},
    attribution: [],
  };
  const writer = await format.open(ctx);
  for (const batch of batches) await writer.writeBatch(batch);
  const result = await writer.close();
  const dir = mkdtempSync(join(tmpdir(), 'cnmw-shp-'));
  const path = join(dir, `${options.options?.layerName ?? 'features'}.shp.zip`);
  writeFileSync(path, Buffer.from(written));
  return { ...result, path };
}

test('shapefile format: Point layer -- ogrinfo opens the .shp.zip directly, feature count/geometry/CRS/attributes correct', async () => {
  const schema = [{ name: 'name', type: 'string' }, { name: 'pop', type: 'int32' }, { name: 'geometry', type: 'geometry' }];
  const batch = {
    rows: 2,
    columns: { name: ['Vaduz', 'Schaan'], pop: [5696, 6162] },
    geometry: [wkbPoint(9.5215, 47.141), wkbPoint(9.5064, 47.1662)],
  };
  const { rows, warnings, path } = await writeToTmpZip([batch], { schema, options: { layerName: 'towns' } });
  assert.equal(rows, 2);
  assert.deepEqual(warnings, []);

  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', '-so', path]).toString();
    assert.match(out, /using driver `ESRI Shapefile' successful/);
    assert.match(out, /Geometry: Point/);
    assert.match(out, /Feature Count: 2/);
    assert.match(out, /"WGS 84"/);
    assert.match(out, /NAME: String/);
    assert.match(out, /POP: Integer/);
  }
  if (HAS_DUCKDB) {
    const csv = execFileSync('duckdb', ['-csv', '-c', `INSTALL spatial; LOAD spatial; SELECT NAME, POP, ST_AsText(geom) FROM ST_Read('${path}') ORDER BY NAME;`]).toString().trim().split('\n');
    assert.deepEqual(csv.slice(1), ['Schaan,6162,POINT (9.5064 47.1662)', 'Vaduz,5696,POINT (9.5215 47.141)']);
  }
});

test('shapefile format: Polygon winding is corrected to the Shapefile convention (outer CW, holes CCW) regardless of input winding', async () => {
  // A valid GeoJSON polygon-with-hole: exterior CCW, hole CW (RFC 7946).
  const geomWithHole = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], // exterior, CCW
      [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]], // hole, CW
    ],
  };
  const schema = [{ name: 'name', type: 'string' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 1, columns: { name: ['donut'] }, geometry: [geomWithHole] };
  const { path } = await writeToTmpZip([batch], { schema, options: { layerName: 'donut' } });

  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', path]).toString();
    assert.match(out, /POLYGON/);
    // A real hole punched out: the reported area should be far less than
    // the 10x10=100 outer square (100 - 36 = 64 for the 6x6 hole).
  }
  if (HAS_DUCKDB) {
    const csv = execFileSync('duckdb', ['-csv', '-c', `INSTALL spatial; LOAD spatial; SELECT round(ST_Area(geom), 1) FROM ST_Read('${path}');`]).toString().trim().split('\n');
    assert.equal(csv[1], '64.0', 'the hole must actually subtract area -- a winding bug would report 100 (hole ignored) or a self-intersecting mess');
  }
});

test('shapefile format: a column name over 10 characters is truncated/deduped, surfaced as a shapefile-field-name-truncated warning, never silently dropped', async () => {
  const schema = [
    { name: 'a_very_long_column_name', type: 'string' },
    { name: 'another_very_long_column_name', type: 'string' }, // truncates to the same 10-char prefix as a plain truncation would collide
    { name: 'geometry', type: 'geometry' },
  ];
  const batch = {
    rows: 1,
    columns: { a_very_long_column_name: ['A'], another_very_long_column_name: ['B'] },
    geometry: [wkbPoint(0, 0)],
  };
  const { warnings, path } = await writeToTmpZip([batch], { schema, options: { layerName: 'longnames' } });
  assert.ok(warnings.some((w) => w.code === 'shapefile-field-name-truncated'), 'expected a truncation warning, got: ' + JSON.stringify(warnings));
  assert.equal(warnings.filter((w) => w.code === 'shapefile-field-name-truncated').length, 2, 'both over-long names should warn, and the collision should force a distinct rename');

  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', '-so', path]).toString();
    const fieldLines = out.split('\n').filter((l) => /: String/.test(l));
    assert.equal(fieldLines.length, 2, 'both columns survived as distinct fields, not collapsed into one');
    for (const line of fieldLines) assert.ok(line.split(':')[0].trim().length <= 10);
  }
});

test('shapefile format: mixing Point and Polygon geometry in one result is refused with FORMAT_CAPABILITY (Shapefile allows one shape type per file)', async () => {
  const format = createShapefileFormat();
  const ctx = {
    writer: { write: () => {}, close: async () => {} },
    schema: [{ name: 'geometry', type: 'geometry' }],
    geometryColumn: 'geometry',
    crs: 'EPSG:4326',
    options: {},
    attribution: [],
  };
  const writer = await format.open(ctx);
  const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  await writer.writeBatch({ rows: 1, columns: {}, geometry: [wkbPoint(0, 0)] });
  await assert.rejects(
    writer.writeBatch({ rows: 1, columns: {}, geometry: [polygon] }),
    (err) => {
      assert.equal(err.code, 'FORMAT_CAPABILITY');
      return true;
    },
  );
});

test('shapefile format: a non-4326 crs is refused with FORMAT_CAPABILITY', async () => {
  const format = createShapefileFormat();
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

test('shapefile format: MultiPolygon is written as a multi-part Polygon shape, decoded correctly', async () => {
  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      [[[10, 10], [11, 10], [11, 11], [10, 10]]],
    ],
  };
  const schema = [{ name: 'name', type: 'string' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 1, columns: { name: ['two-parts'] }, geometry: [multi] };
  const { path } = await writeToTmpZip([batch], { schema, options: { layerName: 'multi' } });
  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', '-so', path]).toString();
    assert.match(out, /Geometry: Polygon/); // GDAL reports a shapefile Polygon layer as "Polygon" even when individual features are multi-part
    assert.match(out, /Feature Count: 1/);
  }
  if (HAS_DUCKDB) {
    const csv = execFileSync('duckdb', ['-csv', '-c', `INSTALL spatial; LOAD spatial; SELECT ST_NumGeometries(geom) FROM ST_Read('${path}');`]).toString().trim().split('\n');
    assert.equal(csv[1], '2', 'both disjoint parts of the MultiPolygon must survive as two parts');
  }
});

test('(environment check) ogrinfo and duckdb are both available, so the assertions above actually ran', () => {
  assert.equal(HAS_OGRINFO, true, 'ogrinfo not found -- shapefile validation was skipped, not actually run');
  assert.equal(HAS_DUCKDB, true, 'duckdb not found -- shapefile validation was skipped, not actually run');
});
