// @cngeo/extract-core -- thin wrapper over hyparquet: footer metadata,
// row-group byte/stat extraction, and row reads. Isolated here so
// estimate.js, prune.js and engine-hyparquet.js share one notion of "what a
// row group looks like" without each reaching into raw hyparquet metadata
// shapes.

import { CngError, CancelledError } from '@cngeo/spec';
import { loadHyparquet } from './cdn.js';
import { raceAbort } from './plan-cache.js';

/**
 * Map a thrown error to `CancelledError` when the operation's own signal is
 * already aborted.
 *
 * Every failure mode in this module is a `fetch` away, and an aborted
 * `fetch` rejects with a bare `AbortError` `DOMException` (or, through a
 * caller-supplied `fetch`, with whatever that implementation throws) --
 * indistinguishable, at the catch site, from a genuine network failure or a
 * truncated/unreadable footer. Wrapping it as `NETWORK` /
 * `DATASET_UNRESOLVED` is what made a cancelled download report a *data*
 * problem: the live-verification audit saw `DATASET_UNRESOLVED` for a
 * cancel mid-row-group read and `NETWORK` (with `state: 'failed'`) for a
 * cancel during planning, where design doc §3.5 rule 1 is explicit --
 * "an abort rejects with `CancelledError` (`code: 'CANCELLED'`), never a
 * bare `DOMException`, so a consumer has one thing to match".
 *
 * Checking `signal.aborted` rather than sniffing the error's name/type is
 * deliberate: it is the only test that stays correct for a custom `fetch`
 * (the `options.fetch` seam every entry point here takes) whose abort
 * rejection is some other error shape entirely.
 *
 * @param {unknown} cause
 * @param {AbortSignal|undefined} signal
 * @param {string} what - what was being read, for the message
 * @returns {CancelledError|null} the error to throw instead, or null to keep the original mapping
 */
function cancellationOf(cause, signal, what) {
  if (!signal?.aborted) return null;
  return new CancelledError(`Cancelled while ${what}.`, {
    context: { reason: typeof signal.reason === 'string' ? signal.reason : undefined },
  });
}

/**
 * @typedef {{
 *   index: number,
 *   rowStart: number,
 *   rowEnd: number,
 *   numRows: number,
 *   columns: Map<string, { statistics?: { min_value?: unknown, max_value?: unknown }, geoStats?: { xmin: number, ymin: number, xmax: number, ymax: number }, totalCompressedSize: number, totalUncompressedSize: number }>,
 * }} RowGroupInfo
 */

/**
 * Open a remote parquet file: fetch the footer (and the whole file's byte
 * length), return a handle with `{ file, metadata, rowGroups, url }`.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {{ initialFetchSize?: number, signal?: AbortSignal }} [opts]
 */
