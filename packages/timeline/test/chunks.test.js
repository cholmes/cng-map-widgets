// A set of chunks: descriptors, and the rules that say which of them a view
// needs, which a selection draws from, who owns a day two of them share, and
// what part of the axis nothing covers.
//
// The ownership, union and gap cases are ported from firms-catalog's
// apps/firms-explorer/mounted.test.mjs. The non-yearly cases are new: that
// app's chunks were years, and these rules must not care.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCngError } from '@cngeo/spec';
import { validateChunks, chunksFromTemplate, extentOf, covers, ownerOf, ownedRanges, axisFor, gapsIn, forView, forSelection } from '../src/chunks.js';

const chunk = (id, start, end, extra = {}) => ({ id, start, end, unit: 'day', format: 'pmtiles', url: `https://data.invalid/${id}.pmtiles`, priority: 0, ...extra });
const ids = (list) => list.map((c) => c.id);
const refused = (fn, needle) => assert.throws(fn, (e) => isCngError(e) && e.code === 'TIMELINE_INVALID' && e.retryable === false && (!needle || e.message.includes(needle)));

// The landing shape of the source app: a rolling week over the tail of the current year.
const week = chunk('latest', '20260908', '20260915', { priority: 1 });
const y2026 = chunk('2026', '20260101', '20260914');
const y2025 = chunk('2025', '20250101', '20251231');
const alltime = chunk('alltime', '20001101', '20260930', { unit: 'month' });

// --- descriptors ------------------------------------------------------------------------------

test('validateChunks: a normalised copy, sorted by start, defaults filled', () => {
  const out = validateChunks([
    { id: 'b', start: '2024-02-01', end: '2024-02-29T23:59:59Z', url: 'https://x.invalid/b.pmtiles' },
    { id: 'a', start: '20240101', end: '20240131', url: 'https://x.invalid/a.pmtiles', unit: 'day', format: 'pmtiles', priority: 2 },
  ]);
  assert.deepEqual(out, [
    { id: 'a', start: '20240101', end: '20240131', unit: 'day', format: 'pmtiles', url: 'https://x.invalid/a.pmtiles', priority: 2 },
    { id: 'b', start: '20240201', end: '20240229', unit: 'day', format: 'pmtiles', url: 'https://x.invalid/b.pmtiles', priority: 0 },
  ]);
});

test('validateChunks: what it refuses, each TIMELINE_INVALID and naming the chunk', () => {
  const good = chunk('a', '20240101', '20240131');
  refused(() => validateChunks(null), 'list');
  refused(() => validateChunks([]), 'empty');
  refused(() => validateChunks([{ ...good, id: '' }]), 'id');
  refused(() => validateChunks([good, { ...good }]), '"a"');
  refused(() => validateChunks([{ ...good, start: 'soon' }]), '"a"');
  refused(() => validateChunks([{ ...good, start: '20240201' }]), 'after');
  refused(() => validateChunks([{ ...good, unit: 'week' }]), 'unit');
  refused(() => validateChunks([{ ...good, url: 'javascript:alert(1)' }]), 'url');
  refused(() => validateChunks([{ ...good, url: './a.pmtiles' }]), 'url');
});

test('extentOf: a chunk in its own bucket keys', () => {
  assert.deepEqual(extentOf(y2025), { unit: 'day', min: '20250101', max: '20251231' });
  assert.deepEqual(extentOf(alltime), { unit: 'month', min: '200011', max: '202609' });
});

// --- chunksFromTemplate --------------------------------------------------------------------------

test('yearly chunks align to the calendar and are clipped to the range', () => {
  const years = chunksFromTemplate({ template: 'https://d.invalid/year={YYYY}/fire-{YYYY}.pmtiles', period: 'year', start: '2000-11-01', end: '20020315' });
  assert.deepEqual(years.map((c) => [c.id, c.start, c.end, c.url]), [
    ['2000', '20001101', '20001231', 'https://d.invalid/year=2000/fire-2000.pmtiles'],
    ['2001', '20010101', '20011231', 'https://d.invalid/year=2001/fire-2001.pmtiles'],
    ['2002', '20020101', '20020315', 'https://d.invalid/year=2002/fire-2002.pmtiles'],
  ]);
  assert.ok(years.every((c) => c.unit === 'day' && c.format === 'pmtiles' && c.priority === 0));
});

