// Item 7: `FormatPlugin.estimateBytes(schema, rows, ctx)` -- the additive
// third argument carrying the dataset's own average geometry bytes per
// row, and the path that number takes from parquet footer statistics into
// `Estimate.outputBytes` and both ceiling checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/hyparquet-setup.js';
import { createGeoJsonFormat, estimateGeoJsonBytes } from '../src/formats/geojson.js';
import { createGeoParquetFormat, estimateGeoParquetBytes } from '../src/formats/geoparquet.js';
import { avgColumnBytesPerRow } from '../src/prune.js';
import { download } from '../src/download.js';
import { memorySink } from '../src/sinks.js';
import { openFakeHostedParquet, enginePlanFor } from './helpers/fake-parquet-host.js';

const SCHEMA = [{ name: 'id', type: 'string' }, { name: 'confidence', type: 'float32' }, { name: 'geometry', type: 'geometry' }];
const ROWS = { min: 0, max: 1000, estimate: 800, exact: false };

// --- avgColumnBytesPerRow: the footer-metadata half --------------------

function rg(index, numRows, cols) {
  const columns = new Map();
  for (const [path, [comp, uncomp]] of Object.entries(cols)) {
    columns.set(path, { statistics: undefined, totalCompressedSize: comp, totalUncompressedSize: uncomp });
  }
  return { index, rowStart: index * numRows, rowEnd: index * numRows + numRows, numRows, columns };
}

test('avgColumnBytesPerRow uses UNCOMPRESSED size, so the model does not depend on the source codec', () => {
  const groups = [rg(0, 100, { geometry: [1_000, 50_000] }), rg(1, 100, { geometry: [2_000, 70_000] })];
  // (50_000 + 70_000) / 200 rows, not (1_000 + 2_000) / 200
  assert.equal(avgColumnBytesPerRow(groups, 'geometry'), 600);
});

test('avgColumnBytesPerRow sums a struct geometry column\'s leaf chunks under its top-level name', () => {
  const groups = [rg(0, 10, { 'geometry.x': [1, 100], 'geometry.y': [1, 100], other: [1, 9999] })];
  assert.equal(avgColumnBytesPerRow(groups, 'geometry'), 20);
});

test('avgColumnBytesPerRow returns null when the column is absent or the groups hold no rows', () => {
  assert.equal(avgColumnBytesPerRow([rg(0, 100, { other: [1, 2] })], 'geometry'), null);
  assert.equal(avgColumnBytesPerRow([], 'geometry'), null);
  assert.equal(avgColumnBytesPerRow([rg(0, 0, { geometry: [0, 0] })], 'geometry'), null);
});

// --- the per-format geometry term --------------------------------------

test('geojson estimateBytes adds a geometry term from ctx.avgGeometryBytes', () => {
  const withGeom = estimateGeoJsonBytes(SCHEMA, ROWS, { avgGeometryBytes: 745.2 });
  // 3 cols * 25 + 745.2 * 1.55 + 40 = 75 + 1195.06 = 1270.06 per row
  assert.ok(Math.abs(withGeom.estimate / ROWS.estimate - 1270.06) < 0.5, `got ${withGeom.estimate / ROWS.estimate}/row`);
  assert.equal(withGeom.exact, false);
  // and it is what the measured output needs: 795 FTW rows wrote 963,287
  const ftw = estimateGeoJsonBytes(SCHEMA, { min: 795, max: 795, estimate: 795, exact: true }, { avgGeometryBytes: 745.2 });
  const ratio = ftw.estimate / 963_287;
  assert.ok(ratio > 0.9 && ratio < 1.2, `expected the FTW GeoJSON model within -10%/+20% of the 963,287 bytes written, got ratio ${ratio.toFixed(3)}`);
});

test('geoparquet estimateBytes models geometry 1:1 with the source WKB bytes', () => {
  const e = estimateGeoParquetBytes(SCHEMA, { min: 218, max: 218, estimate: 218, exact: true }, { avgGeometryBytes: 37_094 });
  // CGAZ ADM0: 218 rows, 8,044,920 bytes actually written
  const ratio = e.estimate / 8_044_920;
  assert.ok(ratio > 0.95 && ratio < 1.1, `expected the CGAZ ADM0 GeoParquet model within 10% of what was written, got ${ratio.toFixed(3)}`);
});

