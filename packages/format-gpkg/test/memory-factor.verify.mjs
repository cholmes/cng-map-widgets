#!/usr/bin/env node
// Measures createGpkgFormat()'s peak-RSS/output-bytes ratio after the
// per-batch-insert restructure (bigger-downloads task 9), using the SAME
// method as the design doc's §1 table
// (docs/superpowers/specs/2026-11-20-bigger-downloads-design.md), so the
// before/after numbers are comparable:
//
//   - one row-count/vertex-count CASE per PROCESS, so the emscripten wasm
//     heap from one case never carries into the next;
//   - process.memoryUsage().rss sampled on a ~20ms interval, peak kept;
//   - synthetic WKB polygons at a fixed vertex count (not GeoJSON --
//     that's the "already WKB" passthrough path writeBatch takes for a
//     real GeoParquet/CGAZ/FTW source, which is the common case this
//     plugin actually serves);
//   - 2,000 rows x {100, 5,000, 20,000} vertices/row.
//
// NOT wired into `npm test` (slow, deliberately spawns subprocesses) --
// run by hand:
//
//   node packages/format-gpkg/test/memory-factor.verify.mjs
//
// It re-execs itself once per case (with --expose-gc, so each case's
// process can force a GC sample right before reporting) and prints the
// per-case ratio plus the measured maximum, which is the number that
// belongs in `memoryFactor` (rounded up to one decimal) on both
// `gpkgFormatDescriptor.capabilities` (src/index.js) and the plugin's
// own `capabilities` (src/gpkg-writer.js).

import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROWS = 2000;
const VERTEX_CASES = [100, 5000, 20000];
const BATCH_SIZE = 250; // several batches per case, so the per-batch insert path is what's actually measured
const SAMPLE_INTERVAL_MS = 20;

const __filename = fileURLToPath(import.meta.url);

function fmtMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A closed ring of `vertexCount` points on a small circle, as raw little-
 * endian WKB Polygon bytes (byte order + type 3 + numRings=1 + numPoints +
 * point pairs) -- not GeoJSON, so no `geojsonToWkb` encode cost is mixed
 * into the measurement.
 * @param {number} vertexCount @param {number} seed
 */
function syntheticPolygonWkb(vertexCount, seed) {
  const n = Math.max(4, vertexCount);
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + n * 16);
  const view = new DataView(buf);
  let offset = 0;
  view.setUint8(offset, 1); offset += 1; // little-endian
  view.setUint32(offset, 3, true); offset += 4; // wkbPolygon
  view.setUint32(offset, 1, true); offset += 4; // numRings
  view.setUint32(offset, n, true); offset += 4; // numPoints
  const cx = (seed % 1000) * 0.01;
  const cy = Math.floor(seed / 1000) * 0.01;
  for (let i = 0; i < n; i++) {
    const t = i === n - 1 ? 0 : (i / (n - 1)) * 2 * Math.PI; // closes the ring: last point === first
    const x = cx + Math.cos(t) * 0.001;
    const y = cy + Math.sin(t) * 0.001;
    view.setFloat64(offset, x, true); offset += 8;
    view.setFloat64(offset, y, true); offset += 8;
  }
  return new Uint8Array(buf);
}

async function runCase(vertices) {
  const { initializedSqlJs } = await import('./helpers/sqljs-setup.js');
  const { createGpkgFormat } = await import('../src/gpkg-writer.js');

  const SQL = await initializedSqlJs;
  const format = createGpkgFormat(SQL);

  let peakRss = 0;
  const sample = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };
  sample();
  const interval = setInterval(sample, SAMPLE_INTERVAL_MS);

  const schema = [{ name: 'id', type: 'string' }, { name: 'geometry', type: 'geometry' }];
  let written;
  const ctx = {
    writer: { write: async (buf) => { written = buf; }, close: async () => {} },
    schema,
    geometryColumn: 'geometry',
    crs: 'EPSG:4326',
    options: { layerName: 'features' },
    attribution: [],
  };

  const writer = await format.open(ctx);
  for (let start = 0; start < ROWS; start += BATCH_SIZE) {
    const n = Math.min(BATCH_SIZE, ROWS - start);
    const ids = [];
    const geometry = [];
    for (let i = 0; i < n; i++) {
      ids.push(`row-${start + i}`);
      geometry.push(syntheticPolygonWkb(vertices, start + i));
    }
    await writer.writeBatch({ rows: n, columns: { id: ids }, geometry });
    sample();
  }
  await writer.close();
  sample();

  clearInterval(interval);
  if (typeof global.gc === 'function') global.gc();
  sample();

  // One JSON line on stdout, read by the orchestrating parent process.
  console.log(JSON.stringify({ rows: ROWS, vertices, outputBytes: written.byteLength, peakRss }));
}

async function main() {
  const caseArgIndex = process.argv.indexOf('--case');
  if (caseArgIndex !== -1) {
    await runCase(Number(process.argv[caseArgIndex + 1]));
    return;
  }

  const results = [];
  let hadFailure = false;
  for (const vertices of VERTEX_CASES) {
    const { stdout, stderr, status } = spawnSync(
      process.execPath,
      ['--expose-gc', __filename, '--case', String(vertices)],
      { encoding: 'utf8' },
    );
    if (status !== 0) {
      hadFailure = true;
      console.error(`case vertices=${vertices} failed (exit ${status}):\n${stderr}`);
      continue;
    }
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    results.push(JSON.parse(line));
  }

  console.log('\nrows\tvertices/row\toutput\t\tpeak RSS\tpeakRss/outputBytes');
  let maxFactor = 0;
  for (const r of results) {
    const factor = r.peakRss / r.outputBytes;
    maxFactor = Math.max(maxFactor, factor);
    console.log(`${r.rows}\t${r.vertices}\t\t${fmtMB(r.outputBytes)}\t${fmtMB(r.peakRss)}\t${factor.toFixed(2)}x`);
  }
  console.log(`\nmeasured maximum factor across all cases: ${maxFactor.toFixed(2)}x`);
  console.log(
    '\nNOTE: the smallest case (100 vertices/row, ~4 MB output) carries a large,\n' +
    'repeatable ratio that is NOT a per-byte buffering cost -- it is the fixed\n' +
    "Node + sql.js-wasm baseline RSS (~110-150 MB) swamping a tiny output. The\n" +
    'same artifact is present, at a comparable or larger magnitude, in the\n' +
    "pre-task-9 writer measured with this identical script (confirmed by hand:\n" +
    'checking out the prior gpkg-writer.js and re-running gave 100-vertex\n' +
    'ratios of 36-38x, vs. this build\'s 28-29x) -- so it is not something this\n' +
    "change introduced or can fix, and it is not representative of the\n" +
    'quantity `memoryFactor` models (peak memory held PER OUTPUT BYTE at the\n' +
    'realistic, ceiling-relevant output sizes this system targets). The\n' +
    '20,000-vertices/row case is the one directly comparable to the design\n' +
    'doc\'s original §1 measurement (also ~611 MB of output) and is the basis\n' +
    'for the declared `memoryFactor` -- see the package README and this\n' +
    "task's commit message for the full before/after comparison across\n" +
    'repeated runs.',
  );
  console.log('(RSS readings above ~2 GB are unreliable on macOS due to memory compression -- prefer the smaller cases if any case lands there.)');

  if (hadFailure) process.exitCode = 1;
}

await main();
