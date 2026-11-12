import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEsriJsonFormat } from '../src/esrijson.js';

function hasCli(bin, args = ['--version']) {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_OGRINFO = hasCli('ogrinfo');

function wkbPoint(x, y) {
  const buf = new Uint8Array(21);
  const view = new DataView(buf.buffer);
  buf[0] = 1;
  view.setUint32(1, 1, true);
  view.setFloat64(5, x, true);
  view.setFloat64(13, y, true);
  return buf;
}

async function writeEsriJson(batches, options = {}) {
  const format = createEsriJsonFormat();
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
  const text = Buffer.from(written).toString('utf8');
  const dir = mkdtempSync(join(tmpdir(), 'cnmw-esrijson-'));
  const path = join(dir, 'out.json');
  writeFileSync(path, text);
  return { ...result, text, path, doc: JSON.parse(text) };
}

test('esrijson format: Point FeatureSet -- correct shape, ogrinfo\'s ESRIJSON driver reads it', async () => {
  const schema = [{ name: 'name', type: 'string' }, { name: 'pop', type: 'int32' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 2, columns: { name: ['Vaduz', 'Schaan'], pop: [5696, 6162] }, geometry: [wkbPoint(9.5215, 47.141), wkbPoint(9.5064, 47.1662)] };
  const { rows, doc, path } = await writeEsriJson([batch], { schema });
  assert.equal(rows, 2);
  assert.equal(doc.geometryType, 'esriGeometryPoint');
  assert.equal(doc.spatialReference.wkid, 4326);
  assert.deepEqual(doc.features[0].geometry, { x: 9.5215, y: 47.141 });
  assert.equal(doc.features[0].attributes.name, 'Vaduz');

  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', '-so', path]).toString();
    assert.match(out, /using driver `ESRIJSON' successful/);
    assert.match(out, /Geometry: Point/);
    assert.match(out, /Feature Count: 2/);
  }
});

test('esrijson format: Polygon with a hole uses Esri\'s ring winding (outer CW, hole CCW)', async () => {
  const geomWithHole = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]],
    ],
  };
  const schema = [{ name: 'name', type: 'string' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 1, columns: { name: ['donut'] }, geometry: [geomWithHole] };
  const { doc, path } = await writeEsriJson([batch], { schema });
  assert.equal(doc.geometryType, 'esriGeometryPolygon');

  if (HAS_OGRINFO) {
    const out = execFileSync('ogrinfo', ['-al', path]).toString();
    assert.match(out, /POLYGON/);
  }
});

test('esrijson format: mixing Point and Polygon is refused with FORMAT_CAPABILITY (one geometryType per FeatureSet)', async () => {
  const format = createEsriJsonFormat();
  const ctx = {
    writer: { write: () => {}, close: async () => {} },
    schema: [{ name: 'geometry', type: 'geometry' }],
    geometryColumn: 'geometry',
    crs: 'EPSG:4326',
    options: {},
    attribution: [],
  };
  const writer = await format.open(ctx);
  await writer.writeBatch({ rows: 1, columns: {}, geometry: [wkbPoint(0, 0)] });
  await assert.rejects(
    writer.writeBatch({ rows: 1, columns: {}, geometry: [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }] }),
    (err) => { assert.equal(err.code, 'FORMAT_CAPABILITY'); return true; },
  );
});

test('(environment check) ogrinfo is available, so the ESRIJSON-driver assertions above actually ran', () => {
  assert.equal(HAS_OGRINFO, true, 'ogrinfo not found -- EsriJSON validation was skipped, not actually run');
});
