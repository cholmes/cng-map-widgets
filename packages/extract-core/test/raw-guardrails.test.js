// @cngeo/extract-core -- Task 8: raw-passthrough guard-rail warnings.
//
// Two honesty-layer warnings on top of Tasks 6/7's raw GeoParquet
// passthrough planning (`planRaw`/`rawEstimate` in raw.js):
//
//  - `raw-size-unknown`: at least one selected part's byte size could not
//    be resolved (no declared `bytes`, and a HEAD that failed or omitted
//    `content-length`). This is the case `enumerateStacItems`-built parts
//    hit routinely -- without this warning, the headline "tell the user
//    before anything is fetched that this is big" guard-rail silently does
//    nothing.
//  - `raw-no-pruning`: the filter asked for an area and/or time narrowing,
//    but partition-level pruning kept every file, because the surviving
//    parts declare no `bbox`/`interval` for that pruning to run against.
//
// Design doc §7.5, as the user chose directly: both "warn and proceed",
// never a ceiling breach and never a refusal (Ruling R9 for the first,
// echoed here for the second).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRaw, rawEstimate, RAW_FORMAT_ID } from '../src/raw.js';
import { download } from '../src/download.js';
import { memorySink } from '../src/sinks.js';

/** A ReadableStream over `bytes`, delivered in one chunk. */
function streamFromBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeBytes(length) {
  return Uint8Array.from({ length }, (_, i) => i % 256);
}

test('raw-size-unknown fires when any part size is unobtainable, and the estimate is inexact', async () => {
  const parts = [
    { url: 'https://example.test/guard/known-a.parquet', bytes: 100 },
    { url: 'https://example.test/guard/known-b.parquet', bytes: 200 },
    { url: 'https://example.test/guard/known-c.parquet', bytes: 300 },
    { url: 'https://example.test/guard/head-fails.parquet' }, // HEAD throws
    { url: 'https://example.test/guard/head-no-length.parquet' }, // HEAD ok, no content-length
  ];
  const fetchImpl = async (url) => {
    if (url === 'https://example.test/guard/head-fails.parquet') throw new Error('network down');
    if (url === 'https://example.test/guard/head-no-length.parquet') {
      return { ok: true, headers: { get: () => null } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: fetchImpl });
  const est = await rawEstimate(plan, {}, {});

  assert.equal(est.outputBytes.exact, false);
  const w = est.warnings.find((x) => x.code === 'raw-size-unknown');
  assert.ok(w, 'expected a raw-size-unknown warning');
  assert.equal(w.partsWithoutSize, 2);
  assert.equal(w.partsTotal, 5);
});

test('raw-size-unknown suppresses large-download and slow-download rather than guessing', async () => {
  const parts = [
    { url: 'https://example.test/guard/big-known.parquet', bytes: 1000 },
    { url: 'https://example.test/guard/unknown.parquet' },
  ];
  const fetchImpl = async (url) => {
    if (url === 'https://example.test/guard/unknown.parquet') {
      return { ok: true, headers: { get: () => null } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: fetchImpl });
  // Thresholds set so a KNOWN-only sum would trivially trip both warnings,
  // to prove the suppression is real and not just "the thresholds weren't met".
  const est = await rawEstimate(plan, {}, { largeDownloadBytes: 10, throughputBytesPerSecond: 1 });

  assert.equal(est.outputBytes.exact, false);
  assert.equal(est.warnings.some((x) => x.code === 'large-download'), false, 'no large-download code present');
  assert.equal(est.warnings.some((x) => x.code === 'slow-download'), false, 'no slow-download code present');
  assert.ok(est.warnings.some((x) => x.code === 'raw-size-unknown'), 'the honest replacement warning is still present');
});

test('large-download still fires on the raw path when every selected part size is known (no regression)', async () => {
  const parts = [{ url: 'https://example.test/guard/large-known.parquet', bytes: 5000 }];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: async () => { throw new Error('must not fetch'); } });
  const est = await rawEstimate(plan, {}, { largeDownloadBytes: 10 });

  assert.equal(est.outputBytes.exact, true);
  assert.ok(est.warnings.some((x) => x.code === 'large-download'), 'large-download must still fire when sizes are exact');
});

