#!/usr/bin/env node
// Headless regression test for `parquet-raw` (packages/extract-core/src/raw.js)
// written through a REAL `FileSystemWritableFileStream` (OPFS), modelled on
// this directory's `filesystem-sink.verify.mjs`.
//
// Why this file exists, separately from `npm test`'s `raw-run.test.js`: that
// suite only ever uses `memorySink()`. The disk-backed-sink ceiling path --
// `effectiveCeiling()` reading a REAL sink's `.kind` (download.js's
// `runRawDownload`: "the sink is created BEFORE the ceiling gate ... so the
// ceiling sees the REAL sink kind") and the commit discipline a real
// `FileSystemWritableFileStream` demands (createWritable exactly once,
// closed exactly once, never written-to after close) -- is unreachable from
// Node, which has no such stream at all. OPFS has the identical
// `createWritable()`/atomic-commit semantics as a real save-file-picker
// handle and needs no user gesture, so it stands in for one here, same as
// `filesystem-sink.verify.mjs` already does for the decoded formats.
//
// The network is faked (a `fetch` keyed by URL, same technique
// `raw-run.test.js` uses for the Node unit tests) -- this file's own job is
// the OPFS commit path, not live data; the download-demo's own
// `verify.mjs` (PART 6) is what proves `parquet-raw` against a real, live
// source file byte-for-byte.
//
// Usage: node packages/extract-core/test/browser/raw-opfs.verify.mjs [port]
//        (starts its own `serve.py` when no port is given)

import { chromium } from 'playwright';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// --- Node-side zip validation (same technique raw-run.test.js uses: round-trip
// through Python's `zipfile` rather than hand-parsing the zip64 bytes here) --
const PY_READ_SCRIPT = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
contents = {n: z.read(n).decode('utf-8', errors='replace') for n in names}
bad = z.testzip()
print(json.dumps({'names': names, 'contents': contents, 'bad': bad}))
`;

function readZipWithPython(base64) {
  const dir = mkdtempSync(path.join(tmpdir(), 'raw-opfs-verify-'));
  const zipPath = path.join(dir, 'archive.zip');
  writeFileSync(zipPath, Buffer.from(base64, 'base64'));
  try {
    const out = execFileSync('python3', ['-I', '-c', PY_READ_SCRIPT, zipPath], { encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HARNESS_HTML = `<!doctype html>
<meta charset="utf-8">
<title>parquet-raw OPFS harness</title>
<script type="importmap">
{ "imports": { "@cngeo/spec": "/packages/spec/src/index.js" } }
</script>
<body><div id="ready">loading</div></body>
<script type="module">
import { download } from '/packages/extract-core/src/download.js';
import { fileSystemSink } from '/packages/extract-core/src/sinks.js';
import { boundedExact } from '/packages/extract-core/src/bounded.js';
import { defaultCeiling } from '/packages/extract-core/src/ceiling.js';
import { RAW_FORMAT_ID } from '/packages/extract-core/src/raw.js';

const OUTPUT = { spec: 'cng-output/1.0', format: RAW_FORMAT_ID };
const FILTER = { spec: 'cng-filter/1.0' };

function partsDataset(parts, extra = {}) {
  return { spec: 'cng-dataset/1.0', source: { kind: 'parquet-set', parts }, ...extra };
}

/** Deterministic, reproducible "file" content -- a byte cycle, long enough
 *  to split into several chunks, distinct per logical part via \`seed\`. */
