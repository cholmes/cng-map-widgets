// @cnmw/download-core -- the default (built-in) hyparquet engine (design
// doc §3.4 Engine, design call #2: hyparquet-first, DuckDB strictly
// opt-in).

import { wkbToGeoJson, bboxOfGeometry, CancelledError } from '@cnmw/spec';
import { planRequest } from './estimate.js';
import { readRows } from './parquet-io.js';
import { rowMatchesArea } from './spatial.js';
import { evaluateWhere } from './predicate.js';
import { coveringPaths } from './prune.js';

export const HYPARQUET_ENGINE_ID = 'hyparquet';

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
  if (paths) {
    const struct = covering.kind === 'struct' ? row[covering.column] : row;
    const fieldNames = covering.kind === 'struct' ? (covering.fields ?? { xmin: 'xmin', ymin: 'ymin', xmax: 'xmax', ymax: 'ymax' }) : covering;
    const xmin = covering.kind === 'struct' ? struct?.[fieldNames.xmin] : row[covering.xmin];
    const ymin = covering.kind === 'struct' ? struct?.[fieldNames.ymin] : row[covering.ymin];
    const xmax = covering.kind === 'struct' ? struct?.[fieldNames.xmax] : row[covering.xmax];
    const ymax = covering.kind === 'struct' ? struct?.[fieldNames.ymax] : row[covering.ymax];
    if ([xmin, ymin, xmax, ymax].every((v) => typeof v === 'number')) return [xmin, ymin, xmax, ymax];
  }
  const geom = decodedGeometry(row, geometryColumn, decodedGeometryCache);
  return geom ? bboxOfGeometry(geom) : null;
}

/**
 * Decode a row's geometry to GeoJSON. `row[geometryColumn]` is always raw
 * WKB bytes here -- never hyparquet's own auto-decoded GeoJSON object --
 * because `parquet-io.js`'s `openParquetFile` fetches metadata with
 * `geoparquet: false` specifically so that `@cnmw/spec`'s `wkbToGeoJson` is
 * the one, uniform decode path for every dataset, whether or not it
 * carries GeoParquet `geo` key-value metadata (both the FTW and
 * tge-labs/CGAZ files this package targets do carry it; a bare/non-geo
 * parquet file would not, and previously took a silently different code
 * path through this same function -- see git history for the fix).
 */
function decodedGeometry(row, geometryColumn, cache) {
  if (cache.has(row)) return cache.get(row);
  const raw = row[geometryColumn];
  const geom = raw ? wkbToGeoJson(raw) : null;
  cache.set(row, geom);
  return geom;
}

/**
 * @param {{ dataset: any, area: import('@cnmw/spec').Area|null, filter: any, plan: Awaited<ReturnType<typeof planRequest>> }} enginePlan
 * @param {(batch: import('./types.js').FeatureBatch) => Promise<void>} onBatch
 * @param {{ signal?: AbortSignal, onProgress?: (p: object) => void, limit?: number }} ctx
 */
async function runHyparquetPlan(enginePlan, onBatch, ctx) {
  const { area, filter, plan } = enginePlan;
  const { readColumns, outputColumns, geometryColumn, covering, perPart } = plan;
  const signal = ctx.signal;
  const limit = filter.limit;

  let rows = 0;
  let readBytes = 0;
  let requests = 0;
  let rowGroupsDone = 0;
  let rowsScannedTotal = 0;
  const rowGroupsTotal = perPart.reduce((n, p) => n + p.selectedRowGroups.length, 0);

  outer: for (const part of perPart) {
    for (const rg of part.selectedRowGroups) {
      if (signal?.aborted) throw new CancelledError();

      const decoded = await readRows(part.handle, {
        rowStart: rg.rowStart,
        rowEnd: rg.rowEnd,
        columns: readColumns,
      });
      requests += 1;
      readBytes += rg.columns && readColumns ? sumColumnBytes(rg, readColumns) : 0;
      rowGroupsDone += 1;
      rowsScannedTotal += decoded.length;

      const cache = new WeakMap();
      const matched = [];
      for (const row of decoded) {
        const featureBBox = rowBBox(row, covering, geometryColumn, cache);
        if (!featureBBox) continue; // no geometry at all: can never match a spatial filter
        if (area) {
          const featureGeometry = filter.spatial.mode === 'intersects' ? decodedGeometry(row, geometryColumn, cache) : undefined;
          const ok = rowMatchesArea({ featureBBox, featureGeometry }, area, filter.spatial);
          if (!ok) continue;
        }
        if (!evaluateWhere(filter.where, row)) continue;
        matched.push(row);
        if (limit !== undefined && rows + matched.length >= limit) break;
      }

      if (matched.length > 0) {
        const batch = buildBatch(matched, outputColumns, geometryColumn);
        await onBatch(batch);
        rows += matched.length;
      }

      // Cooperative cancellation *and* pause (design doc §3.5): the engine
      // checks in after every row group and awaits whatever the caller's
      // progress hook returns, which is how download.js implements
      // `pause()`/`resume()` without the Engine interface needing its own
      // pause primitive.
      await ctx.onProgress?.({
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

      if (limit !== undefined && rows >= limit) break outer;
      if (signal?.aborted) throw new CancelledError();
    }
  }

  return { rows, readBytes, requests };
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
  // Always raw WKB already (parquet-io.js's `geoparquet: false`), so
  // `FeatureBatch.geometry`'s WKB contract (design doc §3.4) is satisfied
  // with no decode/re-encode round trip.
  const geometry = rows.map((r) => r[geometryColumn] ?? null);
  return { rows: rows.length, columns, geometry };
}
