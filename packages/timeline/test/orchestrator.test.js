// The chunk-set orchestrator: which chunks are loaded, which draw, how one
// hands over to the next, and what the histogram says -- run against a fake
// format and a clock moved by hand.
//
// The five lines of the plan's Review Focus are the sections below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCngError } from '@cngeo/spec';
import { createChunkSet } from '../src/orchestrator.js';
import { chunksFromTemplate } from '../src/chunks.js';
import { fakeFormat, fakeTimers, flush } from './helpers/fake-format.js';

const chunk = (id, start, end, extra = {}) => ({ id, start, end, unit: 'day', format: 'fake', url: `https://data.invalid/${id}.bin`, priority: 0, ...extra });
const months2024 = () => chunksFromTemplate({ template: 'https://data.invalid/{YYYY}{MM}.bin', period: 'month', start: '20240101', end: '20241231', format: 'fake' });
const years = (from, to) => chunksFromTemplate({ template: 'https://data.invalid/{YYYY}.bin', period: 'year', start: `${from}0101`, end: `${to}1231`, format: 'fake' });

function make(chunks, formatOptions = {}, options = {}) {
  const fake = fakeFormat({ settleOnMount: true, ...formatOptions });
  const clock = fakeTimers();
  const set = createChunkSet({ chunks, formats: { fake: fake.format }, timers: clock.timers, ...options });
  const changes = [];
  set.on('change', (state) => changes.push(state));
  return { set, fake, clock, changes };
}
const windowOf = (fake, id) => fake.mounts.get(id)?.window ?? null;

// --- the basics ---------------------------------------------------------------------------------

test('what a view needs is opened and mounted; the axis is the whole set, the gaps what is not loaded', async () => {
  const { set, fake, changes } = make(months2024(), { manual: true });
  set.setView({ from: '20240310', to: '20240420' });
  set.setSelection({ from: '20240401', to: '20240405' });
  assert.deepEqual(fake.opened, ['202403', '202404']);
  assert.deepEqual(set.state.pending, ['202403', '202404']);
  assert.deepEqual(set.state.loaded, []);
  assert.deepEqual(set.state.axis, { unit: 'day', min: '20240101', max: '20241231' });
  assert.deepEqual(set.state.gaps, [[0, 365]], 'nothing loaded yet: all of it is a gap');
  fake.release('202403');
  fake.release('202404');
  await flush();
  assert.deepEqual(set.state.loaded, ['202403', '202404']);
  assert.deepEqual(set.state.pending, []);
  assert.deepEqual(set.state.gaps, [[0, 59], [121, 365]]);
  assert.deepEqual(set.state.drawing, ['202404']);
  assert.deepEqual(windowOf(fake, '202404'), { unit: 'day', ranges: [['20240401', '20240405']] });
  assert.equal(windowOf(fake, '202403'), null, 'loaded for the histogram, not drawing');
  assert.ok(changes.length > 0);
  assert.equal(set.state.unit, 'day');
  set.destroy();
});

test('a bad chunk list is refused at once', () => {
  assert.throws(() => createChunkSet({ chunks: [], formats: {} }), (e) => isCngError(e) && e.code === 'TIMELINE_INVALID');
});

// --- Review Focus 1: chunks that are not years ---------------------------------------------------

test('a selection across three monthly chunks draws all three, each its own days', async () => {
  const { set, fake } = make(months2024());
  set.setView({ from: '20240301', to: '20240531' });
  set.setSelection({ from: '20240320', to: '20240528' });
  await flush();
  assert.deepEqual(set.state.drawing, ['202403', '202404', '202405']);
  assert.deepEqual(windowOf(fake, '202403').ranges, [['20240320', '20240331']]);
  assert.deepEqual(windowOf(fake, '202404').ranges, [['20240401', '20240430']]);
  assert.deepEqual(windowOf(fake, '202405').ranges, [['20240501', '20240528']]);
  set.destroy();
});

test('a selection outside the view still gets its chunks, and they are kept', async () => {
  const { set, clock } = make(months2024());
  set.setView({ from: '20240301', to: '20240320' });
  set.setSelection({ from: '20240910', to: '20240912' });
  await flush();
  assert.deepEqual(set.state.loaded, ['202403', '202409']);
  clock.advance(1000); // settle: an eviction pass
  await flush();
  assert.deepEqual(set.state.loaded, ['202403', '202409'], 'the chunk the selection draws from is never evicted');
  assert.deepEqual(set.state.drawing, ['202409']);
  set.destroy();
});

