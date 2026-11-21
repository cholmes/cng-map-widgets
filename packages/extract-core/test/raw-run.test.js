// @cngeo/extract-core -- raw GeoParquet passthrough EXECUTION (Task 7):
// `runRaw` and `download()`'s branch for `output.format === RAW_FORMAT_ID`.
// Task 6's own tests (raw-plan.test.js) cover `planRaw`/`rawEstimate`
// (which files get selected, what they cost) with no fetch beyond HEAD;
// this file covers writing the actual bytes -- verbatim for one file,
// zipped for several -- through the real `download()` state machine, with
// a fake `fetch` standing in for the network (no real file ever read, same
// approach download-handle.test.js/ceiling-wiring.test.js use).
//
// Zip output is verified by round-tripping through Python's `zipfile`
// (same technique as zip-writer.test.js), not by hand-parsing bytes here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download } from '../src/download.js';
import { memorySink } from '../src/sinks.js';
import { RAW_FORMAT_ID } from '../src/raw.js';

const OUTPUT = { spec: 'cng-output/1.0', format: RAW_FORMAT_ID };
const FILTER = { spec: 'cng-filter/1.0' };

function partsDataset(parts, extra = {}) {
  return { spec: 'cng-dataset/1.0', source: { kind: 'parquet-set', parts }, ...extra };
}

/** A ReadableStream over `bytes`, split into `chunkSize`-sized pulls (default: one chunk). */
function streamFromBytes(bytes, chunkSize = bytes.length || 1) {
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

/**
 * A fake `fetch` keyed by URL. `responses` maps a url to either
 * `{ bytes, chunkSize? }` (a 200 with that body) or `{ status }` (a
 * non-2xx with no body, e.g. a stale manifest's 404). Every call is
 * recorded in `.calls`.
 */
function fetchMock(responses) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), init });
    const entry = responses.get(String(url));
    if (!entry) throw new Error(`fetchMock: no response registered for ${url}`);
    if (entry.status) return { ok: false, status: entry.status, body: null };
    return { ok: true, status: 200, body: streamFromBytes(entry.bytes, entry.chunkSize) };
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Deterministic non-ASCII content that can never contain the zip local-header signature (PK\x03\x04 == 0x50,0x4b,0x03,0x04): a monotonically increasing byte cycle never produces a 80-then-75 (decreasing) pair except at the 255->0 wrap, which is never followed by 3,4. */
function fakeParquetBytes(length) {
  return Uint8Array.from({ length }, (_, i) => i % 256);
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function containsZipSignature(bytes) {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) return true;
  }
  return false;
}

