// @cngeo/extract-core -- regression tests for the pre-0.3.0 code review.
//
// One test (or small group) per finding, each written to fail against the
// code as it stood before the fix:
//
//   1. a cancel during raw size resolution was swallowed with the HEAD's
//      network errors, and the ceiling gate armed after a cancel
//   2. a multi-file raw estimate said `exact` but left out ATTRIBUTION.txt
//   3. estimate() for a not-yet-loaded lazy format ignored its descriptor
//   4. size-resolving HEADs ran serially, and ran even past the files ceiling
//   5. the raw path never raised `share-alike`
//   6. a sink whose abort() throws left `handle.result` pending forever
//   7. a blobSink({ maxBytes }) larger than the default was clamped to it
//   8. the row ceiling refused a byte copy that decodes no rows
//   9. `filter.time` pruned row groups but was never tested per row

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRaw, rawEstimate, RAW_FORMAT_ID } from '../src/raw.js';
import { download } from '../src/download.js';
import { memorySink, blobSink } from '../src/sinks.js';
import { effectiveCeiling, UNBOUNDED_BYTES } from '../src/ceiling.js';
import { finalizeEstimate } from '../src/estimate.js';
import { registerLazyFormat } from '../src/registry.js';
import { timeRowPredicate } from '../src/prune.js';
import { boundedExact } from '../src/bounded.js';

const OUTPUT = { spec: 'cng-output/1.0', format: RAW_FORMAT_ID };
const FILTER = { spec: 'cng-filter/1.0' };
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

function partsDataset(parts, extra = {}) {
  return { spec: 'cng-dataset/1.0', id: 'review', source: { kind: 'parquet-set', parts }, ...extra };
}

function bodyOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** HEAD answers `content-length`; GET streams `length` bytes. */
function sizedFetch(length = 64) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (init.method === 'HEAD') return { ok: true, headers: { get: (h) => (h === 'content-length' ? String(length) : null) } };
    return { ok: true, status: 200, body: bodyOf(Uint8Array.from({ length }, (_, i) => i % 251)) };
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

// --- 1. cancel during size resolution ------------------------------------

test('planRaw rejects CANCELLED when the signal aborts during a HEAD, instead of returning a plan', async () => {
  const controller = new AbortController();
  const parts = [{ url: 'https://example.test/r/a.parquet' }, { url: 'https://example.test/r/b.parquet' }];
  // A fetch that fails the way an aborted one does: the abort lands, then it throws.
  const fetchImpl = async () => {
    controller.abort('user cancelled');
    throw new DOMException('aborted', 'AbortError');
  };
  await assert.rejects(
    planRaw(partsDataset(parts), null, FILTER, { fetch: fetchImpl, signal: controller.signal }),
    (err) => err.code === 'CANCELLED',
  );
});

test('a HEAD that fails WITHOUT an abort still just leaves that size unknown', async () => {
  const parts = [{ url: 'https://example.test/r/a.parquet' }];
  const plan = await planRaw(partsDataset(parts), null, FILTER, {
    fetch: async () => {
      throw new Error('CORS');
    },
  });
  assert.equal(plan.sizes.get(parts[0].url), null);
});

test('cancel() while sizes are resolving ends the run: no sink opened, no blocked gate, cancel() resolves', async () => {
  const parts = [{ url: 'https://example.test/r/a.parquet' }, { url: 'https://example.test/r/b.parquet' }];
  // A fetch that IGNORES the signal entirely, so only download()'s own
  // check can notice the cancel.
  /** @type {(() => void)[]} one per in-flight HEAD -- they run concurrently */
  const releaseHeads = [];
  let markHeadStarted;
  const headStarted = new Promise((resolve) => {
    markHeadStarted = resolve;
  });
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'HEAD') {
      markHeadStarted();
      await new Promise((resolve) => {
        releaseHeads.push(resolve);
      });
      return { ok: true, headers: { get: () => '10' } };
    }
    throw new Error('no GET should ever be issued after a cancel');
  };
  const sink = memorySink();
  let opened = false;
  const realOpen = sink.open.bind(sink);
  sink.open = async (meta) => {
    opened = true;
    return realOpen(meta);
  };

  // `outputBytes: 1` guarantees a ceiling breach, the case that used to
  // leave the handle `blocked` with cancel() never resolving.
  const handle = download(partsDataset(parts), null, FILTER, OUTPUT, { sink, fetch: fetchImpl, ceiling: { outputBytes: 1 } });
  await headStarted;
  const cancelled = handle.cancel('user cancelled');
  for (const release of releaseHeads) release();
  await cancelled; // hung forever before the fix

  assert.equal(handle.state, 'cancelled');
  assert.equal(opened, false);
  await assert.rejects(handle.result, (err) => err.code === 'CANCELLED');
});