export async function openParquetFile(url, fetchImpl, opts = {}) {
  if (opts.cache) return openCachedParquetFile(url, fetchImpl, opts);
  const { hyparquet } = await loadHyparquet();
  let file;
  try {
    file = await hyparquet.asyncBufferFromUrl({
      url,
      fetch: withRequestTimeout(fetchImpl, opts.requestTimeoutMs),
      requestInit: { cache: 'no-store', signal: opts.signal },
    });
  } catch (cause) {
    throw cancellationOf(cause, opts.signal, `fetching ${url}`) ?? new CngError(`Couldn't fetch parquet file: ${url}`, 'NETWORK', { cause, context: { url } });
  }
  let metadata;
  try {
    // `geoparquet: false` is load-bearing, not cosmetic: hyparquet >=1.x
    // auto-detects a GeoParquet `geo` key-value-metadata column (which
    // DuckDB writes by default for a native GEOMETRY column -- both the
    // FTW and tge-labs/CGAZ files this package targets carry it) and
    // silently replaces the raw WKB bytes with its own pre-decoded
    // GeoJSON object, independent of any `utf8`-style option. Passing
    // `geoparquet: false` here (once, at metadata-fetch time -- the flag
    // lives on the returned `metadata`'s schema, not on each read call)
    // keeps every column, geometry included, as raw bytes, so
    // `@cngeo/spec`'s `wkbToGeoJson` is the single, uniform decode path
    // for every dataset regardless of whether it carries `geo` metadata.
    // Same fix, same reasoning, as `@cngeo/geocoder-core`'s
    // geometry-resolver.js/index-loader.js (commit c3cd2ea).
    //
    // NOTE: passing a bare number here previously (before this fix) was
    // *also* silently wrong -- `parquetMetadataAsync`'s second argument
    // is always an options object (`{ parsers, initialFetchSize,
    // geoparquet }`), so the old `opts.initialFetchSize ?? 65_536` call
    // destructured `initialFetchSize`/`geoparquet` off of a `Number`,
    // got `undefined` for both, and silently fell back to hyparquet's
    // own (larger, unconfigurable) defaults for the footer-read size.
    metadata = await hyparquet.parquetMetadataAsync(file, {
      initialFetchSize: opts.initialFetchSize ?? 65_536,
      geoparquet: false,
    });
  } catch (cause) {
    throw (
      cancellationOf(cause, opts.signal, `reading the parquet footer of ${url}`) ??
      new CngError(`Couldn't read parquet metadata: ${url}`, 'DATASET_UNRESOLVED', { cause, context: { url } })
    );
  }
  const rowGroups = decodeRowGroups(metadata);
  // `signal` is carried on the handle so `readRows` -- which takes no
  // `fetch`/`signal` of its own, because the AsyncBuffer on `file` already
  // has both bound in -- can still tell a cancelled read from a failed one.
  return { url, file, metadata, rowGroups, byteLength: file.byteLength, signal: opts.signal };
}

/**
 * `openParquetFile` through a `PlanCache` (`opts.cache`). The footer -- the
 * expensive part -- is read once per file and shared; on a hit there is NO
 * request at all, not even hyparquet's HEAD, because the cached byte length
 * is handed to `asyncBufferFromUrl`.
 *
 * The buffer is always new. It is what carries this call's abort signal into
 * every later read, so two callers sharing one footer can still be cancelled
 * independently. The footer load itself runs with no signal (see
 * plan-cache.js): a superseded search leaves its footers for the next one.
 *
 * `fromCache` on the handle says whether this call paid for the footer, so a
 * planner can report an honest request count.
 */
async function openCachedParquetFile(url, fetchImpl, opts) {
  const { hyparquet } = await loadHyparquet();
  let loadedHere = false;
  const shared = opts.cache.footer(url, async (loadSignal) => {
    loadedHere = true;
    // What the host says about the file while its footer is read, kept with
    // the footer: a later read can then tell it is looking at another file.
    let lastModified = null;
    const noting = async (input, init) => {
      const res = await fetchImpl(input, init);
      lastModified = res.headers?.get?.('last-modified') ?? lastModified;
      return res;
    };
    const handle = await openParquetFile(url, noting, { initialFetchSize: opts.initialFetchSize, signal: loadSignal });
    return { metadata: handle.metadata, rowGroups: handle.rowGroups, byteLength: handle.byteLength, lastModified };
  });
  const footer = await raceAbort(shared, opts.signal, `reading the parquet footer of ${url}`);
  const file = await hyparquet.asyncBufferFromUrl({
    url,
    byteLength: footer.byteLength,
    fetch: sizeCheckedFetch(withRequestTimeout(fetchImpl, opts.requestTimeoutMs), url, footer, opts.cache),
    requestInit: { cache: 'no-store', signal: opts.signal },
  });
  return { url, file, metadata: footer.metadata, rowGroups: footer.rowGroups, byteLength: footer.byteLength, signal: opts.signal, fromCache: !loadedHere };
}

/** `context.reason` on the error a read raises when its file is not the one that was planned. */
export const FILE_CHANGED = 'file-changed';

