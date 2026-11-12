// Cancellation must report CANCELLED, not a data/network failure (design
// doc §3.5 rule 1: "An abort rejects with `CancelledError` (`code:
// 'CANCELLED'`), never a bare `DOMException`, so a consumer has one thing
// to match").
//
// The live-verification audit found two places where it did not:
//
//   - cancelling *during planning* surfaced `NETWORK` with `state:
//     'failed'`, because the abort hit the in-flight footer fetch and
//     `openParquetFile` wrapped it as a network error;
//   - cancelling *mid-row-group read* surfaced `DATASET_UNRESOLVED`,
//     because `readRows` wrapped the same abort as a malformed-data error.
//
// Both are now mapped by `parquet-io.js`'s `cancellationOf`, which tests
// `signal.aborted` rather than sniffing the thrown error's shape -- the
// only check that stays correct for a caller-supplied `fetch` whose abort
// rejection is some other error type entirely (exercised below: these
// stubs reject with a plain `Error`, not a `DOMException`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import './helpers/hyparquet-setup.js';
import { openParquetFile, readRows } from '../src/parquet-io.js';
import { download } from '../src/index.js';
import { memorySink } from '../src/sinks.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FIXTURE_URL = `file://${FIXTURES}geo-metadata.parquet`;

const DATASET = {
  spec: 'cnmw-dataset/1.0',
  id: 'fixture-cancellation',
  source: { kind: 'parquet', url: FIXTURE_URL },
  table: {
    geometryColumn: 'geometry',
    geometryEncoding: 'WKB',
    crs: 'OGC:CRS84',
    bbox: { kind: 'struct', column: 'bbox' },
    columns: [
      { name: 'id', type: 'string' },
      { name: 'confidence', type: 'float32' },
      { name: 'geometry', type: 'geometry' },
    ],
  },
};
const FILTER = { spec: 'cnmw-filter/1.0', spatial: { mode: 'bbox' } };
const OUTPUT = { spec: 'cnmw-output/1.0', format: 'geojson', filename: 'out.geojson' };

/** A `fetch` over the local fixture that ignores `signal` entirely, so each test controls exactly which stage throws. */
async function fetchFixture(url) {
  const buf = await readFile(fileURLToPath(new URL(String(url))));
  return new Response(buf, {
    status: 200,
    headers: { 'content-length': String(buf.byteLength), 'accept-ranges': 'bytes' },
  });
}

test('openParquetFile: a failed fetch is NETWORK when not aborted, CANCELLED when aborted', async () => {
  const failing = async () => {
    throw new Error('socket hang up'); // deliberately NOT a DOMException
  };

  await assert.rejects(openParquetFile(FIXTURE_URL, failing, {}), (err) => err.code === 'NETWORK');

  const controller = new AbortController();
  controller.abort('user cancelled');
  await assert.rejects(openParquetFile(FIXTURE_URL, failing, { signal: controller.signal }), (err) => {
    assert.equal(err.code, 'CANCELLED');
    assert.equal(err.name, 'CancelledError');
    assert.equal(err.retryable, false);
    return true;
  });
});

test('openParquetFile: an unreadable footer is DATASET_UNRESOLVED when not aborted, CANCELLED when aborted', async () => {
  const notParquet = async () =>
    new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
      status: 200,
      headers: { 'content-length': '8', 'accept-ranges': 'bytes' },
    });

  await assert.rejects(openParquetFile(FIXTURE_URL, notParquet, {}), (err) => err.code === 'DATASET_UNRESOLVED');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    openParquetFile(FIXTURE_URL, notParquet, { signal: controller.signal }),
    (err) => err.code === 'CANCELLED',
  );
});

test('readRows: a failed row read is DATASET_UNRESOLVED when not aborted, CANCELLED when the handle signal is aborted', async () => {
  const handle = await openParquetFile(FIXTURE_URL, fetchFixture, {});
  // Stand in for a read that dies in flight: the AsyncBuffer throws when
  // hyparquet asks it for bytes -- which is what an aborted range request
  // does, one layer down.
  const broken = {
    ...handle,
    file: {
      byteLength: handle.file.byteLength,
      slice: () => {
        throw new Error('The user aborted a request.');
      },
    },
  };

  await assert.rejects(readRows(broken, { rowStart: 0, rowEnd: 1 }), (err) => err.code === 'DATASET_UNRESOLVED');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readRows({ ...broken, signal: controller.signal }, { rowStart: 0, rowEnd: 1 }),
    (err) => err.code === 'CANCELLED',
  );
});

test('openParquetFile carries its signal onto the handle, so readRows can see it', async () => {
  const controller = new AbortController();
  const handle = await openParquetFile(FIXTURE_URL, fetchFixture, { signal: controller.signal });
  assert.equal(handle.signal, controller.signal);
});

// Why there is no end-to-end "cancel mid-row-group read" test here: the
// local fixtures are a couple of KB, which is under `openParquetFile`'s
// 65,536-byte `initialFetchSize`, so hyparquet satisfies the row read from
// the buffer the footer fetch already pulled -- measured: two fetches for
// planning, zero more for the read, with or without `Range` support in the
// stub. There is no in-flight request left to abort. The `readRows` test
// above covers the exact mapping that misreported, and the engine's own
// before/after-each-row-group `signal.aborted` checks (covered by
// download-handle.test.js's "cancel while running") cover the rest.

test('download(): cancelling during planning reports CANCELLED and state cancelled, not NETWORK/failed', async () => {
  const controller = new AbortController();
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    sink: memorySink(),
    signal: controller.signal,
    // The very first fetch of planning is the footer read; abort there.
    fetch: async () => {
      controller.abort('changed my mind');
      throw new Error('The user aborted a request.');
    },
  });

  await assert.rejects(handle.result, (err) => {
    assert.equal(err.code, 'CANCELLED', `expected CANCELLED, got ${err.code}: ${err.message}`);
    return true;
  });
  assert.equal(handle.state, 'cancelled');
});