// --- 2. exact multi-file size --------------------------------------------

test('a multi-file raw estimate that says exact matches the bytes actually written', async () => {
  const parts = Array.from({ length: 5 }, (_, i) => ({ url: `https://example.test/hive/year=${2020 + i}/part.parquet`, bytes: 64 }));
  const dataset = partsDataset(parts, {
    attribution: [{ text: 'Example Data', license: 'CC-BY-4.0', url: 'https://example.test/licence', shareAlike: false }],
  });
  const fetchImpl = sizedFetch(64);
  const sink = memorySink();
  const result = await download(dataset, null, FILTER, OUTPUT, { sink, fetch: fetchImpl }).result;

  assert.equal(result.estimate.outputBytes.exact, true);
  assert.equal(result.estimate.outputBytes.estimate, result.bytes);
});

// --- 3. lazy format descriptor -------------------------------------------

function minimalPlan() {
  return {
    geometryColumn: 'geometry',
    table: { crs: 'OGC:CRS84', columns: [{ name: 'id', type: 'string' }, { name: 'geometry', type: 'geometry' }] },
    resolved: { attribution: [] },
    outputColumns: ['id', 'geometry'],
    readColumns: ['id', 'geometry'],
    covering: { kind: 'none' },
    perPart: [],
    partStages: [],
    rowGroupBboxStage: { stage: 'row-group-bbox', before: 0, after: 0, basis: 'no area supplied' },
    rowGroupStatsStage: { stage: 'row-group-stats', before: 0, after: 0, basis: 'no time filter' },
    rowGroupWhereStage: { stage: 'row-group-where', before: 0, after: 0, basis: 'no where filter' },
    whereDecidable: false,
    whereStatsSeen: false,
    avgGeometryBytes: null,
    parts: [{ url: 'https://example.test/d.parquet' }],
    selectedParts: [{ url: 'https://example.test/d.parquet' }],
    allRowGroupsTotal: 1,
    selectedRowGroupsTotal: 1,
    maxRowsBeforeLimit: 10,
    rows: boundedExact(10),
    readBytes: boundedExact(100),
    requests: 1,
  };
}

test('estimate for an unloaded lazy format uses its descriptor: its estimateBytes and its streaming ceiling', async () => {
  let loaded = false;
  registerLazyFormat({
    id: 'review-lazy-streaming',
    label: 'Review lazy',
    extension: 'rls',
    mediaType: 'text/plain',
    streaming: true,
    capabilities: { memoryFactor: 0 },
    approxBytes: 1,
    estimateBytes: () => boundedExact(500 * MiB),
    load: async () => {
      loaded = true;
      throw new Error('estimate() must never load a format');
    },
  });
  const est = await finalizeEstimate(minimalPlan(), null, FILTER, {
    output: { spec: 'cng-output/1.0', format: 'review-lazy-streaming' },
    sink: { kind: 'filesystem' },
  });
  assert.equal(loaded, false);
  assert.equal(est.outputBytes.estimate, 500 * MiB); // the descriptor's model, not the generic one
  assert.equal(est.ceiling.limits.outputBytes, UNBOUNDED_BYTES); // streaming, not the factor-3 ~341 MiB
  assert.equal(est.ceiling.exceeded, false);
});

test('a lazy descriptor with no estimateBytes still supplies the ceiling, and does not throw', async () => {
  registerLazyFormat({
    id: 'review-lazy-nomodel',
    extension: 'rln',
    mediaType: 'text/plain',
    streaming: true,
    capabilities: { memoryFactor: 0 },
    approxBytes: 1,
    load: async () => {
      throw new Error('never loaded');
    },
  });
  const est = await finalizeEstimate(minimalPlan(), null, FILTER, {
    output: { spec: 'cng-output/1.0', format: 'review-lazy-nomodel' },
    sink: { kind: 'filesystem' },
  });
  assert.equal(est.ceiling.limits.outputBytes, UNBOUNDED_BYTES);
});

