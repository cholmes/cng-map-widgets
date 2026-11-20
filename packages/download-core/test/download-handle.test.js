// DownloadHandle state machine (design doc §3.4/§3.5): planning -> blocked
// -> running -> paused -> done/cancelled/failed. Uses a fake Engine (no
// network) so this exercises the state machine itself, not the real
// parquet pruning/reading pipeline (covered separately by
// prune.test.js/partitions.test.js/bounded.test.js, and end-to-end by
// integration.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { download } from '../src/download.js';
import { memorySink } from '../src/sinks.js';
import { boundedExact } from '../src/bounded.js';
import { defaultCeiling } from '../src/ceiling.js';
import { registerLazyFormat, formatLoadState } from '../src/registry.js';
import { CancelledError, CeilingExceededError } from '@cng/spec';

const DATASET = { spec: 'cng-dataset/1.0', source: { kind: 'parquet', url: 'https://example.test/d.parquet' } };
const FILTER = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };
const OUTPUT = { spec: 'cng-output/1.0', format: 'geojson', filename: 'out.geojson' };

const MINIMAL_PLAN = {
  geometryColumn: 'geometry',
  table: { crs: 'OGC:CRS84', columns: [{ name: 'id', type: 'string' }, { name: 'geometry', type: 'geometry' }] },
  resolved: { attribution: [] },
  outputColumns: ['id', 'geometry'],
};

function makeEstimate(overrides = {}) {
  return {
    requestDigest: 'test',
    rows: boundedExact(0),
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

/** @param {{ runImpl?: Function }} opts */
function fakeEngine({ runImpl } = {}) {
  return {
    id: 'fake',
    capabilities: ['bbox', 'intersects'],
    async plan(dataset, area, filter) {
      return { dataset, area, filter, plan: MINIMAL_PLAN };
    },
    async run(enginePlan, onBatch, ctx) {
      if (runImpl) return runImpl(enginePlan, onBatch, ctx);
      return { rows: 0, readBytes: 0, requests: 0 };
    },
  };
}

test('happy path: planning -> running -> done, result resolves with a DownloadResult', async () => {
  const sink = memorySink();
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: fakeEngine(),
    sink,
    estimateOverride: makeEstimate(),
  });
  assert.equal(handle.state, 'planning');

  const states = [];
  handle.on('state', ({ state }) => states.push(state));

  const est = await handle.estimate;
  assert.equal(est.ceiling.exceeded, false);

  const result = await handle.result;
  assert.equal(handle.state, 'done');
  assert.equal(result.rows, 0);
  assert.ok(states.includes('running'));
  assert.ok(states.includes('done'));
  assert.equal(states.includes('blocked'), false);
});

test('blocked -> acceptCeiling() -> running -> done', async () => {
  const sink = memorySink();
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: fakeEngine(),
    sink,
    estimateOverride: makeEstimate({ ceiling: { exceeded: true, limits: defaultCeiling(), breaches: ['rows'] } }),
  });

  let sawCeilingEvent = false;
  handle.on('ceiling', () => {
    sawCeilingEvent = true;
  });

  await handle.estimate; // planning settles even though the ceiling is exceeded (design doc §3.4)
  // Give the internal run() a tick to reach the blocked gate.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(handle.state, 'blocked');
  assert.equal(sawCeilingEvent, true);

  const continued = handle.acceptCeiling();
  const result = await handle.result;
  assert.equal(handle.state, 'done');
  assert.equal(result.rows, 0);
  // `acceptCeiling()` hands back the continued run's promise -- the same
  // one `handle.result` now returns.
  assert.equal(await continued, result);
});

