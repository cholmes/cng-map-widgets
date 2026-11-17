// `registerLazyFormat`/`resolveFormat`/`formatLoadState` (design doc §3.4
// amendment, 2026-11-12): a format may be registered as a small static
// descriptor whose `load()` only runs on first `resolveFormat`/`download()`
// use, not at registration time. Covers resolution, caching (one `load()`
// call for N concurrent resolves), failure (-> FORMAT_LOAD_FAILED), and
// that `formats()`/`getFormat()` never trigger a load themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerFormat,
  registerLazyFormat,
  formats,
  getFormat,
  resolveFormat,
  formatLoadState,
  onFormatState,
} from '../src/registry.js';
import { isCnmwError } from '@cng/spec';

function uniqueId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

test('registerLazyFormat: formats() lists it without calling load()', () => {
  const id = uniqueId('lazy');
  let loadCalls = 0;
  registerLazyFormat({
    id,
    label: 'Test Lazy Format',
    extension: 'test',
    mediaType: 'application/x-test',
    streaming: false,
    capabilities: { nestedColumns: false, mixedGeometryTypes: false, crs: ['OGC:CRS84'] },
    approxBytes: { min: 100_000, max: 200_000 },
    estimateBytes: (schema, rows) => ({ min: 0, max: 0, estimate: 0, exact: false }),
    load: async () => {
      loadCalls += 1;
      return { id, extension: 'test', mediaType: 'application/x-test', streaming: false, capabilities: {}, estimateBytes: () => ({}), open: async () => ({}) };
    },
  });

  const entry = formats().find((f) => f.id === id);
  assert.ok(entry, 'lazy format appears in formats()');
  assert.equal(entry.lazy, true);
  assert.equal(entry.loadState, 'idle');
  assert.deepEqual(entry.approxBytes, { min: 100_000, max: 200_000 });
  assert.equal(loadCalls, 0, 'listing never triggers load()');
  assert.equal(getFormat(id), undefined, 'getFormat() is sync and never triggers load()');
  assert.equal(formatLoadState(id), 'idle');
});

test('resolveFormat: loads a lazy format exactly once, caches the result', async () => {
  const id = uniqueId('lazy');
  let loadCalls = 0;
  const plugin = { id, extension: 'test', mediaType: 'application/x-test', streaming: false, capabilities: {}, estimateBytes: () => ({}), open: async () => ({}) };
  registerLazyFormat({
    id,
    extension: 'test',
    mediaType: 'application/x-test',
    streaming: false,
    capabilities: {},
    approxBytes: { min: 1, max: 2 },
    estimateBytes: () => ({}),
    load: async () => {
      loadCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return plugin;
    },
  });

  // Fire several concurrent resolves -- must share one in-flight load().
  const [a, b, c] = await Promise.all([resolveFormat(id), resolveFormat(id), resolveFormat(id)]);
  assert.equal(a, plugin);
  assert.equal(b, plugin);
  assert.equal(c, plugin);
  assert.equal(loadCalls, 1, 'concurrent resolves share one load()');
  assert.equal(formatLoadState(id), 'loaded');
  assert.equal(getFormat(id), plugin, 'now resolvable synchronously too');

  // A later resolve must not call load() again.
  const again = await resolveFormat(id);
  assert.equal(again, plugin);
  assert.equal(loadCalls, 1);
});

test('resolveFormat: a load() that returns a module-shaped object ({ default }) or a bare factory is normalized', async () => {
  const idModule = uniqueId('lazy-module');
  const pluginA = { id: idModule, extension: 'a', mediaType: 'a/a', streaming: false, capabilities: {}, estimateBytes: () => ({}), open: async () => ({}) };
  registerLazyFormat({
    id: idModule,
    extension: 'a',
    mediaType: 'a/a',
    streaming: false,
    capabilities: {},
    estimateBytes: () => ({}),
    load: async () => ({ default: pluginA }), // ESM module shape
  });
  assert.equal(await resolveFormat(idModule), pluginA);

  const idFactory = uniqueId('lazy-factory');
  const pluginB = { id: idFactory, extension: 'b', mediaType: 'b/b', streaming: false, capabilities: {}, estimateBytes: () => ({}), open: async () => ({}) };
  registerLazyFormat({
    id: idFactory,
    extension: 'b',
    mediaType: 'b/b',
    streaming: false,
    capabilities: {},
    estimateBytes: () => ({}),
    load: async () => () => pluginB, // factory shape
  });
  assert.equal(await resolveFormat(idFactory), pluginB);
});

