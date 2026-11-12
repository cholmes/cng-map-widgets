// @cnmw/download-core -- `estimate()` and the shared `planRequest()` the
// hyparquet engine also uses (design doc §3.4, §2.6-§2.8's pruning
// cascades, O12).

import { CnmwError } from '@cnmw/spec';
import { resolveDataset } from './dataset-resolve.js';
import { enumeratePartitions, partitionPruneCascade } from './partitions.js';
import { openParquetFile } from './parquet-io.js';
import { pruneRowGroupsByBBox, pruneRowGroupsByTime, readBytesForRowGroups, coveringPaths } from './prune.js';
import { resolveOutputColumns, resolveReadColumns } from './columns.js';
import { defaultCeiling, requirementsOf } from './ceiling.js';
import { boundedExact, boundedRange, sumBounded, capBounded, isEstimateWide } from './bounded.js';
import { sha256Hex } from './digest.js';
import { bboxesIntersect } from '@cnmw/spec';

/** Top-level column name(s) a BboxCovering reads statistics from. @param {import('./types.js').BboxCovering|undefined} covering */
export function bboxColumnNames(covering) {
  if (!covering || covering.kind === 'none') return [];
  if (covering.kind === 'struct') return [covering.column];
  return [...new Set([covering.xmin, covering.ymin, covering.xmax, covering.ymax])];
}

/** Guess a minimal `DatasetTable` from a parquet schema when the descriptor didn't declare one. */
function inferTableFromSchema(metadata) {
  const names = metadata.schema.slice(1).map((e) => e.name); // schema[0] is the synthetic 'root'
  const geometryColumn = names.includes('geometry') ? 'geometry' : names[names.length - 1];
  const bbox = names.includes('bbox') ? { kind: 'struct', column: 'bbox' } : { kind: 'none' };
  return {
    geometryColumn,
    geometryEncoding: 'WKB',
    crs: 'OGC:CRS84',
    bbox,
    columns: names.map((name) => ({ name, type: 'unknown' })),
  };
}

/**
 * Shared resolution + pruning pipeline. Not part of the public API; used by
 * both `estimate()` and the default hyparquet engine's `plan()`.
 *
 * @param {import('./types.js').DatasetDescriptor} dataset
 * @param {import('@cnmw/spec').Area|null} area
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('./types.js').DownloadCoreOptions} options
 */
