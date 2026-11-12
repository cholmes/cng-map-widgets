import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCsvFormat } from '../src/csv.js';

function hasCli(bin, args = ['--version']) {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
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

async function writeCsv(batches, options = {}) {
  const format = createCsvFormat();
  let text = '';
  const encoderChunks = [];
  const ctx = {
    writer: { write: (buf) => { encoderChunks.push(buf); }, close: async () => {} },
    schema: options.schema ?? [],
    geometryColumn: 'geometry',
    crs: 'EPSG:4326',
    options: options.options ?? {},
    attribution: [],
  };
  const writer = await format.open(ctx);
  for (const batch of batches) await writer.writeBatch(batch);
  const result = await writer.close();
  text = Buffer.concat(encoderChunks.map((c) => Buffer.from(c))).toString('utf8');
  return { ...result, text };
}

test('csv format: header written immediately in open(), rows streamed, WKT geometry column appended', async () => {
  const schema = [{ name: 'name', type: 'string' }, { name: 'pop', type: 'int32' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 2, columns: { name: ['Vaduz', 'Schaan'], pop: [5696, 6162] }, geometry: [wkbPoint(9.5215, 47.141), wkbPoint(9.5064, 47.1662)] };
  const { rows, text } = await writeCsv([batch], { schema });
  assert.equal(rows, 2);
  const lines = text.trim().split('\r\n');
  assert.equal(lines[0], 'name,pop,wkt');
  assert.equal(lines[1], 'Vaduz,5696,POINT (9.5215 47.141)');
  assert.equal(lines[2], 'Schaan,6162,POINT (9.5064 47.1662)');
});

test('csv format: a value containing the delimiter or a quote is RFC4180-escaped, not corrupted', async () => {
  const schema = [{ name: 'note', type: 'string' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 1, columns: { note: ['has, a comma and "quotes"'] }, geometry: [null] };
  const { text } = await writeCsv([batch], { schema });
  const lines = text.trim().split('\r\n');
  assert.equal(lines[1], '"has, a comma and ""quotes""",');
});

test('csv format: { geometry: "drop" } omits the wkt column entirely', async () => {
  const schema = [{ name: 'name', type: 'string' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 1, columns: { name: ['x'] }, geometry: [wkbPoint(0, 0)] };
  const { text } = await writeCsv([batch], { schema, options: { geometry: 'drop' } });
  const lines = text.trim().split('\r\n');
  assert.equal(lines[0], 'name');
  assert.equal(lines[1], 'x');
});

test('csv format: duckdb reads the file back and the WKT parses to the right geometry', { skip: !HAS_DUCKDB && 'duckdb not installed' }, async () => {
  const schema = [{ name: 'name', type: 'string' }, { name: 'geometry', type: 'geometry' }];
  const batch = { rows: 1, columns: { name: ['Vaduz'] }, geometry: [wkbPoint(9.5215, 47.141)] };
  const { text } = await writeCsv([batch], { schema });
  const dir = mkdtempSync(join(tmpdir(), 'cnmw-csv-'));
  const path = join(dir, 'out.csv');
  writeFileSync(path, text);
  const out = execFileSync('duckdb', ['-csv', '-c', `INSTALL spatial; LOAD spatial; SELECT name, ST_AsText(ST_GeomFromText(wkt)) FROM read_csv('${path}');`]).toString().trim();
  assert.equal(out.split('\n')[1], 'Vaduz,POINT (9.5215 47.141)');
});
