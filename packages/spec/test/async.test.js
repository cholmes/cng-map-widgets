import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yieldToMain, forEachChunked } from '../src/yield.js';
import { visvalingamRing, simplifyToVertexCeiling } from '../src/simplify.js';
import { visvalingamRingAsync, simplifyToVertexCeilingAsync } from '../src/simplify-async.js';

// The cooperative-yielding helper (design doc task: "the main thread
// never blocks >50ms") and its use in the O(m log m) async Visvalingam
// simplifier that replaces the O(m^2) synchronous one on the
// background-upgrade path (see simplify-async.js's header comment for
// why the synchronous version is unusable on a raw full-resolution CGAZ
// ring).

test('yieldToMain: resolves', async () => {
  await yieldToMain(); // must not hang, must not throw
});

test('forEachChunked: visits every item exactly once, in order', async () => {
  const seen = [];
  await forEachChunked([1, 2, 3, 4, 5], (item, index) => seen.push([item, index]), { chunkSize: 2 });
  assert.deepEqual(seen, [[1, 0], [2, 1], [3, 2], [4, 3], [5, 4]]);
});

test('forEachChunked: yields at least once for a run longer than chunkSize', async () => {
  let yieldedBeforeLastItem = false;
  const n = 10;
  let processed = 0;
  const items = Array.from({ length: n }, (_, i) => i);
  const task = forEachChunked(items, () => { processed++; }, { chunkSize: 3 });
  // Give the event loop a chance to interleave if forEachChunked actually
  // yields control back (a non-yielding implementation would finish
  // synchronously before this microtask/timer ever runs).
  await Promise.resolve();
  if (processed < n) yieldedBeforeLastItem = true;
  await task;
  assert.equal(processed, n);
  assert.equal(yieldedBeforeLastItem, true, 'expected forEachChunked to still be mid-run after a microtask tick');
});

test('forEachChunked: honors an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => forEachChunked([1, 2, 3], () => {}, { signal: controller.signal }));
});

test('visvalingamRingAsync matches the synchronous visvalingamRing on the same input', async () => {
  // A 13-point near-circle ring -- small enough for the O(m^2) sync
  // version to be instant, which is what lets us compare the two
  // algorithms' output directly.
  const n = 13;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    ring.push([Math.cos(t), Math.sin(t)]);
  }
  ring.push(ring[0]);

  const tolerance = 0.02;
  const syncOut = visvalingamRing(ring, tolerance);
  const asyncOut = await visvalingamRingAsync(ring, tolerance, { chunkOps: 1 }); // chunkOps:1 forces a yield on nearly every removal
  assert.deepEqual(asyncOut, syncOut);
});

test('simplifyToVertexCeilingAsync matches simplifyToVertexCeiling on the same input', async () => {
  const n = 40;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    ring.push([Math.cos(t) * (1 + 0.05 * Math.sin(5 * t)), Math.sin(t) * (1 + 0.05 * Math.sin(5 * t))]);
  }
  ring.push(ring[0]);
  const geometry = { type: 'Polygon', coordinates: [ring] };

  const sync = simplifyToVertexCeiling(geometry, { vertexCeiling: 15, areaDeltaMaxRatio: 0.1 });
  const asyncResult = await simplifyToVertexCeilingAsync(geometry, { vertexCeiling: 15, areaDeltaMaxRatio: 0.1, chunkOps: 1 });

  assert.equal(asyncResult.method, sync.method);
  assert.equal(asyncResult.outputVertices, sync.outputVertices);
  assert.equal(asyncResult.degradedToBbox, sync.degradedToBbox);
  assert.deepEqual(asyncResult.geometry, sync.geometry);
});

test('simplifyToVertexCeilingAsync uses the vertex budget, not just fits it (2026-11-13 fix)', async () => {
  // Mirror of the sync test: the background-upgrade path is the one that
  // produced 17-vertex Poland filter geometry before the fix.
  const n = 5000;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    ring.push([Math.cos(t), Math.sin(t)]);
  }
  ring.push(ring[0]);
  const geometry = { type: 'Polygon', coordinates: [ring] };
  const result = await simplifyToVertexCeilingAsync(geometry, { vertexCeiling: 500, areaDeltaMaxRatio: 0.1 });
  assert.ok(result.outputVertices <= 500, `must fit the ceiling, got ${result.outputVertices}`);
  assert.ok(result.outputVertices >= 250, `must use most of the budget, got ${result.outputVertices}`);
  assert.ok(result.areaDeltaRatio < 0.01);
});

test('simplifyToVertexCeilingAsync: input already under the ceiling is returned untouched, no yielding needed', async () => {
  const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const result = await simplifyToVertexCeilingAsync(geometry, { vertexCeiling: 10_000 });
  assert.equal(result.method, 'none');
  assert.equal(result.geometry, geometry);
});

test('simplifyToVertexCeilingAsync: an aborted signal stops the run', async () => {
  const n = 2000;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    ring.push([Math.cos(t), Math.sin(t)]);
  }
  ring.push(ring[0]);
  const geometry = { type: 'Polygon', coordinates: [ring] };

  const controller = new AbortController();
  const task = simplifyToVertexCeilingAsync(geometry, { vertexCeiling: 10, chunkOps: 1, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => task);
});
