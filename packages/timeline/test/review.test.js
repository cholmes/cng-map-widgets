// What the Phase 4 review found in @cngeo/timeline, each pinned by the test
// that failed before its fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKeyOfDate } from '../src/keys.js';
import { chunksFromTemplate, forView, forSelection, validateChunks } from '../src/chunks.js';
import { createChunkSet } from '../src/orchestrator.js';
import { TimelineCanvas } from '../src/timeline-canvas.js';
import { fakeFormat, fakeTimers, flush } from './helpers/fake-format.js';

const chunk = (id, start, end, extra = {}) => ({ id, start, end, unit: 'day', format: 'fake', url: `https://data.invalid/${id}.bin`, priority: 0, ...extra });
const ids = (list) => list.map((c) => c.id);

// --- Critical 2: an overview that is up to date must not take the recent end away from days ---------
//
// A monthly archive covers its last month whole (to the 30th); daily chunks
// end today (the 25th). Counting days covered, months "showed more" of any
// window that touched the 26th..30th -- by five days -- so the timeline
// opened in months and could not be brought back to days at the recent end.

const years = () => chunksFromTemplate({ template: 'https://data.invalid/{YYYY}.bin', period: 'year', start: '20241101', end: '20261125', format: 'fake' });
const overview = chunk('alltime', '20001101', '20261130', { unit: 'month' });

test('a coarser unit does not win by the unfinished part of its last bucket', () => {
  const set = [...years(), overview];
  assert.equal(forView(set, { from: '20260818', to: '20261125' }).unit, 'day');
  assert.equal(forView(set, { from: '20260823', to: '20261130' }).unit, 'day', 'five days past the end of the daily data is not a reason for months');
  assert.equal(forView(set, { from: '20251201', to: '20261130' }).unit, 'day');
  assert.deepEqual(ids(forView(set, { from: '20260823', to: '20261130' }).load), ['2026']);
});

test('it still wins when it shows a whole bucket more', () => {
  const set = [...years(), overview];
  assert.equal(forView(set, { from: '20240601', to: '20241231' }, { cap: 3 }).unit, 'month', 'five months before the daily data starts');
  assert.equal(forView(set, { from: '20190101', to: '20261130' }).unit, 'month');
});

test('the unit does not flip back and forth as a window grows by a day', () => {
  // An overview that covers only part of the window: days 1..60 of it.
  const set = [chunk('fine', '20240301', '20240630'), chunk('coarse', '20240101', '20240331', { unit: 'month' })];
  const units = [];
  for (let day = 1; day <= 30; day++) units.push(forView(set, { from: '20240101', to: `202404${String(day).padStart(2, '0')}` }).unit);
  const changes = units.filter((u, i) => i > 0 && u !== units[i - 1]).length;
  assert.ok(changes <= 1, `the unit changed ${changes} times: ${units.join(' ')}`);
});

// --- Important 7: a selection over many chunks must not cost seconds ---------------------------------

test('forSelection over thousands of small chunks is quick', () => {
  const days = chunksFromTemplate({ template: 'https://data.invalid/{start}.bin', period: 'day', start: '20001101', end: '20261125', format: 'fake' });
  assert.equal(days.length, 9521);
  const started = performance.now();
  const drawn = forSelection(days, { from: '20001101', to: '20261125' }, 'day');
  const took = performance.now() - started;
  assert.equal(drawn.length, 9521);
  assert.ok(took < 1500, `took ${took.toFixed(0)} ms (it was 54 s)`);
  const weeks = chunksFromTemplate({ template: 'https://data.invalid/{start}.bin', period: 'week', start: '20001101', end: '20261125', format: 'fake' });
  const t1 = performance.now();
  forView(weeks, { from: '20001101', to: '20261125' });
  forSelection(weeks, { from: '20001101', to: '20261125' }, 'day');
  assert.ok(performance.now() - t1 < 500, `weekly: ${(performance.now() - t1).toFixed(0)} ms`);
});

test('ownership is still right after the faster path: an overlay, a patch, and twins', () => {
  const year = chunk('2024', '20240101', '20241231');
  const week = chunk('week', '20241204', '20241210', { priority: 1 });
  const hidden = chunk('hidden', '20240601', '20240610'); // wholly under a higher-priority patch
  const patch = chunk('patch', '20240520', '20240620', { priority: 2 });
  const set = validateChunks([year, week, hidden, patch]);
  assert.deepEqual(ids(forSelection(set, { from: '20240101', to: '20241231' }, 'day')), ['2024', 'patch', 'week']);
  assert.deepEqual(ids(forSelection(set, { from: '20240601', to: '20240605' }, 'day')), ['patch']);
  assert.deepEqual(ids(forSelection(set, { from: '20241205', to: '20241206' }, 'day')), ['week']);
  // Overlays do not count against the cap, however they are found.
  assert.deepEqual(ids(forView(set, { from: '20240501', to: '20241231' }, { cap: 1 }).load), ['2024', 'patch', 'hidden', 'week']);
});

// --- Dates are calendar days in UTC, never local time ------------------------------------------------