test('raw-no-pruning fires when an area narrowed nothing because parts declare no bbox', async () => {
  const parts = [
    { url: 'https://example.test/guard/nobbox-a.parquet', bytes: 10 },
    { url: 'https://example.test/guard/nobbox-b.parquet', bytes: 10 },
  ];
  const area = { bboxes: [[0, 0, 10, 10]] };

  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, area, {}, { fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal(plan.selected.length, parts.length, 'nothing was pruned: no part declares a bbox to test');

  const est = await rawEstimate(plan, {}, {});
  const w = est.warnings.find((x) => x.code === 'raw-no-pruning');
  assert.ok(w, 'expected a raw-no-pruning warning');
  assert.equal(w.basis, 'parts declare no bbox');
});

test('raw-no-pruning fires when a time range narrowed nothing because parts declare no interval', async () => {
  const parts = [
    { url: 'https://example.test/guard/nointerval-a.parquet', bytes: 10 },
    { url: 'https://example.test/guard/nointerval-b.parquet', bytes: 10 },
  ];
  const filter = { time: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' } };

  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, filter, { fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal(plan.selected.length, parts.length);

  const est = await rawEstimate(plan, filter, {});
  const w = est.warnings.find((x) => x.code === 'raw-no-pruning');
  assert.ok(w, 'expected a raw-no-pruning warning');
  assert.equal(w.basis, 'parts declare no interval');
});

test('raw-no-pruning does not fire when the filter asked for no narrowing', async () => {
  const parts = [
    { url: 'https://example.test/guard/noask-a.parquet', bytes: 10 },
    { url: 'https://example.test/guard/noask-b.parquet', bytes: 10 },
  ];

  // No area, no time: selected === parts trivially, but nothing was asked
  // for, so warning here would be noise.
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal(plan.selected.length, parts.length);

  const est = await rawEstimate(plan, {}, {});
  assert.equal(est.warnings.some((x) => x.code === 'raw-no-pruning'), false);
});

test('raw-no-pruning does not fire when the surviving parts actually declare the data that was checked', async () => {
  // The area was supplied and every selected part does declare a bbox
  // (and happens to intersect it) -- "nothing pruned" here is a genuine
  // full match, not a missing-declaration guard-rail case.
  const parts = [
    { url: 'https://example.test/guard/hasbbox-a.parquet', bytes: 10, bbox: [1, 1, 2, 2] },
    { url: 'https://example.test/guard/hasbbox-b.parquet', bytes: 10, bbox: [3, 3, 4, 4] },
  ];
  const area = { bboxes: [[0, 0, 10, 10]] };

  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, area, {}, { fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal(plan.selected.length, parts.length);

  const est = await rawEstimate(plan, {}, {});
  assert.equal(est.warnings.some((x) => x.code === 'raw-no-pruning'), false);
});

test('neither warning is a ceiling breach: the download still runs', async () => {
  const urlA = 'https://example.test/guard/run-a.parquet';
  const urlB = 'https://example.test/guard/run-b.parquet';
  const bytesA = fakeBytes(50);
  const bytesB = fakeBytes(60);
  const parts = [{ url: urlA }, { url: urlB }]; // no bbox, no declared bytes
  const dataset = { spec: 'cng-dataset/1.0', source: { kind: 'parquet-set', parts } };
  const area = { bboxes: [[0, 0, 10, 10]] };
  const filter = { spec: 'cng-filter/1.0' };

  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    if (method === 'HEAD') return { ok: true, headers: { get: () => null } }; // size unobtainable
    if (url === urlA) return { ok: true, status: 200, body: streamFromBytes(bytesA) };
    if (url === urlB) return { ok: true, status: 200, body: streamFromBytes(bytesB) };
    throw new Error(`unexpected fetch: ${url}`);
  };

  const plan = await planRaw(dataset, area, filter, { fetch: fetchImpl });
  const est = await rawEstimate(plan, filter, {});

  assert.ok(est.warnings.some((x) => x.code === 'raw-size-unknown'));
  assert.ok(est.warnings.some((x) => x.code === 'raw-no-pruning'));
  assert.equal(est.ceiling.exceeded, false);

  const sink = memorySink();
  const handle = download(dataset, area, filter, { spec: 'cng-output/1.0', format: RAW_FORMAT_ID }, { sink, fetch: fetchImpl });
  const result = await handle.result;
  assert.equal(result.bytes > 0, true);
});
