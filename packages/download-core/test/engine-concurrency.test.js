// Item 5: the hyparquet engine reads row groups in parallel with bounded
// concurrency (`DownloadCoreOptions.maxConcurrentRequests`, default 12)
// while still delivering batches in strict row-group order.
//
// Every test here runs the production engine against a real parquet file
// served over a fake, latency-controlled `fetch` (see
// helpers/fake-parquet-host.js) -- the only faked thing is the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/hyparquet-setup.js';
import { createHyparquetEngine, DEFAULT_MAX_CONCURRENT_REQUESTS } from '../src/engine-hyparquet.js';
import { openFakeHostedParquet, enginePlanFor } from './helpers/fake-parquet-host.js';

/** Collect the ids every batch delivered, in delivery order. */
async function runCollect(enginePlan, ctx = {}) {
  const engine = createHyparquetEngine();
  const ids = [];
  const batchSizes = [];
  const progress = [];
  const result = await engine.run(
    enginePlan,
    async (batch) => {
      batchSizes.push(batch.rows);
      for (const v of batch.columns.id) ids.push(v);
    },
    {
      onProgress(p) {
        progress.push({ ...p });
      },
      ...ctx,
    },
  );
  return { result, ids, batchSizes, progress };
}

test('default maxConcurrentRequests is 12 (design doc §3.4)', () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_REQUESTS, 12);
});

test('onBatch delivery order is row-group order even when later reads finish first', async () => {
  // Request ordinal 0..1 are the footer reads; the row-group reads follow.
  // Make each successive read *faster* than the one before, so completion
  // order is the exact reverse of row-group order.
  const { handle } = await openFakeHostedParquet({
    groups: 8,
    rowsPerGroup: 5,
    delayMs: (ordinal) => Math.max(0, 200 - ordinal * 20),
  });

  const parallel = await runCollect(enginePlanFor({ handle }), { maxConcurrentRequests: 8 });
  const sequential = await runCollect(enginePlanFor({ handle }), { maxConcurrentRequests: 1 });

  assert.deepEqual(parallel.ids, sequential.ids, 'parallel delivery must be byte-identical in order to the sequential run');
  assert.equal(parallel.ids.length, 40);
  assert.equal(parallel.ids[0], 'g0-r0');
  assert.equal(parallel.ids[39], 'g7-r4');
  // and strictly ascending by group then row, i.e. the file's own order
  assert.deepEqual(
    parallel.ids,
    Array.from({ length: 8 }, (_, g) => Array.from({ length: 5 }, (_, r) => `g${g}-r${r}`)).flat(),
  );
  assert.deepEqual(parallel.batchSizes, sequential.batchSizes);
});

test('parallel reads really are concurrent: 8 slow row groups finish in about one read time', async () => {
  const log = [];
  const { handle } = await openFakeHostedParquet({ groups: 8, rowsPerGroup: 5, delayMs: () => 120, log });

  const t0 = performance.now();
  const parallel = await runCollect(enginePlanFor({ handle }), { maxConcurrentRequests: 8 });
  const parallelMs = performance.now() - t0;

  const t1 = performance.now();
  const sequential = await runCollect(enginePlanFor({ handle }), { maxConcurrentRequests: 1 });
  const sequentialMs = performance.now() - t1;

  assert.deepEqual(parallel.ids, sequential.ids);
  assert.ok(
    parallelMs < sequentialMs / 2,
    `expected the 8-way parallel run to beat the sequential one by more than 2x; got ${Math.round(parallelMs)}ms vs ${Math.round(sequentialMs)}ms`,
  );
});

