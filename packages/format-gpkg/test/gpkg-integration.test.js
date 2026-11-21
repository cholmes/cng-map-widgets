// Real end-to-end integration test (the one network-touching test this
// package allows, same policy as download-core/test/integration.test.js):
// download the FTW Liechtenstein field-boundary slice -- the project's
// established small-live-fixture -- straight to a .gpkg file through
// @cngeo/download-core's real `download()` pipeline (resolveDataset ->
// estimate -> hyparquet engine -> this package's `gpkg` FormatWriter),
// then validate the file with `ogrinfo -al -so` and DuckDB's `ST_Read`,
// asserting both attributes AND geometry.
//
// Skips cleanly (not a failure) if the network or `duckdb`/`ogrinfo` are
// unavailable, same policy as download-core's own integration test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { download, registerFormat, setHyparquetModules } from '@cngeo/download-core';
import { initializedSqlJs } from './helpers/sqljs-setup.js';
import { createGpkgFormat } from '../src/gpkg-writer.js';
import { memorySink } from '@cngeo/download-core';

setHyparquetModules({ hyparquet, compressors });

const LI_URL =
  'https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=LI/Liechtenstein.parquet';

const DATASET = {
  spec: 'cng-dataset/1.0',
  id: 'ftw-fields-li',
  title: 'FTW field boundaries — Liechtenstein',
  source: { kind: 'parquet', url: LI_URL },
  table: {
    geometryColumn: 'geometry',
    geometryEncoding: 'WKB',
    crs: 'OGC:CRS84',
    bbox: { kind: 'struct', column: 'bbox' },
    columns: [
      { name: 'id', type: 'string' },
      { name: 'geometry', type: 'geometry' },
      { name: 'confidence', type: 'float32' },
    ],
  },
  attribution: [{ text: 'Fields of The World', license: 'CC-BY-4.0', shareAlike: false }],
};

let networkOk = true;
try {
  const res = await fetch(LI_URL, { method: 'HEAD' });
  networkOk = res.ok;
} catch {
  networkOk = false;
}

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

test(
  'download() the live Liechtenstein FTW slice straight to .gpkg -- ogrinfo + duckdb validate attributes and geometry',
  { skip: (!networkOk && 'no network access') || (!HAS_OGRINFO && 'ogrinfo not installed') || (!HAS_DUCKDB && 'duckdb not installed') },
  async () => {
    const SQL = await initializedSqlJs;
    registerFormat(createGpkgFormat(SQL));

    const filter = {
      spec: 'cng-filter/1.0',
      spatial: { mode: 'bbox' },
      where: [{ col: 'confidence', op: '>=', value: 0.5 }],
      limit: 100,
    };
    const output = { spec: 'cng-output/1.0', format: 'gpkg', filename: 'li-fields.gpkg', options: { layerName: 'fields' } };
    const sink = memorySink();
    const handle = download(DATASET, null, filter, output, { sink });

    const est = await handle.estimate;
    assert.ok(est.readBytes.estimate < 5 * 1024 * 1024, 'this test is required to stay under a 5MB read');

    const result = await handle.result;
    assert.equal(handle.state, 'done');
    assert.equal(result.rows, 100);
    assert.equal(result.format, 'gpkg');

    const buf = Buffer.concat(sink.chunks.map((c) => Buffer.from(c)));
    const dir = mkdtempSync(join(tmpdir(), 'cng-gpkg-integration-'));
    const path = join(dir, 'li-fields.gpkg');
    writeFileSync(path, buf);

    const ogrOut = execFileSync('ogrinfo', ['-al', '-so', path]).toString();
    assert.match(ogrOut, /using driver `GPKG' successful/);
    assert.match(ogrOut, /Feature Count: 100/);
    assert.match(ogrOut, /Geometry: (Polygon|Multi Polygon)/);
    assert.match(ogrOut, /EPSG",4326/);
    assert.match(ogrOut, /confidence: Real/);

    // Attributes: every row's confidence satisfies the filter, as a real
    // value (not dropped/mis-typed) -- read back via duckdb's ST_Read.
    const confCsv = execFileSync('duckdb', [
      '-csv', '-c',
      `INSTALL spatial; LOAD spatial; SELECT min(confidence), count(*) FILTER (WHERE confidence < 0.5) FROM ST_Read('${path}', layer='fields');`,
    ]).toString().trim().split('\n')[1];
    const [minConf, belowThreshold] = confCsv.split(',');
    assert.ok(Number(minConf) >= 0.5, `expected every row's confidence >= 0.5, min was ${minConf}`);
    assert.equal(belowThreshold, '0');

    // Geometry: every row has real, non-degenerate polygon area, and the
    // layer's geometry type matches what ogrinfo reported.
    const geomCsv = execFileSync('duckdb', [
      '-csv', '-c',
      `INSTALL spatial; LOAD spatial; SELECT count(*) FILTER (WHERE ST_Area(geom) > 0), count(DISTINCT ST_GeometryType(geom)) FROM ST_Read('${path}', layer='fields');`,
    ]).toString().trim().split('\n')[1];
    const [positiveArea, distinctTypes] = geomCsv.split(',');
    assert.equal(positiveArea, '100', 'every one of the 100 rows should have positive polygon area');
    assert.ok(Number(distinctTypes) <= 2, 'at most POLYGON and MULTIPOLYGON, no decode corruption producing something else');
  },
);
