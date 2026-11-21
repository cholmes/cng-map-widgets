// Integration test: a real, tiny remote parquet slice (FTW field
// boundaries for Liechtenstein -- 795 rows, 218 KB on disk, chosen because
// it is the smallest real dataset of this shape we could find: the
// Netherlands worked example from the design doc is 246 MB / 8 row
// groups, far too large to fetch in a test). Exercises resolveDataset ->
// estimate -> download end to end against data.source.coop, and validates
// the GeoJSON output; also writes GeoParquet and validates it with the
// local `duckdb` CLI when available.
//
// Requires network access to data.source.coop. If that is unavailable
// (offline CI, sandboxed run), the whole file is skipped rather than
// failing noisily -- this is deliberately the *one* test allowed to touch
// the network (per the task's integration-test requirement); everything
// else in this package is a pure unit test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import './helpers/hyparquet-setup.js';
import { estimate, download } from '../src/index.js';
import { memorySink } from '../src/sinks.js';

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

function hasDuckdb() {
  try {
    execFileSync('duckdb', ['-c', 'SELECT 1'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('estimate() against the real Liechtenstein file reports honest, metadata-only numbers', { skip: !networkOk && 'no network access' }, async () => {
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' }, where: [{ col: 'confidence', op: '>=', value: 0.5 }] };
  const est = await estimate(DATASET, null, filter);

  assert.equal(est.readBytes.exact, true); // metadata-derived column-chunk bytes (O12)
  assert.ok(est.readBytes.estimate > 0);
  assert.ok(est.readBytes.estimate < 5 * 1024 * 1024, `expected a small read for a 218KB file, got ${est.readBytes.estimate} bytes`);
  assert.equal(est.rowGroups.total, 1);
  assert.equal(est.rowGroups.selected, 1);
  assert.ok(est.warnings.some((w) => w.code === 'single-row-group'));
  assert.equal(est.ceiling.exceeded, false);
  assert.ok(est.rows.max <= 795);
});

test(
  'download() the Liechtenstein file to GeoJSON: a real, tiny (<5MB read) remote download, validated output',
  { skip: !networkOk && 'no network access' },
  async () => {
    const filter = {
      spec: 'cng-filter/1.0',
      spatial: { mode: 'bbox' },
      where: [{ col: 'confidence', op: '>=', value: 0.5 }],
      limit: 50,
    };
    const output = { spec: 'cng-output/1.0', format: 'geojson', filename: 'li-fields.geojson' };
    const sink = memorySink();
    const handle = download(DATASET, null, filter, output, { sink });

    const est = await handle.estimate;
    assert.ok(est.readBytes.estimate < 5 * 1024 * 1024, 'this test is required to stay under a 5MB read');

    const result = await handle.result;
    assert.equal(handle.state, 'done');
    assert.equal(result.rows, 50);
    assert.equal(result.truncated, true); // hit the `limit`
    assert.ok(result.readBytes > 0);
    assert.ok(result.readBytes < 5 * 1024 * 1024);

    const text = Buffer.concat(sink.chunks.map((c) => Buffer.from(c))).toString('utf8');
    const parsed = JSON.parse(text);
    assert.equal(parsed.type, 'FeatureCollection');
    assert.equal(parsed.features.length, 50);
    for (const feature of parsed.features) {
      assert.equal(feature.type, 'Feature');
      assert.ok(feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon');
      assert.ok(feature.geometry.coordinates.length > 0);
      assert.ok(typeof feature.properties.confidence === 'number');
      assert.ok(feature.properties.confidence >= 0.5);
    }
  },
);

test(
  'download() the Liechtenstein file to GeoParquet: valid output readable by the duckdb CLI',
  { skip: !networkOk ? 'no network access' : !hasDuckdb() && 'duckdb CLI not installed' },
  async () => {
    const filter = {
      spec: 'cng-filter/1.0',
      spatial: { mode: 'bbox' },
      where: [{ col: 'confidence', op: '>=', value: 0.5 }],
      limit: 100,
    };
    const output = { spec: 'cng-output/1.0', format: 'geoparquet', filename: 'li-fields.parquet' };
    const sink = memorySink();
    const handle = download(DATASET, null, filter, output, { sink });
    const result = await handle.result;
    assert.equal(result.rows, 100);

    const buf = Buffer.concat(sink.chunks.map((c) => Buffer.from(c)));
    const tmpPath = `/tmp/cng-extract-core-test-${process.pid}.parquet`;
    writeFileSync(tmpPath, buf);
    try {
      const countOut = execFileSync('duckdb', ['-csv', '-c', `SELECT count(*) FROM '${tmpPath}';`]).toString().trim();
      assert.equal(countOut.split('\n').pop(), '100');

      // Validate it's real, spatially-correct GeoParquet: load the
      // spatial extension and read geometry + the bbox covering columns
      // this plugin writes, confirming they agree with the actual geometry.
      const spatialOut = execFileSync('duckdb', [
        '-csv',
        '-c',
        `INSTALL spatial; LOAD spatial; SELECT count(*) FILTER (WHERE abs(bbox_xmin - ST_XMin(geometry)) < 1e-9) FROM '${tmpPath}';`,
      ]).toString().trim();
      assert.equal(spatialOut.split('\n').pop(), '100');

      const geoMetaOut = execFileSync('duckdb', ['-csv', '-c', `SELECT value FROM parquet_kv_metadata('${tmpPath}') WHERE key = 'geo';`]).toString();
      assert.match(geoMetaOut, /encoding.*WKB/);
      assert.match(geoMetaOut, /covering/);
    } finally {
      unlinkSync(tmpPath);
    }
  },
);
