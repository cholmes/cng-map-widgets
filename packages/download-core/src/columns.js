// @cnmw/download-core -- column projection (design doc §2.2 ColumnProjection).

import { columnsUsedByWhere } from './predicate.js';

/**
 * Resolve the *output* column list (what the writer emits), honoring
 * `include`/`exclude`/`dropGeometry`/`includeBbox`.
 * @param {import('./types.js').ColumnProjection|undefined} projection
 * @param {string[]} allColumns
 * @param {string} geometryColumn
 * @param {string[]} bboxColumns -- the covering's top-level column name(s), if any
 */
export function resolveOutputColumns(projection, allColumns, geometryColumn, bboxColumns = []) {
  let cols;
  if (projection?.include) {
    cols = [...projection.include];
  } else {
    cols = allColumns.filter((c) => !(projection?.exclude ?? []).includes(c));
  }
  const dropGeometry = projection?.dropGeometry ?? false;
  if (!dropGeometry && !cols.includes(geometryColumn)) cols.push(geometryColumn);
  if (dropGeometry) cols = cols.filter((c) => c !== geometryColumn);

  const includeBbox = projection?.includeBbox ?? false;
  if (includeBbox) {
    for (const c of bboxColumns) if (!cols.includes(c)) cols.push(c);
  } else {
    cols = cols.filter((c) => !bboxColumns.includes(c));
  }
  return cols;
}

/**
 * Resolve the *read* column list: the output columns plus whatever the
 * engine needs internally to filter (predicate columns, time column, bbox
 * covering columns for the row-level bbox prune) even if they are not in
 * the final output projection.
 * @param {string[]} outputColumns
 * @param {import('./types.js').FilterSpec} filter
 * @param {string|null} timeColumn
 * @param {string[]} bboxColumns
 * @param {string} geometryColumn
 */
export function resolveReadColumns(outputColumns, filter, timeColumn, bboxColumns, geometryColumn) {
  const set = new Set(outputColumns);
  set.add(geometryColumn);
  for (const c of columnsUsedByWhere(filter.where)) set.add(c);
  if (timeColumn && filter.time) set.add(timeColumn);
  for (const c of bboxColumns) set.add(c);
  return [...set];
}
