// @cng/download-core -- `estimate()` and the shared `planRequest()` the
// hyparquet engine also uses (design doc §3.4, §2.6-§2.8's pruning
// cascades, O12).

import { CngError } from '@cng/spec';
import { resolveDataset } from './dataset-resolve.js';
import { enumeratePartitions, partitionPruneCascade } from './partitions.js';
import { openParquetFile } from './parquet-io.js';
import { pruneRowGroupsByBBox, pruneRowGroupsByTime, pruneRowGroupsByWhere, readBytesForRowGroups, coveringPaths, avgColumnBytesPerRow } from './prune.js';
import { resolveOutputColumns, resolveReadColumns, geometryNeededForFilter } from './columns.js';
import { effectiveCeiling, requirementsOf } from './ceiling.js';
import { getFormat } from './registry.js';
import { boundedExact, boundedRange, sumBounded, capBounded, isEstimateWide } from './bounded.js';
import { sha256Hex } from './digest.js';
import { bboxesIntersect } from '@cng/spec';

/** Top-level column name(s) a BboxCovering reads statistics from. @param {import('./types.js').BboxCovering|undefined} covering */
export function bboxColumnNames(covering) {
  if (!covering || covering.kind === 'none') return [];
  if (covering.kind === 'struct') return [covering.column];
  return [...new Set([covering.xmin, covering.ymin, covering.xmax, covering.ymax])];
}

/**
 * Walk a flat parquet `schema` array (thrift `SchemaElement[]`, `schema[0]`
 * the synthetic root) and return only its *direct* children -- i.e. the
 * dataset's real top-level (physical) columns, each with the number of
 * flattened entries its own subtree occupies.
 *
 * A struct/group column (`num_children > 0`, e.g. a GeoParquet 1.1
 * `bbox: {xmin, ymin, xmax, ymax}` covering) has its leaf fields flattened
 * *inline*, immediately after it, in the same array -- there is no nesting
 * in the wire format, only in `num_children`'s bookkeeping. Naively mapping
 * every element's `.name` (as the previous version of this function did)
 * therefore lists a struct's children as if they were columns of their own
 * (`bbox`, *and* `xmin`, `ymin`, `xmax`, `ymax`), which is wrong twice over:
 * `table.columns` gets four extra top-level entries that do not exist as
 * physical columns, and a read that projects one of them fails with
 * "parquet column not found" because hyparquet's `columns` option only
 * accepts real top-level names. This walk instead treats `bbox` as *one*
 * column, matching `predicate.js`'s dotted-path addressing of its children
 * (`bbox.xmin`) and `prune.js`'s/`columns.js`'s use of `covering.column`.
 * @param {readonly { name: string, num_children?: number }[]} schema
 * @returns {{ name: string, isStruct: boolean }[]}
 */
function topLevelSchemaColumns(schema) {
  /** Size (element count) of the subtree rooted at `schema[index]`, including itself. */
  function subtreeSize(index) {
    const numChildren = schema[index].num_children ?? 0;
    let size = 1;
    let seen = 0;
    while (seen < numChildren) {
      size += subtreeSize(index + size);
      seen += 1;
    }
    return size;
  }
  const out = [];
  let i = 1; // schema[0] is the synthetic root
  while (i < schema.length) {
    const el = schema[i];
    out.push({ name: el.name, isStruct: (el.num_children ?? 0) > 0 });
    i += subtreeSize(i);
  }
  return out;
}

/**
 * Default byte threshold above which `finalizeEstimate` raises
 * `large-download` (`options.largeDownloadBytes` overrides it). Strictly
 * exceeded, not reached: exactly this many bytes does not warn -- see the
 * boundary test in download-size-warnings.test.js.
 */
export const DEFAULT_LARGE_DOWNLOAD_BYTES = 1024 ** 3; // 1 GiB