test('monthly chunks carry day buckets, and February knows its length', () => {
  const months = chunksFromTemplate({ template: 'https://d.invalid/{YYYY}/{MM}.pmtiles', period: 'month', start: '20240101', end: '20241231' });
  assert.equal(months.length, 12);
  assert.deepEqual(ids(months).slice(0, 3), ['202401', '202402', '202403']);
  assert.deepEqual([months[1].start, months[1].end], ['20240201', '20240229']);
  assert.equal(months[1].url, 'https://d.invalid/2024/02.pmtiles');
  assert.deepEqual(axisFor(months, 'day'), { unit: 'day', min: '20240101', max: '20241231' });
  // Only March loaded: everything before and after reads as not loaded.
  assert.deepEqual(gapsIn([months[2]], axisFor(months, 'day')), [[0, 59], [91, 365]]);
});

test('weekly chunks run from the start day, whatever weekday it is, and the last is clipped', () => {
  // 3 January 2024 was a Wednesday.
  const weeks = chunksFromTemplate({ template: 'https://d.invalid/w/{start}-{end}.pmtiles', period: 'week', start: '20240103', end: '20240120' });
  assert.deepEqual(weeks.map((c) => [c.id, c.start, c.end]), [
    ['20240103', '20240103', '20240109'],
    ['20240110', '20240110', '20240116'],
    ['20240117', '20240117', '20240120'],
  ]);
  assert.equal(weeks[2].url, 'https://d.invalid/w/20240117-20240120.pmtiles');
});

test('a period of any number of days, and a monthly unit, and a priority', () => {
  const tens = chunksFromTemplate({ template: 'https://d.invalid/{YYYY}{MM}{DD}.pmtiles', period: { days: 10 }, start: '20240225', end: '20240315', priority: 3 });
  assert.deepEqual(tens.map((c) => [c.start, c.end]), [['20240225', '20240305'], ['20240306', '20240315']]);
  assert.equal(tens[1].url, 'https://d.invalid/20240306.pmtiles');
  assert.ok(tens.every((c) => c.priority === 3));
  const decade = chunksFromTemplate({ template: 'https://d.invalid/m/{YYYY}.pmtiles', period: 'year', start: '20200101', end: '20211231', unit: 'month' });
  assert.deepEqual(decade.map((c) => extentOf(c)), [{ unit: 'month', min: '202001', max: '202012' }, { unit: 'month', min: '202101', max: '202112' }]);
});

test('chunksFromTemplate refuses what it cannot lay out', () => {
  refused(() => chunksFromTemplate({ template: 'https://d.invalid/{YYYY}.pmtiles', period: 'fortnight', start: '20240101', end: '20240201' }), 'period');
  refused(() => chunksFromTemplate({ template: 'https://d.invalid/{YYYY}.pmtiles', period: 'year', start: '20240201', end: '20240101' }), 'after');
  refused(() => chunksFromTemplate({ template: '', period: 'year', start: '20240101', end: '20240201' }), 'template');
  refused(() => chunksFromTemplate({ template: 'https://d.invalid/x.pmtiles', period: { days: 0 }, start: '20240101', end: '20240201' }), 'period');
});

// --- the axis is the union -------------------------------------------------------------------------

test('the axis is the union of the chunks of one unit; a coarser chunk adds no buckets', () => {
  assert.deepEqual(axisFor([week], 'day'), { unit: 'day', min: '20260908', max: '20260915' });
  assert.deepEqual(axisFor([week, y2026, y2025], 'day'), { unit: 'day', min: '20250101', max: '20260915' });
  assert.deepEqual(axisFor([week, y2026, alltime], 'day'), { unit: 'day', min: '20260101', max: '20260915' });
  assert.deepEqual(axisFor([week, y2026, alltime], 'month'), { unit: 'month', min: '200011', max: '202609' });
  assert.equal(axisFor([], 'day'), null);
  assert.equal(axisFor([alltime], 'day'), null);
});

