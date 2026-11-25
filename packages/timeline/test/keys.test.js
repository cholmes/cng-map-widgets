// Bucket keys: the day and month a count belongs to, as text, and the
// arithmetic that never goes through a local-time Date.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCngError } from '@cngeo/spec';
import { keyIndex, indexKey, unitOfKey, formatKey, keyToISO, isoToKey, dayRangeOfKey, bucketKeyOfDay, dayKeyOfDate, addDays } from '../src/keys.js';

test('a key says its unit by its width', () => {
  assert.equal(unitOfKey('202402'), 'month');
  assert.equal(unitOfKey('20240229'), 'day');
  assert.throws(() => unitOfKey('2024'), (e) => isCngError(e) && e.code === 'TIMELINE_INVALID');
});

test('a bad key is TIMELINE_INVALID, not a bare Error', () => {
  for (const bad of [() => keyIndex('0101', 'month'), () => keyIndex('202013', 'month'), () => keyIndex('20200100', 'day'), () => keyIndex('202001', 'week'), () => indexKey(5, 'week')]) {
    assert.throws(bad, (e) => isCngError(e) && e.code === 'TIMELINE_INVALID' && e.retryable === false);
  }
});

test('the days a bucket covers', () => {
  assert.deepEqual(dayRangeOfKey('20240229', 'day'), ['20240229', '20240229']);
  assert.deepEqual(dayRangeOfKey('202402', 'month'), ['20240201', '20240229']);
  assert.deepEqual(dayRangeOfKey('202302', 'month'), ['20230201', '20230228']);
  assert.deepEqual(dayRangeOfKey('202412', 'month'), ['20241201', '20241231']);
});

test('the bucket a day falls in', () => {
  assert.equal(bucketKeyOfDay('20241231', 'month'), '202412');
  assert.equal(bucketKeyOfDay('20241231', 'day'), '20241231');
});

test('a date becomes its UTC day, whatever the local time zone', () => {
  assert.equal(dayKeyOfDate('2000-11-01T00:13:00Z'), '20001101');
  assert.equal(dayKeyOfDate('2000-12-31T23:47:00Z'), '20001231');
  assert.equal(dayKeyOfDate('2024-03-05'), '20240305');
  assert.equal(dayKeyOfDate('20240305'), '20240305', 'a day key passes through');
  assert.equal(dayKeyOfDate(new Date(Date.UTC(2026, 10, 25, 23, 59))), '20261125');
  // An instant late in the UTC day is still that UTC day, where a local-time reading east of Greenwich says tomorrow.
  assert.equal(dayKeyOfDate('2024-12-31T23:30:00Z'), '20241231');
  assert.equal(dayKeyOfDate('not a date'), null);
  assert.equal(dayKeyOfDate(null), null);
});

test('adding days crosses months, years and leap days', () => {
  assert.equal(addDays('20241231', 1), '20250101');
  assert.equal(addDays('20240228', 1), '20240229');
  assert.equal(addDays('20240301', -1), '20240229');
  assert.equal(addDays('20240101', 365), '20241231');
});

test('keys as people and as <input> elements read them', () => {
  assert.equal(formatKey('200011', 'month'), 'Nov 2000');
  assert.equal(formatKey('20200705', 'day'), '5 Jul 2020');
  assert.equal(formatKey(null, 'day'), '');
  assert.equal(keyToISO('202402', 'month'), '2024-02');
  assert.equal(keyToISO('20240229', 'day'), '2024-02-29');
  assert.equal(isoToKey('2024-02-29', 'day'), '20240229');
  assert.equal(isoToKey('2024-02', 'month'), '202402');
  assert.equal(isoToKey('2024-02', 'day'), null, 'an unfinished date is not a key');
  assert.equal(isoToKey('', 'day'), null);
});
