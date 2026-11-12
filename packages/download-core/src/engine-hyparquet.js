// @cnmw/download-core -- the default (built-in) hyparquet engine (design
// doc §3.4 Engine, design call #2: hyparquet-first, DuckDB strictly
// opt-in).

import { wkbToGeoJson, bboxOfGeometry, CancelledError } from '@cnmw/spec';
import { planRequest } from './estimate.js';
import { readRows } from './parquet-io.js';
import { rowMatchesArea } from './spatial.js';
import { evaluateWhere } from './predicate.js';
import { coveringPaths } from './prune.js';
import { loadHyparquetWriter } from './cdn.js';

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
 * Decode a row's geometry to GeoJSON. hyparquet auto-decodes a GeoParquet
 * `encoding: "WKB"` column straight to a GeoJSON object when the file
 * declares `geo` metadata (confirmed against real FTW and CGAZ files, both
 * of which do) -- so `row[geometryColumn]` is *usually* already GeoJSON,
 * not raw WKB bytes. Handle both: a `Uint8Array` (no/unsupported `geo`
 * metadata, or a non-GeoParquet column) is decoded with `@cnmw/spec`'s WKB
 * reader; an already-decoded object is used as-is.
 */
function decodedGeometry(row, geometryColumn, cache) {
  if (cache.has(row)) return cache.get(row);
  const raw = row[geometryColumn];
  let geom = null;
  if (raw instanceof Uint8Array) geom = wkbToGeoJson(raw);
  else if (raw && typeof raw === 'object' && 'type' in raw) geom = raw;
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
  // `FeatureBatch.geometry` is WKB per the design doc's format-plugin
  // contract (§3.4), independent of how the engine happened to decode it.
  const { geojsonToWkb } = await loadHyparquetWriter();

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
        const batch = buildBatch(matched, outputColumns, geometryColumn, cache, geojsonToWkb);
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

function buildBatch(rows, outputColumns, geometryColumn, cache, geojsonToWkb) {
  /** @type {Record<string, unknown[]>} */
  const columns = {};
  for (const name of outputColumns) {
    if (name === geometryColumn) continue;
    columns[name] = rows.map((r) => r[name] ?? null);
  }
  const geometry = rows.map((r) => {
    const raw = r[geometryColumn];
    if (raw == null) return null;
    if (raw instanceof Uint8Array) return raw; // already WKB
    const decoded = cache.get(r) ?? raw; // reuse the already-decoded GeoJSON when we have it
    return geojsonToWkb(decoded); // already a Uint8Array
  });
  return { rows: rows.length, columns, geometry };
}
