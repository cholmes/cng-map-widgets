// @cngeo/extract-core -- the pruning cascade (design doc §2.6/§2.7's
// "pruning cascade, in order, each stage reported in the estimate").
//
// Metadata-only (O12): every function here reads only parquet footer
// statistics / column-chunk byte sizes, never a data page.

import { boundedExact } from './bounded.js';
import { bboxesIntersect } from '@cngeo/spec';
import { rowGroupBytesForColumns } from './parquet-io.js';
import { compareBigIntToNumber } from './predicate.js';

/** @typedef {import('@cngeo/spec').BBox} BBox */

/** Resolve a `BboxCovering` to the statistics column paths for xmin/ymin/xmax/ymax, or null if `kind: 'none'`. @param {import('./types.js').BboxCovering|undefined} covering */
export function coveringPaths(covering) {
  if (!covering || covering.kind === 'none') return null;
  // A GeoParquet 2.0 / Parquet GEOMETRY column carries its own per-row-group
  // bbox in the footer, so there are no separate statistics columns to name.
  if (covering.kind === 'native') return { native: covering.column };
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
  if (paths.native) {
    const geo = rg.columns.get(paths.native)?.geoStats;
    if (!geo) return null;
    return [geo.xmin, geo.ymin, geo.xmax, geo.ymax];
  }
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
 * @param {string} [geometryColumn] -- when the descriptor declares no covering,
 *   fall back to this column's native GeospatialStatistics if the file has
 *   them. GeoParquet 2.0 writers emit these without any covering column, so a
 *   dataset that looks un-prunable from its metadata often is not.
 * @returns {{ selected: import('./parquet-io.js').RowGroupInfo[], stage: import('./types.js').PruneStage, rowGroupBBoxes: Map<number, BBox|null> }}
 */
export function pruneRowGroupsByBBox(rowGroups, covering, areaBBoxes, geometryColumn) {
  const before = rowGroups.length;
  let paths = coveringPaths(covering);
  let viaNative = Boolean(paths?.native);
  // Fall back to the geometry column's native GeospatialStatistics when the
  // descriptor declares no covering, OR when the covering it declares turns
  // out to be unusable. The second case is not hypothetical: a STAC-GeoParquet
  // `bbox` column is a LIST ([xmin,ymin,xmax,ymax]), so a `struct` covering
  // inferred from its name reads `bbox.xmin` and gets nothing back -- which
  // used to report "covering bbox" while pruning nothing and suppressing the
  // no-covering warning.
  const hasNative = Boolean(geometryColumn) && rowGroups.some((rg) => rg.columns.get(geometryColumn)?.geoStats);
  const coveringUnusable = Boolean(paths) && !paths.native
    && rowGroups.length > 0 && rowGroups.every((rg) => rowGroupBBoxFromStats(rg, paths) === null);
  if (hasNative && (!paths || coveringUnusable)) {
    paths = { native: /** @type {string} */ (geometryColumn) };
    viaNative = true;
  }
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
    stage: { stage: 'row-group-bbox', before, after: selected.length, basis: viaNative ? 'native geometry statistics' : 'covering bbox' },
  };
}

/**
 * The per-ROW half of a `TimeFilter`: a predicate over one decoded cell of
 * the time column, with exactly the bounds `pruneRowGroupsByTime` uses on
 * row-group statistics (`closed`, default `'[)'`). Pruning alone only
 * discards row groups that lie wholly outside the window; every row of a
 * group that merely OVERLAPS it survives, so without this test a download
 * carried rows from outside the requested window, and two adjacent `[)`
 * windows both carried the rows of any group straddling their boundary.
 *
 * A null/missing time is not inside any window and is rejected. A value
 * that is present but unreadable as a time is KEPT -- the same "cannot
 * decide, so do not drop" rule the statistics prune follows.
 * @param {import('./types.js').TimeFilter|undefined} time
 * @returns {((value: unknown) => boolean)|null} `null` when there is nothing to test.
 */
