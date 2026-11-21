// @cngeo/download-core -- column projection (design doc §2.2 ColumnProjection).

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
 *
 * `geometryColumn` itself is only forced into the read when `outputColumns`
 * already carries it (`dropGeometry` was not set) or `needsGeometryForFilter`
 * says row-level spatial filtering cannot proceed without it -- see
 * `geometryNeededForFilter`'s doc comment for that rule. Reading it
 * speculatively "just in case" would defeat the entire point of
 * `dropGeometry`: a dataset's geometry column is routinely the majority of
 * its bytes, and this is the one place in the pipeline that decides whether
 * those bytes cross the network at all.
 * @param {string[]} outputColumns
 * @param {import('./types.js').FilterSpec} filter
 * @param {string|null} timeColumn
 * @param {string[]} bboxColumns
 * @param {string} geometryColumn
 * @param {boolean} [needsGeometryForFilter]
 */
export function resolveReadColumns(outputColumns, filter, timeColumn, bboxColumns, geometryColumn, needsGeometryForFilter = true) {
  const set = new Set(outputColumns);
  if (outputColumns.includes(geometryColumn) || needsGeometryForFilter) set.add(geometryColumn);
  for (const c of columnsUsedByWhere(filter.where)) set.add(c);
  if (timeColumn && filter.time) set.add(timeColumn);
  for (const c of bboxColumns) set.add(c);
  return [...set];
}

/**
 * Does row-level spatial filtering need the *decoded geometry* (not just a
 * bbox covering's statistics) to decide whether a row matches `area`?
 *
 * This is the design decision behind `dropGeometry` + a spatial filter, and
 * it is deliberately **not** a refusal (`FILTER_REQUIRES_ENGINE` or
 * otherwise): `dropGeometry` is an *output* instruction ("this download is
 * a different product, without geometry" -- design doc §2.2), never a
 * promise that the engine will not look at the column while deciding what
 * to filter. The hyparquet engine's `'intersects'` capability already means
 * "I can decode geometry to test it exactly"; a filter that needs that
 * exact test continues to get it, read internally, even when the caller
 * also asked to drop geometry from the *output* -- `resolveOutputColumns`
 * is what enforces the output side, unconditionally, regardless of this
 * function's answer. A refusal would only make sense for an engine that
 * declares `'intersects'`/`'bbox'` but genuinely cannot read the geometry
 * column at all, which no engine in this package does; `requirementsOf`
 * (`ceiling.js`) is where that capability gate already lives, and this
 * function does not duplicate it.
 *
 * - No `area`: no spatial filter at all, so no, regardless of covering/mode.
 * - No bbox covering (`kind: 'none'`): even `mode: 'bbox'` can't get a
 *   row's bbox from statistics, so `engine-hyparquet.js`'s `rowBBox` falls
 *   back to decoding the geometry just to find out where the row *is* --
 *   yes.
 * - `mode: 'bbox'` with a covering: the covering's own statistics are
 *   enough; the exact polygon test never runs -- no.
 * - `mode: 'intersects'` (or `'clip'`, which runs `intersects` first) with
 *   `area.filterGeometry` present: the exact point-in-polygon/edge test in
 *   `spatial.js`'s `rowMatchesArea` needs the real geometry -- yes.
 * - `mode: 'intersects'` with no `filterGeometry` (degraded-to-bbox,
 *   `rowMatchesArea` falls back to the bbox-only answer): no.
 *
 * @param {import('@cngeo/spec').Area|null} area
 * @param {import('./types.js').BboxCovering|undefined} covering
 * @param {import('./types.js').SpatialFilter|undefined} spatial
 * @returns {boolean}
 */
export function geometryNeededForFilter(area, covering, spatial) {
  if (!area) return false;
  // `native` means the bbox lives in the footer, per ROW GROUP -- there is no
  // per-row bbox to compare against, so a row-level test needs the geometry.
  if (!covering || covering.kind === 'none' || covering.kind === 'native') return true;
  if ((spatial?.mode === 'intersects' || spatial?.mode === 'clip') && area.filterGeometry) return true;
  return false;
}
