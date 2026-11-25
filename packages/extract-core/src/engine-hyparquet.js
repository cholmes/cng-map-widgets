// @cngeo/extract-core -- the default (built-in) hyparquet engine (design
// doc §3.4 Engine, design call #2: hyparquet-first, DuckDB strictly
// opt-in).

import { CancelledError } from '@cngeo/spec';
import { planRequest } from './estimate.js';
import { readRows, isFileChanged } from './parquet-io.js';
import { rowMatchesArea } from './spatial.js';
import { evaluateWhere } from './predicate.js';
import { coveringPaths, timeRowPredicate, timeSpanPredicate } from './prune.js';
import { decodeWkbGeometry, bboxOfAnyGeometry } from './wkb-geometry.js';

export const HYPARQUET_ENGINE_ID = 'hyparquet';

/**
 * `DownloadCoreOptions.maxConcurrentRequests`'s default (design doc §3.4:
 * "Parallel range reads. Default 12; the sentinel-2 precedent says the win
 * comes from parallelism, and that every read must be `cache: 'no-store'`
 * so Chrome's cache lock does not serialize them").
 *
 * The `no-store` half is already satisfied: `parquet-io.js`'s
 * `openParquetFile` builds its AsyncBuffer with
 * `requestInit: { cache: 'no-store', signal }`, and every row-group read
 * goes through that one buffer's `slice()`, so there is no second place a
 * cache mode could leak back in.
 *
 * 12 measured live against the real `sentinel-2-c1-l2a` STAC-GeoParquet
 * footprints (825 row groups for design doc §2.8's Kenya query; no bbox
 * covering, so nothing prunes): a single row-group read costs ~1.26 s
 * there and is almost entirely round-trip -- 8 reads in series took
 * 10.07 s, the same 8 concurrently 1.59 s (6.3x), while the engine's own
 * per-row filter loop is 14 ms per 6,144-row group. See this module's
 * `runHyparquetPlan` for the end-to-end before/after.
 */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 12;

/** How many times a failed row-group read is made again before the run fails. `ctx.readRetries` overrides it. */
export const DEFAULT_READ_RETRIES = 1;

/** @returns {import('./types.js').Engine} */
export function createHyparquetEngine() {
  return {
    id: HYPARQUET_ENGINE_ID,
    capabilities: ['bbox', 'intersects'],
    async plan(dataset, area, filter, ctx) {
      const plan = await planRequest(dataset, area, filter, { ...ctx, engine: this });
      return { dataset: plan.resolved, area, filter, plan };
    },
    async run(enginePlan, onBatch, ctx) {
      return runHyparquetPlan(enginePlan, onBatch, ctx);
    },
  };
}

/** Read a row's bbox from the covering columns if present, else decode the geometry. */
function rowBBox(row, covering, geometryColumn, decodedGeometryCache) {
  const paths = coveringPaths(covering);
  // `native` covering is row-group-level only (footer GeospatialStatistics);
  // it exposes no per-row columns, so fall straight through to the geometry.
  if (paths && !paths.native) {
    const struct = covering.kind === 'struct' ? row[covering.column] : row;
    const fieldNames = covering.kind === 'struct' ? (covering.fields ?? { xmin: 'xmin', ymin: 'ymin', xmax: 'xmax', ymax: 'ymax' }) : covering;
    const xmin = covering.kind === 'struct' ? struct?.[fieldNames.xmin] : row[covering.xmin];
    const ymin = covering.kind === 'struct' ? struct?.[fieldNames.ymin] : row[covering.ymin];
    const xmax = covering.kind === 'struct' ? struct?.[fieldNames.xmax] : row[covering.xmax];
    const ymax = covering.kind === 'struct' ? struct?.[fieldNames.ymax] : row[covering.ymax];
    if ([xmin, ymin, xmax, ymax].every((v) => typeof v === 'number')) return [xmin, ymin, xmax, ymax];
  }
  const geom = decodedGeometry(row, geometryColumn, decodedGeometryCache);
  return geom ? bboxOfAnyGeometry(geom) : null;
}

