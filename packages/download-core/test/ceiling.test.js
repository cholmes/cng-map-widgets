// @cng/download-core -- `effectiveCeiling` and `memoryFactorOf` (design
// doc amendment: ceilings derived from a format's memory cost per output
// byte and whether the sink is memory-backed, rather than one flat
// number). `defaultCeiling()` is also covered here as the compat shim
// existing callers (estimate.js) still depend on unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultCeiling, effectiveCeiling, memoryFactorOf } from '../src/ceiling.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const streaming = { streaming: true, capabilities: {} };
const gpkgLike = { streaming: false, capabilities: { memoryFactor: 3.5 } };

test('memoryFactorOf defaults to 0 for streaming and 3 for buffering', () => {
  assert.equal(memoryFactorOf(streaming), 0);
  assert.equal(memoryFactorOf({ streaming: false, capabilities: {} }), 3);
});

test('a streaming format on a disk-backed sink is effectively unbounded', () => {
  const c = effectiveCeiling({ format: streaming, sink: { kind: 'filesystem' } });
  assert.equal(c.outputBytes, 1024 ** 4);
});

test('a streaming format on a blob sink is capped at blobBytes', () => {
  const c = effectiveCeiling({ format: streaming, sink: { kind: 'blob' } });
  assert.equal(c.outputBytes, 256 * MiB);
});

test('memorySink is exempt from the memory budget', () => {
  const c = effectiveCeiling({ format: streaming, sink: { kind: 'memory' } });
  assert.equal(c.outputBytes, 1024 ** 4);
});

// A literal descriptor shape, not a cross-package import: download-core
// doesn't depend on format-gpkg, and that import only ever worked here
// via workspace hoisting. The "gpkg actually declares 3.5" assertion
// lives in format-gpkg's own test suite instead, where that dependency
// is natural (format-gpkg already has @cng/download-core as a
// devDependency for memoryFactorOf itself).
test('memoryFactorOf reads a declared capabilities.memoryFactor over the streaming-based default', () => {
  assert.equal(memoryFactorOf({ streaming: false, capabilities: { memoryFactor: 3.5 } }), 3.5);
});

test('a buffering format is memoryBudget / memoryFactor regardless of sink', () => {
  const c = effectiveCeiling({ format: gpkgLike, sink: { kind: 'filesystem' } });
  assert.equal(c.outputBytes, Math.floor(GiB / 3.5));
});

test('the memorySink exemption applies only to a streaming format, never to a buffering one', () => {
  // A buffering format's own cost (JS row arrays, a wasm heap, ...) is
  // spent inside the writer regardless of where the bytes end up -- a
  // memorySink only ever exempted the SINK's own buffering, not the
  // format's. Locks the ordering bug this test would have caught: the
  // memory-sink check used to short-circuit ahead of memoryFactorOf,
  // which would have returned UNBOUNDED_BYTES here instead. Note the
  // derived value here (~307 MiB) is ABOVE blobBytes (256 MiB) and must
  // stay uncapped -- memorySink has no real write-time cap to predict,
  // unlike blobSink (see the two tests below).
  const c = effectiveCeiling({ format: gpkgLike, sink: { kind: 'memory' } });
  assert.equal(c.outputBytes, Math.floor(GiB / 3.5));
});

// Whole-branch review item 3 (Important): blobSink genuinely refuses above
// `blobBytes` at write time (`SINK_QUOTA_EXCEEDED` in sinks.js), but
// nothing compared a buffering format's derived `memoryBudget/memoryFactor`
// against it -- so gpkg (factor 3.5, ~307 MiB derived) and geoparquet
// (factor 2, 512 MiB derived) both passed the gate above 256 MiB, only to
// have the sink die at the last step with no `suggestedFormats`. Locks
// `Math.min(derived, blobBytes)` for a memory-backed sink that is NOT the
// explicit `memorySink` escape hatch.
test('a buffering format on a blob sink is bounded by blobBytes even when memoryBudget/memoryFactor is larger', () => {
  const c = effectiveCeiling({ format: gpkgLike, sink: { kind: 'blob' } });
  assert.ok(Math.floor(GiB / 3.5) > 256 * MiB, 'precondition: derived must exceed blobBytes for this test to discriminate');
  assert.equal(c.outputBytes, 256 * MiB);
});

test('a buffering format on a null sink is bounded by blobBytes, the conservative direction', () => {
  const geoparquetLike = { streaming: false, capabilities: { memoryFactor: 2 } };
  const c = effectiveCeiling({ format: geoparquetLike, sink: null });
  assert.ok(Math.floor(GiB / 2) > 256 * MiB, 'precondition: derived must exceed blobBytes for this test to discriminate');
  assert.equal(c.outputBytes, 256 * MiB);
});

test('a buffering format on a blob sink is NOT bounded by blobBytes when the derived value is already smaller', () => {
  // A higher memoryFactor (e.g. 5) can derive below blobBytes on its own;
  // Math.min must not force it UP to blobBytes in that case.
  const highFactor = { streaming: false, capabilities: { memoryFactor: 5 } };
  const c = effectiveCeiling({ format: highFactor, sink: { kind: 'blob' } });
  assert.equal(c.outputBytes, Math.floor(GiB / 5));
  assert.ok(c.outputBytes < 256 * MiB);
});

test('the raised flat defaults apply', () => {
  const c = effectiveCeiling({ format: streaming, sink: { kind: 'filesystem' } });
  assert.equal(c.rows, 50_000_000);
  assert.equal(c.readBytes, 64 * GiB);
  assert.equal(c.files, 10_000);
});

test('a null sink (not yet created) is treated as memory-backed, the conservative direction', () => {
  const c = effectiveCeiling({ format: streaming, sink: null });
  assert.equal(c.outputBytes, 256 * MiB);
});

test('options.ceiling overrides field by field, including memoryBudget', () => {
  const c = effectiveCeiling({ format: gpkgLike, sink: { kind: 'filesystem' }, overrides: { memoryBudget: 4 * GiB } });
  assert.equal(c.outputBytes, Math.floor((4 * GiB) / 3.5));
  const d = effectiveCeiling({ format: gpkgLike, sink: null, overrides: { outputBytes: 7 } });
  assert.equal(d.outputBytes, 7);
});

test('defaultCeiling() is unchanged for existing callers', () => {
  assert.equal(defaultCeiling().blobBytes, 256 * MiB);
  assert.equal(defaultCeiling().rows, 5_000_000);
  assert.equal(defaultCeiling().outputBytes, 2 * GiB);
  assert.equal(defaultCeiling().readBytes, 4 * GiB);
  assert.equal(defaultCeiling().files, 500);
});