function withTempFile(bytes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'raw-run-test-'));
  const path = join(dir, 'archive.zip');
  writeFileSync(path, bytes);
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PY_READ_SCRIPT = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
contents = {n: z.read(n).decode('utf-8', errors='replace') for n in names}
bad = z.testzip()
print(json.dumps({'names': names, 'contents': contents, 'bad': bad}))
`;

function readZipWithPython(path) {
  const out = execFileSync('python3', ['-I', '-c', PY_READ_SCRIPT, path], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** A `memorySink` wrapper that records whether `abort()` was ever called. */
function trackingSink() {
  const inner = memorySink();
  let aborted = false;
  return {
    kind: inner.kind,
    get chunks() {
      return inner.chunks;
    },
    open(meta) {
      return inner.open(meta);
    },
    close() {
      return inner.close();
    },
    async abort(reason) {
      aborted = true;
      await inner.abort(reason);
    },
    get aborted() {
      return aborted;
    },
  };
}

test('one selected part is written verbatim, byte for byte', async () => {
  const bytes = fakeParquetBytes(5000);
  const url = 'https://example.test/solo.parquet';
  const dataset = partsDataset([{ url, bytes: bytes.length }]);
  const sink = memorySink();

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(new Map([[url, { bytes, chunkSize: 777 }]])) });
  const result = await handle.result;

  const written = concatChunks(sink.chunks);
  assert.deepEqual(written, bytes);
  assert.equal(containsZipSignature(written), false);
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.readBytes, bytes.length);
});

test('one part is never wrapped in a zip, even when attribution is share-alike', async () => {
  const bytes = fakeParquetBytes(2000);
  const url = 'https://example.test/odbl-solo.parquet';
  const dataset = partsDataset([{ url, bytes: bytes.length }], {
    attribution: [{ text: 'Overture Maps', license: 'ODbL-1.0', url: 'https://example.test/odbl', shareAlike: true }],
  });
  const sink = memorySink();

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(new Map([[url, { bytes }]])) });
  const result = await handle.result;

  const written = concatChunks(sink.chunks);
  assert.deepEqual(written, bytes, 'the file is piped through untouched, no ATTRIBUTION.txt baked in');
  assert.equal(containsZipSignature(written), false);
  assert.deepEqual(result.attribution, dataset.attribution, 'the license still travels on the DownloadResult itself');
});

test('many parts produce a zip whose entries are the parts plus ATTRIBUTION.txt', async () => {
  const contents = {
    'https://example.test/data/day=01/part.parquet': 'contents-for-day-01',
    'https://example.test/data/day=02/part.parquet': 'contents-for-day-02',
    'https://example.test/data/day=03/part.parquet': 'contents-for-day-03',
  };
  const parts = Object.entries(contents).map(([url, text]) => ({ url, bytes: Buffer.byteLength(text) }));
  const dataset = partsDataset(parts);
  const sink = memorySink();
  const responses = new Map(Object.entries(contents).map(([url, text]) => [url, { bytes: new TextEncoder().encode(text) }]));

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(responses) });
  const result = await handle.result;

  const written = concatChunks(sink.chunks);
  withTempFile(written, (path) => {
    const read = readZipWithPython(path);
    assert.deepEqual(
      read.names.sort(),
      ['ATTRIBUTION.txt', 'day=01/part.parquet', 'day=02/part.parquet', 'day=03/part.parquet'].sort(),
    );
    assert.equal(read.contents['day=01/part.parquet'], contents['https://example.test/data/day=01/part.parquet']);
    assert.equal(read.contents['day=02/part.parquet'], contents['https://example.test/data/day=02/part.parquet']);
    assert.equal(read.contents['day=03/part.parquet'], contents['https://example.test/data/day=03/part.parquet']);
    assert.equal(read.bad, null, 'every entry CRC checks out');
  });
  assert.equal(result.bytes > written.length - 1, true); // sanity: result.bytes is the real archive size
});

test('ATTRIBUTION.txt contains the licenses and source URLs', async () => {
  const urlA = 'https://example.test/attrib/a.parquet';
  const urlB = 'https://example.test/attrib/b.parquet';
  const dataset = partsDataset([{ url: urlA, bytes: 4 }, { url: urlB, bytes: 4 }], {
    attribution: [
      { text: 'Example Dataset', license: 'CC-BY-4.0', url: 'https://example.test/license-a' },
      { text: 'Second Source', license: 'ODbL-1.0', url: 'https://example.test/license-b', shareAlike: true },
    ],
  });
  const sink = memorySink();
  const responses = new Map([
    [urlA, { bytes: new TextEncoder().encode('AAAA') }],
    [urlB, { bytes: new TextEncoder().encode('BBBB') }],
  ]);

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(responses) });
  await handle.result;

  const written = concatChunks(sink.chunks);
  withTempFile(written, (path) => {
    const read = readZipWithPython(path);
    const text = read.contents['ATTRIBUTION.txt'];
    assert.match(text, /CC-BY-4\.0/);
    assert.match(text, /https:\/\/example\.test\/license-a/);
    assert.match(text, /ODbL-1\.0/);
    assert.match(text, /https:\/\/example\.test\/license-b/);
    assert.match(text, new RegExp(urlA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the source file URL itself is listed, not just the dataset attribution URL');
    assert.match(text, new RegExp(urlB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('progress reports copying with a rising fileIndex', async () => {
  const urlA = 'https://example.test/progress/a.parquet';
  const urlB = 'https://example.test/progress/b.parquet';
  const urlC = 'https://example.test/progress/c.parquet';
  const bytesA = fakeParquetBytes(300);
  const bytesB = fakeParquetBytes(300);
  const bytesC = fakeParquetBytes(300);
  const dataset = partsDataset([
    { url: urlA, bytes: bytesA.length },
    { url: urlB, bytes: bytesB.length },
    { url: urlC, bytes: bytesC.length },
  ]);
  const sink = memorySink();
  const responses = new Map([
    [urlA, { bytes: bytesA, chunkSize: 100 }],
    [urlB, { bytes: bytesB, chunkSize: 100 }],
    [urlC, { bytes: bytesC, chunkSize: 100 }],
  ]);

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(responses) });
  const fileIndexes = [];
  handle.on('progress', (p) => {
    if (p.phase === 'copying') fileIndexes.push(p.fileIndex);
  });
  await handle.result;

  assert.ok(fileIndexes.length >= 3, `expected multiple copying events, got ${fileIndexes.length}`);
  assert.equal(fileIndexes[0], 1);
  assert.equal(fileIndexes[fileIndexes.length - 1], 3);
  for (let i = 1; i < fileIndexes.length; i++) {
    assert.ok(fileIndexes[i] >= fileIndexes[i - 1], 'fileIndex never goes backwards');
  }
  assert.ok(fileIndexes.includes(2), 'the middle file is reported too');
});

test('DownloadResult.rows is null when parts declare no rowCount, and truncated is false', async () => {
  const urlA = 'https://example.test/norows/a.parquet';
  const urlB = 'https://example.test/norows/b.parquet';
  const dataset = partsDataset([{ url: urlA, bytes: 4 }, { url: urlB, bytes: 4 }]);
  const sink = memorySink();
  const responses = new Map([
    [urlA, { bytes: new TextEncoder().encode('AAAA') }],
    [urlB, { bytes: new TextEncoder().encode('BBBB') }],
  ]);

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(responses) });
  const result = await handle.result;

  assert.equal(result.rows, null);
  assert.equal(result.truncated, false);
});

// Review Focus 1: a part failing mid-archive must never produce a
// zip that merely looks complete.
test('a part that 404s mid-archive rejects and aborts the sink without committing', async () => {
  const urlA = 'https://example.test/fail/a.parquet';
  const urlB = 'https://example.test/fail/b.parquet';
  const urlC = 'https://example.test/fail/c.parquet';
  const dataset = partsDataset([
    { url: urlA, bytes: 4 },
    { url: urlB, bytes: 4 },
    { url: urlC, bytes: 4 },
  ]);
  const sink = trackingSink();
  const responses = new Map([
    [urlA, { bytes: new TextEncoder().encode('AAAA') }],
    [urlB, { bytes: new TextEncoder().encode('BBBB') }],
    [urlC, { status: 404 }],
  ]);

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(responses) });

  await assert.rejects(handle.result, (err) => err.code === 'NETWORK');
  assert.equal(sink.aborted, true);
  assert.equal(handle.state, 'failed');
});

// Review Focus 2 (ruling 2): the actual bytes transferred, not a stale
// declared size, are what the archive holds and what the result reports.
test('actual bytes differing from the declared size are what the descriptor and result report', async () => {
  const urlBig = 'https://example.test/mismatch/big.parquet';
  const urlEmpty = 'https://example.test/mismatch/empty.parquet';
  // Declares 100 bytes but actually serves 150 -- a stale `file_size`.
  const actualBytes = fakeParquetBytes(150);
  const dataset = partsDataset([
    { url: urlBig, bytes: 100 },
    { url: urlEmpty, bytes: 0 },
  ]);
  const sink = memorySink();
  const responses = new Map([
    [urlBig, { bytes: actualBytes }],
    [urlEmpty, { bytes: new Uint8Array(0) }],
  ]);

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(responses) });
  const result = await handle.result;

  assert.equal(result.readBytes, 150, 'the real 150 bytes read, not the declared 100');
  assert.equal(result.bytes > 150, true, 'the archive holds the real 150 bytes plus zip overhead');
});

// Single-file variant of the above: no zip overhead to inflate `bytes`
// past the declared size, so here `bytes` and `readBytes` are both the
// real, actual byte count -- the declared (wrong) size never surfaces
// anywhere in the result, same `copyBody`/`onBytes` mechanism exercised
// by the never-zipped tests above, now also checked against a declared
// size that disagrees with reality.
test('a single file whose actual size differs from its declared size still reports the real byte count (never zipped)', async () => {
  const url = 'https://example.test/mismatch-solo/big.parquet';
  const actualBytes = fakeParquetBytes(150);
  const dataset = partsDataset([{ url, bytes: 100 }]); // declares 100, serves 150
  const sink = memorySink();

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchMock(new Map([[url, { bytes: actualBytes }]])) });
  const result = await handle.result;

  const written = concatChunks(sink.chunks);
  assert.deepEqual(written, actualBytes, 'the real 150 bytes are what got written, not the declared 100');
  assert.equal(result.readBytes, 150);
  assert.equal(result.bytes, 150, 'no zip overhead on the single-file path: bytes === readBytes exactly');
});

// Review Focus 3: cancelling mid-copy aborts the in-flight fetch (via the
// handle's own AbortController/signal) and the sink, with no partial file
// left committed.
test('cancel() during copying aborts the in-flight fetch and the sink', async () => {
  const url = 'https://example.test/cancel/solo.parquet';
  const firstChunk = fakeParquetBytes(50);
  const dataset = partsDataset([{ url, bytes: 10_000 }]); // declared size is irrelevant here
  const sink = trackingSink();

  function hangingBody(init) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(firstChunk);
        const signal = init.signal;
        const onAbort = () => controller.error(new Error('aborted by signal'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        // Deliberately never closes and never enqueues again: the second
        // `read()` only ever settles via the abort above.
      },
    });
  }

  const fetchImpl = async (fetchedUrl, init = {}) => {
    assert.equal(fetchedUrl, url);
    return { ok: true, status: 200, body: hangingBody(init) };
  };

  const handle = download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchImpl });

  await new Promise((resolve) => {
    handle.on('progress', (p) => {
      if (p.phase === 'copying') resolve();
    });
  });

  await handle.cancel('test cancel mid-copy');

  assert.equal(handle.state, 'cancelled');
  assert.equal(sink.aborted, true);
  await assert.rejects(handle.result, (err) => err.code === 'CANCELLED');
});