test('read-ahead is bounded by maxConcurrentRequests, so a slow group 0 cannot pull the plan into memory', async () => {
  // Group 0's read (request ordinal 2, after the two footer reads) takes
  // far longer than every other read, so without a bound the pool would
  // race ahead and buffer all 19 later groups while group 0 is in flight.
  const log = [];
  const { handle } = await openFakeHostedParquet({
    groups: 20,
    rowsPerGroup: 4,
    delayMs: (ordinal) => (ordinal === 2 ? 300 : 5),
    log,
  });
  const rowGroupLog = [];
  const engine = createHyparquetEngine();
  await engine.run(enginePlanFor({ handle }), async () => {}, {
    maxConcurrentRequests: 4,
    onProgress(p) {
      rowGroupLog.push({ done: p.rowGroupsDone, started: log.length });
    },
  });

  // At the moment the first row group was delivered, no more than
  // `concurrency` row-group reads may have been *started* (log includes
  // the 2 footer requests).
  const atFirstDelivery = rowGroupLog[0];
  assert.ok(
    atFirstDelivery.started - 2 <= 4,
    `expected at most 4 row-group reads started before the first delivery, got ${atFirstDelivery.started - 2}`,
  );
});

test('progress counters stay monotonic and end on the same totals as a sequential run', async () => {
  const { handle } = await openFakeHostedParquet({ groups: 10, rowsPerGroup: 6, delayMs: (o) => Math.max(0, 100 - o * 10) });

  const par = await runCollect(enginePlanFor({ handle }), { maxConcurrentRequests: 10 });
  const seq = await runCollect(enginePlanFor({ handle }), { maxConcurrentRequests: 1 });

  for (const run of [par, seq]) {
    let prev = { rowGroupsDone: 0, requests: 0, bytesRead: 0, rowsScanned: 0, rowsMatched: 0 };
    for (const p of run.progress) {
      for (const k of Object.keys(prev)) {
        assert.ok(p[k] >= prev[k], `${k} went backwards: ${prev[k]} -> ${p[k]}`);
      }
      assert.equal(p.rowGroupsTotal, 10);
      prev = p;
    }
  }
  const lastPar = par.progress.at(-1);
  const lastSeq = seq.progress.at(-1);
  assert.deepEqual(lastPar, lastSeq);
  assert.equal(lastPar.rowGroupsDone, 10);
  assert.deepEqual(par.result, seq.result);
  assert.equal(par.result.requests, 10);
});

test('filter.limit stops work early and yields exactly the sequential run\'s rows', async () => {
  const { handle } = await openFakeHostedParquet({ groups: 12, rowsPerGroup: 5, delayMs: (o) => Math.max(0, 120 - o * 8) });
  const filter = { spec: 'cnmw-filter/1.0', spatial: { mode: 'bbox' }, limit: 13 };

  const par = await runCollect(enginePlanFor({ handle, filter }), { maxConcurrentRequests: 6, limit: 13 });
  const seq = await runCollect(enginePlanFor({ handle, filter }), { maxConcurrentRequests: 1, limit: 13 });

  assert.equal(par.result.rows, 13);
  assert.deepEqual(par.ids, seq.ids);
  assert.deepEqual(par.ids.at(-1), 'g2-r2');
  // Three row groups (5 + 5 + 3) is all either run needed; the parallel
  // run must not *report* more than the sequential one did.
  assert.equal(seq.result.requests, 3);
  assert.equal(par.result.requests, 3);
  assert.equal(par.result.readBytes, seq.result.readBytes);
  assert.ok(par.progress.length <= 3);
});

test('a limit that lands exactly on a row-group boundary matches the sequential run', async () => {
  const { handle } = await openFakeHostedParquet({ groups: 6, rowsPerGroup: 5, delayMs: () => 10 });
  const filter = { spec: 'cnmw-filter/1.0', spatial: { mode: 'bbox' }, limit: 10 };
  const par = await runCollect(enginePlanFor({ handle, filter }), { maxConcurrentRequests: 6, limit: 10 });
  const seq = await runCollect(enginePlanFor({ handle, filter }), { maxConcurrentRequests: 1, limit: 10 });
  assert.deepEqual(par.ids, seq.ids);
  assert.equal(par.result.rows, 10);
  assert.equal(par.result.requests, seq.result.requests);
});