/** @param {unknown} err */
export function isFileChanged(err) {
  return /** @type {any} */ (err)?.code === 'DATASET_UNRESOLVED' && /** @type {any} */ (err)?.context?.reason === FILE_CHANGED;
}

/**
 * A `fetch` for reads made against a KEPT footer. A footer is a map of byte
 * offsets, and it is only right for the file it was read from: published
 * files are rewritten (Sentinel-2's "live" parts, as scenes arrive), and a
 * read at old offsets into a new file decodes garbage, or decodes plausibly
 * wrong rows.
 *
 * Two things a range response says can show it:
 *   - the file's current total size (`Content-Range: bytes a-b/TOTAL`), when
 *     that is not the size the footer was read at, or the range no longer
 *     exists (416);
 *   - its `Last-Modified`, when that differs from the one seen while the
 *     footer was read. A browser script can always read `Last-Modified`; it
 *     can read `Content-Range` only where the host exposes it
 *     (`Access-Control-Expose-Headers`), which GitHub Pages, for one, does not.
 *
 * Then the footer is evicted and the read fails as retryable,
 * `context.reason: 'file-changed'`, before a byte is decoded. A host that
 * shows neither is covered only by `queryRows` dropping the footers of a
 * query that failed, and by the cache's `maxAgeMs`.
 */
function sizeCheckedFetch(fetchImpl, url, footer, cache) {
  const plannedBytes = footer.byteLength;
  return async (input, init) => {
    const res = await fetchImpl(input, init);
    const total = /\/(\d+)\s*$/.exec(res.headers?.get?.('content-range') ?? '')?.[1];
    const actualBytes = total === undefined ? null : Number(total);
    const modified = res.headers?.get?.('last-modified') ?? null;
    const resized = res.status === 416 || (actualBytes !== null && actualBytes !== plannedBytes);
    const rewritten = Boolean(footer.lastModified && modified && modified !== footer.lastModified);
    if (resized || rewritten) {
      cache.evict(url);
      throw new CngError(`${url} changed after it was planned; its footer has been dropped from the cache.`, 'DATASET_UNRESOLVED', {
        retryable: true,
        context: { url, reason: FILE_CHANGED, plannedBytes, actualBytes, plannedLastModified: footer.lastModified ?? null, lastModified: modified },
      });
    }
    return res;
  };
}

/**
 * A `fetch` that gives up on a request -- headers AND body -- after `ms`.
 *
 * Opt-in (`requestTimeoutMs`), and meant for reads known to be small, such as
 * the row groups of a search: the limit covers the whole response, so a
 * legitimately large read on a slow connection would trip it. That is why a
 * download does not set one by default.
 *
 * The body is read here, inside the limit, and handed on as a new Response:
 * a connection that stalls half-way through a body is the case seen live,
 * and it stalls after `fetch()` has already resolved.
 */
