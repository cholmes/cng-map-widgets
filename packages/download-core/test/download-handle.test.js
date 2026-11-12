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
import { CancelledError } from '@cnmw/spec';

const DATASET = { spec: 'cnmw-dataset/1.0', source: { kind: 'parquet', url: 'https://example.test/d.parquet' } };
const FILTER = { spec: 'cnmw-filter/1.0', spatial: { mode: 'bbox' } };
const OUTPUT = { spec: 'cnmw-output/1.0', format: 'geojson', filename: 'out.geojson' };

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

  handle.acceptCeiling();
  const result = await handle.result;
  assert.equal(handle.state, 'done');
  assert.equal(result.rows, 0);
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

test('cancel while blocked: result rejects with CancelledError, state -> cancelled', async () => {
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
  await assert.rejects(handle.result, (err) => err instanceof CancelledError || err.code === 'CANCELLED');
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

test('handle.id is unique per call and the handle is returned synchronously (before any await)', () => {
  const h1 = download(DATASET, null, FILTER, OUTPUT, { engine: fakeEngine(), sink: memorySink(), estimateOverride: makeEstimate() });
  const h2 = download(DATASET, null, FILTER, OUTPUT, { engine: fakeEngine(), sink: memorySink(), estimateOverride: makeEstimate() });
  assert.notEqual(h1.id, h2.id);
  assert.equal(h1.state, 'planning'); // synchronous return, before the internal run() has had a chance to progress
});