// --- 4. HEAD concurrency and the files ceiling ---------------------------

test('size-resolving HEADs run concurrently, bounded, and every part still gets its size', async () => {
  const parts = Array.from({ length: 40 }, (_, i) => ({ url: `https://example.test/c/${i}.parquet` }));
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return { ok: true, headers: { get: () => '7' } };
  };
  const plan = await planRaw(partsDataset(parts), null, FILTER, { fetch: fetchImpl });
  assert.ok(peak > 1, `expected concurrent HEADs, peak in flight was ${peak}`);
  assert.ok(peak <= 8, `expected at most 8 in flight, saw ${peak}`);
  assert.equal(plan.requests, 40);
  assert.deepEqual([...plan.sizes.keys()], parts.map((p) => p.url)); // selection order preserved
  assert.ok([...plan.sizes.values()].every((s) => s === 7));
});

test('a selection over the files ceiling issues no HEADs at all, and is refused on files', async () => {
  const parts = Array.from({ length: 5 }, (_, i) => ({ url: `https://example.test/f/${i}.parquet` }));
  let heads = 0;
  const fetchImpl = async () => {
    heads += 1;
    return { ok: true, headers: { get: () => '7' } };
  };
  const options = { fetch: fetchImpl, ceiling: { files: 3 } };
  const plan = await planRaw(partsDataset(parts), null, FILTER, options);
  const est = await rawEstimate(plan, FILTER, options);
  assert.equal(heads, 0);
  assert.deepEqual(est.ceiling.breaches, ['files']);
  assert.ok(est.warnings.some((w) => w.code === 'raw-size-unknown'));
});

// --- 5. share-alike on the raw path --------------------------------------

test('a raw estimate raises share-alike, reading either key style', async () => {
  for (const key of ['shareAlike', 'share_alike']) {
    const dataset = partsDataset([{ url: 'https://example.test/s/a.parquet', bytes: 10 }], {
      attribution: [
        { text: 'OpenStreetMap contributors', license: 'ODbL-1.0', [key]: true },
        { text: 'Permissive', license: 'CC-BY-4.0', [key]: false },
      ],
    });
    const plan = await planRaw(dataset, null, FILTER, { fetch: sizedFetch() });
    const est = await rawEstimate(plan, FILTER, {});
    const w = est.warnings.find((x) => x.code === 'share-alike');
    assert.ok(w, `expected share-alike with ${key}`);
    assert.equal(w.attribution.length, 1);
    assert.equal(w.attribution[0].license, 'ODbL-1.0');
  }
});

test('no share-alike warning when nothing is share-alike', async () => {
  const dataset = partsDataset([{ url: 'https://example.test/s/a.parquet', bytes: 10 }], {
    attribution: [{ text: 'Permissive', license: 'CC-BY-4.0', shareAlike: false }],
  });
  const plan = await planRaw(dataset, null, FILTER, { fetch: sizedFetch() });
  const est = await rawEstimate(plan, FILTER, {});
  assert.equal(est.warnings.some((w) => w.code === 'share-alike'), false);
});

// --- 6. a sink whose abort() throws --------------------------------------

test('a failed download still rejects result when the host sink\'s abort() throws', async () => {
  const sink = {
    kind: 'stream',
    async open() {
      throw new Error('disk full');
    },
    async close() {},
    async abort() {
      throw new TypeError("Cannot read properties of undefined (reading 'abort')");
    },
  };
  const parts = [{ url: 'https://example.test/x/a.parquet', bytes: 10 }];
  const handle = download(partsDataset(parts), null, FILTER, OUTPUT, { sink, fetch: sizedFetch(10) });
  const outcome = await Promise.race([
    handle.result.then(
      () => 'resolved',
      (err) => err,
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 500)),
  ]);
  assert.notEqual(outcome, 'pending', 'handle.result never settled');
  assert.match(outcome.message, /disk full/);
  assert.equal(handle.state, 'failed');
});

// --- 7. blobSink({ maxBytes }) -------------------------------------------

