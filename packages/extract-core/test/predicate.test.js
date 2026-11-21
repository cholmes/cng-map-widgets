import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPath, evaluatePredicate, evaluateWhere, columnsUsedByWhere } from '../src/predicate.js';

test('getPath resolves a dotted struct path', () => {
  assert.equal(getPath({ names: { primary: 'Contra Costa' } }, 'names.primary'), 'Contra Costa');
});

test('getPath resolves a [n] list subscript', () => {
  assert.equal(getPath({ tags: ['a', 'b', 'c'] }, 'tags[1]'), 'b');
});

test('getPath returns undefined through a missing intermediate', () => {
  assert.equal(getPath({ a: null }, 'a.b.c'), undefined);
});

test('comparison operators', () => {
  const row = { confidence: 0.9 };
  assert.equal(evaluatePredicate({ col: 'confidence', op: '=', value: 0.9 }, row), true);
  assert.equal(evaluatePredicate({ col: 'confidence', op: '!=', value: 0.9 }, row), false);
  assert.equal(evaluatePredicate({ col: 'confidence', op: '<', value: 1 }, row), true);
  assert.equal(evaluatePredicate({ col: 'confidence', op: '<=', value: 0.9 }, row), true);
  assert.equal(evaluatePredicate({ col: 'confidence', op: '>', value: 0.9 }, row), false);
  assert.equal(evaluatePredicate({ col: 'confidence', op: '>=', value: 0.9 }, row), true);
});

test('comparison against a null/undefined value is false (not an error)', () => {
  assert.equal(evaluatePredicate({ col: 'missing', op: '=', value: 1 }, {}), false);
  assert.equal(evaluatePredicate({ col: 'missing', op: '>', value: 1 }, {}), false);
});

test('in / not_in', () => {
  const row = { sensor: 'VIIRS_SNPP' };
  assert.equal(evaluatePredicate({ col: 'sensor', op: 'in', values: ['VIIRS_SNPP', 'VIIRS_NOAA20'] }, row), true);
  assert.equal(evaluatePredicate({ col: 'sensor', op: 'not_in', values: ['VIIRS_SNPP'] }, row), false);
  assert.equal(evaluatePredicate({ col: 'sensor', op: 'not_in', values: ['OTHER'] }, row), true);
});

test('between is inclusive on both ends', () => {
  const pred = { col: 'area_ha', op: 'between', low: 0.1, high: 500 };
  assert.equal(evaluatePredicate(pred, { area_ha: 0.1 }), true);
  assert.equal(evaluatePredicate(pred, { area_ha: 500 }), true);
  assert.equal(evaluatePredicate(pred, { area_ha: 500.1 }), false);
  assert.equal(evaluatePredicate(pred, { area_ha: 0.09 }), false);
});

test('is_null / is_not_null', () => {
  assert.equal(evaluatePredicate({ col: 'x', op: 'is_null' }, { x: null }), true);
  assert.equal(evaluatePredicate({ col: 'x', op: 'is_null' }, {}), true);
  assert.equal(evaluatePredicate({ col: 'x', op: 'is_null' }, { x: 0 }), false);
  assert.equal(evaluatePredicate({ col: 'x', op: 'is_not_null' }, { x: 0 }), true);
});

test('like / ilike / not_like with % and _ wildcards', () => {
  assert.equal(evaluatePredicate({ col: 'name', op: 'like', value: 'Contra%' }, { name: 'Contra Costa' }), true);
  assert.equal(evaluatePredicate({ col: 'name', op: 'like', value: 'contra%' }, { name: 'Contra Costa' }), false);
  assert.equal(evaluatePredicate({ col: 'name', op: 'ilike', value: 'contra%' }, { name: 'Contra Costa' }), true);
  assert.equal(evaluatePredicate({ col: 'name', op: 'like', value: 'C_ntra%' }, { name: 'Contra Costa' }), true);
  assert.equal(evaluatePredicate({ col: 'name', op: 'not_like', value: 'Contra%' }, { name: 'Contra Costa' }), false);
});

test('and / or / not combinators', () => {
  const row = { a: 1, b: 2 };
  assert.equal(evaluatePredicate({ op: 'and', args: [{ col: 'a', op: '=', value: 1 }, { col: 'b', op: '=', value: 2 }] }, row), true);
  assert.equal(evaluatePredicate({ op: 'and', args: [{ col: 'a', op: '=', value: 1 }, { col: 'b', op: '=', value: 3 }] }, row), false);
  assert.equal(evaluatePredicate({ op: 'or', args: [{ col: 'a', op: '=', value: 9 }, { col: 'b', op: '=', value: 2 }] }, row), true);
  assert.equal(evaluatePredicate({ op: 'not', arg: { col: 'a', op: '=', value: 9 } }, row), true);
});

test('evaluateWhere ANDs the top-level array; empty/undefined means "match everything"', () => {
  const row = { confidence: 0.9, area_ha: 1 };
  assert.equal(evaluateWhere(undefined, row), true);
  assert.equal(evaluateWhere([], row), true);
  assert.equal(
    evaluateWhere([{ col: 'confidence', op: '>=', value: 0.9 }, { col: 'area_ha', op: '<', value: 2 }], row),
    true,
  );
  assert.equal(
    evaluateWhere([{ col: 'confidence', op: '>=', value: 0.9 }, { col: 'area_ha', op: '>', value: 2 }], row),
    false,
  );
});

test('columnsUsedByWhere collects top-level column names from a predicate tree', () => {
  const where = [
    { col: 'confidence', op: '>=', value: 0.9 },
    { op: 'and', args: [{ col: 'sensor', op: 'in', values: ['a'] }, { op: 'not', arg: { col: 'quality', op: '=', value: 'sp' } }] },
  ];
  assert.deepEqual(new Set(columnsUsedByWhere(where)), new Set(['confidence', 'sensor', 'quality']));
});
