// Approach (a): full-load. Fetch the whole index parquet once via hyparquet,
// decode into memory, then do in-memory prefix search with a sorted-array
// binary search. See PLAN.md E1 (a).

import { CDN, normalize, prefixRange, instrumentFetch } from './common.js'

let hyparquetMod = null
let compressorsMod = null
async function loadDeps() {
  if (!hyparquetMod) hyparquetMod = await import(CDN.hyparquet)
  if (!compressorsMod) compressorsMod = await import(CDN.hyparquetCompressors)
  return { hyparquet: hyparquetMod, compressors: compressorsMod.compressors }
}

/**
 * Load an entire index parquet file into memory.
 * @param {string} url
 * @returns {Promise<{rows: object[], nameNorms: string[], fetchMs: number, decodeMs: number, bytes: number, requests: number}>}
 */
export async function loadFullIndex(url) {
  const { hyparquet, compressors } = await loadDeps()
  const instr = instrumentFetch()

  const t0 = performance.now()
  const res = await fetch(url)
  const buf = await res.arrayBuffer()
  const t1 = performance.now()

  const rows = await hyparquet.parquetReadObjects({
    file: buf,
    columns: ['name', 'name_norm', 'level', 'country', 'feature_id', 'bbox'],
    compressors,
  })
  const t2 = performance.now()

  const netStats = instr.stop()
  const nameNorms = rows.map((r) => r.name_norm)

  return {
    rows,
    nameNorms,
    fetchMs: t1 - t0,
    decodeMs: t2 - t1,
    bytes: netStats.bytes || buf.byteLength,
    requests: netStats.requests,
  }
}

/**
 * In-memory prefix search over an already-loaded full index.
 * @param {{rows: object[], nameNorms: string[]}} index
 * @param {string} rawQuery
 * @param {number} [limit]
 * @returns {{ms: number, count: number, results: object[]}}
 */
export function searchFull(index, rawQuery, limit = 20) {
  const prefix = normalize(rawQuery)
  const t0 = performance.now()
  const [start, end] = prefixRange(index.nameNorms, prefix)
  const results = []
  for (let i = start; i < end && results.length < limit; i++) {
    results.push(index.rows[i])
  }
  const t1 = performance.now()
  return { ms: t1 - t0, count: end - start, results }
}
