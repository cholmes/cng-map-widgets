// What the timeline panel says and offers, with no DOM: its status words, its
// preset spans, and what its date inputs hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '@cngeo/timeline';
import { timelineStatusOf, presetsFor, inputsFor, selectionTotal, notLoadedBuckets, createTimelineModel } from '../src/timeline-model.js';

const DAY_AXIS = { unit: 'day', min: '20240101', max: '20241231' };
const base = (extra = {}) => ({
  unit: 'day',
  axis: DAY_AXIS,
  gaps: [],
  loaded: ['2024'],
  drawing: ['2024'],
  outgoing: [],
  pending: [],
  failed: [],
  histogram: { 20241120: 10, 20241121: 5, 20241125: 1000, 20241201: 7 },
  partial: false,
  view: { from: '20240901', to: '20241231' },
  selection: { from: '20241120', to: '20241125' },
  ...extra,
});
const say = (state, extra = {}) => timelineStatusOf(state, { timeline: T, metricLabel: 'detections', ...extra });

test('selectionTotal: what the bars inside the selection add up to', () => {
  assert.equal(selectionTotal(base(), T), 1015);
  assert.equal(selectionTotal(base({ selection: { from: '20240101', to: '20240105' } }), T), 0);
  const monthly = base({ unit: 'month', axis: { unit: 'month', min: '200011', max: '202412' }, histogram: { 202411: 40, 202412: 2 }, selection: { from: '20241115', to: '20241203' } });
  assert.equal(selectionTotal(monthly, T), 42, 'a selection in months is the months it touches');
  assert.equal(selectionTotal(base({ axis: null }), T), 0);
});

test('notLoadedBuckets: how much of the selection nothing loaded covers', () => {
  // Days 0..323 of 2024 are a gap: everything before 20 November.
  assert.equal(notLoadedBuckets(base({ gaps: [[0, 323]] }), T), 0);
  assert.equal(notLoadedBuckets(base({ gaps: [[0, 325]] }), T), 2, '20 and 21 November');
  assert.equal(notLoadedBuckets(base({ gaps: [[0, 400]] }), T), 6);
  assert.equal(notLoadedBuckets(base({ gaps: [[330, 365]] }), T), 0);
});

test('status: what is selected and how much of it there is', () => {
  assert.deepEqual(say(base()), { tone: 'info', line: '20 Nov 2024 – 25 Nov 2024 · 1,015 detections in view' });
  assert.equal(say(base({ selection: { from: '20241125', to: '20241125' } })).line, '25 Nov 2024 · 1,000 detections in view');
  const monthly = base({ unit: 'month', axis: { unit: 'month', min: '200011', max: '202412' }, histogram: { 202411: 40 }, selection: { from: '20241101', to: '20241130' } });
  assert.equal(say(monthly).line, 'Nov 2024 · 40 detections in view');
  assert.equal(say(base(), { metricLabel: 'features' }).line.endsWith('features in view'), true);
});

test('status: loading says so, with tiles when they are known', () => {
  assert.equal(say(base({ axis: null, loaded: [], drawing: [], pending: ['2024'] })).line, 'Loading…');
  assert.equal(say(base({ partial: true })).line, '20 Nov 2024 – 25 Nov 2024 · loading…');
  assert.equal(say(base({ partial: true }), { tiles: { selected: 12, loaded: 5 } }).line, '20 Nov 2024 – 25 Nov 2024 · loading 5 of 12 tiles…');
  assert.equal(say(base({ partial: true }), { tiles: { selected: 12, loaded: 12 } }).line, '20 Nov 2024 – 25 Nov 2024 · loading…');
});

test('status: a selection that reaches into what is not loaded says how much, not a total that looks whole', () => {
  const out = say(base({ gaps: [[0, 325]] }));
  assert.equal(out.tone, 'info');
  assert.equal(out.line, '20 Nov 2024 – 25 Nov 2024 · 1,015 detections in view · 2 days not loaded');
  assert.match(say(base({ gaps: [[0, 324]] })).line, /1 day not loaded/);
});

test('status: a chunk that failed is an error, named, with what it said', () => {
  const failed = [{ id: '2023', error: Object.assign(new Error('Chunk "2023" could not be loaded: HTTP 404'), { code: 'LAYER_LOAD_FAILED' }) }];
  const out = say(base({ failed }));
  assert.equal(out.tone, 'error');
  assert.match(out.line, /2023/);
  assert.match(out.line, /404/);
  assert.match(out.line, /1,015 detections/, 'what did load is still reported');
});

test('status does not depend on the view: panning says nothing new', () => {
  assert.deepEqual(say(base()), say(base({ view: { from: '20240101', to: '20240301' } })));
});

test('presets: spans the axis can show, and always "All"', () => {
  assert.deepEqual(presetsFor(DAY_AXIS, T).map((p) => [p.id, p.buckets]), [['7d', 7], ['30d', 30], ['90d', 90], ['1y', 365], ['all', null]]);
  assert.deepEqual(presetsFor({ unit: 'day', min: '20241101', max: '20241210' }, T).map((p) => p.id), ['7d', '30d', 'all']);
  assert.deepEqual(presetsFor({ unit: 'month', min: '200011', max: '202412' }, T).map((p) => [p.id, p.buckets]), [['1y', 12], ['5y', 60], ['10y', 120], ['all', null]]);
  assert.deepEqual(presetsFor({ unit: 'month', min: '202401', max: '202406' }, T).map((p) => p.id), ['all']);
  assert.deepEqual(presetsFor(null, T), []);
  assert.ok(presetsFor(DAY_AXIS, T).every((p) => typeof p.label === 'string' && p.label));
});

test('date inputs: days on a daily axis, months on a monthly one, bounded by the axis', () => {
  assert.deepEqual(inputsFor(base(), T), { type: 'date', from: '2024-11-20', to: '2024-11-25', min: '2024-01-01', max: '2024-12-31' });
  const monthly = base({ unit: 'month', axis: { unit: 'month', min: '200011', max: '202412' }, selection: { from: '20241101', to: '20241130' } });
  assert.deepEqual(inputsFor(monthly, T), { type: 'month', from: '2024-11', to: '2024-11', min: '2000-11', max: '2024-12' });
  assert.equal(inputsFor(base({ axis: null }), T), null);
});

test('the model follows its session and says when what it shows has changed', () => {
  let state = base();
  const listeners = new Set();
  const session = { timeline: T, get state() { return state; }, on: (type, fn) => { listeners.add(fn); return () => listeners.delete(fn); }, tiles: () => ({ selected: 0, loaded: 0 }) };
  const model = createTimelineModel({ session, metricLabel: 'detections' });
  const seen = [];
  model.on('change', (s) => seen.push(s.status.line));
  assert.equal(model.state.status.line, '20 Nov 2024 – 25 Nov 2024 · 1,015 detections in view');
  assert.equal(model.state.inputs.type, 'date');
  assert.equal(model.state.presets.length, 5);
  state = base({ selection: { from: '20241125', to: '20241125' } });
  for (const fn of listeners) fn(state);
  assert.deepEqual(seen, ['25 Nov 2024 · 1,000 detections in view']);
  model.destroy();
  assert.equal(listeners.size, 0);
});
