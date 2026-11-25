// One failed range read used to fail the whole run. A Sentinel-2 scene search
// is about 80 range requests; live, two searches in ten lost one of them to a
// transport error (`ERR_QUIC_PROTOCOL_ERROR`) and with it every scene already
// found. A row-group read is idempotent, so it is tried again -- once -- before
// the run gives up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/hyparquet-setup.js';
import { openParquetFile } from '../src/parquet-io.js';
import { createHyparquetEngine } from '../src/engine-hyparquet.js';
import { buildParquet, rangeFetch, enginePlanFor } from './helpers/fake-parquet-host.js';

const URL_ = 'https://example.invalid/test.parquet';

/**
 * A host whose data reads fail when `shouldFail(n)` says so, where `n` counts
 * data reads (not the footer) from 0. The failure is what `fetch` gives for a
 * dropped connection: a rejected promise with a TypeError.
 */
async function flakyHost(shouldFail, opts = {}) {
  const bytes = buildParquet({ groups: 4, rowsPerGroup: 5 });
  const serve = rangeFetch(bytes);
  let dataReads = 0;
  let opened = false;
  const attempts = [];
  const fetch = async (url, init = {}) => {
    const range = init.headers?.get?.('Range') ?? null;
    if (opened && range) {
      const n = dataReads++;
      attempts.push(range);
      if (shouldFail(n, range)) throw new TypeError('network error');
    }
    return serve(url, init);
  };
  const handle = await openParquetFile(URL_, fetch, { signal: opts.signal });
  opened = true;
  return { handle, attempts };
}

async function run(handle, ctx = {}) {
  const ids = [];
  const result = await createHyparquetEngine().run(enginePlanFor({ handle }), async (batch) => ids.push(...batch.columns.id), { maxConcurrentRequests: 1, ...ctx });
  return { ids, result };
}
const ALL_IDS = [0, 1, 2, 3].flatMap((g) => [0, 1, 2, 3, 4].map((r) => `g${g}-r${r}`));

test('a row-group read that fails once is tried again, and the run completes in order', async () => {
  const { handle, attempts } = await flakyHost((n) => n === 2);
  const { ids, result } = await run(handle);
  assert.deepEqual(ids, ALL_IDS);
  assert.equal(result.rows, 20);
  assert.equal(result.requests, 4, 'one per row group delivered, as before');
  assert.ok(attempts.length > 4, 'the failed read was made again');
});

test('with parallel reads, a failure in one does not disturb the others', async () => {
  const { handle } = await flakyHost((n) => n === 1);
  const { ids } = await run(handle, { maxConcurrentRequests: 4 });
  assert.deepEqual(ids, ALL_IDS);
});

test('a read that fails every time still fails the run, with the cause', async () => {
  // Every read from the third on fails: the third row group, and its retry.
  const always = await flakyHost((n) => n >= 2);
  await assert.rejects(run(always.handle), (e) => {
    assert.equal(e.code, 'DATASET_UNRESOLVED');
    assert.match(e.cause?.message ?? '', /network error/);
    return true;
  });
  assert.equal(always.attempts.length, 4, 'two good reads, then the third tried twice');
});

test('readRetries: 0 restores the old behaviour: the first failure is final', async () => {
  const { handle, attempts } = await flakyHost((n) => n === 0);
  await assert.rejects(run(handle, { readRetries: 0 }), (e) => e.code === 'DATASET_UNRESOLVED');
  assert.equal(attempts.length, 1);
});

test('a cancelled read is not retried', async () => {
  const stop = new AbortController();
  const { handle, attempts } = await flakyHost((n) => {
    if (n === 1) stop.abort();
    return n === 1;
  }, { signal: stop.signal });
  await assert.rejects(run(handle, { signal: stop.signal }), (e) => e.code === 'CANCELLED');
  assert.equal(attempts.length, 2, 'the read that was cancelled was not made again');
});
