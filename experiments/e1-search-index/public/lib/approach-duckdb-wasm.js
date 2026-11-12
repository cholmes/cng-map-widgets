// Approach (c): duckdb-wasm baseline. Queries the REMOTE source file(s)
// directly with ILIKE 'prefix%' -- no sidecar index at all. This is the
// "why optimization is needed" baseline from PLAN.md E1 (c) / design-call
// item 2 (DuckDB-WASM is a benchmark baseline only, never shipped core).

import { CDN, instrumentFetch } from './common.js'

let duckdbMod = null
async function loadDuckdb() {
  if (!duckdbMod) duckdbMod = await import(/* @vite-ignore */ CDN.duckdbWasm)
  return duckdbMod
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms cap`)), ms)),
  ])
}

/**
 * Cold-start duckdb-wasm: instantiate the engine and run a trivial first
 * query, so "cold start" includes wasm instantiation + first-query warmup.
 * @returns {Promise<{db: any, conn: any, instantiateMs: number, firstQueryMs: number, bytes: number, requests: number}>}
 */
export async function startDuckdb() {
  const duckdb = await loadDuckdb()
  const instr = instrumentFetch()

  const t0 = performance.now()
  const bundles = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(bundles)
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  )
  const worker = new Worker(workerUrl)
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel ? duckdb.LogLevel.WARNING : undefined)
  const db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  URL.revokeObjectURL(workerUrl)
  const t1 = performance.now()

  const conn = await db.connect()
  await withTimeout(conn.query('SELECT 1'), 30000, 'cold-start warmup query')
  const t2 = performance.now()

  const netStats = instr.stop()

  return {
    db,
    conn,
    instantiateMs: t1 - t0,
    firstQueryMs: t2 - t1,
    bytes: netStats.bytes,
    requests: netStats.requests,
  }
}

/**
 * Run ILIKE 'prefix%' directly against a remote parquet URL. No index, no
 * caching beyond whatever duckdb-wasm's own vfs does across calls on the
 * same connection -- this is the baseline we expect to look bad.
 * @param {any} conn
 * @param {string} remoteUrl
 * @param {string} rawQuery
 * @param {number} [limit]
 */
export async function searchDuckdb(conn, remoteUrl, rawQuery, limit = 20) {
  const instr = instrumentFetch()
  const prefix = rawQuery.replace(/'/g, "''")
  const sql = `
    SELECT shapeName AS name, shapeGroup AS country, shapeType
    FROM '${remoteUrl}'
    WHERE shapeName ILIKE '${prefix}%'
    LIMIT ${limit}
  `
  const t0 = performance.now()
  const result = await withTimeout(conn.query(sql), 30000, `query "${rawQuery}"`)
  const t1 = performance.now()
  const netStats = instr.stop()

  return {
    ms: t1 - t0,
    count: result.numRows,
    bytes: netStats.bytes,
    requests: netStats.requests,
  }
}
