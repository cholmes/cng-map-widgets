// @cng/download-core -- thin wrapper over hyparquet: footer metadata,
// row-group byte/stat extraction, and row reads. Isolated here so
// estimate.js, prune.js and engine-hyparquet.js share one notion of "what a
// row group looks like" without each reaching into raw hyparquet metadata
// shapes.

import { CngError, CancelledError } from '@cng/spec';
import { loadHyparquet } from './cdn.js';

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
 *   columns: Map<string, { statistics?: { min_value?: unknown, max_value?: unknown }, totalCompressedSize: number, totalUncompressedSize: number }>,
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
  const { hyparquet } = await loadHyparquet();
  let file;
  try {
    file = await hyparquet.asyncBufferFromUrl({
      url,
      fetch: fetchImpl,
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
    // `@cng/spec`'s `wkbToGeoJson` is the single, uniform decode path
    // for every dataset regardless of whether it carries `geo` metadata.
    // Same fix, same reasoning, as `@cng/geocoder-core`'s
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
      columns.set(path, {
        statistics: meta.statistics,
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
    throw (
      cancellationOf(cause, handle.signal, 'reading parquet row data') ??
      new CngError('Failed to read parquet row data.', 'DATASET_UNRESOLVED', { cause })
    );
  }
}
