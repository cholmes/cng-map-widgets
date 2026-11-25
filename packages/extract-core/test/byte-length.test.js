// A parquet file's size has to be known before its footer can be read, and
// the reader took it from a HEAD request. GitHub Pages -- where the Portolan
// registry's own index lives -- answers HEAD with the length of the GZIP
// encoding of the file (`Content-Encoding: gzip`), which a script can neither
// see nor switch off. The footer was then looked for in the wrong place:
// "parquet file invalid (footer != PAR1)". A request with a `Range` is served
// unencoded, so the size is asked for that way instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/hyparquet-setup.js';
import { openParquetFile, remoteByteLength, readRows } from '../src/parquet-io.js';
import { buildParquet } from './helpers/fake-parquet-host.js';

const URL_ = 'https://pages.invalid/index.parquet';

/**
 * A host shaped like GitHub Pages: HEAD (and any request with no Range)
 * reports a smaller, "compressed" length; ranges are honoured against the
 * real bytes; `Content-Range` can be hidden, as CORS hides it from a script.
 */
function pagesLikeHost(bytes, { exposeContentRange = true, ignoreRange = false, status = null } = {}) {
  const log = [];
  let bodyBytes = 0;
  const fetch = async (url, init = {}) => {
    const range = init.headers?.get?.('Range') ?? new Headers(init.headers ?? {}).get('Range');
    const method = init.method ?? 'GET';
    log.push({ method, range });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (status) return new Response(null, { status });
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(bytes.byteLength - 1000), 'accept-ranges': 'bytes' } });
    if (!range || ignoreRange) return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] === '' ? bytes.byteLength : Number(m[2]) + 1;
    const slice = bytes.slice(start, end);
    const headers = { 'content-length': String(slice.byteLength) };
    if (exposeContentRange) headers['content-range'] = `bytes ${start}-${end - 1}/${bytes.byteLength}`;
    // A streamed body, so that a reader who stops early is seen to have stopped.
    const body = new ReadableStream({
      start(controller) {
        const chunk = 256;
        let at = 0;
        const push = () => {
          if (init.signal?.aborted) return controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (at >= slice.byteLength) return controller.close();
          const piece = slice.slice(at, at + chunk);
          at += piece.byteLength;
          bodyBytes += piece.byteLength;
          controller.enqueue(piece);
          setTimeout(push, 0);
        };
        push();
      },
    });
    return new Response(body, { status: 206, headers });
  };
  return { fetch, log, bodyBytes: () => bodyBytes };
}

test('a host whose HEAD reports a compressed length still opens: the size comes from a ranged request', async () => {
  const bytes = buildParquet({ groups: 3, rowsPerGroup: 4 });
  const host = pagesLikeHost(bytes);
  assert.equal(await remoteByteLength(URL_, host.fetch), bytes.byteLength);
  const handle = await openParquetFile(URL_, host.fetch);
  assert.equal(handle.byteLength, bytes.byteLength);
  assert.equal(handle.rowGroups.length, 3);
  const rows = await readRows(handle, { rowStart: 0, rowEnd: 4, columns: ['id'] });
  assert.deepEqual(rows.map((r) => r.id), ['g0-r0', 'g0-r1', 'g0-r2', 'g0-r3']);
});

test('opening makes no HEAD request', async () => {
  const host = pagesLikeHost(buildParquet({ groups: 2, rowsPerGroup: 4 }));
  await openParquetFile(URL_, host.fetch);
  assert.deepEqual(host.log.filter((r) => r.method === 'HEAD'), []);
  assert.equal(host.log[0].range, 'bytes=0-0', 'the size is asked for with one byte');
});

// What a browser sees on GitHub Pages: the range is honoured, but
// `Content-Range` is not exposed to the script. `Content-Length` always is.
test('where Content-Range is hidden, the size comes from the Content-Length of an open-ended range, and its body is not downloaded', async () => {
  const bytes = buildParquet({ groups: 40, rowsPerGroup: 50 });
  const host = pagesLikeHost(bytes, { exposeContentRange: false });
  assert.equal(await remoteByteLength(URL_, host.fetch), bytes.byteLength);
  assert.deepEqual(host.log.map((r) => r.range), ['bytes=0-0', 'bytes=0-']);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(host.bodyBytes() < bytes.byteLength / 2, `stopped after ${host.bodyBytes()} of ${bytes.byteLength} bytes`);
  // ...and the file then opens and reads.
  const handle = await openParquetFile(URL_, host.fetch);
  assert.equal(handle.rowGroups.length, 40);
});