test('every shipped format plugin accepts the third argument and is unchanged without it', async () => {
  const extras = await import('../../format-extras/src/index.js');
  const gpkg = await import('../../format-gpkg/src/index.js');
  const shapefile = await import('../../format-shapefile/src/index.js');
  const flatgeobuf = await import('../../format-flatgeobuf/src/index.js');

  /** @type {{ id: string, estimateBytes: Function }[]} */
  const subjects = [
    createGeoJsonFormat(),
    createGeoParquetFormat(),
    extras.createCsvFormat(),
    extras.createEsriJsonFormat(),
    extras.csvFormatDescriptor,
    extras.esriJsonFormatDescriptor,
    gpkg.gpkgFormatDescriptor,
    shapefile.createShapefileFormat(),
    shapefile.shapefileFormatDescriptor,
    flatgeobuf.flatGeobufFormatDescriptor,
  ];

  for (const s of subjects) {
    // 1. Backwards compatible: no ctx at all, no NaN, still a Bounded.
    const bare = s.estimateBytes(SCHEMA, ROWS);
    for (const k of ['min', 'max', 'estimate']) {
      assert.equal(typeof bare[k], 'number', `${s.id}.${k}`);
      assert.ok(Number.isFinite(bare[k]), `${s.id}.${k} must be finite, got ${bare[k]}`);
    }
    assert.equal(bare.exact, false, s.id);
    assert.ok(bare.min <= bare.estimate && bare.estimate <= bare.max, s.id);

    // 2. A null/absent geometry figure behaves exactly like no ctx.
    assert.deepEqual(s.estimateBytes(SCHEMA, ROWS, { avgGeometryBytes: null }), bare, s.id);
    assert.deepEqual(s.estimateBytes(SCHEMA, ROWS, {}), bare, s.id);

    // 3. A real geometry figure moves the number, monotonically.
    const small = s.estimateBytes(SCHEMA, ROWS, { avgGeometryBytes: 100 });
    const big = s.estimateBytes(SCHEMA, ROWS, { avgGeometryBytes: 10_000 });
    assert.ok(big.estimate > small.estimate, `${s.id}: a bigger geometry must model more bytes`);
    assert.ok(big.estimate / small.estimate > 10, `${s.id}: a 100x geometry must dominate the per-row total, got ${(big.estimate / small.estimate).toFixed(1)}x`);
  }
});

test('a lazy descriptor and its loaded plugin model the same bytes', async () => {
  const extras = await import('../../format-extras/src/index.js');
  const shapefile = await import('../../format-shapefile/src/index.js');
  const flatgeobuf = await import('../../format-flatgeobuf/src/index.js');
  const ctx = { avgGeometryBytes: 4_470.5 };
  const pairs = [
    [extras.csvFormatDescriptor, extras.createCsvFormat()],
    [extras.esriJsonFormatDescriptor, extras.createEsriJsonFormat()],
    [shapefile.shapefileFormatDescriptor, shapefile.createShapefileFormat()],
    [flatgeobuf.flatGeobufFormatDescriptor, flatgeobuf.createFlatGeobufFormat({ serialize: () => new Uint8Array() })],
  ];
  for (const [descriptor, plugin] of pairs) {
    assert.deepEqual(descriptor.estimateBytes(SCHEMA, ROWS, ctx), plugin.estimateBytes(SCHEMA, ROWS, ctx), descriptor.id);
  }
});

// --- the whole path, through download() --------------------------------

/** A dataset descriptor over the fake-hosted parquet file, with a declared table. */
function fakeDataset(url, fetchImpl) {
  return {
    dataset: {
      spec: 'cng-dataset/1.0',
      id: 'fake',
      title: 'fake',
      source: { kind: 'parquet', url },
      table: {
        geometryColumn: 'geometry',
        geometryEncoding: 'WKB',
        crs: 'OGC:CRS84',
        bbox: { kind: 'none' },
        columns: [
          { name: 'id', type: 'string' },
          { name: 'n', type: 'int32' },
          { name: 'cat', type: 'string' },
          { name: 'geometry', type: 'geometry' },
        ],
      },
    },
    fetch: fetchImpl,
  };
}

