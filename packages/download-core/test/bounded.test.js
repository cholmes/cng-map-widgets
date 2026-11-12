import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedExact,
  boundedRange,
  zeroBounded,
  addBounded,
  sumBounded,
  scaleBounded,
  capBounded,
  isEstimateWide,
} from '../src/bounded.js';

test('boundedExact sets min=max=estimate and exact:true', () => {
  const b = boundedExact(42);
  assert.deepEqual(b, { min: 42, max: 42, estimate: 42, exact: true });
});

test('addBounded sums every field and ANDs exact', () => {
  const a = boundedRange(0, 10, 5, true);
  const b = boundedRange(0, 20, 8, false);
  assert.deepEqual(addBounded(a, b), { min: 0, max: 30, estimate: 13, exact: false });
});

test('addBounded keeps exact:true when both inputs are exact', () => {
  const a = boundedExact(3);
  const b = boundedExact(4);
  assert.deepEqual(addBounded(a, b), { min: 7, max: 7, estimate: 7, exact: true });
});

test('sumBounded over an empty list is zero and exact', () => {
  assert.deepEqual(sumBounded([]), zeroBounded());
});

test('sumBounded over a list sums all three fields', () => {
  const list = [boundedExact(1), boundedExact(2), boundedRange(0, 10, 5)];
  assert.deepEqual(sumBounded(list), { min: 3, max: 13, estimate: 8, exact: false });
});

test('scaleBounded multiplies every field, keeps exact flag', () => {
  const a = boundedExact(10);
  assert.deepEqual(scaleBounded(a, 2.5), { min: 25, max: 25, estimate: 25, exact: true });
});

test('capBounded is a no-op when max is already under the cap', () => {
  const a = boundedRange(0, 10, 5);
  assert.deepEqual(capBounded(a, 100), a);
});

test('capBounded clamps max/estimate and forces exact:false when it binds', () => {
  const a = boundedExact(1000);
  const capped = capBounded(a, 50);
  assert.deepEqual(capped, { min: 50, max: 50, estimate: 50, exact: false });
});

test('capBounded clamps a wide range correctly', () => {
  const a = boundedRange(0, 1000, 500);
  const capped = capBounded(a, 50);
  assert.deepEqual(capped, { min: 0, max: 50, estimate: 50, exact: false });
});

test('isEstimateWide: false when max/estimate is within the ratio', () => {
  assert.equal(isEstimateWide(boundedRange(0, 100, 20), 10), false); // 100/20 = 5
});

test('isEstimateWide: true when max/estimate exceeds the ratio', () => {
  assert.equal(isEstimateWide(boundedRange(0, 10_000, 5), 10), true); // 2000
});

test('isEstimateWide: a positive max with zero estimate is wide', () => {
  assert.equal(isEstimateWide(boundedRange(0, 100, 0)), true);
});

test('isEstimateWide: zero/zero is not wide', () => {
  assert.equal(isEstimateWide(boundedExact(0)), false);
});