test('a server that ignores Range gives its Content-Length', async () => {
  const bytes = buildParquet({ groups: 2, rowsPerGroup: 4 });
  const host = pagesLikeHost(bytes, { ignoreRange: true });
  assert.equal(await remoteByteLength(URL_, host.fetch), bytes.byteLength);
});

test('a 404 rejects NETWORK with the status', async () => {
  const host = pagesLikeHost(buildParquet(), { status: 404 });
  await assert.rejects(remoteByteLength(URL_, host.fetch), (e) => e.code === 'NETWORK' && e.context.status === 404 && e.context.url === URL_);
  await assert.rejects(openParquetFile(URL_, host.fetch), (e) => e.code === 'NETWORK');
});

test('an aborted signal rejects CANCELLED', async () => {
  const host = pagesLikeHost(buildParquet());
  await assert.rejects(openParquetFile(URL_, host.fetch, { signal: AbortSignal.abort() }), (e) => e.code === 'CANCELLED');
});

// --- Review (Phase 3), Important 1: the probe behind a request timeout --------
//
// `requestTimeoutMs` wraps `fetch` in a reader that takes the WHOLE body before
// it returns, so that a stalled body is caught. Handed to the size probe, that
// turned "ask `bytes=0-` and hang up at the headers" into "download the file".

test('with a request timeout, the size probe still does not download the file', async () => {
  const bytes = buildParquet({ groups: 40, rowsPerGroup: 50 });
  const host = pagesLikeHost(bytes, { exposeContentRange: false });
  const handle = await openParquetFile(URL_, host.fetch, { requestTimeoutMs: 5000, initialFetchSize: 4096 });
  assert.equal(handle.byteLength, bytes.byteLength);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(host.bodyBytes() < bytes.byteLength / 2, `${host.bodyBytes()} bytes were read of a ${bytes.byteLength}-byte file`);
});

test('a host that never answers the size probe is given up on after the request timeout', async () => {
  // A fetch that ignores its signal entirely: the limit must not depend on it.
  const never = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(openParquetFile(URL_, never, { requestTimeoutMs: 40 }), (e) => e.code === 'NETWORK' && e.retryable === true);
  assert.ok(Date.now() - started < 2000);
});

test('a server that answers an open-ended range with 200 and a Content-Length gives that length', async () => {
  // 206 to `bytes=0-0` with Content-Range hidden, then 200 to `bytes=0-`.
  const bytes = buildParquet({ groups: 2, rowsPerGroup: 4 });
  const fetch = async (url, init = {}) => {
    const range = new Headers(init.headers ?? {}).get('Range');
    if (range === 'bytes=0-0') return new Response(bytes.slice(0, 1), { status: 206, headers: { 'content-length': '1' } });
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  };
  assert.equal(await remoteByteLength(URL_, fetch), bytes.byteLength);
});

// --- Review (Phase 3), Important 2: the other place a parquet file is opened ---

test('a collection-mirror on a host whose HEAD misreports is enumerated, with no HEAD', async () => {
  const { enumeratePartitions } = await import('../src/partitions.js');
  const bytes = buildParquet({ groups: 2, rowsPerGroup: 3 });
  const host = pagesLikeHost(bytes, { exposeContentRange: false });
  const { parts } = await enumeratePartitions(
    { kind: 'hive', scheme: 'hive', glob: 'https://pages.invalid/year=*/d.parquet', keys: [{ name: 'year', type: 'int' }], enumeration: { kind: 'collection-mirror', url: URL_ } },
    { fetch: host.fetch },
  );
  assert.equal(parts.length, 6, 'one part per row of the mirror');
  assert.deepEqual(host.log.filter((r) => r.method === 'HEAD'), []);
});