/**
 * Decode a row's geometry to GeoJSON. `row[geometryColumn]` is always raw
 * WKB bytes here -- never hyparquet's own auto-decoded GeoJSON object --
 * because `parquet-io.js`'s `openParquetFile` fetches metadata with
 * `geoparquet: false` specifically so that this package's one, uniform
 * decode path (`./wkb-geometry.js`'s `decodeWkbGeometry`, which delegates
 * to `@cngeo/spec`'s `wkbToGeoJson` for everything but Point/MultiPoint --
 * see that module's doc comment) is used for every dataset, whether or not
 * it carries GeoParquet `geo` key-value metadata (both the FTW and
 * tge-labs/CGAZ files this package targets do carry it; a bare/non-geo
 * parquet file would not, and previously took a silently different code
 * path through this same function -- see git history for the fix).
 */
function decodedGeometry(row, geometryColumn, cache) {
  if (cache.has(row)) return cache.get(row);
  const raw = row[geometryColumn];
  const geom = raw ? decodeWkbGeometry(raw) : null;
  cache.set(row, geom);
  return geom;
}

/**
 * A one-shot, re-armable notification. Not a queue: `notify()` wakes
 * whoever is waiting *right now* and nothing more, which is safe here
 * because every waiter re-checks the state it cares about before waiting
 * again, and JS's single thread means no waiter can be interrupted
 * between that check and its `wait()`.
 */
function latch() {
  /** @type {(() => void)|null} */
  let wake = null;
  /** @type {Promise<void>|null} */
  let pending = null;
  return {
    wait() {
      if (!pending) {
        pending = new Promise((resolve) => {
          wake = resolve;
        });
      }
      return pending;
    },
    notify() {
      if (wake) {
        const resolve = wake;
        wake = null;
        pending = null;
        resolve();
      }
    },
  };
}

/**
 * Run a plan's selected row groups.
 *
 * **Reads go in parallel; delivery stays ordered.** Row groups are fetched
 * by `maxConcurrentRequests` workers pulling from one shared cursor (the
 * same worker-pool shape as `@cngeo/geocoder-core`'s `searchRangeIndex` and
 * `geometry-resolver.js`'s `firstMatch`, commit 8c1308c -- N workers over
 * a cursor and one `Promise.all`, never concurrency-sized waves, so a slow
 * read never idles the other N-1 workers). `onBatch` is still invoked in
 * strict row-group order, by a single delivery loop that only ever hands
 * over slot `delivered`, so the output file's row order is byte-for-byte
 * what the old sequential implementation produced.
 *
 * Measured live against the real `sentinel-2-c1-l2a` STAC-GeoParquet
 * footprints -- design doc §2.8's Kenya query, which plans 825 row-group
 * reads because that dataset publishes no bbox covering, so nothing
 * prunes. Per-group cost there is ~1.26 s and is almost entirely HTTP
 * round trip; the per-row filter loop below is 14 ms per 6,144-row group.
 * See this package's README for the end-to-end table.
 *
 * **Memory.** `maxConcurrentRequests` concurrent reads means up to that
 * many decoded row groups alive at once -- 12x the peak of the sequential
 * implementation, which is the price of the speedup and the reason the
 * option exists at all (a host reading a file with very large row groups
 * should lower it). Worse, the delivery ordering is itself a buffer: if
 * group 0 is slow, every later group that finishes has to be *held*. So
 * the read-ahead is bounded -- a worker will not start the read for slot
 * `i` while `i - delivered >= maxConcurrentRequests` -- which caps live
 * decoded groups at `maxConcurrentRequests` whatever the latency spread,
 * instead of letting one slow group pull the whole remaining plan into
 * memory. The worker holding slot `delivered` is never blocked by that
 * bound (it already holds its slot), so the pipeline cannot deadlock.
 *
 * **`limit`.** The limit is applied at *delivery*, not at read time: a
 * worker cannot know how many rows the groups before it matched. Delivery
 * truncates the batch to exactly `limit - rowsSoFar`, which is the same
 * prefix the sequential implementation emitted, then stops the cursor.
 * Reads already in flight when that happens (at most
 * `maxConcurrentRequests - 1` of them) finish and are discarded, and are
 * *not* counted -- `requests`/`bytesRead`/`rowGroupsDone`/`rowsScanned`
 * are all incremented by the ordered delivery loop, so every counter
 * reports the row groups that actually contributed to the output and ends
 * on exactly the totals the sequential implementation reported.
 *
 * @param {{ dataset: any, area: import('@cngeo/spec').Area|null, filter: any, plan: Awaited<ReturnType<typeof planRequest>> }} enginePlan
 * @param {(batch: import('./types.js').FeatureBatch) => Promise<void>} onBatch
 * @param {{ signal?: AbortSignal, onProgress?: (p: object) => void|Promise<void>, limit?: number, maxConcurrentRequests?: number }} ctx
 */