export async function planRequest(dataset, area, filter, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const signal = options.signal;
  let requests = 0;

  const resolved = await resolveDataset(dataset, { fetch: fetchImpl, signal });

  const requires = requirementsOf(filter, area);
  const engineCapabilities = options.engine?.capabilities ?? ['bbox', 'intersects'];
  if (filter.spatial.mode === 'clip' && area?.crossesAntimeridian) {
    throw new CnmwError(
      'Exact clip is not available across the antimeridian. Use intersects.',
      'AREA_ANTIMERIDIAN_CLIP',
    );
  }
  for (const req of requires) {
    if (!engineCapabilities.includes(req)) {
      throw new CnmwError(`This filter needs an engine with the "${req}" capability.`, 'FILTER_REQUIRES_ENGINE', {
        context: { requirement: req },
      });
    }
  }

  // --- partition / part enumeration -------------------------------------
  const src = resolved.source;
  /** @type {import('./types.js').DatasetPart[]} */
  let parts;
  if (src.kind === 'parquet') {
    parts = [{ url: src.url }];
  } else if (src.kind === 'parquet-set') {
    parts = src.parts ?? src.urls.map((url) => ({ url }));
  } else {
    const en = await enumeratePartitions(src, { fetch: fetchImpl, signal });
    parts = en.parts;
    requests += en.requests;
  }

  const areaBBoxes = area ? area.bboxes : null;
  const { selected: selectedParts, stages: partStages } = partitionPruneCascade(
    parts,
    areaBBoxes,
    filter.time,
    filter.partitions,
  );

  // --- per-part footers + row-group pruning ------------------------------
  let table = resolved.table;
  let geometryColumn = table?.geometryColumn ?? 'geometry';
  let covering = table?.bbox;
  let allRowGroupsTotal = 0;
  const perPart = [];
  for (const part of selectedParts) {
    const handle = await openParquetFile(part.url, fetchImpl, { signal });
    requests += 1;
    if (!table) {
      table = inferTableFromSchema(handle.metadata);
      geometryColumn = table.geometryColumn;
      covering = table.bbox;
    }
    allRowGroupsTotal += handle.rowGroups.length;
    const bboxPrune = pruneRowGroupsByBBox(handle.rowGroups, covering, areaBBoxes);
    const timePrune = pruneRowGroupsByTime(bboxPrune.selected, table.timeColumn ?? null, filter.time);
    perPart.push({ part, handle, selectedRowGroups: timePrune.selected, bboxPrune, timePrune });
  }
  if (!table) {
    // No parts at all (every part pruned before footer read, e.g. the
    // partition cascade alone excluded everything).
    table = { geometryColumn: 'geometry', geometryEncoding: 'WKB', crs: 'OGC:CRS84', bbox: { kind: 'none' } };
  }

  const bboxCols = bboxColumnNames(covering);
  const allColumns = table.columns?.map((c) => c.name) ?? [...new Set(perPart.flatMap((p) => [...p.handle.metadata.schema.slice(1).map((e) => e.name)]))];
  const outputColumns = resolveOutputColumns(filter.columns, allColumns, geometryColumn, bboxCols);
  const readColumns = resolveReadColumns(outputColumns, filter, table.timeColumn ?? null, bboxCols, geometryColumn);

  const rowGroupBboxStage = {
    stage: 'row-group-bbox',
    before: perPart.reduce((n, p) => n + p.bboxPrune.stage.before, 0),
    after: perPart.reduce((n, p) => n + p.bboxPrune.stage.after, 0),
    basis: covering && covering.kind !== 'none' ? 'covering bbox' : !areaBBoxes ? 'no area supplied' : 'no covering — full scan',
  };
  const rowGroupStatsStage = {
    stage: 'row-group-stats',
    before: perPart.reduce((n, p) => n + p.timePrune.stage.before, 0),
    after: perPart.reduce((n, p) => n + p.timePrune.stage.after, 0),
    basis: filter.time ? `time ${table.timeColumn ?? '(none declared)'} window` : 'no time filter',
  };

  const selectedRowGroups = perPart.flatMap((p) => p.selectedRowGroups);
  const readBytes = sumBounded(perPart.map((p) => readBytesForRowGroups(p.selectedRowGroups, readColumns)));

  // --- row-count estimate (O12: metadata-only, with a bbox-area-overlap
  // selectivity heuristic when an Area is present) -----------------------
  const maxRows = selectedRowGroups.reduce((n, rg) => n + rg.numRows, 0);
  const noFiltering = !area && (!filter.where || filter.where.length === 0) && !filter.time;
  let rows;
  if (noFiltering) {
    rows = boundedExact(maxRows);
  } else {
    const ratio = area ? estimateAreaOverlapRatio(perPart, areaBBoxes) : 0.5;
    const estimateRows = Math.max(0, Math.min(maxRows, Math.round(maxRows * ratio)));
    rows = boundedRange(0, maxRows, estimateRows, false);
  }
  if (filter.limit !== undefined) rows = capBounded(rows, filter.limit);

  return {
    resolved,
    table,
    geometryColumn,
    covering,
    perPart,
    partStages,
    rowGroupBboxStage,
    rowGroupStatsStage,
    parts,
    selectedParts,
    allRowGroupsTotal,
    selectedRowGroupsTotal: selectedRowGroups.length,
    maxRowsBeforeLimit: maxRows,
    outputColumns,
    readColumns,
    readBytes,
    rows,
    requests: requests + selectedRowGroups.length, // + one coalesced range read per surviving row group
  };
}

/**
 * Approximate selectivity: for each selected row group with a known bbox,
 * the fraction of its bbox area covered by the area's bboxes, weighted by
 * row count. This is a heuristic, not a geometric guarantee (real
 * selectivity depends on how features are distributed within the row
 * group) -- hence `Bounded.exact: false` and the `estimate-wide` warning
 * when the ratio is small relative to `max`.
 */
function estimateAreaOverlapRatio(perPart, areaBBoxes) {
  let weightedRatio = 0;
  let totalRows = 0;
  for (const p of perPart) {
    for (const rg of p.selectedRowGroups) {
      const rgBBox = p.bboxPrune.rowGroupBBoxes.get(rg.index);
      const ratio = rgBBox ? boxOverlapRatio(rgBBox, areaBBoxes) : 1; // no stats: assume no reduction
      weightedRatio += ratio * rg.numRows;
      totalRows += rg.numRows;
    }
  }
  if (totalRows === 0) return 1;
  return Math.max(0.02, Math.min(1, weightedRatio / totalRows));
}

function boxOverlapRatio(box, areaBBoxes) {
  const boxArea = Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
  if (boxArea === 0) return areaBBoxes.some((a) => bboxesIntersect(box, a)) ? 1 : 0;
  let overlapArea = 0;
  for (const a of areaBBoxes) {
    const ox = Math.max(0, Math.min(box[2], a[2]) - Math.max(box[0], a[0]));
    const oy = Math.max(0, Math.min(box[3], a[3]) - Math.max(box[1], a[1]));
    overlapArea += ox * oy;
  }
  return Math.min(1, overlapArea / boxArea);
}

/** Generic, format-agnostic bytes-per-row model used when `estimate()` is called standalone (no `OutputRequest` -- see module doc). */
function genericOutputBytesModel(plan) {
  const avgReadBytesPerRow = plan.maxRowsBeforeLimit > 0 ? plan.readBytes.estimate / plan.maxRowsBeforeLimit : 200;
  const EXPANSION = 1.6; // decoded/text output vs on-disk compressed columnar bytes, rough
  const perRow = Math.max(40, avgReadBytesPerRow * EXPANSION);
  return {
    min: plan.rows.min * perRow,
    max: plan.rows.max * perRow,
    estimate: plan.rows.estimate * perRow,
    exact: false,
  };
}