test('a date-time with no zone is read as UTC, not as this machine\'s time', () => {
  const before = process.env.TZ;
  try {
    for (const zone of ['Europe/Berlin', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      assert.equal(dayKeyOfDate('2024-01-01T00:00:00'), '20240101', zone);
      assert.equal(dayKeyOfDate('2024-01-01T23:59:59.999'), '20240101', zone);
      assert.equal(dayKeyOfDate('2024-01-01 12:00:00'), '20240101', zone);
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
  assert.equal(dayKeyOfDate('2024-01-01T00:00:00+14:00'), '20231231', 'an offset that is given is honoured');
});

// --- Important 1: a gesture whose end is never reported -----------------------------------------------

test('a view held under "dragging" is treated as still after two seconds of silence', async () => {
  const fake = fakeFormat({ settleOnMount: true });
  const clock = fakeTimers();
  const set = createChunkSet({
    chunks: [...chunksFromTemplate({ template: 'https://data.invalid/{YYYY}.bin', period: 'year', start: '20150101', end: '20241231', format: 'fake' }), chunk('alltime', '20150101', '20241231', { unit: 'month' })],
    formats: { fake: fake.format },
    timers: clock.timers,
    cap: 2,
  });
  set.setView({ from: '20240201', to: '20240401' });
  set.setSelection({ from: '20240310', to: '20240312' });
  await flush();
  // A pinch out to six years; the event that says it has ended never comes.
  set.setView({ from: '20190101', to: '20241231' }, { dragging: true });
  clock.advance(600);
  await flush();
  assert.equal(set.state.unit, 'day', 'not yet: it may still be in flight');
  clock.advance(2000);
  await flush();
  assert.equal(set.state.unit, 'month', 'two seconds of nothing is the end of a gesture');
  assert.deepEqual(set.state.loaded, ['alltime']);
  set.destroy();
  assert.equal(clock.pending(), 0);
});

function stubCanvas(width = 800, height = 60) {
  const listeners = new Map();
  const ctx = new Proxy({}, { get: (t, name) => (name === 'measureText' ? () => ({ width: 10 }) : name in t ? t[name] : () => {}), set: (t, name, value) => { t[name] = value; return true; } });
  return {
    style: {}, width: 0, height: 0, tabIndex: -1,
    hasAttribute: () => false,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: () => {},
    focus() {}, setPointerCapture() {},
    fire(type, event = {}) {
      for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {}, clientX: 0, clientY: 0, pointerId: 1, ...event });
    },
  };
}
function canvasOn(axis) {
  globalThis.requestAnimationFrame = () => 0;
  const canvas = stubCanvas();
  const events = [];
  const timeline = new TimelineCanvas(canvas, { onChange: (e) => events.push(e) });
  timeline.setAxis(axis);
  return { timeline, canvas, events };
}
const YEAR = { unit: 'day', min: '20240101', max: '20241231' };

test('a pinch says when it is over', () => {
  const { timeline, canvas, events } = canvasOn(YEAR);
  timeline.setViewDays('20240301', '20240331');
  canvas.fire('pointerdown', { pointerId: 1, clientX: 300, clientY: 10 });
  canvas.fire('pointerdown', { pointerId: 2, clientX: 500, clientY: 10 });
  canvas.fire('pointermove', { pointerId: 2, clientX: 420, clientY: 10 }); // fingers together: zoom out
  assert.equal(events.at(-1).dragging, true);
  canvas.fire('pointerup', { pointerId: 1, clientX: 300, clientY: 10 });
  canvas.fire('pointerup', { pointerId: 2, clientX: 420, clientY: 10 });
  assert.equal(events.at(-1).dragging, false, 'or whoever is waiting for the gesture to end waits for ever');
  timeline.destroy();
});

// --- Important 6: the keyboard moves the selection along the AXIS, not only inside the view ----------

test('arrow keys carry the selection past the edge of the view, which follows', () => {
  const { timeline, canvas } = canvasOn(YEAR);
  timeline.setViewDays('20240301', '20240331');
  timeline.setSelectionDays('20240330', '20240331');
  for (let i = 0; i < 5; i++) canvas.fire('keydown', { key: 'ArrowRight' });
  assert.deepEqual(timeline.selectionDays(), { from: '20240404', to: '20240405' });
  assert.ok(timeline.viewDays().to >= '20240405');
  timeline.destroy();
});

test('an arrow key does not shrink a selection wider than the view, or drag one in from off screen', () => {
  const { timeline, canvas } = canvasOn(YEAR);
  timeline.setSelectionDays('20240201', '20240430'); // ninety days
  timeline.setViewDays('20240301', '20240310'); // ten in view
  canvas.fire('keydown', { key: 'ArrowRight' });
  assert.deepEqual(timeline.selectionDays(), { from: '20240202', to: '20240501' }, 'the same ninety days, one later');
  timeline.setSelectionDays('20241201', '20241205');
  timeline.setViewDays('20240301', '20240310');
  canvas.fire('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(timeline.selectionDays(), { from: '20241130', to: '20241204' }, 'one day earlier, not a jump into March');
  timeline.destroy();
});

test('shift and an arrow key resize the selection along the axis', () => {
  const { timeline, canvas } = canvasOn(YEAR);
  timeline.setViewDays('20240301', '20240331');
  timeline.setSelectionDays('20240330', '20240331');
  canvas.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  canvas.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.deepEqual(timeline.selectionDays(), { from: '20240330', to: '20240402' });
  canvas.fire('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.deepEqual(timeline.selectionDays(), { from: '20240330', to: '20240401' });
  timeline.destroy();
});