/**
 * Default assumed throughput (`options.throughputBytesPerSecond`) that
 * `finalizeEstimate` divides `outputBytes.estimate` by to produce
 * `estimatedSeconds` on both the `large-download` and `slow-download`
 * warnings. This is NOT a measurement of anything this request did --
 * it is a fixed, rough assumption about network speed, so a UI must
 * present `estimatedSeconds` as an approximation ("about N seconds, at an
 * assumed 10 MB/s"), never as a countdown or a promise.
 */
export const DEFAULT_THROUGHPUT_BYTES_PER_SECOND = 10_000_000;

/** Seconds above which `finalizeEstimate` raises `slow-download`. */
export const SLOW_DOWNLOAD_SECONDS = 120;

/** Guess a minimal `DatasetTable` from a parquet schema when the descriptor didn't declare one. @param {{ schema: readonly { name: string, num_children?: number }[] }} metadata */
export function inferTableFromSchema(metadata) {
  const topLevel = topLevelSchemaColumns(metadata.schema);
  const names = topLevel.map((c) => c.name);
  const geometryColumn = names.includes('geometry') ? 'geometry' : names[names.length - 1];
  const bboxCol = topLevel.find((c) => c.name === 'bbox');
  const bbox = bboxCol?.isStruct ? { kind: 'struct', column: 'bbox' } : { kind: 'none' };
  return {
    geometryColumn,
    geometryEncoding: 'WKB',
    crs: 'OGC:CRS84',
    bbox,
    columns: topLevel.map((c) => ({ name: c.name, type: c.isStruct ? 'struct' : 'unknown' })),
  };
}

