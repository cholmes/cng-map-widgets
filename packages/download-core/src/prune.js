// @cnmw/download-core -- the pruning cascade (design doc §2.6/§2.7's
// "pruning cascade, in order, each stage reported in the estimate").
//
// Metadata-only (O12): every function here reads only parquet footer
// statistics / column-chunk byte sizes, never a data page.

import { boundedExact } from './bounded.js';
import { bboxesIntersect } from '@cnmw/spec';
import { rowGroupBytesForColumns } from './parquet-io.js';

/** @typedef {import('@cnmw/spec').BBox} BBox */

/** Resolve a `BboxCovering` to the statistics column paths for xmin/ymin/xmax/ymax, or null if `kind: 'none'`. @param {import('./types.js').BboxCovering|undefined} covering */
export function coveringPaths(covering) {
  if (!covering || covering.kind === 'none') return null;
  if (covering.kind === 'columns') {
    return { xmin: covering.xmin, ymin: covering.ymin, xmax: covering.xmax, ymax: covering.ymax };
  }
  const fields = covering.fields ?? { xmin: 'xmin', ymin: 'ymin', xmax: 'xmax', ymax: 'ymax' };
  return {
    xmin: `${covering.column}.${fields.xmin}`,
    ymin: `${covering.column}.${fields.ymin}`,
    xmax: `${covering.column}.${fields.xmax}`,
    ymax: `${covering.column}.${fields.ymax}`,
  };
}

/** Read a row group's bbox from its covering-column statistics, or null if any stat is missing. @param {import('./parquet-io.js').RowGroupInfo} rg @param {ReturnType<typeof coveringPaths>} paths @returns {BBox|null} */
export function rowGroupBBoxFromStats(rg, paths) {
  if (!paths) return null;
  const xminCol = rg.columns.get(paths.xmin);
  const yminCol = rg.columns.get(paths.ymin);
  const xmaxCol = rg.columns.get(paths.xmax);
  const ymaxCol = rg.columns.get(paths.ymax);
  const xmin = xminCol?.statistics?.min_value;
  const ymin = yminCol?.statistics?.min_value;
  const xmax = xmaxCol?.statistics?.max_value;
  const ymax = ymaxCol?.statistics?.max_value;
  if ([xmin, ymin, xmax, ymax].some((v) => v === undefined || v === null)) return null;
  return [Number(xmin), Number(ymin), Number(xmax), Number(ymax)];
}

/**
 * Prune row groups by bbox-covering statistics against the Area's
 * (antimeridian-split) bboxes.
 * @param {import('./parquet-io.js').RowGroupInfo[]} rowGroups
 * @param {import('./types.js').BboxCovering|undefined} covering
 * @param {BBox[]|null} areaBBoxes -- null means "no area": select everything.
 * @returns {{ selected: import('./parquet-io.js').RowGroupInfo[], stage: import('./types.js').PruneStage, rowGroupBBoxes: Map<number, BBox|null> }}
 */
export function pruneRowGroupsByBBox(rowGroups, covering, areaBBoxes) {
  const before = rowGroups.length;
  const paths = coveringPaths(covering);
  const rowGroupBBoxes = new Map();

  if (!areaBBoxes || !paths) {
    for (const rg of rowGroups) rowGroupBBoxes.set(rg.index, paths ? rowGroupBBoxFromStats(rg, paths) : null);
    return {
      selected: rowGroups,
      rowGroupBBoxes,
      stage: {
        stage: 'row-group-bbox',
        before,
        after: before,
        basis: !areaBBoxes ? 'no area supplied' : 'no covering — full scan',
      },
    };
  }

  const selected = [];
  for (const rg of rowGroups) {
    const bbox = rowGroupBBoxFromStats(rg, paths);
    rowGroupBBoxes.set(rg.index, bbox);
    if (!bbox) {
      selected.push(rg); // no statistics for this row group: can't prune it, must read it
      continue;
    }
    if (areaBBoxes.some((abox) => bboxesIntersect(bbox, abox))) selected.push(rg);
  }
  return {
    selected,
    rowGroupBBoxes,
    stage: { stage: 'row-group-bbox', before, after: selected.length, basis: 'covering bbox' },
  };
}

/**
 * Prune row groups by a time column's min/max statistics against a
 * `TimeFilter` window. Stats that are missing or non-comparable leave the
 * row group selected (honest "can't prune" rather than a silent drop).
 * @param {import('./parquet-io.js').RowGroupInfo[]} rowGroups @param {string|null} timeColumn
 * @param {import('./types.js').TimeFilter|undefined} time
 */
export function pruneRowGroupsByTime(rowGroups, timeColumn, time) {
  const before = rowGroups.length;
  if (!time || !timeColumn) {
    return { selected: rowGroups, stage: { stage: 'row-group-stats', before, after: before, basis: 'no time filter' } };
  }
  const startMs = time.start ? Date.parse(time.start) : -Infinity;
  const endMs = time.end ? Date.parse(time.end) : Infinity;
  const closed = time.closed ?? '[)';
  const selected = rowGroups.filter((rg) => {
    const col = rg.columns.get(timeColumn);
    const stats = col?.statistics;
    if (!stats || stats.min_value === undefined || stats.max_value === undefined) return true; // 'no-statistics'
    const rgMin = toEpochMs(stats.min_value);
    const rgMax = toEpochMs(stats.max_value);
    if (rgMin === null || rgMax === null) return true;
    const startOk = closed[0] === '[' ? rgMax >= startMs : rgMax > startMs;
    const endOk = closed[1] === ']' ? rgMin <= endMs : rgMin < endMs;
    return startOk && endOk;
  });
  return {
    selected,
    stage: { stage: 'row-group-stats', before, after: selected.length, basis: `time ${timeColumn} ∈ [${time.start ?? '-∞'}, ${time.end ?? '+∞'})` },
  };
}

function toEpochMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Exact (metadata-derived) read-bytes for a set of selected row groups,
 * given the top-level column names that will actually be fetched.
 * @param {import('./parquet-io.js').RowGroupInfo[]} rowGroups @param {string[]} columnNames
 */
export function readBytesForRowGroups(rowGroups, columnNames) {
  let bytes = 0;
  for (const rg of rowGroups) bytes += rowGroupBytesForColumns(rg, columnNames);
  return boundedExact(bytes);
}