test('weekly chunks: the gaps are the weeks not loaded', async () => {
  const weeks = chunksFromTemplate({ template: 'https://data.invalid/w{start}.bin', period: 'week', start: '20240103', end: '20240228', format: 'fake' });
  const { set } = make(weeks, {}, { cap: 2 });
  set.setView({ from: '20240110', to: '20240120' });
  set.setSelection({ from: '20240112', to: '20240113' });
  await flush();
  assert.deepEqual(set.state.loaded, ['20240110', '20240117']);
  assert.deepEqual(set.state.gaps, [[0, 6], [21, 56]]);
  set.destroy();
});

// --- Review Focus 2: overlapping chunks that disagree --------------------------------------------

const y2024 = chunk('2024', '20240101', '20241231');
const week = chunk('week', '20241204', '20241210', { priority: 1 });

test('a bucket two chunks share is drawn once, by the one with the higher priority', async () => {
  const { set, fake } = make([y2024, week]);
  set.setView({ from: '20241101', to: '20241231' });
  set.setSelection({ from: '20241201', to: '20241215' });
  await flush();
  assert.deepEqual(set.state.drawing, ['2024', 'week']);
  assert.deepEqual(windowOf(fake, 'week').ranges, [['20241204', '20241210']]);
  assert.deepEqual(windowOf(fake, '2024').ranges, [['20241201', '20241203'], ['20241211', '20241215']], 'the year gives up the days the week has');
  set.destroy();
});

test('the histogram takes each bucket from its owner, and counts it once', async () => {
  const { set, clock } = make([y2024, week], {
    histograms: {
      2024: { 20241203: 10, 20241204: 99, 20241205: 99, 20241211: 7 }, // the year's copy of the week's days is stale
      week: { 20241204: 4, 20241205: 5 },
    },
  });
  set.setView({ from: '20241101', to: '20241231' });
  set.setSelection({ from: '20241201', to: '20241215' });
  set.setViewport({ bbox: [-10, -10, 10, 10] });
  await flush();
  clock.advance(200);
  assert.deepEqual(set.state.histogram, { 20241203: 10, 20241204: 4, 20241205: 5, 20241211: 7 });
  set.destroy();
});

test('the histogram is recomputed once after a burst of tiles, and is partial until every chunk has settled', async () => {
  const { set, fake, clock } = make([y2024, week], { settleOnMount: false, histograms: { 2024: { 20241203: 1 } } });
  set.setView({ from: '20241101', to: '20241231' });
  set.setSelection({ from: '20241201', to: '20241215' });
  set.setViewport({ bbox: [0, 0, 1, 1] });
  await flush();
  const year = fake.mounts.get('2024');
  const before = year.histogramCalls;
  for (let i = 0; i < 5; i++) year.ctx.changed();
  clock.advance(100);
  assert.equal(year.histogramCalls, before, 'not yet: 180 ms after the last');
  clock.advance(100);
  assert.equal(year.histogramCalls, before + 1);
  assert.deepEqual(year.viewport, { bbox: [0, 0, 1, 1] });
  assert.equal(set.state.partial, true);
  year.ctx.settled(true);
  fake.mounts.get('week').ctx.settled(true);
  assert.equal(set.state.partial, false);
  year.ctx.settled(false); // the map moved: it is fetching again
  assert.equal(set.state.partial, true);
  set.destroy();
});

// --- Review Focus 3: a chunk that fails, or never answers ------------------------------------------

test('a chunk that will not open is reported, its span stays a gap, and the rest work', async () => {
  const { set, fake } = make(months2024(), { fail: ['202404'] });
  set.setView({ from: '20240301', to: '20240531' });
  set.setSelection({ from: '20240320', to: '20240528' });
  await flush();
  assert.deepEqual(set.state.loaded, ['202403', '202405']);
  assert.equal(set.state.failed.length, 1);
  const { id, error } = set.state.failed[0];
  assert.equal(id, '202404');
  assert.ok(isCngError(error) && error.code === 'LAYER_LOAD_FAILED' && error.retryable === true);
  assert.equal(error.context.chunk, '202404');
  assert.match(error.message, /202404/);
  assert.deepEqual(set.state.gaps, [[0, 59], [91, 120], [152, 365]], 'April reads as not loaded, not as zero');
  assert.deepEqual(set.state.drawing, ['202403', '202405']);
  assert.equal(fake.opened.filter((x) => x === '202404').length, 1, 'not retried on every change');
  set.setSelection({ from: '20240321', to: '20240528' });
  await flush();
  assert.equal(fake.opened.filter((x) => x === '202404').length, 1);
  set.destroy();
});

