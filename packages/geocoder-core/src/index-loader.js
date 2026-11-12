// @cnmw/geocoder-core -- index manifest + parquet loading.
//
// Reuses the proven hyparquet patterns from
// experiments/e1-search-index/public/lib/{approach-full-load,approach-range-request}.js:
// a full-load path (fetch once, decode, in-memory binary search) and a
// range-request path (footer-only, then range-read matching row groups).
// `auto` picks between them per design doc §3.2 / §6.3 item 8.

import { CnmwError } from '@cnmw/spec';
import { CDN } from './cdn.js';

const REQUIRED_COLUMNS = ['name', 'name_norm', 'level', 'country', 'feature_id', 'source', 'bbox'];
const OPTIONAL_COLUMNS = ['parent_name', 'parent_id', 'area_km2', 'geometry_ref'];

let hyparquetMod = null;
let compressorsMod = null;
/** Lazily imports hyparquet from the pinned CDN URL (design doc §4.2: never a bare specifier). */
async function loadHyparquet() {
  if (!hyparquetMod) hyparquetMod = await import(/* @vite-ignore */ CDN.hyparquet);
  if (!compressorsMod) compressorsMod = await import(/* @vite-ignore */ CDN.hyparquetCompressors);
  return { hyparquet: hyparquetMod, compressors: compressorsMod.compressors };
}

/**
 * Fetch and validate the index manifest (design doc §6.4).
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadManifest(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url);
  } catch (cause) {
    throw new CnmwError(`Couldn't load the place index manifest at ${url}.`, 'INDEX_FETCH_FAILED', { cause });
  }
  if (!res.ok) {
    throw new CnmwError(`Index manifest fetch failed: HTTP ${res.status}`, 'INDEX_FETCH_FAILED', {
      context: { status: res.status, url },
    });
  }
  const manifest = await res.json();
  if (manifest.spec !== 'cnmw-index/1.0') {
    throw new CnmwError('Index manifest has an unrecognized spec version.', 'INDEX_SCHEMA_MISMATCH', {
      context: { spec: manifest.spec },
    });
  }
  return manifest;
}

/**
 * A manifest URL may itself be relative (e.g. `'./data/index.json'`, the
 * common case for a same-origin zero-build page). `URL(rel, base)`
 * requires an absolute base, so resolve against `location.href` first
 * when running in a browser; outside one, the caller must pass an
 * absolute URL.
 */
export function toAbsoluteUrl(url) {
  if (typeof location !== 'undefined' && location.href) return new URL(url, location.href).toString();
  return new URL(url).toString();
}

/** Resolve a manifest-relative URL against the manifest's own (possibly relative) URL. */
export function resolveManifestUrl(manifestUrl, relativeUrl) {
  return new URL(relativeUrl, toAbsoluteUrl(manifestUrl)).toString();
}

function assertSchema(firstRow) {
  for (const col of REQUIRED_COLUMNS) {
    if (!(col in firstRow)) {
      throw new CnmwError(`Index parquet is missing required column "${col}".`, 'INDEX_SCHEMA_MISMATCH', {
        context: { column: col },
      });
    }
  }
}

/**
 * Full-load strategy: fetch the whole index parquet, decode every row,
 * return an in-memory structure ready for binary-search prefix queries.
 * @param {string} parquetUrl
 * @param {typeof fetch} fetchImpl
 */