test('signal.aborted mid-run rejects with CANCELLED and leaves no read unhandled', async () => {
  const controller = new AbortController();
  const { handle } = await openFakeHostedParquet({ groups: 20, rowsPerGroup: 4, delayMs: () => 20, signal: controller.signal });
  const engine = createHyparquetEngine();

  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    let delivered = 0;
    await assert.rejects(
      engine.run(enginePlanFor({ handle }), async () => {
        delivered += 1;
        if (delivered === 2) controller.abort('user cancelled');
      }, { signal: controller.signal, maxConcurrentRequests: 6 }),
      (err) => err.code === 'CANCELLED',
    );
    // give any abandoned read a tick to reject
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('pause() stops further reads, not just delivery', async () => {
  const log = [];
  const { handle } = await openFakeHostedParquet({ groups: 20, rowsPerGroup: 4, delayMs: () => 5, log });
  const engine = createHyparquetEngine();

  let paused = null;
  let resume = null;
  const run = engine.run(enginePlanFor({ handle }), async () => {}, {
    maxConcurrentRequests: 4,
    async onProgress(p) {
      if (p.rowGroupsDone === 2 && !paused) {
        paused = new Promise((r) => {
          resume = r;
        });
      }
      if (paused) await paused;
    },
  });

  // Let the pause settle, then record how many reads have been issued and
  // confirm it does not grow while paused.
  await new Promise((r) => setTimeout(r, 120));
  const startedWhilePaused = log.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(log.length, startedWhilePaused, 'a paused run must not start new row-group reads');
  // at most 2 footer reads + the 2 delivered + the bounded read-ahead
  assert.ok(startedWhilePaused - 2 <= 2 + 4, `read-ahead while paused should stay bounded, got ${startedWhilePaused - 2}`);

  resume();
  const result = await run;
  assert.equal(result.requests, 20);
});

test('a failing read surfaces one error and does not leave siblings unhandled-rejecting', async () => {
  const bad = await openFakeHostedParquet({ groups: 12, rowsPerGroup: 4, delayMs: () => 10 });
  // Break the AsyncBuffer underneath every read *after* the footer is
  // already parsed, so several in-flight reads fail at once.
  const realSlice = bad.handle.file.slice.bind(bad.handle.file);
  let sliceCount = 0;
  bad.handle.file.slice = async (start, end) => {
    sliceCount += 1;
    if (sliceCount > 1) throw new Error('synthetic range-read failure');
    return realSlice(start, end);
  };

  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const engine = createHyparquetEngine();
    await assert.rejects(
      engine.run(enginePlanFor({ handle: bad.handle }), async () => {}, { maxConcurrentRequests: 6 }),
      (err) => err.code === 'DATASET_UNRESOLVED',
    );
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('maxConcurrentRequests: 1 is the old sequential behaviour, one read at a time', async () => {
  const log = [];
  const { handle } = await openFakeHostedParquet({ groups: 6, rowsPerGroup: 3, delayMs: () => 20, log });
  const engine = createHyparquetEngine();
  const inFlightMax = { n: 0 };
  let inFlight = 0;
  const realSlice = handle.file.slice.bind(handle.file);
  handle.file.slice = async (s, e) => {
    inFlight += 1;
    inFlightMax.n = Math.max(inFlightMax.n, inFlight);
    try {
      return await realSlice(s, e);
    } finally {
      inFlight -= 1;
    }
  };
  await engine.run(enginePlanFor({ handle }), async () => {}, { maxConcurrentRequests: 1 });
  assert.equal(inFlightMax.n, 1);
});

test('an empty plan (every row group pruned) returns zero totals', async () => {
  const { handle } = await openFakeHostedParquet({ groups: 4, rowsPerGroup: 2 });
  const engine = createHyparquetEngine();
  const result = await engine.run(enginePlanFor({ handle, rowGroups: [] }), async () => {
    throw new Error('onBatch must not be called');
  }, {});
  assert.deepEqual(result, { rows: 0, readBytes: 0, requests: 0 });
});