test('retry() opens a failed chunk again', async () => {
  const { set, fake } = make(months2024(), { fail: ['202404'] });
  set.setView({ from: '20240401', to: '20240420' });
  set.setSelection({ from: '20240405', to: '20240406' });
  await flush();
  assert.deepEqual(set.state.failed.map((f) => f.id), ['202404']);
  fake.fail.delete('202404');
  set.retry('202404');
  await flush();
  assert.deepEqual(set.state.failed, []);
  assert.deepEqual(set.state.loaded, ['202404']);
  assert.deepEqual(set.state.drawing, ['202404']);
  set.destroy();
});

test('a chunk that never answers is given up on, and its request is aborted', async () => {
  const { set, fake, clock } = make(months2024(), { manual: true }, { openTimeoutMs: 5000 });
  set.setView({ from: '20240401', to: '20240420' });
  set.setSelection({ from: '20240405', to: '20240406' });
  const signal = fake.waiting.get('202404').signal;
  clock.advance(4999);
  assert.deepEqual(set.state.pending, ['202404']);
  clock.advance(2);
  await flush();
  assert.deepEqual(set.state.pending, []);
  assert.equal(set.state.failed[0].id, '202404');
  assert.equal(set.state.failed[0].error.code, 'LAYER_LOAD_FAILED');
  assert.match(set.state.failed[0].error.message, /did not answer/);
  assert.equal(signal.aborted, true);
  set.destroy();
});

test('a chunk of a format nobody registered is a failure of that chunk, not of the set', async () => {
  const chunks = [...months2024().slice(0, 2), { ...months2024()[2], format: 'geoparquet' }];
  const { set } = make(chunks);
  set.setView({ from: '20240101', to: '20240331' });
  set.setSelection({ from: '20240110', to: '20240111' });
  await flush();
  assert.deepEqual(set.state.loaded, ['202401', '202402']);
  assert.equal(set.state.failed[0].error.code, 'TIMELINE_INVALID');
  assert.equal(set.state.failed[0].error.retryable, false);
  set.destroy();
});

// --- Review Focus 4: fast input ----------------------------------------------------------------------

test('a fast drag across many boundaries opens no chunk twice and never holds more than twice the cap', async () => {
  const { set, fake, clock } = make(years(2015, 2024), {}, { cap: 2 });
  set.setView({ from: '20240101', to: '20240301' });
  set.setSelection({ from: '20240110', to: '20240112' });
  await flush();
  let most = 0;
  // Dragging the view back through the years, a boundary every 50 ms.
  for (let y = 2023; y >= 2017; y--) {
    set.setView({ from: `${y}1101`, to: `${y + 1}0115` }, { dragging: true });
    clock.advance(50);
    await flush();
    most = Math.max(most, set.state.loaded.length + set.state.pending.length);
  }
  assert.ok(most <= 5, `held ${most} chunks at once (cap 2: twice that, plus the one the selection draws from)`);
  assert.equal(new Set(fake.opened).size, fake.opened.length, `opened twice: ${fake.opened.join(',')}`);
  assert.ok(set.state.loaded.includes('2024'), 'the chunk that is drawing is never evicted mid-drag');
  // Pointer up, and the dust settles.
  set.setView({ from: '20171101', to: '20180115' });
  clock.advance(1000);
  await flush();
  assert.deepEqual(set.state.loaded, ['2017', '2018', '2024']);
  set.destroy();
});

