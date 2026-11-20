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

test('gpkg declares the measured 3.5, not the default 3', async () => {
  const { gpkgFormatDescriptor } = await import('@cng/format-gpkg');
  assert.equal(memoryFactorOf(gpkgFormatDescriptor), 3.5);
});

test('a buffering format is memoryBudget / memoryFactor regardless of sink', () => {
  const c = effectiveCeiling({ format: gpkgLike, sink: { kind: 'filesystem' } });
  assert.equal(c.outputBytes, Math.floor(GiB / 3.5));
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