test("a blocked handle's result REJECTS with CeilingExceededError rather than waiting forever", async () => {
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: fakeEngine(),
    sink: memorySink(),
    estimateOverride: makeEstimate({ ceiling: { exceeded: true, limits: defaultCeiling(), breaches: ['rows', 'outputBytes'] } }),
  });

  // The whole point of the fix: an `await handle.result` with no prior
  // `handle.estimate` inspection used to hang forever. It now settles.
  const err = await handle.result.then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof CeilingExceededError, `expected CeilingExceededError, got ${err}`);
  assert.equal(err.code, 'CEILING_EXCEEDED');
  assert.equal(err.retryable, false);
  assert.deepEqual(err.context.breaches, ['rows', 'outputBytes']);
  assert.equal(err.context.estimate.ceiling.exceeded, true);
  // By the time a rejection handler runs (a microtask), the synchronous
  // state transition has already happened.
  assert.equal(handle.state, 'blocked');

  // ...and the run is still there to be continued.
  const result = await handle.acceptCeiling();
  assert.equal(handle.state, 'done');
  assert.equal(result.rows, 0);
});

test('acceptCeiling() from a synchronous ceiling handler works, and the rejected promise is the blocked one', async () => {
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: fakeEngine(),
    sink: memorySink(),
    estimateOverride: makeEstimate({ ceiling: { exceeded: true, limits: defaultCeiling(), breaches: ['rows'] } }),
  });
  const blocked = handle.result; // captured BEFORE the breach settles it
  handle.on('ceiling', () => handle.acceptCeiling());

  await assert.rejects(blocked, (e) => e.code === 'CEILING_EXCEEDED');
  const result = await handle.result; // the fresh promise acceptCeiling() installed
  assert.equal(result.rows, 0);
  assert.equal(handle.state, 'done');
});

test('acceptCeiling() on a handle that never blocked is a no-op returning the live result', async () => {
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: fakeEngine(),
    sink: memorySink(),
    estimateOverride: makeEstimate(),
  });
  assert.equal(await handle.acceptCeiling(), await handle.result);
  assert.equal(handle.state, 'done');
});

test('acceptCeiling: true at call time skips the blocked state entirely', async () => {
  const sink = memorySink();
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: fakeEngine(),
    sink,
    acceptCeiling: true,
    estimateOverride: makeEstimate({ ceiling: { exceeded: true, limits: defaultCeiling(), breaches: ['rows'] } }),
  });
  const states = [];
  handle.on('state', ({ state }) => states.push(state));
  await handle.result;
  assert.equal(states.includes('blocked'), false);
  assert.equal(handle.state, 'done');
});

test('cancel while blocked: state -> cancelled, and the promise keeps the CEILING_EXCEEDED it was already given', async () => {
  const sink = memorySink();
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: fakeEngine(),
    sink,
    estimateOverride: makeEstimate({ ceiling: { exceeded: true, limits: defaultCeiling(), breaches: ['outputBytes'] } }),
  });
  await handle.estimate;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(handle.state, 'blocked');

  await handle.cancel('user declined the ceiling');
  assert.equal(handle.state, 'cancelled');
  // The ceiling breach already settled this promise; declining afterwards
  // does not re-settle it with a different code underneath a caller who
  // is already holding it. `state` is the thing that says "cancelled".
  await assert.rejects(handle.result, (err) => err.code === 'CEILING_EXCEEDED');
});

test('cancel during planning: the handle can be cancelled before planning finishes', async () => {
  // A fake engine cannot honestly exercise the *reporting* half of this
  // (that a cancelled planning read says `CANCELLED` rather than
  // `NETWORK`/`DATASET_UNRESOLVED`), because the misreporting happened in
  // `parquet-io.js`'s wrapping of a real aborted fetch -- see
  // cancellation.test.js, which drives it through the real engine against
  // a local fixture. What this covers is the state machine: `cancel()`
  // during `'planning'` is possible at all, which is the entire reason
  // `download()` returns synchronously (design doc §3.4).
  let planStarted;
  const planRunning = new Promise((resolve) => {
    planStarted = resolve;
  });
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: {
      id: 'slow',
      capabilities: ['bbox', 'intersects'],
      async plan(dataset, area, filter, ctx) {
        planStarted();
        // Stand in for an in-flight footer fetch that rejects on abort.
        await new Promise((resolve, reject) => {
          if (ctx.signal?.aborted) reject(new CancelledError());
          ctx.signal?.addEventListener('abort', () => reject(new CancelledError()));
          setTimeout(resolve, 30_000).unref?.();
        });
        return { dataset, area, filter, plan: MINIMAL_PLAN };
      },
      async run() {
        return { rows: 0, readBytes: 0, requests: 0 };
      },
    },
    sink: memorySink(),
  });
  assert.equal(handle.state, 'planning');
  await planRunning; // cancel *while* planning is in flight, not before it starts
  await handle.cancel('changed my mind');
  assert.equal(handle.state, 'cancelled');
  await assert.rejects(handle.result, (err) => err instanceof CancelledError && err.code === 'CANCELLED');
});

