// Two ways a kept plan goes wrong that the first version of the plan cache did
// not survive (Phase 2 review, I1 and I9):
//
//   STALLED  A request that never answers. Cached loads run without the
//            caller's signal -- on purpose, so a superseded search leaves its
//            footers behind -- which meant a hung footer read was a promise
//            nobody could cancel, handed to every later caller for ten
//            minutes. Hangs are real: one live search waited 140 s.
//
//   STALE    A file rewritten since its footer was kept, on a host that does
//            not let a script see `Content-Range` (GitHub Pages does not).
//            The size check then sees nothing, and every search failed until
//            the cache expired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/hyparquet-setup.js';
import { queryRows, createPlanCache } from '../src/index.js';
import { openParquetFile } from '../src/parquet-io.js';
import { buildScenes, scenesDataset, scenesHost, SCENES_URL } from './helpers/scenes-fixture.js';

const ALL = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };

/** A request that never answers; it gives up only when its own signal aborts. */
const never = (init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });

/** `scenesHost` with switches: hang chosen requests, hide or add response headers. */
function trickyHost(bytes) {
  const real = scenesHost(bytes);
  const state = { hang: () => false, hide: [], lastModified: null, dataReads: 0 };
  const fetch = async (url, init = {}) => {
    const isRange = Boolean(init.headers?.get?.('Range'));
    const isData = isRange && real.log.length > 0 && state.opened;
    const n = isData ? state.dataReads++ : -1;
    if (state.hang({ url: String(url), init, isRange, isData, n })) return never(init);
    const res = await real.fetch(url, init);
    if (!state.hide.length && !state.lastModified) return res;
    const headers = new Headers(res.headers);
    for (const name of state.hide) headers.delete(name);
    if (state.lastModified) headers.set('last-modified', state.lastModified);
    return new Response(res.status === 206 ? await res.arrayBuffer() : null, { status: res.status, headers });
  };
  return { fetch, state, real, replace: (next) => real.replace(next) };
}

// --- stalled --------------------------------------------------------------------------

test('a cached footer read that never answers times out, is not kept, and the next caller reads again', async () => {
  const host = trickyHost(buildScenes());
  const cache = createPlanCache({ loadTimeoutMs: 40 });
  host.state.hang = () => true;
  await assert.rejects(openParquetFile(SCENES_URL, host.fetch, { cache }), (e) => {
    assert.equal(e.code, 'NETWORK');
    assert.equal(e.retryable, true);
    assert.equal(e.context.reason, 'timeout');
    return true;
  });
  assert.equal(cache.stats().footers, 0);
  host.state.hang = () => false;
  const handle = await openParquetFile(SCENES_URL, host.fetch, { cache });
  assert.equal(handle.rowGroups.length, 4);
});

test('a caller that gives up on a stalled load is released at once; a later caller is not stuck behind it', async () => {
  const host = trickyHost(buildScenes());
  const cache = createPlanCache({ loadTimeoutMs: 60 });
  host.state.hang = () => true;
  const stop = new AbortController();
  const first = openParquetFile(SCENES_URL, host.fetch, { cache, signal: stop.signal });
  stop.abort();
  await assert.rejects(first, (e) => e.code === 'CANCELLED');
  // The network comes back. Within the load's lifetime the stalled read is
  // still the one in the cache; once it has timed out, a new one is made.
  host.state.hang = () => false;
  await new Promise((r) => setTimeout(r, 90));
  const rows = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  assert.equal(rows.rows.length, 12);
});

test('loadTimeoutMs: 0 turns the timeout off', async () => {
  const host = trickyHost(buildScenes());
  const cache = createPlanCache({ loadTimeoutMs: 0 });
  host.state.hang = () => true;
  const stop = new AbortController();
  const pending = openParquetFile(SCENES_URL, host.fetch, { cache, signal: stop.signal });
  const outcome = await Promise.race([pending.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('still waiting'), 80))]);
  assert.equal(outcome, 'still waiting');
  stop.abort();
  await assert.rejects(pending, (e) => e.code === 'CANCELLED');
});

test('with requestTimeoutMs, a row read that never answers is abandoned and made again', async () => {
  const host = trickyHost(buildScenes());
  host.state.opened = false;
  const cache = createPlanCache();
  await openParquetFile(SCENES_URL, host.fetch, { cache });
  host.state.opened = true;
  // The second row-group read hangs, once.
  let hung = 0;
  host.state.hang = ({ isData, n }) => isData && n === 1 && hung++ === 0;
  const result = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache, requestTimeoutMs: 40, maxConcurrentRequests: 1 });
  assert.equal(result.rows.length, 12);
  assert.deepEqual(result.rows.map((r) => r.id).slice(0, 4), ['g0-r0', 'g0-r1', 'g0-r2', 'g1-r0']);
  assert.equal(hung, 1);
});

test('a row read that never answers on either attempt fails the query, saying it timed out', async () => {
  const host = trickyHost(buildScenes());
  const cache = createPlanCache();
  await openParquetFile(SCENES_URL, host.fetch, { cache });
  host.state.opened = true;
  host.state.hang = ({ isData }) => isData;
  await assert.rejects(queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache, requestTimeoutMs: 30 }), (e) => {
    assert.equal(e.code, 'DATASET_UNRESOLVED');
    assert.match(String(e.cause?.message ?? e.cause), /timed out/i);
    return true;
  });
});

// --- stale --------------------------------------------------------------------------------

test('where Content-Range is hidden, a changed Last-Modified still shows the file was rewritten', async () => {
  const host = trickyHost(buildScenes());
  host.state.hide = ['content-range'];
  host.state.lastModified = 'Tue, 25 Nov 2026 10:00:00 GMT';
  const cache = createPlanCache();
  await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  host.replace(buildScenes({ groups: 6, tag: 'new-' }));
  host.state.lastModified = 'Tue, 25 Nov 2026 11:00:00 GMT';
  const result = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  assert.equal(result.rows.length, 18, 're-planned once, by itself');
  assert.ok(result.rows.every((r) => r.id.startsWith('new-')));
});

test('an unchanged Last-Modified is not mistaken for a rewrite', async () => {
  const host = trickyHost(buildScenes());
  host.state.lastModified = 'Tue, 25 Nov 2026 10:00:00 GMT';
  const cache = createPlanCache();
  await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  host.real.reset();
  const again = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  assert.equal(again.rows.length, 12);
  assert.equal(host.real.log.length, host.real.dataReads().length, 'no footer read');
});

test('where nothing says the file changed, a failed query drops the footers it used, so the next one recovers', async () => {
  const host = trickyHost(buildScenes());
  host.state.hide = ['content-range', 'last-modified'];
  const cache = createPlanCache();
  await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  // Rewritten, much shorter: the kept footer now points past the end of the file.
  host.replace(buildScenes({ groups: 1, rowsPerGroup: 2, tag: 'new-' }));
  await assert.rejects(queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache, readRetries: 0 }));
  assert.equal(cache.stats().footers, 0, 'the footer that led it astray is gone');
  const result = await queryRows(scenesDataset(), null, ALL, { fetch: host.fetch, cache });
  assert.deepEqual(result.rows.map((r) => r.id), ['new-g0-r0', 'new-g0-r1']);
});