function withRequestTimeout(fetchImpl, ms) {
  if (!(ms > 0) || !Number.isFinite(ms)) return fetchImpl;
  return async (input, init = {}) => {
    const controller = new AbortController();
    const outer = init.signal;
    const onOuterAbort = () => controller.abort(outer.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener('abort', onOuterAbort, { once: true });
    const timeout = new Error(`The request timed out after ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`}: ${String(input).slice(0, 200)}`);
    timeout.name = 'TimeoutError';
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeout);
        reject(timeout);
      }, ms);
    });
    const work = (async () => {
      const res = await fetchImpl(input, { ...init, signal: controller.signal });
      if (init.method === 'HEAD' || res.body === null) return res;
      const body = await res.arrayBuffer();
      return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
    })();
    work.catch(() => {});
    try {
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  };
}

/** @param {any} metadata @returns {RowGroupInfo[]} */
function decodeRowGroups(metadata) {
  /** @type {RowGroupInfo[]} */
  const out = [];
  let rowStart = 0;
  metadata.row_groups.forEach((rg, index) => {
    const numRows = Number(rg.num_rows);
    const columns = new Map();
    for (const col of rg.columns) {
      const meta = col.meta_data;
      if (!meta) continue;
      const path = meta.path_in_schema.join('.');
      // Native Parquet GeospatialStatistics (GEOMETRY logical type, i.e.
      // GeoParquet 2.0). Carried alongside `statistics` because they are a
      // *separate* thrift field that ordinary min/max stats never populate
      // for a geometry column -- and because they let us prune files that
      // publish no covering column at all. See prune.js.
      const geo = meta.geospatial_statistics?.bbox;
      columns.set(path, {
        statistics: meta.statistics,
        geoStats: geo && [geo.xmin, geo.ymin, geo.xmax, geo.ymax].every((v) => typeof v === 'number' && Number.isFinite(v))
          ? { xmin: geo.xmin, ymin: geo.ymin, xmax: geo.xmax, ymax: geo.ymax }
          : undefined,
        totalCompressedSize: Number(meta.total_compressed_size ?? 0),
        totalUncompressedSize: Number(meta.total_uncompressed_size ?? 0),
      });
    }
    out.push({ index, rowStart, rowEnd: rowStart + numRows, numRows, columns });
    rowStart += numRows;
  });
  return out;
}

/** Sum of `totalCompressedSize` for a set of column (top-level) names across one row group. @param {RowGroupInfo} rg @param {string[]} columnNames */
export function rowGroupBytesForColumns(rg, columnNames) {
  let bytes = 0;
  for (const [path, col] of rg.columns) {
    const top = path.split('.')[0];
    if (columnNames.includes(top)) bytes += col.totalCompressedSize;
  }
  return bytes;
}

/**
 * Read decoded row objects for one row group (or an arbitrary absolute
 * [rowStart, rowEnd) range), optionally projected to `columns`. The AsyncBuffer
 * on `handle.file` already carries its own fetch/signal (bound at
 * `openParquetFile` time), so no `fetch` argument is needed here.
 * @param {{ file: any, metadata: any, signal?: AbortSignal }} handle
 * @param {{ rowStart: number, rowEnd: number, columns?: string[] }} range
 */
export async function readRows(handle, range) {
  const { hyparquet, compressors } = await loadHyparquet();
  try {
    return await hyparquet.parquetReadObjects({
      file: handle.file,
      metadata: handle.metadata,
      rowStart: range.rowStart,
      rowEnd: range.rowEnd,
      columns: range.columns,
      compressors,
      // `utf8: false` is the other half of the openParquetFile's
      // `geoparquet: false` fix: disabling GeoParquet auto-decode alone
      // only removes the GEOMETRY *logical type* hyparquet would have
      // assigned -- it does NOT, by itself, make the column come back as
      // raw bytes. hyparquet's own fallback for any BYTE_ARRAY column
      // with no converted/logical type is to decode it as a UTF-8
      // *string* by default (`utf8: true` is the hyparquet default), which
      // silently mangles binary WKB. `utf8: false` only affects columns
      // with no declared string type -- a real VARCHAR/STRING column
      // (`converted_type: 'UTF8'` or a STRING logical type, which every
      // non-geometry text column here has) decodes as a string either
      // way. Verified against both a DuckDB-written GEOMETRY column (geo
      // kv-metadata present) and a plain BLOB column (no geo metadata) --
      // both need both flags to come back as Uint8Array.
      utf8: false,
    });
  } catch (cause) {
    const cancelled = cancellationOf(cause, handle.signal, 'reading parquet row data');
    if (cancelled) throw cancelled;
    // Already the right error, raised by `sizeCheckedFetch`: keep its
    // `retryable` and its context rather than burying them in a `cause`.
    if (isFileChanged(cause)) throw cause;
    throw new CngError('Failed to read parquet row data.', 'DATASET_UNRESOLVED', { cause });
  }
}
