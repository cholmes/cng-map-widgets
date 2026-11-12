// Approach (b): range-request. Read only the parquet footer/metadata,
// binary-search row groups using the name_norm column's min/max statistics,
// then fetch only the matching row group(s) via HTTP byte ranges. See
// PLAN.md E1 (b). Requires the file to be sorted by name_norm (build-index.sql
// guarantees this) so that row-group stats partition the keyspace.

import { CDN, normalize, createTrackedFetch } from './common.js'

let hyparquetMod = null
let compressorsMod = null
async function loadDeps() {
  if (!hyparquetMod) hyparquetMod = await import(CDN.hyparquet)
  if (!compressorsMod) compressorsMod = await import(CDN.hyparquetCompressors)
  return { hyparquet: hyparquetMod, compressors: compressorsMod.compressors }
}

/**
 * Open a sorted index parquet file lazily: fetch+parse the footer only.
 * @param {string} url
 * @returns {Promise<object>} range index handle
 */
export async function openRangeIndex(url) {
  const { hyparquet } = await loadDeps()
  // One tracked-fetch function lives for the lifetime of this index handle
  // and is the ONLY fetch hyparquet ever uses for it (see createTrackedFetch
  // doc comment for why window.fetch patching doesn't work here).
  const tracked = createTrackedFetch()

  const t0 = performance.now()
  const file = await hyparquet.asyncBufferFromUrl({ url, fetch: tracked.fetch })
  const metadata = await hyparquet.parquetMetadataAsync(file)
  const t1 = performance.now()

  const footerStats = tracked.stats()
  tracked.reset()

  // Build per-row-group [rowStart, rowEnd) + name_norm min/max.
  const groups = []
  let rowStart = 0
  for (const rg of metadata.row_groups) {
    const col = rg.columns.find((c) => c.meta_data && c.meta_data.path_in_schema.join('.') === 'name_norm')
    const stats = col && col.meta_data && col.meta_data.statistics
    const numRows = Number(rg.num_rows)
    groups.push({
      rowStart,
      rowEnd: rowStart + numRows,
      min: stats ? String(stats.min_value) : '',
      max: stats ? String(stats.max_value) : '￿',
    })
    rowStart += numRows
  }

  return {
    url,
    file,
    metadata,
    groups,
    tracked,
    footerMs: t1 - t0,
    footerBytes: footerStats.bytes,
    footerRequests: footerStats.requests,
  }
}

/**
 * Binary-search which row groups can possibly contain `prefix`, using each
 * group's [min, max] name_norm statistics. Groups are contiguous in sort
 * order, so this is a binary search for the first candidate followed by a
 * forward scan of the (typically 1-2) overlapping groups.
 * @param {{min:string,max:string}[]} groups
 * @param {string} prefix
 * @returns {number[]} candidate group indices
 */
export function findCandidateGroups(groups, prefix) {
  const hiBound = prefix + '￿'
  let lo = 0
  let hi = groups.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (groups[mid].max < prefix) lo = mid + 1
    else hi = mid
  }
  const candidates = []
  for (let i = lo; i < groups.length; i++) {
    if (groups[i].min > hiBound) break
    candidates.push(i)
  }
  return candidates
}

/**
 * Fetch only the row group(s) that can contain `rawQuery` and filter.
 * @param {object} index result of openRangeIndex
 * @param {string} rawQuery
 * @param {number} [limit]
 */
export async function searchRange(index, rawQuery, limit = 20) {
  const { hyparquet, compressors } = await loadDeps()
  const prefix = normalize(rawQuery)
  index.tracked.reset()

  const t0 = performance.now()
  const candidateIdx = findCandidateGroups(index.groups, prefix)

  let allRows = []
  for (const gi of candidateIdx) {
    const g = index.groups[gi]
    const rows = await hyparquet.parquetReadObjects({
      file: index.file,
      metadata: index.metadata,
      columns: ['name', 'name_norm', 'level', 'country', 'feature_id', 'bbox'],
      rowStart: g.rowStart,
      rowEnd: g.rowEnd,
      compressors,
    })
    allRows = allRows.concat(rows)
  }
  const matches = allRows.filter((r) => r.name_norm && r.name_norm.startsWith(prefix))
  const results = matches.slice(0, limit)
  const t1 = performance.now()

  const netStats = index.tracked.stats()

  return {
    ms: t1 - t0,
    groupsFetched: candidateIdx.length,
    totalGroups: index.groups.length,
    count: matches.length,
    results,
    bytes: netStats.bytes,
    requests: netStats.requests,
  }
}
