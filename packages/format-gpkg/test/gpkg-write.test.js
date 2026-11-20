// Writes a small multi-type batch (Point + MultiPolygon layers, mixed
// attribute types) through `createGpkgFormat`, then validates the bytes
// the same way download-core's geoparquet-write.test.js validates its
// output: with `ogrinfo -al -so` and, where duckdb is installed, DuckDB's
// spatial `ST_Read`. This is the empirical bar O5 set for the sql.js path
// (design doc O5 / this package's README).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializedSqlJs } from './helpers/sqljs-setup.js';
import { createGpkgFormat } from '../src/gpkg-writer.js';
import { geojsonToWkb } from '../src/wkb.js';

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

async function writeToTmpFile(formatWriterPromiseOrCtx, batches, options = {}) {
  const SQL = await initializedSqlJs;
  const format = createGpkgFormat(SQL);
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
  const { rows, bytes } = await writer.close();
  const dir = mkdtempSync(join(tmpdir(), 'cng-gpkg-'));
  const path = join(dir, 'out.gpkg');
  writeFileSync(path, Buffer.from(written));
  return { rows, bytes, path, written };
}

test('gpkg format: Point layer with string/integer/float attributes -- ogrinfo reads it cleanly, feature count/geometry type/CRS/attributes correct', async () => {
  const schema = [
    { name: 'id', type: 'string' },
    { name: 'pop', type: 'int32' },
    { name: 'area_km2', type: 'float64' },
    { name: 'geometry', type: 'geometry' },
  ];
  const batch = {
    rows: 2,
    columns: {
      id: ['vaduz', 'schaan'],
      pop: [5696, 6162],
      area_km2: [17.3, 26.8],
    },
    geometry: [
      geojsonToWkb({ type: 'Point', coordinates: [9.5215, 47.141] }),
      geojsonToWkb({ type: 'Point', coordinates: [9.5064, 47.1662] }),
    ],
  };

  const { rows, path } = await writeToTmpFile(null, [batch], { schema, options: { layerName: 'towns' } });
  assert.equal(rows, 2);

  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', '-so', path]).toString();
    assert.match(out, /using driver `GPKG' successful/);
    assert.match(out, /Geometry: Point/);
    assert.match(out, /Feature Count: 2/);
    assert.match(out, /"WGS 84"/);
    assert.match(out, /EPSG",4326/);
    assert.match(out, /id: String/);
    assert.match(out, /pop: Integer/);
    assert.match(out, /area_km2: Real/);
  }

  if (HAS_DUCKDB) {
    const csv = execFileSync('duckdb', [
      '-csv', '-c',
      `INSTALL spatial; LOAD spatial; SELECT id, pop, ST_AsText(geom) FROM ST_Read('${path}', layer='towns') ORDER BY id;`,
    ]).toString().trim().split('\n');
    assert.deepEqual(csv.slice(1), [
      'schaan,6162,POINT (9.5064 47.1662)',
      'vaduz,5696,POINT (9.5215 47.141)',
    ]);
  }
});

test('gpkg format: MultiPolygon layer -- geometry decoded correctly, matches input area shape', async () => {
  const schema = [
    { name: 'name', type: 'string' },
    { name: 'geometry', type: 'geometry' },
  ];
  const multiPoly = {
    type: 'MultiPolygon',
    coordinates: [[[[9.5, 47.1], [9.55, 47.1], [9.55, 47.15], [9.5, 47.15], [9.5, 47.1]]]],
  };
  const batch = {
    rows: 1,
    columns: { name: ['Liechtenstein-ish'] },
    geometry: [geojsonToWkb(multiPoly)],
  };

  const { path } = await writeToTmpFile(null, [batch], { schema, options: { layerName: 'areas' } });

  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', path]).toString();
    assert.match(out, /Geometry: Multi Polygon/);
    assert.match(out, /name \(String\) = Liechtenstein-ish/);
    assert.match(out, /MULTIPOLYGON/);
  }

  if (HAS_DUCKDB) {
    const csv = execFileSync('duckdb', [
      '-csv', '-c',
      `INSTALL spatial; LOAD spatial; SELECT ST_Area(geom) > 0, ST_GeometryType(geom) FROM ST_Read('${path}', layer='areas');`,
    ]).toString().trim().split('\n');
    assert.equal(csv[1], 'true,MULTIPOLYGON');
  }
});

test('gpkg format: a null geometry row is preserved as a null geom, not dropped', async () => {
  const schema = [{ name: 'name', type: 'string' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 2, columns: { name: ['has-geom', 'no-geom'] }, geometry: [geojsonToWkb({ type: 'Point', coordinates: [1, 1] }), null] };
  const { rows, path } = await writeToTmpFile(null, [batch], { schema, options: { layerName: 'maybe' } });
  assert.equal(rows, 2);
  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', path]).toString();
    assert.match(out, /Feature Count: 2/);
  }
});

test('gpkg format: a non-4326 crs is refused with FORMAT_CAPABILITY, not silently mis-tagged', async () => {
  const SQL = await initializedSqlJs;
  const format = createGpkgFormat(SQL);
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

test('gpkg format: a source column literally named "geom" or "fid" is renamed, not silently dropped or collided with the geometry/fid columns', async () => {
  const schema = [
    { name: 'fid', type: 'string' }, // collides with GeoPackage's reserved primary key column
    { name: 'geom', type: 'string' }, // collides with our fixed geometry column name
    { name: 'geometry', type: 'geometry' },
  ];
  const batch = { rows: 1, columns: { fid: ['source-fid-value'], geom: ['source-geom-value'] }, geometry: [geojsonToWkb({ type: 'Point', coordinates: [0, 0] })] };
  const { path } = await writeToTmpFile(null, [batch], { schema, options: { layerName: 'collide' } });
  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', path]).toString();
    assert.match(out, /fid_1 \(String\) = source-fid-value/);
    assert.match(out, /geom_1 \(String\) = source-geom-value/);
  }
});

test('(environment check) ogrinfo and duckdb are both available, so the assertions above actually ran', () => {
  assert.equal(HAS_OGRINFO, true, 'ogrinfo not found -- GPKG validation was skipped, not actually run');
  assert.equal(HAS_DUCKDB, true, 'duckdb not found -- GPKG validation was skipped, not actually run');
});