test('a selection moved onto a chunk that has not opened yet draws once it has', async () => {
  const { set, fake } = make(months2024(), { manual: true });
  set.setView({ from: '20240301', to: '20240430' });
  set.setSelection({ from: '20240305', to: '20240306' });
  fake.release('202403');
  await flush();
  assert.deepEqual(set.state.drawing, ['202403']);
  set.setSelection({ from: '20240410', to: '20240412' }); // April is still opening
  assert.deepEqual(set.state.pending, ['202404']);
  fake.release('202404');
  await flush();
  assert.deepEqual(set.state.drawing, ['202404']);
  assert.deepEqual(windowOf(fake, '202404').ranges, [['20240410', '20240412']]);
  set.destroy();
});

test('handover: a chunk that stops drawing is frozen until its successor has something to show', async () => {
  const { set, fake } = make(months2024(), { settleOnMount: false });
  set.setView({ from: '20240301', to: '20240430' });
  set.setSelection({ from: '20240305', to: '20240306' });
  await flush();
  const march = fake.mounts.get('202403');
  const april = fake.mounts.get('202404');
  march.ctx.settled(true);
  const windowsBefore = march.windows.length;
  set.setSelection({ from: '20240410', to: '20240412' });
  assert.equal(march.frozen, true, 'still showing what it showed');
  assert.equal(march.windows.length, windowsBefore, 'and not told to stop');
  assert.deepEqual(set.state.outgoing, ['202403']);
  assert.deepEqual(set.state.drawing, ['202404']);
  april.ctx.settled(true);
  assert.equal(march.window, null, 'released');
  assert.equal(march.frozen, false);
  assert.deepEqual(set.state.outgoing, []);
  set.destroy();
});

test('handover does not wait for ever', async () => {
  const { set, fake, clock } = make(months2024(), { settleOnMount: false }, { handoverMs: 3000 });
  set.setView({ from: '20240301', to: '20240430' });
  set.setSelection({ from: '20240305', to: '20240306' });
  await flush();
  fake.mounts.get('202403').ctx.settled(true); // March is on screen
  set.setSelection({ from: '20240410', to: '20240412' });
  assert.deepEqual(set.state.outgoing, ['202403']);
  clock.advance(3001);
  assert.deepEqual(set.state.outgoing, []);
  assert.equal(fake.mounts.get('202403').window, null);
  set.destroy();
});

test('a frozen chunk the selection comes back to simply draws again', async () => {
  const { set, fake } = make(months2024(), { settleOnMount: false });
  set.setView({ from: '20240301', to: '20240430' });
  set.setSelection({ from: '20240305', to: '20240306' });
  await flush();
  set.setSelection({ from: '20240410', to: '20240412' });
  set.setSelection({ from: '20240307', to: '20240308' });
  const march = fake.mounts.get('202403');
  assert.equal(march.frozen, false);
  assert.deepEqual(march.window.ranges, [['20240307', '20240308']]);
  assert.deepEqual(set.state.outgoing, ['202404'].filter(() => false), 'April never showed anything: nothing to hand over from');
  set.destroy();
});

test('a callback fired from inside setWindow does not loop', async () => {
  let calls = 0;
  const { set, changes } = make(months2024(), {
    settleOnMount: false,
    onSetWindow: (record) => {
      calls += 1;
      record.ctx.settled(true);
      record.ctx.changed();
    },
  });
  set.setView({ from: '20240301', to: '20240430' });
  set.setSelection({ from: '20240305', to: '20240306' });
  await flush();
  assert.ok(calls > 0 && calls < 10, `${calls} setWindow calls`);
  assert.ok(changes.length < 30, `${changes.length} change events`);
  set.destroy();
});

test('destroy() destroys every mount, aborts what is opening, and silences everything', async () => {
  const { set, fake, clock, changes } = make(months2024(), { manual: true });
  set.setView({ from: '20240301', to: '20240520' });
  set.setSelection({ from: '20240305', to: '20240306' });
  fake.release('202403');
  await flush();
  const opening = fake.waiting.get('202404').signal;
  const march = fake.mounts.get('202403');
  set.destroy();
  assert.equal(march.destroyed, true);
  assert.equal(opening.aborted, true);
  const seen = changes.length;
  march.ctx.changed();
  march.ctx.settled(true);
  set.setView({ from: '20240601', to: '20240620' });
  set.setSelection({ from: '20240605', to: '20240606' });
  clock.advance(10_000);
  await flush();
  assert.equal(changes.length, seen, 'no event after destroy');
  assert.equal(clock.pending(), 0, 'no timer left');
  assert.equal(fake.everMounted.filter((m) => !m.destroyed).length, 0);
});

