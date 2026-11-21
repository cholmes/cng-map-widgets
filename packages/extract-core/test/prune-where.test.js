// Item 6: `where[]` predicate pushdown against row-group statistics.
//
// Half of this file is fallback tests. Pruning may only ever drop a row
// group when the statistics *prove* no row in it can match -- a wrong
// prune silently removes rows from a user's download -- so every
// "statistics cannot decide this" case has its own test asserting the row
// group is KEPT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneRowGroupsByWhere, predicateExcludesRowGroup, STATS_PRUNABLE_OPS } from '../src/prune.js';
import { evaluateWhere } from '../src/predicate.js';

/**
 * Build a synthetic RowGroupInfo. `stats` maps a column path to
 * `{ min, max, nulls }`; a column mapped to `null` is present with no
 * statistics at all.
 */
function rg(index, numRows, stats, extra = {}) {
  const columns = new Map();
  for (const [path, s] of Object.entries(stats)) {
    columns.set(path, {
      statistics: s === null ? undefined : { min_value: s.min, max_value: s.max, null_count: s.nulls },
      totalCompressedSize: 1000,
      totalUncompressedSize: 2000,
    });
  }
  return { index, rowStart: index * numRows, rowEnd: index * numRows + numRows, numRows, columns, ...extra };
}

const g = (stats, numRows = 100) => rg(0, numRows, stats);

// --- the ops that prune --------------------------------------------------

test('= prunes a row group whose min/max bracket excludes the value', () => {
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 10, max: 20 } }), { col: 'n', op: '=', value: 5 }), true);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 10, max: 20 } }), { col: 'n', op: '=', value: 25 }), true);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 10, max: 20 } }), { col: 'n', op: '=', value: 15 }), false);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 10, max: 20 } }), { col: 'n', op: '=', value: 10 }), false);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 10, max: 20 } }), { col: 'n', op: '=', value: 20 }), false);
});

test('< <= > >= prune only on the proving side of the bound', () => {
  const group = g({ n: { min: 10, max: 20 } });
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '<', value: 10 }), true); // nothing below the min
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '<', value: 11 }), false);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '<=', value: 9 }), true);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '<=', value: 10 }), false);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '>', value: 20 }), true);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '>', value: 19 }), false);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '>=', value: 21 }), true);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '>=', value: 20 }), false);
});

test('between prunes when the window misses the row group entirely', () => {
  const group = g({ n: { min: 10, max: 20 } });
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: 'between', low: 0, high: 9 }), true);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: 'between', low: 21, high: 99 }), true);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: 'between', low: 15, high: 16 }), false);
});

test('in prunes only when every listed value is outside the bounds', () => {
  const group = g({ n: { min: 10, max: 20 } });
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: 'in', values: [1, 2, 99] }), true);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: 'in', values: [1, 2, 15] }), false);
  // one non-comparable member is enough to make the whole thing unknown
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: 'in', values: [1, 'x'] }), false);
  // an empty `in` proves nothing from statistics; the row filter handles it
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: 'in', values: [] }), false);
});

test('ASCII string bounds prune = and the comparisons', () => {
  const group = g({ cat: { min: 'bravo', max: 'delta' } });
  assert.equal(predicateExcludesRowGroup(group, { col: 'cat', op: '=', value: 'alpha' }), true);
  assert.equal(predicateExcludesRowGroup(group, { col: 'cat', op: '=', value: 'echo' }), true);
  assert.equal(predicateExcludesRowGroup(group, { col: 'cat', op: '=', value: 'charlie' }), false);
  assert.equal(predicateExcludesRowGroup(group, { col: 'cat', op: '>', value: 'delta' }), true);
});

test('boolean and Date bounds prune', () => {
  assert.equal(predicateExcludesRowGroup(g({ b: { min: true, max: true } }), { col: 'b', op: '=', value: false }), true);
  assert.equal(predicateExcludesRowGroup(g({ b: { min: false, max: true } }), { col: 'b', op: '=', value: false }), false);
  const t = g({ when: { min: new Date('2024-01-01T00:00:00Z'), max: new Date('2024-01-31T00:00:00Z') } });
  assert.equal(predicateExcludesRowGroup(t, { col: 'when', op: '<', value: new Date('2024-01-01T00:00:00Z') }), true);
  assert.equal(predicateExcludesRowGroup(t, { col: 'when', op: '>', value: new Date('2024-02-01T00:00:00Z') }), true);
});