export function timeRowPredicate(time) {
  if (!time || (!time.start && !time.end)) return null;
  const startMs = time.start ? Date.parse(time.start) : -Infinity;
  const endMs = time.end ? Date.parse(time.end) : Infinity;
  const closed = time.closed ?? '[)';
  return (value) => {
    if (value === null || value === undefined) return false;
    const ms = toEpochMs(value);
    if (ms === null) return true;
    const startOk = closed[0] === '[' ? ms >= startMs : ms > startMs;
    const endOk = closed[1] === ']' ? ms <= endMs : ms < endMs;
    return startOk && endOk;
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

// ---------------------------------------------------------------------------
// `where[]` predicate pushdown (statistics-only, design doc §2.6-§2.8's
// pruning cascade).
//
// SOUNDNESS IS THE WHOLE POINT. A wrong prune silently drops rows from a
// user's download -- the worst bug this package could have -- so every
// function below answers one question only: do these footer statistics
// *prove* that no row in this row group can match? "Don't know" always
// means "keep the row group", exactly like the `no-statistics` path in
// `pruneRowGroupsByTime` above. Concretely, all of these keep it:
//
//   - no statistics at all for the predicate's column, or no
//     `min_value`/`max_value` (an all-null column chunk, or a writer that
//     emitted none);
//   - a column path with a list subscript (`tags[0]`), which has no
//     column chunk of its own to read statistics from;
//   - a value whose type does not match the statistic's type -- notably
//     any string-vs-number comparison, and any string/number vs timestamp;
//   - non-ASCII strings on either side, because Parquet orders BYTE_ARRAY
//     statistics by unsigned byte and JS `<` orders by UTF-16 code unit;
//     the two agree on ASCII and may disagree outside it;
//   - `like`/`ilike`/`not_like`, and anything under a `not`;
//   - any operator this module does not know.
// ---------------------------------------------------------------------------

/** Operators `predicateExcludesRowGroup` can decide from statistics at all. */
export const STATS_PRUNABLE_OPS = Object.freeze([
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'not_in',
  'between',
  'is_null',
  'is_not_null',
]);

/** Classify a statistic/predicate value. `'other'` never compares. */
function statKind(v) {
  if (typeof v === 'number' || typeof v === 'bigint') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (v instanceof Date) return 'date';
  return 'other';
}

const ASCII_ONLY = /^[\x00-\x7F]*$/;

/**
 * Three-way compare for pruning, or `null` for "not comparable" (which
 * every caller must read as "keep the row group"). Deliberately NOT
 * `predicate.js`'s `compareScalar`: that one coerces a float to a BigInt
 * with `Math.trunc` when the other side is a BigInt, which is fine for
 * row-level filtering but would make `col < 0.5` look like `col < 0`
 * against an INT64 statistic and prune a row group whose rows do match.
 */
function statCompare(a, b) {
  const ka = statKind(a);
  const kb = statKind(b);
  if (ka === 'other' || kb === 'other' || ka !== kb) return null;
  if (ka === 'number') {
    const aBig = typeof a === 'bigint';
    const bBig = typeof b === 'bigint';
    if (aBig && bBig) return a < b ? -1 : a > b ? 1 : 0;
    if (aBig || bBig) {
      // Exact at any magnitude, and exact for a fractional threshold
      // against an INT64 bound -- see compareBigIntToNumber's comment for
      // the truncation bug that made this necessary.
      const cmp = aBig ? compareBigIntToNumber(a, b) : compareBigIntToNumber(b, a);
      return cmp === null ? null : aBig ? cmp : -cmp;
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (ka === 'date') {
    const na = a.getTime();
    const nb = b.getTime();
    if (Number.isNaN(na) || Number.isNaN(nb)) return null;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (ka === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (!ASCII_ONLY.test(a) || !ASCII_ONLY.test(b)) return null;
  return a < b ? -1 : a > b ? 1 : 0;
}

const lt = (a, b) => statCompare(a, b) === -1;
const gt = (a, b) => statCompare(a, b) === 1;
const le = (a, b) => [-1, 0].includes(statCompare(a, b));
const ge = (a, b) => [0, 1].includes(statCompare(a, b));

/** `null_count` as a number, or null when absent/unusable. */
function nullCountOf(stats) {
  const raw = stats?.null_count;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'bigint' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Do `rg`'s statistics *prove* that no row in it can satisfy `predicate`?
 * `false` is the safe answer and is returned for every unknown.
 * @param {import('./parquet-io.js').RowGroupInfo} rg
 * @param {import('./types.js').Predicate} predicate
 */
export function predicateExcludesRowGroup(rg, predicate) {
  const p = predicate;
  if (!p || typeof p !== 'object') return false;
  const op = p.op;

  // `a AND b` is impossible as soon as either side is; `a OR b` only when
  // every side is. A `not` would need the opposite proof ("the inner
  // predicate always matches"), which min/max cannot give, so it keeps.
  if (op === 'and') return (p.args ?? []).some((a) => predicateExcludesRowGroup(rg, a));
  if (op === 'or') return (p.args ?? []).length > 0 && p.args.every((a) => predicateExcludesRowGroup(rg, a));
  if (op === 'not') return false;

  if (typeof p.col !== 'string' || p.col.includes('[')) return false;
  const stats = rg.columns?.get(p.col)?.statistics;
  if (!stats) return false;

  if (op === 'is_null') return nullCountOf(stats) === 0;
  if (op === 'is_not_null') {
    const nulls = nullCountOf(stats);
    return nulls !== null && nulls === rg.numRows;
  }

  const min = stats.min_value;
  const max = stats.max_value;
  if (min === undefined || min === null || max === undefined || max === null) return false;

  switch (op) {
    // Parquet's min/max exclude nulls, and none of these operators matches
    // a null row (`predicate.js`'s `compareScalar` returns null, which
    // every comparison reads as "no match"), so null counts never make a
    // range prune unsound.
    case '=':
      return gt(min, p.value) || lt(max, p.value);
    case '<':
      return ge(min, p.value);
    case '<=':
      return gt(min, p.value);
    case '>':
      return le(max, p.value);
    case '>=':
      return lt(max, p.value);
    case 'between':
      return lt(max, p.low) || gt(min, p.high);
    case 'in':
      return Array.isArray(p.values) && p.values.length > 0 && p.values.every((v) => gt(min, v) || lt(max, v));
    case '!=':
    case 'not_in': {
      // Only provable when the row group collapses to one value, and every
      // row is that excluded value. A BYTE_ARRAY statistic may be
      // *truncated* by the writer, which can make two different long
      // strings share one bound and fake that collapse -- so this case is
      // restricted to statistic types that are never truncated.
      const kind = statKind(min);
      if (kind !== 'number' && kind !== 'boolean' && kind !== 'date') return false;
      if (statCompare(min, max) !== 0) return false;
      if (op === '!=') return statCompare(min, p.value) === 0;
      return Array.isArray(p.values) && p.values.some((v) => statCompare(min, v) === 0);
    }
    default:
      // like / ilike / not_like, and anything this module has never heard
      // of. A prefix `LIKE 'abc%'` *could* be decided from string bounds,
      // but only under the byte-vs-UTF-16 ordering and truncation caveats
      // above, so it is honestly left unpruned.
      return false;
  }
}

/** Visit every leaf (non-and/or/not) predicate, flagging the ones under a `not`. */
function walkLeaves(p, fn, negated = false) {
  if (!p || typeof p !== 'object') return;
  if (p.op === 'and' || p.op === 'or') {
    for (const a of p.args ?? []) walkLeaves(a, fn, negated);
    return;
  }
  if (p.op === 'not') {
    walkLeaves(p.arg, fn, true);
    return;
  }
  fn(p, negated);
}

/** Short human text for one predicate node, for `PruneStage.basis`. */
function describePredicate(p) {
  if (!p || typeof p !== 'object') return '?';
  if (p.op === 'and' || p.op === 'or') return `(${(p.args ?? []).map(describePredicate).join(` ${p.op.toUpperCase()} `)})`;
  if (p.op === 'not') return `NOT ${describePredicate(p.arg)}`;
  if (p.op === 'is_null' || p.op === 'is_not_null') return `${p.col} ${p.op.replace('_', ' ')}`;
  if (p.op === 'in' || p.op === 'not_in') return `${p.col} ${p.op} (${(p.values ?? []).length} values)`;
  if (p.op === 'between') return `${p.col} between ${JSON.stringify(p.low)} and ${JSON.stringify(p.high)}`;
  return `${p.col} ${p.op} ${JSON.stringify(p.value)}`;
}

/**
 * Prune row groups whose footer statistics prove no row can satisfy the
 * ANDed `filter.where` predicates -- the same metadata-only machinery
 * `pruneRowGroupsByBBox`/`pruneRowGroupsByTime` use, applied to the
 * structured predicate list so that a selective `where` narrows the read
 * *before* it is issued instead of only filtering rows afterwards (the
 * engine still evaluates every predicate per row; pruning never replaces
 * filtering).
 *
 * `decidable` reports whether any statistics-prunable operator was present
 * at all, and `statsSeen` whether the row groups actually carried
 * statistics for those columns -- so the estimate can say "could not
 * prune" honestly rather than implying the predicate was unselective.
 *
 * @param {import('./parquet-io.js').RowGroupInfo[]} rowGroups
 * @param {readonly import('./types.js').Predicate[]|undefined} where
 * @returns {{ selected: import('./parquet-io.js').RowGroupInfo[], stage: import('./types.js').PruneStage, decidable: boolean, statsSeen: boolean }}
 */
export function pruneRowGroupsByWhere(rowGroups, where) {
  const before = rowGroups.length;
  const predicates = (where ?? []).filter((p) => p && typeof p === 'object');
  if (predicates.length === 0) {
    return {
      selected: rowGroups,
      decidable: false,
      statsSeen: false,
      stage: { stage: 'row-group-where', before, after: before, basis: 'no where filter' },
    };
  }

  /** @type {Set<string>} */
  const decidableCols = new Set();
  let decidable = false;
  for (const p of predicates) {
    walkLeaves(p, (leaf, negated) => {
      if (negated) return;
      if (typeof leaf.col !== 'string' || leaf.col.includes('[')) return;
      if (!STATS_PRUNABLE_OPS.includes(leaf.op)) return;
      decidable = true;
      decidableCols.add(leaf.col);
    });
  }
  const statsSeen = decidable && rowGroups.some((rg) => [...decidableCols].some((c) => rg.columns?.get(c)?.statistics !== undefined));

  const selected = decidable && statsSeen ? rowGroups.filter((rg) => !predicates.some((p) => predicateExcludesRowGroup(rg, p))) : rowGroups;

  const summary = predicates.map(describePredicate).join(' AND ');
  const basis = !decidable
    ? `where[] ${summary} — no statistics-prunable operator`
    : !statsSeen
      ? `where[] ${summary} — no statistics`
      : `where[] statistics: ${summary}`;

  return {
    selected,
    decidable,
    statsSeen,
    stage: { stage: 'row-group-where', before, after: selected.length, basis },
  };
}

/**
 * A time value -- footer statistic or decoded row cell -- as epoch ms, or
 * `null` when it cannot be read as one.
 * @param {unknown} v @returns {number|null}
 */
export function toEpochMs(v) {
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
 * Average *uncompressed* bytes per row for one top-level column across a
 * set of row groups, from footer metadata alone -- `null` when the column
 * has no chunks in them, or they hold no rows.
 *
 * Uncompressed, not compressed, on purpose: this number exists to model
 * output size (`FormatPlugin.estimateBytes`'s `ctx.avgGeometryBytes`), and
 * what every output format expands from is the *decoded* WKB of a
 * geometry, not whatever the source file's codec happened to squeeze it
 * into. `total_compressed_size` would make the same dataset model a
 * different output size depending on how it was written -- zstd-19 WKB and
 * uncompressed WKB produce identical GeoJSON. There is a small upward bias
 * (page headers and the definition-level bytes of a nullable column are
 * counted in the chunk total but are not geometry), which is the safer
 * direction for a ceiling check.
 *
 * @param {import('./parquet-io.js').RowGroupInfo[]} rowGroups
 * @param {string} columnName - a top-level column name
 * @returns {number|null}
 */
export function avgColumnBytesPerRow(rowGroups, columnName) {
  let bytes = 0;
  let rows = 0;
  let seen = false;
  for (const rg of rowGroups) {
    let rgBytes = 0;
    let found = false;
    for (const [path, col] of rg.columns ?? []) {
      if (path.split('.')[0] !== columnName) continue;
      found = true;
      rgBytes += col.totalUncompressedSize || 0;
    }
    if (!found) continue;
    seen = true;
    bytes += rgBytes;
    rows += rg.numRows;
  }
  if (!seen || rows === 0) return null;
  return bytes / rows;
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