// --- Review Focus 5: units ----------------------------------------------------------------------------

const overview = chunk('alltime', '20150101', '20241231', { unit: 'month' });

test('a view wider than the cap moves to the coarser unit, but only once things settle', async () => {
  const { set, fake, clock } = make([...years(2015, 2024), overview], {}, { cap: 2 });
  set.setView({ from: '20240201', to: '20240401' });
  set.setSelection({ from: '20240310', to: '20240312' });
  await flush();
  assert.equal(set.state.unit, 'day');
  set.setView({ from: '20190101', to: '20241231' });
  await flush();
  assert.equal(set.state.unit, 'day', 'not mid-gesture');
  assert.deepEqual(set.state.axis, { unit: 'day', min: '20150101', max: '20241231' });
  clock.advance(451);
  await flush();
  assert.equal(set.state.unit, 'month');
  assert.deepEqual(set.state.axis, { unit: 'month', min: '201501', max: '202412' });
  assert.deepEqual(set.state.loaded, ['alltime']);
  assert.deepEqual(set.state.drawing, ['alltime']);
  assert.deepEqual(windowOf(fake, 'alltime'), { unit: 'month', ranges: [['202403', '202403']] }, 'the same days, in months');
  assert.equal(fake.mounts.get('2024').destroyed, true, 'the daily chunk is let go');
  assert.deepEqual(set.state.view, { from: '20190101', to: '20241231' });
  assert.deepEqual(set.state.selection, { from: '20240310', to: '20240312' });
  set.destroy();
});

test('zooming back in returns to the finer unit', async () => {
  const { set, clock } = make([...years(2015, 2024), overview], {}, { cap: 2 });
  set.setView({ from: '20190101', to: '20241231' });
  set.setSelection({ from: '20240310', to: '20240312' });
  await flush();
  assert.equal(set.state.unit, 'month');
  set.setView({ from: '20240201', to: '20240401' });
  clock.advance(451);
  await flush();
  assert.equal(set.state.unit, 'day');
  assert.deepEqual(set.state.loaded, ['2024']);
  assert.deepEqual(set.state.drawing, ['2024']);
  set.destroy();
});

test('the daily chunk keeps drawing until the monthly one has settled, then goes', async () => {
  const { set, fake, clock } = make([...years(2015, 2024), overview], { settleOnMount: false }, { cap: 2 });
  set.setView({ from: '20240201', to: '20240401' });
  set.setSelection({ from: '20240310', to: '20240312' });
  await flush();
  fake.mounts.get('2024').ctx.settled(true);
  set.setView({ from: '20190101', to: '20241231' });
  clock.advance(451);
  await flush();
  const daily = fake.mounts.get('2024');
  assert.equal(daily.destroyed, false);
  assert.equal(daily.frozen, true);
  assert.deepEqual(set.state.outgoing, ['2024']);
  fake.mounts.get('alltime').ctx.settled(true);
  assert.equal(daily.destroyed, true);
  assert.deepEqual(set.state.outgoing, []);
  set.destroy();
});

test('with no coarser chunk, the cap nearest the view load and the rest is a gap', async () => {
  const { set, clock } = make(years(2015, 2024), {}, { cap: 2 });
  set.setView({ from: '20180601', to: '20220601' });
  set.setSelection({ from: '20200601', to: '20200605' });
  clock.advance(1000);
  await flush();
  assert.equal(set.state.unit, 'day');
  assert.deepEqual(set.state.loaded, ['2019', '2020']);
  assert.equal(set.state.gaps.length, 2);
  set.destroy();
});

// --- mounts() -------------------------------------------------------------------------------------------

test('mounts() lists what is mounted, bottom first, with what each is doing', async () => {
  const { set } = make([y2024, week], { settleOnMount: false });
  set.setView({ from: '20241101', to: '20241231' });
  set.setSelection({ from: '20241201', to: '20241202' });
  await flush();
  assert.deepEqual(set.mounts().map((m) => [m.id, m.drawing, m.outgoing]), [['2024', true, false], ['week', false, false]]);
  assert.equal(typeof set.mounts()[0].mount.histogram, 'function');
  set.destroy();
});