test('effectiveCeiling honours a blob sink\'s own maxBytes instead of clamping to the default', () => {
  const streaming = { streaming: true, capabilities: { memoryFactor: 0 } };
  const buffering = { streaming: false, capabilities: { memoryFactor: 2 } };

  assert.equal(effectiveCeiling({ format: streaming, sink: blobSink({ maxBytes: GiB }) }).outputBytes, GiB);
  assert.equal(effectiveCeiling({ format: streaming, sink: blobSink({ maxBytes: 64 * MiB }) }).outputBytes, 64 * MiB);
  // Buffering: min(memoryBudget / factor, the sink's real limit).
  assert.equal(effectiveCeiling({ format: buffering, sink: blobSink({ maxBytes: GiB }) }).outputBytes, 512 * MiB);
  assert.equal(effectiveCeiling({ format: buffering, sink: blobSink({ maxBytes: 64 * MiB }) }).outputBytes, 64 * MiB);

  // Unchanged: the default sink, a bare { kind } stand-in, and an explicit override.
  assert.equal(effectiveCeiling({ format: streaming, sink: blobSink() }).outputBytes, 256 * MiB);
  assert.equal(effectiveCeiling({ format: streaming, sink: { kind: 'blob' } }).outputBytes, 256 * MiB);
  assert.equal(effectiveCeiling({ format: streaming, sink: blobSink({ maxBytes: GiB }), overrides: { blobBytes: 8 * MiB } }).outputBytes, 8 * MiB);
});

// --- 8. no row ceiling on a byte copy ------------------------------------

test('raw passthrough is not refused on rows: declared row counts over the ceiling still pass', async () => {
  const parts = [
    { url: 'https://example.test/rows/a.parquet', bytes: 100, rowCount: 100_000_000 },
    { url: 'https://example.test/rows/b.parquet', bytes: 100, rowCount: 100_000_000 },
  ];
  const plan = await planRaw(partsDataset(parts), null, FILTER, { fetch: sizedFetch() });
  const est = await rawEstimate(plan, FILTER, { sink: { kind: 'filesystem' } });
  assert.equal(est.rows.estimate, 200_000_000); // still reported
  assert.deepEqual(est.ceiling.breaches, []);
  assert.equal(est.ceiling.exceeded, false);
});

// --- 9. filter.time, per row ---------------------------------------------

test('timeRowPredicate applies the window per row, honouring closed', () => {
  const start = '2026-09-01T00:00:00Z';
  const end = '2026-09-08T00:00:00Z';
  const at = (iso) => new Date(iso);

  const halfOpen = timeRowPredicate({ start, end }); // default '[)'
  assert.equal(halfOpen(at(start)), true);
  assert.equal(halfOpen(at('2026-09-04T12:00:00Z')), true);
  assert.equal(halfOpen(at(end)), false);
  assert.equal(halfOpen(at('2026-08-31T23:59:59Z')), false);
  assert.equal(halfOpen(at('2026-09-08T00:00:01Z')), false);

  const closed = timeRowPredicate({ start, end, closed: '[]' });
  assert.equal(closed(at(end)), true);
  const open = timeRowPredicate({ start, end, closed: '()' });
  assert.equal(open(at(start)), false);

  // Every decoded representation a time cell can arrive in.
  assert.equal(halfOpen('2026-09-04T12:00:00Z'), true);
  assert.equal(halfOpen(Date.parse('2026-09-04T12:00:00Z')), true);
  assert.equal(halfOpen(BigInt(Date.parse('2026-09-09T00:00:00Z'))), false);

  // One-sided windows.
  assert.equal(timeRowPredicate({ start })(at('2030-01-01T00:00:00Z')), true);
  assert.equal(timeRowPredicate({ end })(at('1990-01-01T00:00:00Z')), true);

  // A null time is in no window; an unreadable one is not dropped.
  assert.equal(halfOpen(null), false);
  assert.equal(halfOpen(undefined), false);
  assert.equal(halfOpen({ not: 'a time' }), true);

  // Nothing to test.
  assert.equal(timeRowPredicate(undefined), null);
  assert.equal(timeRowPredicate({}), null);
});

test('adjacent [) windows tile: every instant lands in exactly one', () => {
  const week1 = timeRowPredicate({ start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z' });
  const week2 = timeRowPredicate({ start: '2026-09-08T00:00:00Z', end: '2026-09-15T00:00:00Z' });
  for (const iso of ['2026-09-07T23:59:59.999Z', '2026-09-08T00:00:00Z', '2026-09-08T00:00:00.001Z']) {
    const d = new Date(iso);
    assert.equal(Number(week1(d)) + Number(week2(d)), 1, iso);
  }
});
