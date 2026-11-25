// The canvas component, driven through a stub canvas: this suite has no DOM
// library, and what matters here is not the pixels but what the component
// tells its owner -- always in day keys, whatever the axis's unit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineCanvas, TIMELINE_THEME_DARK, TIMELINE_THEME_LIGHT } from '../src/timeline-canvas.js';

/** A canvas that records its listeners and draws nowhere. */
function stubCanvas(width = 800, height = 60) {
  const listeners = new Map();
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, name) {
      if (name === 'measureText') return (text) => ({ width: String(text).length * 6 });
      if (name in target) return target[name];
      return (...args) => {
        calls.push([name, args]);
      };
    },
    set(target, name, value) {
      target[name] = value;
      return true;
    },
  });
  const canvas = {
    style: {},
    width: 0,
    height: 0,
    tabIndex: -1,
    calls,
    listeners,
    hasAttribute: () => false,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
    focus() {},
    setPointerCapture() {},
    fire(type, event = {}) {
      for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {}, clientX: 0, clientY: 0, pointerId: 1, ...event });
    },
    count: () => [...listeners.values()].reduce((n, list) => n + list.length, 0),
  };
  return canvas;
}

/** Frames are run by hand. */
function frames() {
  const queue = [];
  globalThis.requestAnimationFrame = (fn) => queue.push(fn);
  globalThis.cancelAnimationFrame = () => {};
  return () => {
    for (const fn of queue.splice(0)) fn();
  };
}

const YEAR = { unit: 'day', min: '20240101', max: '20241231' };
const RECORD = { unit: 'month', min: '200011', max: '202412' };

function make(axis = YEAR) {
  const runFrames = frames();
  const canvas = stubCanvas();
  const events = [];
  const timeline = new TimelineCanvas(canvas, { onChange: (e) => events.push(e) });
  timeline.setAxis(axis);
  return { timeline, canvas, events, runFrames };
}

test('a view and a selection go in and come out as day keys, on a daily axis', () => {
  const { timeline, events } = make();
  timeline.setViewDays('20240301', '20240531');
  timeline.setSelectionDays('20240410', '20240420');
  assert.deepEqual(timeline.viewDays(), { from: '20240301', to: '20240531' });
  assert.deepEqual(timeline.selectionDays(), { from: '20240410', to: '20240420' });
  const last = events.at(-1);
  assert.deepEqual(last.view, { from: '20240301', to: '20240531' });
  assert.deepEqual(last.selection, { from: '20240410', to: '20240420' });
  assert.equal(last.unit, 'day');
  assert.equal(last.dragging, false);
  timeline.destroy();
});

test('on a monthly axis a day range is the months it touches, whole', () => {
  const { timeline } = make(RECORD);
  timeline.setViewDays('20190115', '20240320');
  timeline.setSelectionDays('20240310', '20240312');
  assert.deepEqual(timeline.viewDays(), { from: '20190101', to: '20240331' });
  assert.deepEqual(timeline.selectionDays(), { from: '20240301', to: '20240331' });
  timeline.destroy();
});

test('reversed dates are swapped, and dates off the axis are brought onto it', () => {
  const { timeline } = make();
  timeline.setSelectionDays('20240420', '20240410');
  assert.deepEqual(timeline.selectionDays(), { from: '20240410', to: '20240420' });
  timeline.setViewDays('20231101', '20240215');
  assert.deepEqual(timeline.viewDays().from, '20240101');
  timeline.setSelectionDays('20250101', '20250105');
  assert.deepEqual(timeline.selectionDays(), { from: '20241227', to: '20241231' }, 'slid to the end, its width kept');
  timeline.destroy();
});

test('setAxis({ keep }) changes the unit under the same dates, and says nothing', () => {
  const { timeline, events } = make({ unit: 'day', min: '20001101', max: '20241231' });
  timeline.setViewDays('20190101', '20241231');
  timeline.setSelectionDays('20240310', '20240312');
  const said = events.length;
  timeline.setAxis(RECORD, { keep: true });
  assert.equal(events.length, said, 'the owner asked for this: it is not told about it');
  assert.equal(timeline.axis.unit, 'month');
  assert.deepEqual(timeline.viewDays(), { from: '20190101', to: '20241231' });
  assert.deepEqual(timeline.selectionDays(), { from: '20240301', to: '20240331' });
  // And back: months to days, exactly the days those months hold.
  timeline.setViewDays('20240101', '20240630');
  timeline.setAxis({ unit: 'day', min: '20001101', max: '20241231' }, { keep: true });
  assert.deepEqual(timeline.viewDays(), { from: '20240101', to: '20240630' });
  assert.deepEqual(timeline.selectionDays(), { from: '20240301', to: '20240331' });
  timeline.destroy();
});

