// @cngeo/extract-core -- live check for GitHub issue #4 (run by hand, not
// part of `npm test`: it reads data.source.coop).
//
//   node packages/extract-core/test/stac-roundtrip.verify.mjs
//
// Downloads a slice of the live Sentinel-2 STAC-GeoParquet catalog to
// GeoParquet through the real `download()`, then reads the result back
// with hyparquet and (when available) DuckDB, and fails unless the nested
// STAC columns are still native structs/lists and the bytes reached the
// sink in more than one write.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import * as writer from 'hyparquet-writer';
import { setHyparquetModules, resolveDataset, download } from '../src/index.js';
import { areaFromGeoJson } from '../../upload-core/src/index.js';

setHyparquetModules({ hyparquet, compressors, writer });

const dataset = await resolveDataset({
  spec: 'cng-dataset/1.0',
  id: 'sentinel-2-c1-l2a',
  source: { kind: 'portolan-collection', url: 'https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json' },
});

// Nairobi and the country around it.
const { area } = await areaFromGeoJson(
  { type: 'Polygon', coordinates: [[[36.0, -2.0], [38.0, -2.0], [38.0, 0.0], [36.0, 0.0], [36.0, -2.0]]] },
  { name: 'nairobi.geojson' },
);

const filter = {
  spec: 'cng-filter/1.0',
  area: { ref: 'area' },
  spatial: { mode: 'intersects' },
  time: { start: '2025-06-01T00:00:00Z', end: '2025-06-15T00:00:00Z', closed: '[)' },
  columns: { include: ['id', 'datetime', 'eo:cloud_cover', 'bbox', 'assets', 'links', 'stac_extensions'] },
};

// A recording sink: how many writes, and all the bytes.
const chunks = [];
const sink = {
  kind: 'memory',
  chunks,
  async open() {
    return { write: async (c) => void chunks.push(c) };
  },
  async close() {},
  async abort() {},
};

const output = { spec: 'cng-output/1.0', format: 'geoparquet', options: { rowGroupSize: 10 } };
const result = await download(dataset, area, filter, output, { sink }).result;
console.log(`downloaded ${result.rows} rows, ${result.bytes.toLocaleString()} bytes in ${chunks.length} writes`);
assert.ok(result.rows > 10, `need more than one row group of rows to prove streaming, got ${result.rows}`);
assert.ok(chunks.length > 2, 'bytes must reach the sink in more than one write');

const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
let o = 0;
for (const c of chunks) {
  bytes.set(c, o);
  o += c.byteLength;
}
assert.equal(bytes.byteLength, result.bytes);

const file = bytes.buffer;
const metadata = await hyparquet.parquetMetadataAsync(file, { geoparquet: false });
const tree = hyparquet.parquetSchema(metadata);
const cols = new Map(tree.children.map((c) => [c.element.name, c.element]));
console.log(`row groups: ${metadata.row_groups.length}`);
assert.ok(metadata.row_groups.length > 1);
// The nested columns of THIS catalog: `links` is list<struct>, `bbox` is
// list<double>, `stac_extensions` is list<string>. (`assets` here is a
// plain string column at the source -- the upstream object as JSON text --
// so it must stay a string; it is not a nested type to preserve.)
for (const name of ['links', 'bbox', 'stac_extensions']) {
  const el = cols.get(name);
  assert.ok(el, `missing column ${name}`);
  assert.ok(el.num_children > 0 && el.type === undefined, `${name} is a ${el.type ?? 'group'}/${el.converted_type ?? '-'}, expected a native group`);
  assert.equal(el.converted_type, 'LIST');
  console.log(`ok: ${name} is a native LIST group`);
}
assert.equal(cols.get('assets').type, 'BYTE_ARRAY');
assert.equal(cols.get('assets').converted_type, 'UTF8', 'a source string column stays a string');

const rows = await hyparquet.parquetReadObjects({ file, metadata, compressors, utf8: false });
const first = rows[0];
assert.ok(Array.isArray(first.links) && typeof first.links[0] === 'object' && typeof first.links[0].href === 'string');
assert.ok(Array.isArray(first.bbox) && first.bbox.length === 4 && first.bbox.every((v) => typeof v === 'number'));
assert.ok(Array.isArray(first.stac_extensions));
assert.equal(typeof first.assets, 'string');
console.log(`ok: first row has ${first.links.length} links, bbox [${first.bbox.map((v) => v.toFixed(2)).join(', ')}], ${first.stac_extensions.length} extensions`);

// The time filter is per row now: nothing outside the window.
for (const r of rows) {
  const t = new Date(r.datetime).getTime();
  assert.ok(t >= Date.parse(filter.time.start) && t < Date.parse(filter.time.end), `row ${r.id} is outside the time window`);
}
console.log('ok: every row is inside the requested time window');

const geo = JSON.parse(metadata.key_value_metadata.find((kv) => kv.key === 'geo').value);
console.log(`covering: ${JSON.stringify(geo.columns[geo.primary_column].covering)}`);

let hasDuckdb = true;
try {
  execFileSync('duckdb', ['-c', 'SELECT 1'], { stdio: 'ignore' });
} catch {
  hasDuckdb = false;
}
if (hasDuckdb) {
  const dir = mkdtempSync(join(tmpdir(), 'cng-stac-roundtrip-'));
  const path = join(dir, 'out.parquet');
  writeFileSync(path, bytes);
  try {
    const out = execFileSync('duckdb', ['-csv', '-c', `SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM '${path}') WHERE column_name IN ('links','stac_extensions','bbox');`]).toString();
    console.log(out.trim());
    for (const line of out.trim().split('\n').slice(1)) {
      assert.ok(!/,VARCHAR$|,JSON$|,BLOB$/.test(line), `DuckDB sees a string where a nested type belongs: ${line}`);
    }
    const n = execFileSync('duckdb', ['-csv', '-c', `SELECT count(*) FROM '${path}' WHERE len(links) > 0;`]).toString().trim().split('\n').pop();
    assert.equal(Number(n), result.rows);
    console.log('ok: DuckDB reads the nested columns as STRUCT/LIST');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log('(duckdb not found: skipped the independent-reader check)');
}

console.log('\nSTAC-GeoParquet round-trip verified.');