export async function loadFullIndex(parquetUrl, fetchImpl) {
  const { hyparquet, compressors } = await loadHyparquet();
  const t0 = performance.now();
  const res = await fetchImpl(parquetUrl);
  if (!res.ok) {
    throw new CnmwError(`Index parquet fetch failed: HTTP ${res.status}`, 'INDEX_FETCH_FAILED', {
      context: { status: res.status, url: parquetUrl },
    });
  }
  const buf = await res.arrayBuffer();
  let rows;
  try {
    rows = await hyparquet.parquetReadObjects({ file: buf, compressors });
  } catch (cause) {
    throw new CnmwError('Failed to decode index parquet.', 'INDEX_SCHEMA_MISMATCH', { cause });
  }
  if (rows.length > 0) assertSchema(rows[0]);
  const nameNorms = rows.map((r) => r.name_norm);
  // Builder guarantee check (design doc §6.3 item 1): ascending, byte-wise.
  for (let i = 1; i < nameNorms.length; i++) {
    if (nameNorms[i - 1] > nameNorms[i]) {
      throw new CnmwError('Index parquet is not sorted ascending by name_norm.', 'INDEX_SCHEMA_MISMATCH', {
        context: { atRow: i },
      });
    }
  }
  const loadMs = performance.now() - t0;
  return { strategy: 'full', rows, nameNorms, bytes: buf.byteLength, loadMs };
}

/** Binary search a sorted array of strings for the half-open range starting with `prefix`. */
function lowerBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** [start, end) indices of entries starting with `prefix` in a sorted array. */
export function prefixRange(arr, prefix) {
  const start = lowerBound(arr, prefix);
  const end = lowerBound(arr, prefix + '￿');
  return [start, end];
}

/**
 * Range-request strategy: read the parquet footer only, bucket row groups
 * by their name_norm min/max statistics, and fetch just the candidate
 * group(s) per query.
 * @param {string} parquetUrl
 * @param {typeof fetch} fetchImpl
 * @param {number} initialFetchSize
 */
export async function openRangeIndex(parquetUrl, fetchImpl, initialFetchSize = 65_536) {
  const { hyparquet } = await loadHyparquet();
  const t0 = performance.now();
  const file = await hyparquet.asyncBufferFromUrl({ url: parquetUrl, fetch: fetchImpl, requestInit: { cache: 'no-store' } });
  const metadata = await hyparquet.parquetMetadataAsync(file, initialFetchSize);
  const groups = [];
  let rowStart = 0;
  for (const rg of metadata.row_groups) {
    const col = rg.columns.find((c) => c.meta_data && c.meta_data.path_in_schema.join('.') === 'name_norm');
    const stats = col && col.meta_data && col.meta_data.statistics;
    const numRows = Number(rg.num_rows);
    groups.push({
      rowStart,
      rowEnd: rowStart + numRows,
      min: stats ? String(stats.min_value) : '',
      max: stats ? String(stats.max_value) : '￿',
    });
    rowStart += numRows;
  }
  if (groups.length === 0) {
    throw new CnmwError('Index parquet has no row groups.', 'INDEX_SCHEMA_MISMATCH');
  }
  const loadMs = performance.now() - t0;
  return { strategy: 'range', url: parquetUrl, file, metadata, groups, rows: rowStart, loadMs };
}

/** Which row-group indices could contain `prefix`, via a binary search over group [min,max]. */
export function findCandidateGroups(groups, prefix) {
  const hiBound = prefix + '￿';
  let lo = 0;
  let hi = groups.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (groups[mid].max < prefix) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [];
  for (let i = lo; i < groups.length; i++) {
    if (groups[i].min > hiBound) break;
    candidates.push(i);
  }
  return candidates;
}

/**
 * Fetch only the row group(s) that can contain `prefix` and filter to an
 * exact prefix match.
 * @param {ReturnType<typeof openRangeIndex> extends Promise<infer T> ? T : never} handle
 * @param {string} prefix
 */
export async function searchRangeIndex(handle, prefix) {
  const { hyparquet, compressors } = await loadHyparquet();
  const candidateIdx = findCandidateGroups(handle.groups, prefix);
  let allRows = [];
  for (const gi of candidateIdx) {
    const g = handle.groups[gi];
    const rows = await hyparquet.parquetReadObjects({
      file: handle.file,
      metadata: handle.metadata,
      rowStart: g.rowStart,
      rowEnd: g.rowEnd,
      compressors,
    });
    allRows = allRows.concat(rows);
  }
  return allRows.filter((r) => r.name_norm && r.name_norm.startsWith(prefix));
}