async function runHyparquetPlan(enginePlan, onBatch, ctx) {
  const { area, filter, plan } = enginePlan;
  const { readColumns, outputColumns, geometryColumn, covering, perPart } = plan;
  const signal = ctx.signal;
  const limit = filter.limit;

  // Flattened in row-group order, which is both the read order the cursor
  // hands out and the delivery order `onBatch` sees.
  /** @type {{ handle: any, rg: import('./parquet-io.js').RowGroupInfo }[]} */
  const tasks = [];
  for (const part of perPart) for (const rg of part.selectedRowGroups) tasks.push({ handle: part.handle, rg });
  const rowGroupsTotal = tasks.length;

  const concurrency = Math.max(1, Math.trunc(ctx.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS));

  let rows = 0;
  let readBytes = 0;
  let requests = 0;
  let rowGroupsDone = 0;
  let rowsScannedTotal = 0;

  /** @type {({ matched: object[], scanned: number, bytes: number }|undefined)[]} */
  const results = new Array(tasks.length);
  let cursor = 0; // next task index a worker will claim
  let delivered = 0; // next task index the delivery loop will hand to onBatch
  let stopReads = false;
  let workersActive = 0;
  /** @type {unknown} */
  let firstError = null;
  const ready = latch(); // a result landed, or a worker finished/failed
  const room = latch(); // a slot was delivered and its rows freed
  /** @type {Promise<void>|null} */
  let progressBarrier = null;

  // `filter.time`, per row. Only with a declared time column: it is what
  // `resolveReadColumns` added to the read set, and without one there is
  // no cell to test (`finalizeEstimate` already warns `no-statistics`).
  const timeColumn = plan.table?.timeColumn ?? null;
  // A table whose rows carry start/end columns is tested by SPAN overlap
  // (its instant is often null, which the single-column test rejects).
  const timeInterval = plan.table?.timeInterval ?? null;
  const spanOk = timeInterval ? timeSpanPredicate(filter.time, { instant: timeColumn, ...timeInterval }) : null;
  const timeOk = !timeInterval && timeColumn ? timeRowPredicate(filter.time) : null;

  // Whether a row's bbox can be known at all from what this plan reads. It
  // cannot when the geometry was dropped from the output, there is no area
  // to need it, and no covering columns stand in for it. Then "no bbox" says
  // nothing about the row, and must not be read as "has no geometry": that
  // dropped EVERY row of such a request.
  const rowCovering = coveringPaths(covering);
  const bboxKnowable =
    !readColumns || readColumns.includes(geometryColumn) || Boolean(rowCovering && !rowCovering.native && bboxColumnNamesOf(covering).every((c) => readColumns.includes(c)));
  const requireBBox = Boolean(area) || bboxKnowable;

  /** The per-row filter the old sequential loop ran inline. Pure; no awaits. */
  function matchRows(decoded) {
    const cache = new WeakMap();
    const matched = [];
    for (const row of decoded) {
      const featureBBox = requireBBox ? rowBBox(row, covering, geometryColumn, cache) : null;
      if (requireBBox && !featureBBox) continue; // no geometry at all: can never match a spatial filter
      if (area) {
        const featureGeometry = filter.spatial.mode === 'intersects' ? decodedGeometry(row, geometryColumn, cache) : undefined;
        const ok = rowMatchesArea({ featureBBox, featureGeometry }, area, filter.spatial);
        if (!ok) continue;
      }
      if (timeOk && !timeOk(row[timeColumn])) continue;
      if (spanOk && !spanOk(row)) continue;
      if (!evaluateWhere(filter.where, row)) continue;
      matched.push(row);
      // No single row group can contribute more than `limit` rows to the
      // output, so stop collecting there -- the exact truncation happens
      // at delivery, where `rowsSoFar` is actually known.
      if (limit !== undefined && matched.length >= limit) break;
    }
    return matched;
  }

  /**
   * Read one row group, trying again when the read fails.
   *
   * A run is many range requests -- a Sentinel-2 scene search is about 80 --
   * and one of them failing used to fail all of it: seen live, two searches
   * in ten lost a single request to a transport error and, with it, every
   * scene already found. A row-group read is idempotent, so it is made
   * again (`ctx.readRetries` times, default once) before the run gives up.
   *
   * Not retried: a cancellation, and a file that changed under a kept
   * footer (parquet-io.js) -- reading that again cannot help; it has to be
   * re-planned.
   */
  const readRetries = Math.max(0, Math.trunc(ctx.readRetries ?? DEFAULT_READ_RETRIES));
  async function readRowGroup(handle, range) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await readRows(handle, range);
      } catch (err) {
        if (attempt >= readRetries || signal?.aborted || stopReads || err?.code === 'CANCELLED' || isFileChanged(err)) throw err;
      }
    }
  }

  /**
   * `pause()` is implemented by `download.js` as an `onProgress` that does
   * not resolve until `resume()` (design doc §3.5). A worker therefore has
   * to wait on that same promise *before starting another read*, or a
   * paused download would keep hammering object storage and only the
   * delivery would look paused.
   */
  async function waitForResume() {
    while (progressBarrier) {
      try {
        await progressBarrier;
      } catch {
        return; // the delivery loop owns this rejection; the worker just stops
      }
    }
  }

  async function worker() {
    workersActive += 1;
    try {
      for (;;) {
        // Acquire: both gates (pause, read-ahead bound) have to be clear
        // at the same time, and waiting on either can make the other dirty.
        for (;;) {
          await waitForResume();
          if (stopReads || firstError || signal?.aborted || cursor >= tasks.length) return;
          if (cursor - delivered >= concurrency) {
            await room.wait();
            continue;
          }
          break;
        }
        const i = cursor;
        cursor = i + 1;
        const { handle, rg } = tasks[i];
        const decoded = await readRowGroup(handle, { rowStart: rg.rowStart, rowEnd: rg.rowEnd, columns: readColumns });
        results[i] = {
          matched: matchRows(decoded),
          scanned: decoded.length,
          bytes: rg.columns && readColumns ? sumColumnBytes(rg, readColumns) : 0,
        };
        ready.notify();
      }
    } catch (err) {
      // Captured, never rethrown: a worker that rejected while its N-1
      // siblings were still in flight would make `Promise.all` settle
      // early and leave their later rejections unhandled.
      firstError ??= err;
      stopReads = true;
    } finally {
      workersActive -= 1;
      ready.notify();
      room.notify();
    }
  }

  async function reportProgress() {
    const pending = ctx.onProgress?.({
      phase: 'reading',
      rowGroupsDone,
      rowGroupsTotal,
      bytesRead: readBytes,
      rowsScanned: rowsScannedTotal,
      rowsMatched: rows,
      requests,
      bytesPerSecond: 0,
      etaMs: null,
    });
    if (!pending || typeof pending.then !== 'function') return;
    const barrier = Promise.resolve(pending).then(
      () => {
        if (progressBarrier === barrier) progressBarrier = null;
      },
      (err) => {
        if (progressBarrier === barrier) progressBarrier = null;
        throw err;
      },
    );
    progressBarrier = barrier;
    await barrier;
  }

  async function deliverInOrder() {
    while (delivered < tasks.length) {
      if (signal?.aborted) throw new CancelledError();
      if (firstError) return;
      const slot = results[delivered];
      if (slot === undefined) {
        // Nothing to hand over yet. If no worker is left to produce it,
        // the run is over (cancelled, or a worker failed).
        if (workersActive === 0) return;
        await ready.wait();
        continue;
      }
      results[delivered] = undefined; // free the held rows before awaiting anything
      delivered += 1;
      room.notify();

      requests += 1;
      readBytes += slot.bytes;
      rowGroupsDone += 1;
      rowsScannedTotal += slot.scanned;

      let matched = slot.matched;
      if (limit !== undefined && rows + matched.length > limit) matched = matched.slice(0, Math.max(0, limit - rows));
      if (matched.length > 0) {
        // `rowFormat: 'objects'` (queryRows) takes the matched rows as they
        // were read -- every READ column, geometry still WKB -- instead of
        // the columnar batch a format writer wants. No writer sets it.
        await onBatch(ctx.rowFormat === 'objects' ? { rows: matched.length, objects: matched } : buildBatch(matched, outputColumns, geometryColumn));
        rows += matched.length;
      }

      // Cooperative cancellation *and* pause (design doc §3.5): the engine
      // checks in after every row group and awaits whatever the caller's
      // progress hook returns, which is how download.js implements
      // `pause()`/`resume()` without the Engine interface needing its own
      // pause primitive. The workers wait on the same promise.
      await reportProgress();

      if (limit !== undefined && rows >= limit) {
        stopReads = true;
        room.notify();
        return;
      }
      if (signal?.aborted) throw new CancelledError();
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, () => worker());
  try {
    await deliverInOrder();
  } finally {
    // However the delivery ended -- done, limit reached, cancelled, or
    // thrown -- no further reads should start, and nothing may outlive
    // this call: the workers are awaited, not abandoned.
    stopReads = true;
    room.notify();
    ready.notify();
    await Promise.all(workers); // none of these ever reject; see worker()'s catch
  }
  if (firstError) throw firstError;
  if (signal?.aborted) throw new CancelledError();

  return { rows, readBytes, requests };
}