test('the geometry term reaches Estimate.outputBytes through download()', async () => {
  const hosted = await openFakeHostedParquet({ groups: 4, rowsPerGroup: 25 });
  // Reuse the same byte buffer through a fresh range-serving fetch so
  // download() can resolve the dataset itself.
  const { rangeFetch } = await import('./helpers/fake-parquet-host.js');
  const fetchImpl = rangeFetch(hosted.bytes);
  const { dataset } = fakeDataset('https://example.invalid/t.parquet', fetchImpl);

  const seen = [];
  const format = {
    ...createGeoJsonFormat(),
    estimateBytes(schema, rows, ctx) {
      seen.push(ctx);
      return estimateGeoJsonBytes(schema, rows, ctx);
    },
  };
  const { registerFormat } = await import('../src/registry.js');
  registerFormat({ ...format, id: 'geojson-spy' });

  const handle = download(
    dataset,
    null,
    { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } },
    { spec: 'cng-output/1.0', format: 'geojson-spy', filename: 'x.geojson' },
    { sink: memorySink(), fetch: fetchImpl, acceptCeiling: true },
  );
  const est = await handle.estimate;
  await handle.result;

  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0].avgGeometryBytes, 'number');
  assert.ok(seen[0].avgGeometryBytes > 0);
  assert.equal(seen[0].geometryColumn, 'geometry');
  // outputBytes is the format's number, geometry term included -- not the
  // generic fallback model.
  const expected = estimateGeoJsonBytes(
    [
      { name: 'id', type: 'string' },
      { name: 'n', type: 'int32' },
      { name: 'cat', type: 'string' },
      { name: 'geometry', type: 'geometry' },
    ],
    est.rows,
    seen[0],
  );
  assert.deepEqual(est.outputBytes, expected);
});

test('the improved outputBytes is what the outputBytes ceiling checks, for a streaming or a buffering format', async () => {
  const hosted = await openFakeHostedParquet({ groups: 4, rowsPerGroup: 25 });
  const { rangeFetch } = await import('./helpers/fake-parquet-host.js');
  const fetchImpl = rangeFetch(hosted.bytes);
  const { dataset } = fakeDataset('https://example.invalid/t.parquet', fetchImpl);
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };

  // A ceiling just under the geometry-inclusive number must now trip,
  // where the old attribute-only model would have sailed under it.
  const probe = download(dataset, null, filter, { spec: 'cng-output/1.0', format: 'geojson' }, { sink: memorySink(), fetch: fetchImpl, acceptCeiling: true });
  const probeEst = await probe.estimate;
  await probe.result;
  const geomInclusiveMax = probeEst.outputBytes.max;
  const attributesOnlyMax = 4 * 25 * probeEst.rows.max; // what `schema.length * 25` alone would have said
  assert.ok(geomInclusiveMax > attributesOnlyMax, `the geometry term must raise the number: ${geomInclusiveMax} vs ${attributesOnlyMax}`);

  const blocked = download(dataset, null, filter, { spec: 'cng-output/1.0', format: 'geojson' }, {
    sink: memorySink(),
    fetch: fetchImpl,
    ceiling: { outputBytes: attributesOnlyMax },
  });
  const blockedEst = await blocked.estimate;
  assert.ok(blockedEst.ceiling.breaches.includes('outputBytes'));
  await blocked.cancel('done asserting');

  // Same idea for a non-streaming (buffering) format, but through the
  // lever that replaced the old hardcoded `!format.streaming &&
  // outputBytes.max > blobBytes` check download.js used to apply by hand
  // (task 4, design doc §7.3/§7.8): a buffering format's own ceiling is
  // `memoryBudget / memoryFactor`, regardless of sink. `geoparquet`
  // declares `memoryFactor: 2`, so a tiny `memoryBudget` forces a ceiling
  // far below its real output and must breach on `outputBytes` -- there
  // is no separate `blobBytes` breach code to check for anymore.
  const bufferingBlocked = download(dataset, null, filter, { spec: 'cng-output/1.0', format: 'geoparquet' }, {
    sink: memorySink(),
    fetch: fetchImpl,
    ceiling: { memoryBudget: 2_000 }, // -> outputBytes ceiling of floor(2_000 / 2) = 1,000
  });
  const bufferingEst = await bufferingBlocked.estimate;
  assert.ok(bufferingEst.ceiling.breaches.includes('outputBytes'));
  assert.equal(bufferingEst.ceiling.limits.outputBytes, 1_000);
  await bufferingBlocked.cancel('done asserting');
});

test('a dataset whose geometry column has no chunks still estimates (null avgGeometryBytes)', async () => {
  const hosted = await openFakeHostedParquet({ groups: 2, rowsPerGroup: 5 });
  const plan = enginePlanFor({ handle: hosted.handle });
  // No geometry column by that name -> null, and the plugins fall back.
  assert.equal(avgColumnBytesPerRow(plan.plan.perPart[0].selectedRowGroups, 'not_a_column'), null);
  const fallback = estimateGeoJsonBytes(SCHEMA, ROWS, { avgGeometryBytes: null });
  assert.deepEqual(fallback, estimateGeoJsonBytes(SCHEMA, ROWS));
});