test('resolveFormat: a failing load() throws FORMAT_LOAD_FAILED, not the raw error, and leaves the format re-attemptable', async () => {
  const id = uniqueId('lazy-fail');
  let attempts = 0;
  registerLazyFormat({
    id,
    extension: 'test',
    mediaType: 'application/x-test',
    streaming: false,
    capabilities: {},
    approxBytes: { min: 1, max: 1 },
    estimateBytes: () => ({}),
    load: async () => {
      attempts += 1;
      throw new Error('network says no');
    },
  });

  await assert.rejects(resolveFormat(id), (err) => {
    assert.ok(isCnmwError(err));
    assert.equal(err.code, 'FORMAT_LOAD_FAILED');
    assert.match(err.message, /network says no/);
    assert.equal(err.context.format, id);
    return true;
  });
  assert.equal(formatLoadState(id), 'failed');
  assert.equal(attempts, 1);

  // A later resolve retries (does not stay permanently cached as a
  // rejection) -- same shape as a network fetch a user might retry.
  await assert.rejects(resolveFormat(id), { code: 'FORMAT_LOAD_FAILED' });
  assert.equal(attempts, 2);
});

test('registerFormat (eager) for an id also registered lazily wins over the lazy descriptor', async () => {
  const id = uniqueId('both');
  const eagerPlugin = { id, extension: 'e', mediaType: 'e/e', streaming: false, capabilities: {}, estimateBytes: () => ({}), open: async () => ({}) };
  let lazyLoadCalls = 0;
  registerLazyFormat({
    id,
    extension: 'e',
    mediaType: 'e/e',
    streaming: false,
    capabilities: {},
    estimateBytes: () => ({}),
    load: async () => {
      lazyLoadCalls += 1;
      return eagerPlugin;
    },
  });
  registerFormat(eagerPlugin);

  assert.equal(getFormat(id), eagerPlugin);
  assert.equal(await resolveFormat(id), eagerPlugin);
  assert.equal(lazyLoadCalls, 0, 'the eager registration short-circuits resolveFormat entirely');
  assert.equal(formats().filter((f) => f.id === id).length, 1, 'formats() lists the id once, as the eager entry');
});

// --- onFormatState: the load-state subscription ------------------------
//
// Before this existed, `formats()`/`formatLoadState()` were pull-only, so
// a format picker had no way to learn that a lazy format had finished
// loading; the portolan-browser integration polled by bumping a
// reactivity counter. These lock in the push channel that replaces that.

test('onFormatState: reports idle on lazy registration, then loading -> loaded across a resolveFormat', async () => {
  const id = uniqueId('observed');
  const seen = [];
  const unsubscribe = onFormatState((change) => {
    if (change.id === id) seen.push(change.state);
  });

  const plugin = { id, extension: 'o', mediaType: 'o/o', streaming: true, capabilities: {}, estimateBytes: () => ({}), open: async () => ({}) };
  registerLazyFormat({
    id,
    extension: 'o',
    mediaType: 'o/o',
    streaming: true,
    capabilities: {},
    estimateBytes: () => ({}),
    load: async () => {
      // Assert mid-flight: 'loading' must be observable *while* the load
      // is in flight, which is the whole point for a UI spinner.
      assert.deepEqual(seen, ['idle', 'loading']);
      return plugin;
    },
  });
  assert.deepEqual(seen, ['idle']);

  await resolveFormat(id);
  assert.deepEqual(seen, ['idle', 'loading', 'loaded']);

  // A second resolve is served from cache and emits nothing further.
  await resolveFormat(id);
  assert.deepEqual(seen, ['idle', 'loading', 'loaded']);

  unsubscribe();
  registerFormat(plugin);
  assert.deepEqual(seen, ['idle', 'loading', 'loaded'], 'unsubscribe() stops delivery');
});

test('onFormatState: a failing load() reports failed, and the state matches formatLoadState()', async () => {
  const id = uniqueId('observed-fail');
  const seen = [];
  const unsubscribe = onFormatState((change) => {
    if (change.id === id) seen.push(change.state);
  });

  registerLazyFormat({
    id,
    extension: 'x',
    mediaType: 'x/x',
    streaming: false,
    capabilities: {},
    estimateBytes: () => ({}),
    load: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(resolveFormat(id), { code: 'FORMAT_LOAD_FAILED' });

  assert.deepEqual(seen, ['idle', 'loading', 'failed']);
  assert.equal(formatLoadState(id), 'failed');
  unsubscribe();
});

test('onFormatState: an eager registerFormat reports loaded', () => {
  const id = uniqueId('observed-eager');
  const seen = [];
  const unsubscribe = onFormatState((change) => {
    if (change.id === id) seen.push(change.state);
  });
  registerFormat({ id, extension: 'g', mediaType: 'g/g', streaming: true, capabilities: {}, estimateBytes: () => ({}), open: async () => ({}) });
  assert.deepEqual(seen, ['loaded']);
  unsubscribe();
});

test('onFormatState: a handler that throws neither fails the registration nor starves the others', async () => {
  const id = uniqueId('observed-throw');
  const seen = [];
  const un1 = onFormatState(() => {
    throw new Error('broken subscriber');
  });
  const un2 = onFormatState((change) => {
    if (change.id === id) seen.push(change.state);
  });

  assert.doesNotThrow(() =>
    registerFormat({ id, extension: 't', mediaType: 't/t', streaming: true, capabilities: {}, estimateBytes: () => ({}), open: async () => ({}) }),
  );
  assert.deepEqual(seen, ['loaded']);
  assert.equal(formatLoadState(id), 'loaded');
  un1();
  un2();
});
