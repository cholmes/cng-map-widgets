// @cngeo/extract-core -- queryRows: filtered rows as objects, not a file.
//
// `download()` resolves a dataset, prunes it by area, time and predicate, and
// reads what is left -- then encodes it into a file. A search needs
// everything up to that last step. `queryRows` is the same pipeline (same
// planner, same engine, same pruning narration) with the matched rows handed
// back as they arrive.
//
// It applies no ceiling: there is no output file to size. Bound a query with
// `filter.limit`, and read `plan.requests` (from `onPlan`) before deciding a
// query is worth waiting for.

import { CancelledError } from '@cngeo/spec';
import { createHyparquetEngine } from './engine-hyparquet.js';
import { finalizeEstimate } from './estimate.js';
import { decodeWkbGeometry } from './wkb-geometry.js';
import { isFileChanged } from './parquet-io.js';

/**
 * @typedef {Object} QueryPlan
 * @property {{ total: number, selected: number }} files
 * @property {{ total: number, selected: number }} rowGroups
 * @property {{ stage: string, before: number, after: number, basis: string }[]} prune  What narrowed the read, in order.
 * @property {number} requests   Requests this query makes; with a plan cache, only those not already paid for.
 * @property {object[]} warnings `estimate()`'s warnings (`no-covering`, `share-alike`, ...), flat.
 */

/**
 * Read the rows of `dataset` that match `area` and `filter`.
 *
 * Each row is a plain object of the OUTPUT columns (`filter.columns` projects,
 * exactly as it does for a download). `BigInt` values are coerced: to a
 * number when that is exact, otherwise to a decimal string, so a row always
 * survives `JSON.stringify`.
 *
 * `options.geometry` says what the geometry column holds:
 *   `'geojson'` (default)  decoded GeoJSON;
 *   `'wkb'`                what the file holds -- WKB bytes, except for a
 *                          GeoParquet 2.0 native GEOMETRY column, which the
 *                          reader has already decoded;
 *   `'none'`               the column is left out, and is not even read
 *                          unless the spatial filter needs it.
 *
 * `options.onRows` receives each row group's matches, in file order, as they
 * are read; it is awaited. `options.onPlan` receives the plan once, before any
 * row. The returned `rows` is the concatenation of every `onRows` call.
 *
 * `filter.limit` is honoured; `truncated` says whether it bound.
 * Cancellation rejects with `CANCELLED`.
 *
 * With `options.cache` (a `createPlanCache()`), a repeated query pays for row
 * reads only. If a file turns out to have been rewritten since its footer
 * was kept, the query re-plans once on its own -- provided nothing has been
 * delivered yet. Otherwise, and on a second change, it rejects with a
 * retryable `DATASET_UNRESOLVED`, `context.reason: 'file-changed'`.
 *
 * @param {import('./types.js').DatasetDescriptor} dataset
 * @param {import('@cngeo/spec').Area|null} area
 * @param {import('./types.js').FilterSpec} filter
 * @param {{
 *   onRows?: (rows: object[]) => void|Promise<void>,
 *   onPlan?: (plan: QueryPlan) => void,
 *   onProgress?: (progress: object) => void|Promise<void>,
 *   geometry?: 'geojson'|'wkb'|'none',
 *   signal?: AbortSignal,
 *   cache?: import('./plan-cache.js').PlanCache,
 *   fetch?: typeof fetch,
 *   maxConcurrentRequests?: number,
 * }} [options]
 * @returns {Promise<{ rows: object[], truncated: boolean, plan: QueryPlan }>}
 */
export async function queryRows(dataset, area, filter, options = {}) {
  const mode = options.geometry ?? 'geojson';
  if (mode !== 'geojson' && mode !== 'wkb' && mode !== 'none') {
    throw new TypeError(`queryRows: options.geometry must be 'geojson', 'wkb' or 'none' (got ${JSON.stringify(mode)}).`);
  }
  const signal = options.signal;
  const cancelled = () => new CancelledError('Cancelled.', { context: { reason: typeof signal?.reason === 'string' ? signal.reason : undefined } });
  if (signal?.aborted) throw cancelled();

  // `dropGeometry` is the existing switch for "do not output the geometry,
  // and do not read it unless the filter needs it" (columns.js).
  const effective = mode === 'none' ? { ...filter, columns: { ...(filter.columns ?? {}), dropGeometry: true } } : filter;
  const engine = createHyparquetEngine();
  const rows = [];

  async function attempt() {
    const enginePlan = await engine.plan(dataset, area, effective, { fetch: options.fetch, signal, cache: options.cache });
    const { outputColumns, geometryColumn } = enginePlan.plan;
    const estimate = await finalizeEstimate(enginePlan.plan, area, effective, {});
    const plan = {
      files: estimate.files,
      rowGroups: estimate.rowGroups,
      prune: estimate.prune,
      requests: estimate.requests,
      warnings: estimate.warnings,
    };
    if (signal?.aborted) throw cancelled();
    options.onPlan?.(plan);
    await engine.run(
      enginePlan,
      async (batch) => {
        const out = batch.objects.map((raw) => projectRow(raw, outputColumns, geometryColumn, mode));
        rows.push(...out);
        await options.onRows?.(out);
      },
      { signal, rowFormat: 'objects', maxConcurrentRequests: options.maxConcurrentRequests, onProgress: options.onProgress },
    );
    return plan;
  }

  let plan;
  try {
    plan = await attempt();
  } catch (err) {
    // The footer this was planned from described an older file. It has been
    // dropped from the cache, so planning again reads the real one. Only when
    // nothing was delivered: rows already handed to `onRows` cannot be taken
    // back, and the retry would deliver them a second time.
    if (!isFileChanged(err) || rows.length > 0 || signal?.aborted) throw err;
    plan = await attempt();
  }
  return { rows, truncated: effective.limit !== undefined && rows.length >= effective.limit, plan };
}

/** One read row -> one output row. */
function projectRow(raw, outputColumns, geometryColumn, mode) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const name of outputColumns) {
    const value = raw[name] ?? null;
    if (name !== geometryColumn) out[name] = plain(value);
    else if (mode === 'wkb') out[name] = value;
    else if (mode === 'geojson') out[name] = value === null ? null : decodeWkbGeometry(value);
  }
  return out;
}

/**
 * Make a decoded parquet value safe to hand out: hyparquet decodes INT64 as
 * `BigInt`, and one `BigInt` anywhere in a row makes `JSON.stringify` throw.
 * Walks lists and structs; leaves bytes and dates alone.
 */
function plain(value) {
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plain);
  if (ArrayBuffer.isView(value) || value instanceof Date) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = plain(v);
  return out;
}
