// @cnmw/download-core -- `where[]` structured predicate evaluation
// (design doc §2.2 Predicate).
//
// `col` may be a dotted path into a struct (`names.primary`) with a `[n]`
// list subscript, per design doc §2.2's note. A MAP's keys are not in the
// schema and so are passed through unchecked (we simply index with
// whatever string/number the path segment is).

import { CnmwError } from '@cnmw/spec';

/**
 * Resolve a dotted/bracketed path against a row object.
 * `a.b[0].c` -> ['a','b','0','c'].
 * @param {Record<string, unknown>} row @param {string} path
 */
export function getPath(row, path) {
  const parts = path.split(/\.|\[|\]/).filter((p) => p.length > 0);
  /** @type {unknown} */
  let cur = row;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    const key = /^\d+$/.test(part) ? Number(part) : part;
    cur = /** @type {any} */ (cur)[key];
  }
  return cur;
}

/** @param {string} pattern @param {boolean} caseInsensitive */
function likeToRegExp(pattern, caseInsensitive) {
  let re = '';
  for (const ch of pattern) {
    if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'is' : 's');
}

function compareScalar(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    a = typeof a === 'bigint' ? a : BigInt(Math.trunc(Number(a)));
    b = typeof b === 'bigint' ? b : BigInt(Math.trunc(Number(b)));
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Evaluate one `Predicate` node against a decoded row.
 * @param {import('./types.js').Predicate} predicate
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
export function evaluatePredicate(predicate, row) {
  const op = predicate.op;
  if (op === 'and') return predicate.args.every((p) => evaluatePredicate(p, row));
  if (op === 'or') return predicate.args.some((p) => evaluatePredicate(p, row));
  if (op === 'not') return !evaluatePredicate(predicate.arg, row);

  const value = getPath(row, predicate.col);

  if (op === 'is_null') return value === null || value === undefined;
  if (op === 'is_not_null') return !(value === null || value === undefined);

  if (op === 'in' || op === 'not_in') {
    const found = predicate.values.some((v) => compareScalar(value, v) === 0);
    return op === 'in' ? found : !found && value !== null && value !== undefined;
  }

  if (op === 'between') {
    const lo = compareScalar(value, predicate.low);
    const hi = compareScalar(value, predicate.high);
    if (lo === null || hi === null) return false;
    return lo >= 0 && hi <= 0;
  }

  if (op === 'like' || op === 'ilike' || op === 'not_like') {
    if (value === null || value === undefined) return false;
    const matches = likeToRegExp(predicate.value, op === 'ilike').test(String(value));
    return op === 'not_like' ? !matches : matches;
  }

  const cmp = compareScalar(value, predicate.value);
  if (cmp === null) return false;
  switch (op) {
    case '=':
      return cmp === 0;
    case '!=':
      return cmp !== 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    default:
      throw new CnmwError(`Unsupported predicate operator: ${op}`, 'FILTER_UNSUPPORTED_PREDICATE', {
        context: { op },
      });
  }
}

/**
 * ANDs a `FilterSpec.where` array (design doc §2.2: "ANDed").
 * @param {readonly import('./types.js').Predicate[] | undefined} where
 * @param {Record<string, unknown>} row
 */
export function evaluateWhere(where, row) {
  if (!where || where.length === 0) return true;
  return where.every((p) => evaluatePredicate(p, row));
}

/** Collect every column name a predicate tree touches (top-level path segment), for the engine's read-column projection. @param {readonly import('./types.js').Predicate[] | undefined} where */
export function columnsUsedByWhere(where) {
  /** @type {Set<string>} */
  const cols = new Set();
  function walk(p) {
    if (!p) return;
    if (p.op === 'and' || p.op === 'or') return p.args.forEach(walk);
    if (p.op === 'not') return walk(p.arg);
    if (p.col) cols.add(p.col.split(/\.|\[/)[0]);
  }
  (where ?? []).forEach(walk);
  return [...cols];
}
