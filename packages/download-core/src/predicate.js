// @cng/download-core -- `where[]` structured predicate evaluation
// (design doc §2.2 Predicate).
//
// `col` may be a dotted path into a struct (`names.primary`) with a `[n]`
// list subscript, per design doc §2.2's note. A MAP's keys are not in the
// schema and so are passed through unchecked (we simply index with
// whatever string/number the path segment is).

import { CnmwError } from '@cng/spec';

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

/**
 * Exact three-way compare of a BigInt against a double, at any magnitude.
 *
 * `Math.floor` of a finite double is itself integer-valued, so `BigInt()`
 * of it is exact even past 2^53 -- which is why this does not simply
 * widen one side to the other's type. The previous version of
 * `compareScalar` coerced the float side with `BigInt(Math.trunc(n))`,
 * which made `0n < 0.5` evaluate to *false*: every INT64 column compared
 * against a fractional threshold filtered wrongly, and
 * `prune.js`'s `where[]` pushdown (which must agree with this function
 * row for row) had to refuse that whole case to stay sound.
 */
export function compareBigIntToNumber(bi, num) {
  if (Number.isNaN(num)) return null;
  if (num === Infinity) return -1;
  if (num === -Infinity) return 1;
  const floor = BigInt(Math.floor(num));
  if (bi < floor) return -1;
  if (bi > floor) return 1;
  // bi === floor(num): equal only when num is itself an integer, else
  // floor(num) < num, so bi < num.
  return Number.isInteger(num) ? 0 : -1;
}

function compareScalar(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  const aBig = typeof a === 'bigint';
  const bBig = typeof b === 'bigint';
  if (aBig || bBig) {
    if (aBig && bBig) return a < b ? -1 : a > b ? 1 : 0;
    const other = aBig ? b : a;
    // A BigInt against anything but a number/boolean is not comparable:
    // the old coercion ran `BigInt(Math.trunc(Number('abc')))`, which
    // throws, and `BigInt(…)` of a true/false reads as 1n/0n, which is
    // the one widening that is actually exact.
    if (typeof other === 'boolean') {
      const bigSide = aBig ? a : b;
      const cmp = compareBigIntToNumber(bigSide, other ? 1 : 0);
      return cmp === null ? null : aBig ? cmp : -cmp;
    }
    if (typeof other !== 'number') return null;
    const cmp = aBig ? compareBigIntToNumber(a, b) : compareBigIntToNumber(b, a);
    return cmp === null ? null : aBig ? cmp : -cmp;
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