test('is_null prunes when null_count is 0; is_not_null when every row is null', () => {
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 1, max: 2, nulls: 0 } }), { col: 'n', op: 'is_null' }), true);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 1, max: 2, nulls: 3 } }), { col: 'n', op: 'is_null' }), false);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 1, max: 2, nulls: 100 } }, 100), { col: 'n', op: 'is_not_null' }), true);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 1, max: 2, nulls: 99 } }, 100), { col: 'n', op: 'is_not_null' }), false);
  // bigint null_count (what an int64 footer field decodes to) still works
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 1, max: 2, nulls: 0n } }), { col: 'n', op: 'is_null' }), true);
});

test('!= / not_in prune only when the row group collapses to the excluded value', () => {
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 7, max: 7 } }), { col: 'n', op: '!=', value: 7 }), true);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 7, max: 8 } }), { col: 'n', op: '!=', value: 7 }), false);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 7, max: 7 } }), { col: 'n', op: '!=', value: 8 }), false);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 7, max: 7 } }), { col: 'n', op: 'not_in', values: [3, 7] }), true);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 7, max: 7 } }), { col: 'n', op: 'not_in', values: [3, 9] }), false);
});

test('!= on string statistics never prunes: a BYTE_ARRAY min/max may be truncated', () => {
  // Two different long strings can share a truncated bound, so min===max
  // does NOT prove the column is constant for strings.
  const group = g({ cat: { min: 'the-same-prefix', max: 'the-same-prefix' } });
  assert.equal(predicateExcludesRowGroup(group, { col: 'cat', op: '!=', value: 'the-same-prefix' }), false);
  assert.equal(predicateExcludesRowGroup(group, { col: 'cat', op: 'not_in', values: ['the-same-prefix'] }), false);
});

test('and / or compose: AND prunes if either side does, OR only if both do', () => {
  const group = g({ a: { min: 10, max: 20 }, b: { min: 0, max: 5 } });
  const impossible = { col: 'a', op: '>', value: 100 };
  const possible = { col: 'b', op: '=', value: 3 };
  assert.equal(predicateExcludesRowGroup(group, { op: 'and', args: [impossible, possible] }), true);
  assert.equal(predicateExcludesRowGroup(group, { op: 'or', args: [impossible, possible] }), false);
  assert.equal(predicateExcludesRowGroup(group, { op: 'or', args: [impossible, { col: 'b', op: '>', value: 9 }] }), true);
  assert.equal(predicateExcludesRowGroup(group, { op: 'or', args: [] }), false);
});

// --- the fallbacks: every one of these must KEEP the row group -----------

test('fallback: a column with no statistics at all is never pruned', () => {
  assert.equal(predicateExcludesRowGroup(g({ n: null }), { col: 'n', op: '=', value: 5 }), false);
});

test('fallback: a column absent from the row group is never pruned', () => {
  assert.equal(predicateExcludesRowGroup(g({ other: { min: 1, max: 2 } }), { col: 'n', op: '=', value: 5 }), false);
});

test('fallback: missing or null min_value/max_value is never pruned', () => {
  assert.equal(predicateExcludesRowGroup(g({ n: { min: undefined, max: 20 } }), { col: 'n', op: '=', value: 5 }), false);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 10, max: undefined } }), { col: 'n', op: '=', value: 5 }), false);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: null, max: null } }), { col: 'n', op: '<', value: 5 }), false);
});

test('fallback: string value against numeric statistics is never pruned', () => {
  const group = g({ n: { min: 10, max: 20 } });
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '=', value: '5' }), false);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '<', value: '5' }), false);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '>', value: '99' }), false);
});

test('fallback: numeric value against string statistics is never pruned', () => {
  const group = g({ cat: { min: 'bravo', max: 'delta' } });
  assert.equal(predicateExcludesRowGroup(group, { col: 'cat', op: '=', value: 5 }), false);
  assert.equal(predicateExcludesRowGroup(group, { col: 'cat', op: '>', value: 5 }), false);
});

test('fallback: an ISO-string value against timestamp (Date) statistics is never pruned', () => {
  const group = g({ when: { min: new Date('2024-01-01T00:00:00Z'), max: new Date('2024-01-31T00:00:00Z') } });
  assert.equal(predicateExcludesRowGroup(group, { col: 'when', op: '<', value: '2020-01-01T00:00:00Z' }), false);
  assert.equal(predicateExcludesRowGroup(group, { col: 'when', op: '>', value: '2030-01-01T00:00:00Z' }), false);
});

test('fallback: non-ASCII strings on either side are never pruned (byte vs UTF-16 ordering)', () => {
  assert.equal(predicateExcludesRowGroup(g({ cat: { min: 'é', max: 'ü' } }), { col: 'cat', op: '=', value: 'a' }), false);
  assert.equal(predicateExcludesRowGroup(g({ cat: { min: 'b', max: 'd' } }), { col: 'cat', op: '=', value: 'é' }), false);
});