// --- ownership where they overlap ------------------------------------------------------------------

test('a day two chunks share belongs to the one with the higher priority, whatever the order', () => {
  assert.equal(ownerOf([y2026, week], '20260912').id, 'latest');
  assert.equal(ownerOf([week, y2026], '20260912').id, 'latest');
  assert.equal(ownerOf([week, y2026], '20260301').id, '2026');
  assert.equal(ownerOf([week, y2026], '20260915').id, 'latest', 'the most recent day, where the year is partial');
  assert.equal(ownerOf([week, y2026], '20240101'), null);
  assert.equal(ownerOf([week, y2026, alltime], '202603').id, 'alltime', 'a month key is asked of the monthly chunks');
});

test('a tie goes to the narrower chunk, then to the earlier id', () => {
  const tied = [{ ...y2026, priority: 1 }, week];
  assert.equal(ownerOf(tied, '20260912').id, 'latest');
  const twins = [chunk('b', '20240101', '20240131'), chunk('a', '20240101', '20240131')];
  assert.equal(ownerOf(twins, '20240115').id, 'a');
});

test('covers: by unit and by span', () => {
  assert.equal(covers(y2025, '20250615'), true);
  assert.equal(covers(y2025, '20260101'), false);
  assert.equal(covers(y2025, '202506'), false, 'a month key is not a day of a daily chunk');
  assert.equal(covers(alltime, '202506'), true);
});

test('ownedRanges: the buckets of a window a chunk owns, as runs', () => {
  const held = [y2026, week];
  // The year under the overlapping week loses the week's days.
  assert.deepEqual(ownedRanges(held, y2026, '20260901', '20260915'), [['20260901', '20260907']]);
  assert.deepEqual(ownedRanges(held, week, '20260901', '20260915'), [['20260908', '20260915']]);
  // A higher-priority chunk in the middle splits the lower one in two.
  const patch = chunk('patch', '20260301', '20260305', { priority: 5 });
  assert.deepEqual(ownedRanges([y2026, patch], y2026, '20260225', '20260310'), [['20260225', '20260228'], ['20260306', '20260310']]);
  assert.deepEqual(ownedRanges(held, y2025, '20260901', '20260915'), [], 'nothing of it in that window');
  assert.deepEqual(ownedRanges([alltime], alltime, '202601', '202603'), [['202601', '202603']]);
});

// --- holes -----------------------------------------------------------------------------------------

test('gaps are what no loaded chunk covers, as index ranges of the axis', () => {
  assert.deepEqual(gapsIn([week], { unit: 'day', min: '20260717', max: '20260915' }), [[0, 52]]);
  assert.deepEqual(gapsIn([week, y2026], axisFor([week, y2026], 'day')), []);
  assert.deepEqual(gapsIn([], { unit: 'day', min: '20260101', max: '20260110' }), [[0, 9]], 'nothing loaded is one gap, not none');
  const split = [y2025, chunk('2027', '20270101', '20271231')];
  assert.deepEqual(gapsIn(split, axisFor(split, 'day')), [[365, 729]], 'a missing middle year is one interior gap');
  assert.deepEqual(gapsIn([alltime, y2025], { unit: 'day', min: '20250101', max: '20250110' }), [], 'a chunk of another unit neither fills nor makes a gap');
  assert.deepEqual(gapsIn([alltime], { unit: 'day', min: '20250101', max: '20250103' }), [[0, 2]]);
  assert.deepEqual(gapsIn([y2025], null), []);
});

// --- what a view needs -----------------------------------------------------------------------------

const y2023 = chunk('2023', '20230101', '20231231');
const y2024 = chunk('2024', '20240101', '20241231');
const dec = chunk('week', '20241204', '20241210', { priority: 1 });
const all = chunk('alltime', '20001101', '20241231', { unit: 'month' });
const mixed = [y2023, y2024, dec, all];