/**
 * Shared resolution + pruning pipeline. Not part of the public API; used by
 * both `estimate()` and the default hyparquet engine's `plan()`.
 *
 * @param {import('./types.js').DatasetDescriptor} dataset
 * @param {import('@cng/spec').Area|null} area
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
    throw new CngError(
      'Exact clip is not available across the antimeridian. Use intersects.',
      'AREA_ANTIMERIDIAN_CLIP',
    );
  }
  for (const req of requires) {
    if (!engineCapabilities.includes(req)) {
      throw new CngError(`This filter needs an engine with the "${req}" capability.`, 'FILTER_REQUIRES_ENGINE', {
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
    const bboxPrune = pruneRowGroupsByBBox(handle.rowGroups, covering, areaBBoxes, geometryColumn);
    const timePrune = pruneRowGroupsByTime(bboxPrune.selected, table.timeColumn ?? null, filter.time);
    // `where[]` pushdown runs last in the row-group cascade: it is the
    // cheapest stage to report honestly (statistics it cannot decide
    // simply keep the row group) and it narrows what the bbox/time stages
    // already selected, so its `before` is their `after`.
    const wherePrune = pruneRowGroupsByWhere(timePrune.selected, filter.where);
    perPart.push({ part, handle, selectedRowGroups: wherePrune.selected, bboxPrune, timePrune, wherePrune });
  }
  if (!table) {
    // No parts at all (every part pruned before footer read, e.g. the
    // partition cascade alone excluded everything).
    table = { geometryColumn: 'geometry', geometryEncoding: 'WKB', crs: 'OGC:CRS84', bbox: { kind: 'none' } };
  }

  const bboxCols = bboxColumnNames(covering);
  const allColumns = table.columns?.map((c) => c.name) ?? [...new Set(perPart.flatMap((p) => topLevelSchemaColumns(p.handle.metadata.schema).map((c) => c.name)))];
  const outputColumns = resolveOutputColumns(filter.columns, allColumns, geometryColumn, bboxCols);
  // Geometry is always excluded from `outputColumns` when `dropGeometry` is
  // set (`resolveOutputColumns`, above), but it may still need to be *read*
  // -- never output, just read -- when a spatial filter can't be decided
  // without it. See `columns.js`'s `geometryNeededForFilter` doc comment
  // for the exact rule and the design decision behind it.
  const needsGeometryForFilter = geometryNeededForFilter(area, covering, filter.spatial);
  const readColumns = resolveReadColumns(outputColumns, filter, table.timeColumn ?? null, bboxCols, geometryColumn, needsGeometryForFilter);

  const rowGroupBboxStage = {
    stage: 'row-group-bbox',
    before: perPart.reduce((n, p) => n + p.bboxPrune.stage.before, 0),
    after: perPart.reduce((n, p) => n + p.bboxPrune.stage.after, 0),
    // Derived from what the parts ACTUALLY pruned on, not from the
    // descriptor: a file can declare no covering and still carry native
    // GeospatialStatistics in its footer, which prune.js falls back to.
    basis: perPart.some((p) => p.bboxPrune.stage.basis === 'native geometry statistics')
      ? 'native geometry statistics'
      : covering && covering.kind !== 'none' ? 'covering bbox' : !areaBBoxes ? 'no area supplied' : 'no covering — full scan',
  };
  const rowGroupStatsStage = {
    stage: 'row-group-stats',
    before: perPart.reduce((n, p) => n + p.timePrune.stage.before, 0),
    after: perPart.reduce((n, p) => n + p.timePrune.stage.after, 0),
    basis: filter.time ? `time ${table.timeColumn ?? '(none declared)'} window` : 'no time filter',
  };
  const rowGroupWhereStage = {
    stage: 'row-group-where',
    before: perPart.reduce((n, p) => n + p.wherePrune.stage.before, 0),
    after: perPart.reduce((n, p) => n + p.wherePrune.stage.after, 0),
    basis: perPart[0]?.wherePrune.stage.basis ?? (filter.where?.length ? 'every part pruned before its footer was read' : 'no where filter'),
  };
  const whereDecidable = perPart.some((p) => p.wherePrune.decidable);
  const whereStatsSeen = perPart.some((p) => p.wherePrune.statsSeen);

  const selectedRowGroups = perPart.flatMap((p) => p.selectedRowGroups);
  const readBytes = sumBounded(perPart.map((p) => readBytesForRowGroups(p.selectedRowGroups, readColumns)));

  // Item 7: the dataset's own average geometry bytes per row, derived from
  // footer metadata only, so `FormatPlugin.estimateBytes` can model the
  // geometry it actually has to write instead of a per-format constant.
  // Measured over the *selected* row groups (the ones this query will
  // read), falling back to every row group in the selected parts when the
  // cascade pruned them all away, so a tiny selection still gets the
  // file's own figure rather than nothing.
  const geometryBytesSource = selectedRowGroups.length > 0 ? selectedRowGroups : perPart.flatMap((p) => p.handle.rowGroups);
  const avgGeometryBytes = avgColumnBytesPerRow(geometryBytesSource, geometryColumn);

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
    rowGroupWhereStage,
    whereDecidable,
    whereStatsSeen,
    avgGeometryBytes,
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

/**
 * Builds the `{name,type}[]` schema array a `FormatPlugin.estimateBytes`
 * expects, from a resolved plan's declared table columns and its output
 * projection. Exported so `download.js` reuses exactly this shape rather
 * than recomputing it.
 * @param {Awaited<ReturnType<typeof planRequest>>} plan
 */