test('INT64 (BigInt) statistics prune exactly, at any magnitude', () => {
  const ok = g({ n: { min: 10n, max: 20n } });
  assert.equal(predicateExcludesRowGroup(ok, { col: 'n', op: '<', value: 10 }), true);
  assert.equal(predicateExcludesRowGroup(ok, { col: 'n', op: '<', value: 11 }), false);
  // past 2^53, where neither bound round-trips through a double
  const huge = g({ n: { min: 9007199254740993n, max: 9007199254740999n } });
  assert.equal(predicateExcludesRowGroup(huge, { col: 'n', op: '<', value: 1 }), true);
  assert.equal(predicateExcludesRowGroup(huge, { col: 'n', op: '=', value: 9007199254740995n }), false);
});

test('a fractional value against an INT64 statistic agrees with the row filter', () => {
  // The bug this guards: coercing 0.5 to BigInt(0) (which predicate.js's
  // `compareScalar` used to do) makes `n < 0.5` behave like `n < 0`. That
  // was wrong at the row level *and* would have pruned a row group whose
  // min is 0 -- whose rows do match.
  const group = g({ n: { min: 0n, max: 5n } }, 3);
  assert.equal(predicateExcludesRowGroup(group, { col: 'n', op: '<', value: 0.5 }), false);
  assert.equal(evaluateWhere([{ col: 'n', op: '<', value: 0.5 }], { n: 0n }), true);
  assert.equal(evaluateWhere([{ col: 'n', op: '<', value: 0.5 }], { n: 1n }), false);
  // and where it *is* provable, it prunes
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 1n, max: 5n } }), { col: 'n', op: '<', value: 0.5 }), true);
});

test('fallback: a BigInt compared against a string is not comparable, at row level or in the pruner', () => {
  // The old coercion ran BigInt(Math.trunc(Number('abc'))), which throws.
  assert.equal(evaluateWhere([{ col: 'n', op: '=', value: 'abc' }], { n: 5n }), false);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 1n, max: 5n } }), { col: 'n', op: '>', value: 'abc' }), false);
});

test('fallback: like / ilike / not_like never prune', () => {
  const group = g({ cat: { min: 'bravo', max: 'delta' } });
  for (const op of ['like', 'ilike', 'not_like']) {
    assert.equal(predicateExcludesRowGroup(group, { col: 'cat', op, value: 'zulu%' }), false, op);
  }
});

test('fallback: an unknown operator never prunes', () => {
  assert.equal(predicateExcludesRowGroup(g({ n: { min: 10, max: 20 } }), { col: 'n', op: 'st_within', value: 5 }), false);
});

test('fallback: anything under a not never prunes', () => {
  const group = g({ n: { min: 10, max: 20 } });
  assert.equal(predicateExcludesRowGroup(group, { op: 'not', arg: { col: 'n', op: '=', value: 5 } }), false);
  assert.equal(predicateExcludesRowGroup(group, { op: 'not', arg: { col: 'n', op: '=', value: 15 } }), false);
});

test('fallback: a list-subscript column path never prunes (no column chunk of its own)', () => {
  const group = g({ tags: { min: 'a', max: 'b' } });
  assert.equal(predicateExcludesRowGroup(group, { col: 'tags[0]', op: '=', value: 'z' }), false);
});

test('fallback: a malformed predicate node never prunes', () => {
  const group = g({ n: { min: 10, max: 20 } });
  for (const p of [null, undefined, 'nope', 42, {}, { op: '=' }, { col: 5, op: '=', value: 1 }]) {
    assert.equal(predicateExcludesRowGroup(group, p), false, JSON.stringify(p));
  }
});

test('fallback: NaN / Infinity bounds never prune', () => {
  assert.equal(predicateExcludesRowGroup(g({ n: { min: NaN, max: NaN } }), { col: 'n', op: '=', value: 5 }), false);
  assert.equal(predicateExcludesRowGroup(g({ n: { min: -Infinity, max: Infinity } }), { col: 'n', op: '=', value: 5 }), false);
});

// --- the cascade stage ---------------------------------------------------