test('cancel while running: cooperative cancellation aborts mid-flight, state -> cancelled', async () => {
  let rowGroupsProcessed = 0;
  const runImpl = async (enginePlan, onBatch, ctx) => {
    for (let i = 0; i < 100; i++) {
      if (ctx.signal?.aborted) throw new CancelledError();
      rowGroupsProcessed++;
      await ctx.onProgress({ phase: 'reading', rowGroupsDone: i, rowGroupsTotal: 100, bytesRead: 0, rowsScanned: 0, rowsMatched: 0, requests: i, bytesPerSecond: 0, etaMs: null });
    }
    return { rows: 0, readBytes: 0, requests: 100 };
  };
  const sink = memorySink();
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: fakeEngine({ runImpl }),
    sink,
    estimateOverride: makeEstimate(),
  });

  // Cancel shortly after it starts running, well before the fake loop of
  // 100 row groups would finish.
  await handle.estimate;
  handle.cancel('changed my mind');

  await assert.rejects(handle.result, (err) => err.code === 'CANCELLED');
  assert.equal(handle.state, 'cancelled');
  assert.ok(rowGroupsProcessed < 100, `expected cancellation before all row groups processed, got ${rowGroupsProcessed}`);
});

test('pause() / resume(): the run loop blocks at the next progress checkpoint until resumed', async () => {
  const seen = [];
  const runImpl = async (enginePlan, onBatch, ctx) => {
    for (let i = 0; i < 5; i++) {
      seen.push(i);
      await ctx.onProgress({ phase: 'reading', rowGroupsDone: i, rowGroupsTotal: 5, bytesRead: 0, rowsScanned: 0, rowsMatched: 0, requests: i, bytesPerSecond: 0, etaMs: null });
    }
    return { rows: 0, readBytes: 0, requests: 5 };
  };
  const sink = memorySink();
  const handle = download(DATASET, null, FILTER, OUTPUT, {
    engine: fakeEngine({ runImpl }),
    sink,
    estimateOverride: makeEstimate(),
  });

  const states = [];
  // Pause synchronously the *first* time 'running' fires (events are
  // emitted synchronously, design doc §3.5), so pause takes effect before
  // the fake engine's first row-group iteration completes -- no timing
  // race. Guarded so resume()'s own 'running' transition doesn't re-pause.
  let pausedOnce = false;
  handle.on('state', ({ state }) => {
    states.push(state);
    if (state === 'running' && !pausedOnce) {
      pausedOnce = true;
      handle.pause();
    }
  });
  await handle.estimate;
  assert.equal(handle.state, 'paused');
  // pause() was called synchronously off the 'running' state event, before
  // engine.run() was even invoked -- so the fake engine's first iteration
  // is guaranteed to block at its first onProgress checkpoint. Opening the
  // sink/format writer takes a few more real microtask turns than a single
  // `await`, though, so poll briefly for that first iteration to land
  // rather than asserting immediately.
  for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(seen.length, 1, 'exactly one row group should have started before the pause gate blocks it');
  const seenAtPause = seen.length;

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, seenAtPause, 'no further progress while paused');

  handle.resume();
  assert.equal(handle.state, 'running');
  const result = await handle.result;
  assert.equal(result.rows, 0);
  assert.ok(states.includes('paused'));
});