function fakeBytes(length, seed = 0) {
  return Uint8Array.from({ length }, (_, i) => (i + seed) % 256);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A ReadableStream over \`bytes\`, split into \`chunkSize\`-sized pulls --
 *  several chunks (not one) is what gives \`runRaw\`'s \`onProgress\` (and
 *  therefore pause/resume/cancel) more than one place to fire. */
function streamFromBytes(bytes, chunkSize = Math.max(1, Math.floor(bytes.length / 6))) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** Keyed by URL, same shape as raw-run.test.js's Node fetchMock: \`{ bytes }\`
 *  for a 200 body, \`{ status }\` for a non-ok response with no body. */
function fetchMock(responses) {
  return async (url, init = {}) => {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const entry = responses.get(String(url));
    if (!entry) throw new Error('fetchMock: no response registered for ' + url);
    if (entry.status) return { ok: false, status: entry.status, body: null };
    return { ok: true, status: 200, body: streamFromBytes(entry.bytes, entry.chunkSize) };
  };
}

function estimateOverrides(overrides = {}) {
  return {
    requestDigest: 'verify',
    rows: null,
    readBytes: boundedExact(0),
    outputBytes: boundedExact(0),
    files: { total: 1, selected: 1 },
    rowGroups: { total: 0, selected: 0 },
    requests: 1,
    prune: [],
    columns: [],
    warnings: [],
    ceiling: { exceeded: false, limits: defaultCeiling(), breaches: [] },
    elapsedMs: 0,
    ...overrides,
  };
}

async function opfsHandle(name) {
  const dir = await navigator.storage.getDirectory();
  return dir.getFileHandle(name, { create: true });
}

async function readOpfsBase64(name) {
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle(name)).getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), size: bytes.length };
}

async function clearOpfs() {
  const dir = await navigator.storage.getDirectory();
  for await (const key of dir.keys()) {
    try { await dir.removeEntry(key); } catch { /* best effort */ }
  }
}

// --- scenarios -------------------------------------------------------------

/** One real file, written verbatim through a real OPFS writable. */
async function happySingle(filename) {
  const bytes = fakeBytes(5000, 1);
  const url = 'https://example.test/' + filename;
  const dataset = partsDataset([{ url, bytes: bytes.length }]);
  const handle = await opfsHandle(filename);
  const sink = await fileSystemSink({ handle });
  const h = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(new Map([[url, { bytes }]])) });
  const result = await h.result;
  const { base64, size } = await readOpfsBase64(filename);
  const written = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return { size, rows: result.rows, bytes: result.bytes, format: result.format, exact: bytesEqual(written, bytes), state: h.state };
}

/** Several parts -> a real zip, written through the same real writable. */
async function happyZip(filename) {
  const parts = [0, 1, 2].map((i) => ({ url: 'https://example.test/part-' + i + '.parquet', bytesContent: fakeBytes(800, i * 97) }));
  const responses = new Map(parts.map((p) => [p.url, { bytes: p.bytesContent }]));
  const dataset = partsDataset(
    parts.map((p) => ({ url: p.url, bytes: p.bytesContent.length })),
    { attribution: [{ text: 'Verify Attribution', license: 'CC-BY-4.0', url: 'https://example.test/license', shareAlike: false }] },
  );
  const handle = await opfsHandle(filename);
  const sink = await fileSystemSink({ handle });
  const h = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(responses) });
  const result = await h.result;
  const { base64, size } = await readOpfsBase64(filename);
  return { size, bytes: result.bytes, entries: result.attribution, base64 };
}

/** Blocked on the ceiling, then accepted -- the continued run must still
 *  commit to the real writable (same invariant filesystem-sink.verify.mjs
 *  checks for the decoded formats). */
async function ceilingAccept(filename) {
  const bytes = fakeBytes(3000, 2);
  const url = 'https://example.test/' + filename;
  const dataset = partsDataset([{ url, bytes: bytes.length }]);
  const handle = await opfsHandle(filename);
  const sink = await fileSystemSink({ handle });
  const h = download(dataset, null, FILTER, OUTPUT, {
    sink,
    fetch: fetchMock(new Map([[url, { bytes }]])),
    estimateOverride: estimateOverrides({ ceiling: { exceeded: true, limits: defaultCeiling(), breaches: ['outputBytes'] } }),
  });
  let result;
  try {
    await h.result;
    throw new Error('expected a CEILING_EXCEEDED rejection');
  } catch (err) {
    if (err?.code !== 'CEILING_EXCEEDED') throw err;
    result = await h.acceptCeiling();
  }
  const { base64, size } = await readOpfsBase64(filename);
  const written = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return { size, bytes: result.bytes, exact: bytesEqual(written, bytes), state: h.state };
}

/** Paused mid-copy and resumed -- \`handle.pause()\`/\`resume()\` are generic
 *  (download.js's \`onProgress\` await), not raw-path-specific, but this is
 *  the one place that exercises them against a REAL writable. */
async function pauseResume(filename) {
  const bytes = fakeBytes(6000, 3);
  const url = 'https://example.test/' + filename;
  const dataset = partsDataset([{ url, bytes: bytes.length }]);
  const handle = await opfsHandle(filename);
  const sink = await fileSystemSink({ handle });
  let paused = false;
  const h = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(new Map([[url, { bytes, chunkSize: 500 }]])) });
  h.on('progress', (p) => {
    if (p.phase === 'copying' && !paused) {
      paused = true;
      h.pause();
      setTimeout(() => h.resume(), 30);
    }
  });
  const result = await h.result;
  const { base64, size } = await readOpfsBase64(filename);
  const written = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return { size, bytes: result.bytes, exact: bytesEqual(written, bytes), pausedAtLeastOnce: paused, state: h.state };
}

/** A cancelled run, then a brand-new download to the SAME filename --
 *  proves the real writable was not left locked/corrupted by the cancel. */
async function cancelThenRedownload(filename) {
  const bytes = fakeBytes(6000, 4);
  const url = 'https://example.test/' + filename;
  const dataset = partsDataset([{ url, bytes: bytes.length }]);
  const first = await opfsHandle(filename);
  const firstSink = await fileSystemSink({ handle: first });
  const h1 = download(dataset, null, FILTER, OUTPUT, { sink: firstSink, fetch: fetchMock(new Map([[url, { bytes, chunkSize: 500 }]])) });
  let cancelled = false;
  h1.on('progress', (p) => {
    // NOT awaited: cancel() waits for the run to finish tearing down, and
    // the run is right here inside this same onProgress call -- awaiting
    // it from in here would deadlock this verify script, not the library.
    if (p.phase === 'copying' && !cancelled) {
      cancelled = true;
      h1.cancel('verify cancel');
    }
  });
  try { await h1.result; } catch { /* cancelled, expected */ }
  const cancelledState = h1.state;

  const second = await happySingle(filename);
  return { ...second, cancelledState };
}

/** The commit-discipline invariant, asserted rather than assumed, over the
 *  multi-part zip path: createWritable exactly once, closed exactly once,
 *  never aborted, nothing written after close. */
async function commitDiscipline(filename) {
  const parts = [0, 1, 2, 3].map((i) => ({ url: 'https://example.test/cd-part-' + i + '.parquet', bytesContent: fakeBytes(400, i * 53) }));
  const responses = new Map(parts.map((p) => [p.url, { bytes: p.bytesContent, chunkSize: 150 }]));
  const dataset = partsDataset(parts.map((p) => ({ url: p.url, bytes: p.bytesContent.length })));
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
  const h = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(responses) });
  const result = await h.result;
  const { base64, size } = await readOpfsBase64(filename);
  return { size, bytes: result.bytes, calls, base64 };
}

/** A second open() on one sink must be refused, not silently truncate --
 *  independent of the raw path (sinks.js's own invariant), kept here for
 *  parity with filesystem-sink.verify.mjs's own coverage. */
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
    await sink.abort('verify teardown');
  }
}

window.__run = async () => {
  await clearOpfs();
  const out = {};
  out.happySingle = await happySingle('happy.parquet');
  out.happyZip = await happyZip('happy.zip');
  out.ceiling = await ceilingAccept('ceiling.parquet');
  out.pause = await pauseResume('pause.parquet');
  out.cancelRedownload = await cancelThenRedownload('again.parquet');
  out.multiPart = await commitDiscipline('multipart.zip');
  out.secondOpen = await secondOpenRefused('second-open.parquet');
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

  await page.route('**/raw-opfs-harness.html', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HARNESS_HTML }),
  );

  try {
    await page.goto(`http://localhost:${port}/raw-opfs-harness.html`);
    await page.waitForSelector('#ready:has-text("ready")', { timeout: 20000 });

    const out = await Promise.race([
      page.evaluate(() => window.__run()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('scenarios did not finish within 90s')), 90000)),
    ]);
    console.log('\n--- parquet-raw / OPFS ---');
    console.log(JSON.stringify({ ...out, happyZip: { ...out.happyZip, base64: '(elided)' }, multiPart: { ...out.multiPart, base64: '(elided)' } }, null, 2));

    check(out.happySingle.size > 0, `happySingle: commits a non-empty file (got ${out.happySingle.size} bytes)`);
    check(out.happySingle.exact, 'happySingle: committed bytes are byte-for-byte the fake source file');
    check(out.happySingle.size === out.happySingle.bytes, `happySingle: file size matches DownloadResult.bytes (${out.happySingle.size} vs ${out.happySingle.bytes})`);
    check(out.happySingle.format === 'parquet-raw', `happySingle: result.format is parquet-raw (got ${out.happySingle.format})`);
    check(out.happySingle.rows === null, 'happySingle: rows is null (no declared rowCount on this fake part, never guessed on the raw path)');

    const zip = readZipWithPython(out.happyZip.base64);
    console.log('happyZip zip contents (python zipfile):', zip);
    check(zip.bad === null, `happyZip: python zipfile reports no bad/corrupt entry (testzip() => ${zip.bad})`);
    check(zip.names.length === 4, `happyZip: 3 parts + ATTRIBUTION.txt = 4 entries (got ${zip.names.length}: ${zip.names.join(', ')})`);
    check(zip.names.includes('ATTRIBUTION.txt'), 'happyZip: includes ATTRIBUTION.txt');
    check(/Verify Attribution/.test(zip.contents['ATTRIBUTION.txt'] ?? ''), 'happyZip: ATTRIBUTION.txt carries the declared attribution text');
    check(out.happyZip.entries?.[0]?.text === 'Verify Attribution', 'happyZip: DownloadResult.attribution also carries it');

    check(out.ceiling.size > 0, `ceiling: acceptCeiling() continuation commits a non-empty file (got ${out.ceiling.size} bytes)`);
    check(out.ceiling.exact, 'ceiling: the continued run commits byte-for-byte correct bytes');

    check(out.pause.pausedAtLeastOnce, 'pause: the run was actually paused at least once mid-copy');
    check(out.pause.size > 0 && out.pause.exact, `pause: pause/resume run still commits the exact bytes (${out.pause.size} bytes)`);

    check(out.cancelRedownload.cancelledState === 'cancelled', 'cancelRedownload: the first run really did cancel');
    check(out.cancelRedownload.size > 0 && out.cancelRedownload.exact, `cancelRedownload: a fresh download after a cancelled one commits the exact bytes (${out.cancelRedownload.size} bytes)`);

    const mp = readZipWithPython(out.multiPart.base64);
    check(mp.bad === null, `multiPart: python zipfile reports no bad/corrupt entry over a 4-part run (testzip() => ${mp.bad})`);
    check(mp.names.length === 5, `multiPart: 4 parts + ATTRIBUTION.txt = 5 entries (got ${mp.names.length})`);
    const c = out.multiPart.calls;
    check(out.multiPart.size > 0, `multiPart: commits a non-empty file (got ${out.multiPart.size} bytes)`);
    check(out.multiPart.size === out.multiPart.bytes, `multiPart: file size matches DownloadResult.bytes (${out.multiPart.size} vs ${out.multiPart.bytes})`);
    check(c.createWritable === 1, `multiPart: createWritable() called exactly once across 4 parts (got ${c.createWritable})`);
    check(c.close === 1, `multiPart: the writable is closed exactly once (got ${c.close})`);
    check(c.abort === 0, `multiPart: the writable is never aborted on the success path (got ${c.abort})`);
    check(c.writeAfterClose === 0, `multiPart: nothing is written after the close (got ${c.writeAfterClose})`);

    check(out.secondOpen.refused && out.secondOpen.code === 'SINK_UNSUPPORTED', `secondOpen: a second open() on one sink is refused (${JSON.stringify(out.secondOpen)})`);

    check(consoleErrors.length === 0, `no console errors (${consoleErrors.join(' | ')})`);
  } finally {
    await browser.close();
    server?.kill();
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll parquet-raw OPFS checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
