#!/usr/bin/env node
// Headless regression test for `fileSystemSink` (packages/download-core/src/sinks.js)
// against a REAL `FileSystemWritableFileStream`.
//
// Why a browser script and not `node --test`: the File System Access API
// exists in no Node runtime, and the bug this guards against lives
// precisely in the part of the sink that only a real writable stream has
// -- the *commit*. Chrome writes a picker-chosen `foo.parquet` through a
// sibling `foo.parquet.crswap` swap file and only replaces the real file
// when the writable is `close()`d; a writable that is merely dropped on
// the floor leaves the swap behind (and the browser discards it), so the
// user's file stays at the zero bytes it was created with even though
// every byte was written and the widget reported success.
//
// OPFS (`navigator.storage.getDirectory()`) has exactly the same
// `createWritable()` / atomic-commit semantics as a picker handle and
// needs no user gesture, so it is what this drives -- the picker itself
// cannot be opened headless, which is also why the portolan-browser e2e
// suite (which takes the anchor/Blob path under `navigator.webdriver`)
// never saw this.
//
// Runs the REAL `download()` lifecycle -- happy path, ceiling breach +
// acceptCeiling(), pause/resume, and a cancelled run followed by a fresh
// download to the same filename -- and asserts the committed file is not
// empty and round-trips.
//
// Usage: node packages/download-core/test/browser/filesystem-sink.verify.mjs [port]
//        (starts its own `serve.py` when no port is given)

import { chromium } from 'playwright';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