/**
 * design doc §3.4. **DEVIATION**: the published signature takes no
 * `OutputRequest`, so the standalone `estimate()` necessarily uses a
 * generic, format-agnostic bytes-per-row model for `outputBytes`
 * (documented on `genericOutputBytesModel`). `download()` recomputes
 * `outputBytes` internally with the real `FormatPlugin.estimateBytes` once
 * it knows the output format, and that more accurate number is what the
 * ceiling check inside `download()` actually uses.
 *
 * @param {import('./types.js').DatasetDescriptor} dataset
 * @param {import('@cnmw/spec').Area|null} area
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('./types.js').DownloadCoreOptions & { signal?: AbortSignal, outputBytesOverride?: import('./bounded.js').Bounded }} [options]
 * @returns {Promise<import('./types.js').Estimate>}
 */
export async function estimate(dataset, area, filter, options = {}) {
  const t0 = performance.now();
  const plan = await planRequest(dataset, area, filter, options);
  return finalizeEstimate(plan, area, filter, options, t0);
}

/**
 * Turn an already-computed `plan` (from `planRequest`) into a public
 * `Estimate`. Split out of `estimate()` so `download()` can reuse the same
 * plan its engine already produced, with the *real* output format's
 * `estimateBytes` in place of the generic model (see module doc comment).
 *
 * @param {Awaited<ReturnType<typeof planRequest>>} plan
 * @param {import('@cnmw/spec').Area|null} area
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('./types.js').DownloadCoreOptions & { outputBytesOverride?: import('./bounded.js').Bounded }} options
 * @param {number} [t0]
 */
export async function finalizeEstimate(plan, area, filter, options = {}, t0 = performance.now()) {
  const ceiling = { ...defaultCeiling(), ...options.ceiling };

  const outputBytes = options.outputBytesOverride ?? genericOutputBytesModel(plan);

  /** @type {import('./types.js').EstimateWarning[]} */
  const warnings = [];
  if (!plan.covering || plan.covering.kind === 'none') {
    warnings.push({ code: 'no-covering', message: 'This dataset has no bbox covering column; row-group pruning cannot narrow the read.' });
  }
  const singleRowGroupFiles = plan.perPart.filter((p) => p.handle.rowGroups.length === 1 && p.selectedRowGroups.length === 1).length;
  if (singleRowGroupFiles > 0) {
    warnings.push({ code: 'single-row-group', message: 'One or more selected files are a single row group; pruning cannot narrow the read within them.', files: singleRowGroupFiles });
  }
  if (area && !area.filterGeometry) {
    warnings.push({ code: 'degraded-to-bbox', message: "This Area's filter geometry was unavailable or degraded; filtering falls back to its bbox alone." });
  }
  if (area && area.bboxes.length > 1) {
    warnings.push({ code: 'antimeridian-split', boxes: area.bboxes.length });
  }
  if (isEstimateWide(plan.rows)) {
    warnings.push({ code: 'estimate-wide', ratio: plan.rows.estimate > 0 ? plan.rows.max / plan.rows.estimate : Infinity });
  }
  const shareAlike = (plan.resolved.attribution ?? []).filter((a) => a.shareAlike);
  if (shareAlike.length > 0) warnings.push({ code: 'share-alike', attribution: shareAlike });
  if (filter.time && plan.rowGroupStatsStage.before === plan.rowGroupStatsStage.after && !plan.table.timeColumn) {
    warnings.push({ code: 'no-statistics', message: 'No declared time column; the time filter could not prune row groups.' });
  }

  const breaches = [];
  if (plan.rows.max > ceiling.rows) breaches.push('rows');
  if (outputBytes.max > ceiling.outputBytes) breaches.push('outputBytes');
  if (plan.readBytes.max > ceiling.readBytes) breaches.push('readBytes');
  if (plan.selectedParts.length > ceiling.files) breaches.push('files');

  const requestDigest = await sha256Hex(
    JSON.stringify({ dataset: plan.resolved, areaId: area?.id ?? null, filter }),
  );

  return {
    requestDigest,
    rows: plan.rows,
    readBytes: plan.readBytes,
    outputBytes,
    files: { total: plan.parts.length, selected: plan.selectedParts.length },
    rowGroups: { total: plan.allRowGroupsTotal, selected: plan.selectedRowGroupsTotal },
    requests: plan.requests,
    prune: [...plan.partStages, plan.rowGroupBboxStage, plan.rowGroupStatsStage],
    columns: plan.outputColumns,
    warnings,
    ceiling: { exceeded: breaches.length > 0, limits: ceiling, breaches },
    elapsedMs: performance.now() - t0,
  };
}