test('forView: a window inside one fine chunk loads it, and an overlay that touches', () => {
  assert.deepEqual(ids(forView(mixed, { from: '20240301', to: '20240430' }).load), ['2024']);
  const late = forView(mixed, { from: '20241101', to: '20241231' });
  assert.equal(late.unit, 'day');
  assert.deepEqual(ids(late.load), ['2024', 'week']);
});

test('forView: across a boundary both load; an overlay does not count against the cap', () => {
  const across = forView(mixed, { from: '20231215', to: '20240115' }, { cap: 2 });
  assert.equal(across.unit, 'day');
  assert.deepEqual(ids(across.load), ['2023', '2024']);
  const both = forView(mixed, { from: '20231215', to: '20241231' }, { cap: 2 });
  assert.deepEqual(ids(both.load), ['2023', '2024', 'week'], 'two years and the week: the week is an overlay');
});

test('forView: wider than the fine chunks cover moves to the coarser unit', () => {
  const wide = forView(mixed, { from: '20190101', to: '20241231' });
  assert.equal(wide.unit, 'month');
  assert.deepEqual(ids(wide.load), ['alltime']);
});

test('forView: more fine chunks than the cap moves to the coarser unit too', () => {
  const years = chunksFromTemplate({ template: 'https://d.invalid/{YYYY}.pmtiles', period: 'year', start: '20180101', end: '20241231' });
  const out = forView([...years, all], { from: '20200601', to: '20240601' }, { cap: 3 });
  assert.equal(out.unit, 'month');
  assert.deepEqual(ids(out.load), ['alltime']);
});

test('forView: with no coarser chunk, the cap nearest the middle load and the rest is left', () => {
  const years = chunksFromTemplate({ template: 'https://d.invalid/{YYYY}.pmtiles', period: 'year', start: '20180101', end: '20241231' });
  const out = forView(years, { from: '20200601', to: '20240601' }, { cap: 2 });
  assert.equal(out.unit, 'day');
  assert.deepEqual(ids(out.load), ['2021', '2022'], 'the middle of the window is June 2022');
});

test('forView: monthly chunks — a ten-week window needs three, and gets them', () => {
  const months = chunksFromTemplate({ template: 'https://d.invalid/{YYYY}{MM}.pmtiles', period: 'month', start: '20240101', end: '20241231' });
  assert.deepEqual(ids(forView(months, { from: '20240320', to: '20240528' }).load), ['202403', '202404', '202405']);
  assert.deepEqual(ids(forView(months, { from: '20240101', to: '20241231' }, { cap: 3 }).load), ['202406', '202407', '202408']);
});

test('forView: a window nothing touches, and an empty set', () => {
  assert.deepEqual(forView(mixed, { from: '20300101', to: '20300201' }), { unit: 'day', load: [] });
  assert.deepEqual(forView([], { from: '20240101', to: '20240201' }), { unit: 'day', load: [] });
  assert.deepEqual(forView([all], { from: '20240101', to: '20240201' }).unit, 'month');
});

// --- what a selection draws from --------------------------------------------------------------------

test('forSelection: every chunk that owns part of it — three months of a ten-week selection', () => {
  const months = chunksFromTemplate({ template: 'https://d.invalid/{YYYY}{MM}.pmtiles', period: 'month', start: '20240101', end: '20241231' });
  assert.deepEqual(ids(forSelection(months, { from: '20240320', to: '20240528' }, 'day')), ['202403', '202404', '202405']);
  assert.deepEqual(ids(forSelection(months, { from: '20240410', to: '20240412' }, 'day')), ['202404']);
});

test('forSelection: an overlapped chunk is left out when it owns none of the window', () => {
  assert.deepEqual(ids(forSelection(mixed, { from: '20241205', to: '20241209' }, 'day')), ['week'], 'the week owns all of it');
  assert.deepEqual(ids(forSelection(mixed, { from: '20241201', to: '20241209' }, 'day')), ['2024', 'week']);
  assert.deepEqual(ids(forSelection(mixed, { from: '20241201', to: '20241209' }, 'month')), ['alltime']);
  assert.deepEqual(forSelection(mixed, { from: '20300101', to: '20300201' }, 'day'), []);
});