test('pruneRowGroupsByWhere drops exactly the provably-empty row groups and reports the stage', () => {
  const groups = [
    rg(0, 100, { conf: { min: 0.1, max: 0.4 } }),
    rg(1, 100, { conf: { min: 0.45, max: 0.9 } }),
    rg(2, 100, { conf: { min: 0.95, max: 1.0 } }),
  ];
  const out = pruneRowGroupsByWhere(groups, [{ col: 'conf', op: '>=', value: 0.5 }]);
  assert.deepEqual(out.selected.map((r) => r.index), [1, 2]);
  assert.equal(out.stage.stage, 'row-group-where');
  assert.equal(out.stage.before, 3);
  assert.equal(out.stage.after, 2);
  assert.match(out.stage.basis, /where\[\] statistics: conf >= 0\.5/);
  assert.equal(out.decidable, true);
  assert.equal(out.statsSeen, true);
});

test('pruneRowGroupsByWhere ANDs the where array', () => {
  const groups = [
    rg(0, 100, { a: { min: 0, max: 1 }, b: { min: 0, max: 1 } }),
    rg(1, 100, { a: { min: 5, max: 6 }, b: { min: 0, max: 1 } }),
    rg(2, 100, { a: { min: 5, max: 6 }, b: { min: 5, max: 6 } }),
  ];
  const out = pruneRowGroupsByWhere(groups, [
    { col: 'a', op: '>=', value: 5 },
    { col: 'b', op: '>=', value: 5 },
  ]);
  assert.deepEqual(out.selected.map((r) => r.index), [2]);
});

test('pruneRowGroupsByWhere with no where filter is a no-op stage', () => {
  const groups = [rg(0, 100, { n: { min: 1, max: 2 } })];
  for (const where of [undefined, [], null]) {
    const out = pruneRowGroupsByWhere(groups, where);
    assert.equal(out.selected.length, 1);
    assert.deepEqual(out.stage, { stage: 'row-group-where', before: 1, after: 1, basis: 'no where filter' });
    assert.equal(out.decidable, false);
    assert.equal(out.statsSeen, false);
  }
});

test('pruneRowGroupsByWhere says so when the operator is not statistics-decidable', () => {
  const groups = [rg(0, 100, { cat: { min: 'a', max: 'b' } })];
  const out = pruneRowGroupsByWhere(groups, [{ col: 'cat', op: 'like', value: 'z%' }]);
  assert.equal(out.selected.length, 1);
  assert.equal(out.decidable, false);
  assert.match(out.stage.basis, /no statistics-prunable operator/);
});

test('pruneRowGroupsByWhere says so when the files carry no statistics for the predicate column', () => {
  const groups = [rg(0, 100, { conf: null }), rg(1, 100, { conf: null })];
  const out = pruneRowGroupsByWhere(groups, [{ col: 'conf', op: '>=', value: 0.5 }]);
  assert.equal(out.selected.length, 2);
  assert.equal(out.decidable, true);
  assert.equal(out.statsSeen, false);
  assert.match(out.stage.basis, /no statistics$/);
});

test('STATS_PRUNABLE_OPS is the documented list and excludes like/not', () => {
  assert.deepEqual([...STATS_PRUNABLE_OPS].sort(), ['!=', '<', '<=', '=', '>', '>=', 'between', 'in', 'is_not_null', 'is_null', 'not_in']);
  for (const op of ['like', 'ilike', 'not_like', 'and', 'or', 'not']) {
    assert.ok(!STATS_PRUNABLE_OPS.includes(op), op);
  }
});

// --- the soundness property: pruning never removes a matching row -------

test('property: a pruned row group can hold no row the row filter would accept', () => {
  // For a grid of bounds and predicates, assert that whenever the pruner
  // drops a row group, no value inside [min, max] satisfies the predicate
  // according to `evaluateWhere` -- the row-level truth this must agree
  // with.
  const bounds = [
    [0, 10],
    [-5, 5],
    [3, 3],
    [10, 20],
  ];
  const values = [-6, -5, 0, 3, 5, 9, 10, 15, 20, 21];
  const ops = ['=', '!=', '<', '<=', '>', '>=', 'in', 'not_in', 'between'];
  let prunes = 0;
  for (const [min, max] of bounds) {
    const group = g({ n: { min, max, nulls: 0 } });
    for (const op of ops) {
      for (const v of values) {
        const predicate =
          op === 'in' || op === 'not_in'
            ? { col: 'n', op, values: [v] }
            : op === 'between'
              ? { col: 'n', op, low: v, high: v + 2 }
              : { col: 'n', op, value: v };
        if (!predicateExcludesRowGroup(group, predicate)) continue;
        prunes += 1;
        for (let x = min; x <= max; x += 0.25) {
          assert.equal(
            evaluateWhere([predicate], { n: x }),
            false,
            `pruned [${min},${max}] for ${op} ${v} but row n=${x} matches`,
          );
        }
      }
    }
  }
  assert.ok(prunes > 30, `expected the grid to exercise real prunes, got ${prunes}`);
});