test('an unregistered output format fails fast with FORMAT_UNAVAILABLE', async () => {
  const handle = download(DATASET, null, FILTER, { ...OUTPUT, format: 'shapefile' }, {
    engine: fakeEngine(),
    sink: memorySink(),
  });
  await assert.rejects(handle.estimate, (err) => err.code === 'FORMAT_UNAVAILABLE');
  await assert.rejects(handle.result, (err) => err.code === 'FORMAT_UNAVAILABLE');
  assert.equal(handle.state, 'failed');
});

test('download() of a lazily-registered format loads it on first use, emitting a loading-format progress event', async () => {
  let loadCalls = 0;
  const lazyPlugin = {
    id: 'lazy-test-format',
    extension: 'lzt',
    mediaType: 'application/x-lazy-test',
    streaming: true,
    capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84'] },
    estimateBytes: (schema, rows) => ({ min: 0, max: 0, estimate: 0, exact: false }),
    async open(ctx) {
      let rows = 0;
      return {
        async writeBatch(batch) {
          rows += batch.rows;
        },
        async close() {
          return { rows, bytes: 0 };
        },
        async abort() {},
      };
    },
  };
  registerLazyFormat({
    id: 'lazy-test-format',
    extension: 'lzt',
    mediaType: 'application/x-lazy-test',
    streaming: true,
    capabilities: lazyPlugin.capabilities,
    approxBytes: { min: 500, max: 600 },
    estimateBytes: lazyPlugin.estimateBytes,
    load: async () => {
      loadCalls += 1;
      return lazyPlugin;
    },
  });

  assert.equal(formatLoadState('lazy-test-format'), 'idle', 'registering does not load it');

  const progressPhases = [];
  const handle = download(DATASET, null, FILTER, { ...OUTPUT, format: 'lazy-test-format' }, {
    engine: fakeEngine(),
    sink: memorySink(),
    estimateOverride: makeEstimate(),
  });
  handle.on('progress', (p) => progressPhases.push(p.phase));

  const result = await handle.result;
  assert.equal(result.rows, 0);
  assert.equal(loadCalls, 1, 'the heavy load() ran exactly once, triggered by this download');
  assert.ok(progressPhases.includes('loading-format'), 'UI-visible loading phase was emitted');
  assert.equal(formatLoadState('lazy-test-format'), 'loaded');

  // A second download of the same format must not load it again.
  const handle2 = download(DATASET, null, FILTER, { ...OUTPUT, format: 'lazy-test-format' }, {
    engine: fakeEngine(),
    sink: memorySink(),
    estimateOverride: makeEstimate(),
  });
  await handle2.result;
  assert.equal(loadCalls, 1, 'cached after the first load');
});

test('download() of a lazy format whose load() fails rejects with FORMAT_LOAD_FAILED', async () => {
  registerLazyFormat({
    id: 'lazy-fail-format',
    extension: 'lzf',
    mediaType: 'application/x-lazy-fail',
    streaming: true,
    capabilities: {},
    approxBytes: { min: 1, max: 1 },
    estimateBytes: () => ({ min: 0, max: 0, estimate: 0, exact: false }),
    load: async () => {
      throw new Error('simulated CDN fetch failure');
    },
  });

  const handle = download(DATASET, null, FILTER, { ...OUTPUT, format: 'lazy-fail-format' }, {
    engine: fakeEngine(),
    sink: memorySink(),
    estimateOverride: makeEstimate(),
  });
  await assert.rejects(handle.result, (err) => {
    assert.equal(err.code, 'FORMAT_LOAD_FAILED');
    return true;
  });
  assert.equal(handle.state, 'failed');
});

test('handle.id is unique per call and the handle is returned synchronously (before any await)', () => {
  const h1 = download(DATASET, null, FILTER, OUTPUT, { engine: fakeEngine(), sink: memorySink(), estimateOverride: makeEstimate() });
  const h2 = download(DATASET, null, FILTER, OUTPUT, { engine: fakeEngine(), sink: memorySink(), estimateOverride: makeEstimate() });
  assert.notEqual(h1.id, h2.id);
  assert.equal(h1.state, 'planning'); // synchronous return, before the internal run() has had a chance to progress
});