export function schemaFor(plan) {
  const declared = new Map((plan.table.columns ?? []).map((c) => [c.name, c]));
  return plan.outputColumns.map((name) => declared.get(name) ?? { name, type: 'unknown' });
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
 * @param {import('@cng/spec').Area|null} area
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
 * `options.output` (an `OutputSpec`) and `options.sink` (`{ kind: string
 * }|null`) are both optional and additive (design doc §7.3/§7.8): when
 * `output.format` names a format `getFormat` can resolve *synchronously*
 * (already registered, or already loaded if it was lazy -- this never
 * triggers a `load()`), the ceiling this function judges the plan against
 * is `effectiveCeiling({ format, sink, overrides: options.ceiling })`
 * instead of one flat default, and -- absent an explicit
 * `outputBytesOverride` -- `outputBytes` itself comes from that format's
 * own `estimateBytes` rather than the generic per-row heuristic. Omitting
 * `options.output` (a plain `estimate()` call with no `OutputRequest`)
 * keeps the generic `outputBytes` model exactly as before; only the
 * ceiling it is judged against changes, since `effectiveCeiling` replaces
 * `defaultCeiling()` for every caller now, formatless or not (an absent
 * `format` is `effectiveCeiling`'s already-conservative default: treated
 * as buffering, `memoryFactorOf`'s factor-3 case).
 *
 * `options.formatOverride` is an internal-only seam (not part of
 * `estimate()`'s documented options): `download()` has ALREADY resolved
 * the real `FormatPlugin` by the time it calls this -- including through
 * its `builtinFormat()` fallback for an unregistered 'geojson'/'geoparquet'
 * -- and passes that exact object here so the ceiling this function
 * derives is computed from the SAME format `outputBytesOverride` was
 * computed from. Without it, a format resolved only through that
 * fallback (never actually in the registry) would be invisible to the
 * `getFormat(options.output.format)` lookup below and silently fall back
 * to the conservative default factor -- wrong whenever the real format is
 * streaming.
 *
 * @param {Awaited<ReturnType<typeof planRequest>>} plan
 * @param {import('@cng/spec').Area|null} area
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('./types.js').DownloadCoreOptions & { output?: import('./types.js').OutputRequest, sink?: { kind: string }|null, outputBytesOverride?: import('./bounded.js').Bounded, formatOverride?: import('./types.js').FormatPlugin }} options
 * @param {number} [t0]
 */
export async function finalizeEstimate(plan, area, filter, options = {}, t0 = performance.now()) {
  const format = options.formatOverride ?? (options.output ? getFormat(options.output.format) : undefined);
  const sink = options.sink ?? null;
  const ceiling = effectiveCeiling({ format, sink, overrides: options.ceiling });

  const outputBytes =
    options.outputBytesOverride ??
    (format
      ? format.estimateBytes(schemaFor(plan), plan.rows, { avgGeometryBytes: plan.avgGeometryBytes ?? null, geometryColumn: plan.geometryColumn })
      : genericOutputBytesModel(plan));

  /** @type {import('./types.js').EstimateWarning[]} */
  const warnings = [];
  const prunedNatively = plan.rowGroupBboxStage?.basis === 'native geometry statistics';
  if ((!plan.covering || plan.covering.kind === 'none') && !prunedNatively) {
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
  // Honest about `where[]` pushdown: say so when the predicate *could*
  // have pruned from statistics but the files carry none for its columns,
  // rather than letting a full scan look like an unselective predicate.
  if (plan.whereDecidable && !plan.whereStatsSeen) {
    warnings.push({ code: 'no-statistics', message: 'No column statistics for the where[] predicate columns; the predicate could not prune row groups and is applied per row after the read.' });
  }
  // `estimatedSeconds` is a rough ETA from a fixed, assumed throughput --
  // never a measurement of this request -- shared by both warnings below
  // so a UI showing one can't disagree with the other (see module doc on
  // `DEFAULT_THROUGHPUT_BYTES_PER_SECOND`).
  const throughputBytesPerSecond = options.throughputBytesPerSecond ?? DEFAULT_THROUGHPUT_BYTES_PER_SECOND;
  const largeDownloadBytes = options.largeDownloadBytes ?? DEFAULT_LARGE_DOWNLOAD_BYTES;
  const estimatedSeconds = Math.round(outputBytes.estimate / throughputBytesPerSecond);
  if (outputBytes.estimate > largeDownloadBytes) {
    warnings.push({ code: 'large-download', bytes: outputBytes.estimate, estimatedSeconds });
  }
  if (estimatedSeconds > SLOW_DOWNLOAD_SECONDS) {
    warnings.push({ code: 'slow-download', estimatedSeconds });
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
    prune: [...plan.partStages, plan.rowGroupBboxStage, plan.rowGroupStatsStage, plan.rowGroupWhereStage],
    columns: plan.outputColumns,
    warnings,
    ceiling: { exceeded: breaches.length > 0, limits: ceiling, breaches },
    elapsedMs: performance.now() - t0,
  };
}