const failures = [];
function check(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error('FAIL:', msg);
  } else {
    console.log('ok:', msg);
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(port) {
  const proc = spawn('python3', [path.join(repoRoot, 'serve.py'), String(port)], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/package.json`);
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`serve.py did not come up on :${port}`);
}

const HARNESS_HTML = `<!doctype html>
<meta charset="utf-8">
<title>fileSystemSink OPFS harness</title>
<script type="importmap">
{ "imports": { "@cng/spec": "/packages/spec/src/index.js" } }
</script>
<body><div id="ready">loading</div></body>
<script type="module">
import { download } from '/packages/download-core/src/download.js';
import { fileSystemSink } from '/packages/download-core/src/sinks.js';
import { boundedExact } from '/packages/download-core/src/bounded.js';
import { defaultCeiling } from '/packages/download-core/src/ceiling.js';

const DATASET = { spec: 'cng-dataset/1.0', source: { kind: 'parquet', url: 'https://example.test/d.parquet' } };
const FILTER = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };

const PLAN = {
  geometryColumn: 'geometry',
  table: { crs: 'OGC:CRS84', columns: [{ name: 'id', type: 'string' }, { name: 'geometry', type: 'geometry' }] },
  resolved: { attribution: [] },
  outputColumns: ['id', 'geometry'],
};

// WKB for a tiny square polygon -- real bytes, so the geoparquet writer has
// a real geometry column to encode rather than an all-null one.
function squareWkb(x, y, size = 0.01) {
  const ring = [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + ring.length * 16);
  const view = new DataView(buf);
  let o = 0;
  view.setUint8(o, 1); o += 1;
  view.setUint32(o, 3, true); o += 4;
  view.setUint32(o, 1, true); o += 4;
  view.setUint32(o, ring.length, true); o += 4;
  for (const [cx, cy] of ring) { view.setFloat64(o, cx, true); o += 8; view.setFloat64(o, cy, true); o += 8; }
  return new Uint8Array(buf);
}

function estimate(overrides = {}) {
  return {
    requestDigest: 'verify',
    rows: boundedExact(3),
    readBytes: boundedExact(0),
    outputBytes: boundedExact(0),
    files: { total: 1, selected: 1 },
    rowGroups: { total: 1, selected: 1 },
    requests: 1,
    prune: [],
    columns: ['id', 'geometry'],
    warnings: [],
    ceiling: { exceeded: false, limits: defaultCeiling(), breaches: [] },
    elapsedMs: 0,
    ...overrides,
  };
}

/** A fake Engine that hands over \`batches\` batches of 3 rows each. */
function fakeEngine({ batches = 2, between } = {}) {
  return {
    id: 'fake',
    capabilities: ['bbox', 'intersects'],
    async plan(dataset, area, filter) { return { dataset, area, filter, plan: PLAN }; },
    async run(enginePlan, onBatch, ctx) {
      for (let b = 0; b < batches; b++) {
        await onBatch({
          rows: 3,
          columns: { id: ['a' + b, 'b' + b, 'c' + b], geometry: [null, null, null] },
          geometry: [squareWkb(1, 1), squareWkb(2, 2), squareWkb(3, 3)],
        });
        await ctx.onProgress({ phase: 'reading', rowGroupsDone: b + 1, rowGroupsTotal: batches, rowsMatched: (b + 1) * 3, bytesRead: 0 });
        if (between) await between(b);
      }
      return { rows: batches * 3, readBytes: 0, requests: batches };
    },
  };
}

async function opfsHandle(name) {
  const dir = await navigator.storage.getDirectory();
  return dir.getFileHandle(name, { create: true });
}

async function sizeOf(name) {
  const dir = await navigator.storage.getDirectory();
  const h = await dir.getFileHandle(name);
  return (await h.getFile()).size;
}

async function clearOpfs() {
  const dir = await navigator.storage.getDirectory();
  for await (const key of dir.keys()) {
    try { await dir.removeEntry(key); } catch { /* best effort */ }
  }
}

// --- scenarios -------------------------------------------------------------

/** The plain happy path: pick a file, download, nothing unusual. */
async function happyPath(format, filename) {
  const handle = await opfsHandle(filename);
  const sink = await fileSystemSink({ handle });
  const h = download(DATASET, null, FILTER, { spec: 'cng-output/1.0', format, filename }, {
    engine: fakeEngine(), sink, estimateOverride: estimate(),
  });
  const result = await h.result;
  return { size: await sizeOf(filename), rows: result.rows, bytes: result.bytes, state: h.state };
}

/** Blocked on the ceiling, then accepted -- the continued run must still commit. */
async function ceilingAccept(format, filename) {
  const handle = await opfsHandle(filename);
  const sink = await fileSystemSink({ handle });
  const h = download(DATASET, null, FILTER, { spec: 'cng-output/1.0', format, filename }, {
    engine: fakeEngine(), sink,
    estimateOverride: estimate({ ceiling: { exceeded: true, limits: defaultCeiling(), breaches: ['rows'] } }),
  });
  let result;
  try {
    await h.result;
    throw new Error('expected a CEILING_EXCEEDED rejection');
  } catch (err) {
    if (err?.code !== 'CEILING_EXCEEDED') throw err;
    result = await h.acceptCeiling();
  }
  return { size: await sizeOf(filename), rows: result.rows, bytes: result.bytes, state: h.state };
}

/** Paused mid-run and resumed. */
async function pauseResume(format, filename) {
  const handle = await opfsHandle(filename);
  const sink = await fileSystemSink({ handle });
  let h;
  const engine = fakeEngine({
    batches: 3,
    between: async (b) => {
      if (b === 0) {
        h.pause();
        await new Promise((r) => setTimeout(r, 20));
        h.resume();
      }
    },
  });
  h = download(DATASET, null, FILTER, { spec: 'cng-output/1.0', format, filename }, {
    engine, sink, estimateOverride: estimate(),
  });
  const result = await h.result;
  return { size: await sizeOf(filename), rows: result.rows, bytes: result.bytes, state: h.state };
}

/** A cancelled run, then a brand-new download to the SAME filename. */
async function cancelThenRedownload(format, filename) {
  const first = await opfsHandle(filename);
  const firstSink = await fileSystemSink({ handle: first });
  let h1;
  const engine = fakeEngine({
    batches: 4,
    // NOT awaited: \`cancel()\` waits for the run to finish tearing down, and
    // the run is right here inside the engine callback -- awaiting it from
    // in here would deadlock the test, not the library.
    between: (b) => { if (b === 0) h1.cancel('verify cancel'); },
  });
  h1 = download(DATASET, null, FILTER, { spec: 'cng-output/1.0', format, filename }, {
    engine, sink: firstSink, estimateOverride: estimate(),
  });
  try { await h1.result; } catch { /* cancelled, expected */ }
  const cancelledState = h1.state;

  const second = await happyPath(format, filename);
  return { ...second, cancelledState };
}

/**
 * The invariant, asserted rather than assumed: across a run that spans
 * MANY batches (what a multi-part dataset looks like from the sink's side
 * -- the engine reads parts, the sink only ever sees batches), the
 * writable is created exactly once, closed exactly once, never aborted,
 * and nothing is written after the close. Counts the real API calls by
 * proxying the OPFS handle.
 */
async function commitDiscipline(format, filename, batches) {
  const real = await opfsHandle(filename);
  const calls = { createWritable: 0, write: 0, close: 0, abort: 0, writeAfterClose: 0 };
  const handle = {
    kind: real.kind,
    name: real.name,
    getFile: () => real.getFile(),
    async createWritable(options) {
      calls.createWritable++;
      const w = await real.createWritable(options);
      let closed = false;
      return {
        async write(chunk) { calls.write++; if (closed) calls.writeAfterClose++; return w.write(chunk); },
        async close() { calls.close++; closed = true; return w.close(); },
        async abort(reason) { calls.abort++; closed = true; return w.abort(reason); },
      };
    },
  };
  const sink = await fileSystemSink({ handle });
  const h = download(DATASET, null, FILTER, { spec: 'cng-output/1.0', format, filename }, {
    engine: fakeEngine({ batches }), sink, estimateOverride: estimate(),
  });
  const result = await h.result;
  return { size: await sizeOf(filename), rows: result.rows, bytes: result.bytes, calls };
}

/** A second open() on one sink must be refused, not silently truncate. */
async function secondOpenRefused(filename) {
  const handle = await opfsHandle(filename);
  const sink = await fileSystemSink({ handle });
  await sink.open({ filename, mediaType: 'application/octet-stream', estimatedBytes: 0 });
  try {
    await sink.open({ filename, mediaType: 'application/octet-stream', estimatedBytes: 0 });
    return { refused: false, code: null };
  } catch (err) {
    return { refused: true, code: err?.code ?? null };
  } finally {
    // Leave no writable holding this OPFS entry open, or the next run's
    // cleanup trips over a locked file.
    await sink.abort('verify teardown');
  }
}

window.__run = async (format) => {
  await clearOpfs();
  const ext = format === 'geoparquet' ? 'parquet' : 'geojson';
  const out = {};
  out.happy = await happyPath(format, 'happy.' + ext);
  out.ceiling = await ceilingAccept(format, 'ceiling.' + ext);
  out.pause = await pauseResume(format, 'pause.' + ext);
  out.cancelRedownload = await cancelThenRedownload(format, 'again.' + ext);
  // 12 batches: the shape a 54-part dataset pruned to a handful of parts
  // presents to the sink. The sink never learns about parts at all, which
  // is the point -- the commit must not depend on how many it took.
  out.multiPart = await commitDiscipline(format, 'multipart.' + ext, 12);
  out.secondOpen = await secondOpenRefused('second-open.' + ext);
  // Read one file back, to prove the committed bytes are the real output
  // and not a truncated or half-written swap.
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle('happy.' + ext)).getFile();
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  out.magic = String.fromCharCode(...head);
  return out;
};

document.getElementById('ready').textContent = 'ready';
</script>
`;

async function main() {
  const givenPort = process.argv[2];
  const port = givenPort ? Number(givenPort) : await freePort();
  const server = givenPort ? null : await startServer(port);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.route('**/opfs-harness.html', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HARNESS_HTML }),
  );

  try {
    await page.goto(`http://localhost:${port}/opfs-harness.html`);
    await page.waitForSelector('#ready:has-text("ready")', { timeout: 20000 });

    for (const format of ['geojson', 'geoparquet']) {
      // A watchdog, not politeness: a sink that never settles is one of the
      // failure modes this script exists to catch, and a hung `evaluate`
      // reports nothing at all.
      const out = await Promise.race([
        page.evaluate((f) => window.__run(f), format),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${format}: scenarios did not finish within 90s`)), 90000)),
      ]);
      console.log(`\n--- ${format} ---`);
      console.log(JSON.stringify(out, null, 2));

      // THE regression assertion: the file the user ends up with has bytes
      // in it. Every one of these was 0 before the sink learned to close
      // its writable.
      check(out.happy.size > 0, `${format}: happy path commits a non-empty file (got ${out.happy.size} bytes)`);
      check(out.happy.size === out.happy.bytes, `${format}: happy path file size matches the reported DownloadResult.bytes (${out.happy.size} vs ${out.happy.bytes})`);
      check(out.ceiling.size > 0, `${format}: acceptCeiling() continuation commits a non-empty file (got ${out.ceiling.size} bytes)`);
      check(out.pause.size > 0, `${format}: pause/resume run commits a non-empty file (got ${out.pause.size} bytes)`);
      check(out.cancelRedownload.cancelledState === 'cancelled', `${format}: the first run really did cancel`);
      check(out.cancelRedownload.size > 0, `${format}: a fresh download after a cancelled one commits a non-empty file (got ${out.cancelRedownload.size} bytes)`);
      const expectedMagic = format === 'geoparquet' ? 'PAR1' : '{"ty';
      check(out.magic === expectedMagic, `${format}: committed bytes start with ${JSON.stringify(expectedMagic)} (got ${JSON.stringify(out.magic)})`);

      // One writable per run, opened once, closed exactly once, never
      // after an abort -- the invariant, over a 12-batch (multi-part
      // shaped) run.
      const c = out.multiPart.calls;
      check(out.multiPart.size > 0, `${format}: 12-batch run commits a non-empty file (got ${out.multiPart.size} bytes)`);
      check(out.multiPart.size === out.multiPart.bytes, `${format}: 12-batch file size matches DownloadResult.bytes (${out.multiPart.size} vs ${out.multiPart.bytes})`);
      check(c.createWritable === 1, `${format}: createWritable() called exactly once across 12 batches (got ${c.createWritable})`);
      check(c.close === 1, `${format}: the writable is closed exactly once (got ${c.close})`);
      check(c.abort === 0, `${format}: the writable is never aborted on the success path (got ${c.abort})`);
      check(c.writeAfterClose === 0, `${format}: nothing is written after the close (got ${c.writeAfterClose})`);
      check(out.secondOpen.refused && out.secondOpen.code === 'SINK_UNSUPPORTED', `${format}: a second open() on one sink is refused (${JSON.stringify(out.secondOpen)})`);
    }

    check(consoleErrors.length === 0, `no console errors (${consoleErrors.join(' | ')})`);
  } finally {
    await browser.close();
    server?.kill();
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll fileSystemSink OPFS checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