test('a first axis opens on its last days', () => {
  const { timeline } = make();
  timeline.openAt({ selectDays: 5, viewDays: 100 });
  assert.deepEqual(timeline.selectionDays(), { from: '20241227', to: '20241231' });
  assert.deepEqual(timeline.viewDays(), { from: '20240923', to: '20241231' });
  timeline.destroy();
});

test('shift() moves the selection a bucket, takes the view with it, and stops at the end', () => {
  const { timeline, events } = make();
  timeline.setViewDays('20240301', '20240331');
  timeline.setSelectionDays('20240330', '20240331');
  const said = events.length;
  assert.equal(timeline.shift(1), true);
  assert.deepEqual(timeline.selectionDays(), { from: '20240331', to: '20240401' });
  assert.ok(timeline.viewDays().to >= '20240401', 'the view followed');
  assert.equal(events.length, said + 1);
  assert.equal(timeline.shift(-1), true);
  timeline.setSelectionDays('20241230', '20241231');
  assert.equal(timeline.shift(1), false, 'nothing after the last day');
  assert.deepEqual(timeline.selectionDays(), { from: '20241230', to: '20241231' });
  timeline.setSelectionDays('20240101', '20240102');
  assert.equal(timeline.shift(-1), false);
  timeline.destroy();
});

test('toStart() puts the selection on the first buckets, same width', () => {
  const { timeline } = make();
  timeline.setSelectionDays('20241201', '20241203');
  timeline.toStart();
  assert.deepEqual(timeline.selectionDays(), { from: '20240101', to: '20240103' });
  timeline.destroy();
});

test('arrow keys move the selection and say so', () => {
  const { timeline, canvas, events } = make();
  timeline.setViewDays('20240301', '20240331');
  timeline.setSelectionDays('20240310', '20240312');
  canvas.fire('keydown', { key: 'ArrowRight' });
  assert.deepEqual(events.at(-1).selection, { from: '20240311', to: '20240313' });
  canvas.fire('keydown', { key: 'ArrowLeft' });
  canvas.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.deepEqual(events.at(-1).selection, { from: '20240310', to: '20240313' }, 'shift widens it');
  timeline.destroy();
});

test('a drag says it is a drag, and its end says it is over', () => {
  const { timeline, canvas, events } = make();
  timeline.setViewDays('20240101', '20240410'); // 101 days over 800 px
  timeline.setSelectionDays('20240201', '20240210');
  const said = events.length;
  canvas.fire('pointerdown', { clientX: 280, clientY: 10 }); // inside the selection
  canvas.fire('pointermove', { clientX: 360, clientY: 10 });
  assert.equal(events.at(-1).dragging, true);
  assert.notDeepEqual(events.at(-1).selection, { from: '20240201', to: '20240210' });
  assert.deepEqual(events.at(-1).view, { from: '20240101', to: '20240410' }, 'the view did not move');
  canvas.fire('pointerup', { clientX: 360, clientY: 10 });
  assert.equal(events.at(-1).dragging, false, 'one last event, so a listener waiting for the end gets one');
  assert.ok(events.length >= said + 2);
  timeline.destroy();
});

test('values, gaps and a theme are painted without a DOM', () => {
  const { timeline, canvas, runFrames } = make();
  timeline.setValues({ 20240105: 4, count_20240106: 9, count_modis: 999 });
  timeline.setGaps([[100, 365]]);
  timeline.setTheme(TIMELINE_THEME_LIGHT);
  canvas.fire('pointermove', { clientX: 20, clientY: 10 });
  runFrames();
  const drawn = canvas.calls.map(([name]) => name);
  assert.ok(drawn.includes('fillRect') && drawn.includes('stroke') && drawn.includes('fillText'), drawn.slice(0, 8).join(','));
  assert.notEqual(TIMELINE_THEME_DARK.track, TIMELINE_THEME_LIGHT.track);
  timeline.destroy();
});

test('destroy() removes every listener it added', () => {
  const { timeline, canvas } = make();
  assert.ok(canvas.count() >= 7);
  timeline.destroy();
  assert.equal(canvas.count(), 0);
});

test('with no axis it does nothing rather than throw', () => {
  frames();
  const canvas = stubCanvas();
  const timeline = new TimelineCanvas(canvas, {});
  assert.equal(timeline.viewDays(), null);
  assert.equal(timeline.selectionDays(), null);
  assert.equal(timeline.shift(1), false);
  timeline.setViewDays('20240101', '20240201');
  canvas.fire('keydown', { key: 'ArrowRight' });
  canvas.fire('wheel', { deltaY: 10 });
  timeline.destroy();
});