/** The top-level columns a row-level covering is read from. */
function bboxColumnNamesOf(covering) {
  if (covering.kind === 'struct') return [covering.column];
  return [covering.xmin, covering.ymin, covering.xmax, covering.ymax];
}

function sumColumnBytes(rg, columnNames) {
  let bytes = 0;
  for (const [path, col] of rg.columns) {
    if (columnNames.includes(path.split('.')[0])) bytes += col.totalCompressedSize;
  }
  return bytes;
}

function buildBatch(rows, outputColumns, geometryColumn) {
  /** @type {Record<string, unknown[]>} */
  const columns = {};
  for (const name of outputColumns) {
    if (name === geometryColumn) continue;
    columns[name] = rows.map((r) => r[name] ?? null);
  }
  // `outputColumns` is the one place `filter.columns.dropGeometry` already
  // takes effect (`columns.js`'s `resolveOutputColumns`): it excludes
  // `geometryColumn` from the *output* projection, unconditionally, even
  // though `readColumns` (`resolveReadColumns` / `geometryNeededForFilter`)
  // may still have asked the engine to decode geometry internally to
  // evaluate a spatial filter. Without this check, a `dropGeometry` request
  // with an `intersects` filter would read geometry for filtering (as it
  // must) and then leak those same decoded bytes into every writer via
  // `batch.geometry` -- the "no-op, not an error" bug this check closes.
  // Every writer must still receive an array the length of `rows`, so a
  // dropped geometry is `null` per row rather than an omitted field: a
  // format whose output always carries a `geometry` member (GeoJSON's
  // `Feature.geometry`, nullable by the RFC) writes `null`; GeoParquet's
  // writer (`formats/geoparquet.js`) goes further and omits the physical
  // column entirely when every row model reaching it is `null`.
  const geometry = outputColumns.includes(geometryColumn) ? rows.map((r) => r[geometryColumn] ?? null) : rows.map(() => null);
  return { rows: rows.length, columns, geometry };
}
