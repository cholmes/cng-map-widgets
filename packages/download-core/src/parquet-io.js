// @cnmw/download-core -- thin wrapper over hyparquet: footer metadata,
// row-group byte/stat extraction, and row reads. Isolated here so
// estimate.js, prune.js and engine-hyparquet.js share one notion of "what a
// row group looks like" without each reaching into raw hyparquet metadata
// shapes.

import { CnmwError } from '@cnmw/spec';
import { loadHyparquet } from './cdn.js';

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
    throw new CnmwError(`Couldn't fetch parquet file: ${url}`, 'NETWORK', { cause, context: { url } });
  }
  let metadata;
  try {
    metadata = await hyparquet.parquetMetadataAsync(file, opts.initialFetchSize ?? 65_536);
  } catch (cause) {
    throw new CnmwError(`Couldn't read parquet metadata: ${url}`, 'DATASET_UNRESOLVED', { cause, context: { url } });
  }
  const rowGroups = decodeRowGroups(metadata);
  return { url, file, metadata, rowGroups, byteLength: file.byteLength };
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
 * @param {{ file: any, metadata: any }} handle
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
    });
  } catch (cause) {
    throw new CnmwError('Failed to read parquet row data.', 'DATASET_UNRESOLVED', { cause });
  }
}
