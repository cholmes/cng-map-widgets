// What the timeline panel says and offers, with no DOM: its status words, its
// preset spans, and what its date inputs hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '@cngeo/timeline';
import { timelineStatusOf, presetsFor, inputsFor, selectionTotal, notLoadedBuckets, createTimelineModel, trackNews, unboundStatus, liveness } from '../src/timeline-model.js';

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

// Review, Important 5. The track speaks whole buckets; the session holds exact
// days. Every track event used to forward BOTH the view and the selection, so
// on the monthly track the first zoom overwrote an exact five-day selection
// with the whole month it sat in -- and it came back from months as a month.
test('a track event forwards only what the track changed', () => {
  const june = { from: '20260601', to: '20260630' };
  const shown = { view: { from: '20200101', to: '20261130' }, selection: june, dragging: false };
  // A zoom on the monthly track: the view moved, the selection did not.
  assert.deepEqual(trackNews(shown, { view: { from: '20250101', to: '20261130' }, selection: june, dragging: false }), { view: true, selection: false });
  // A drag of the selection.
  assert.deepEqual(trackNews(shown, { view: shown.view, selection: { from: '20260701', to: '20260731' }, dragging: true }), { view: true, selection: true });
  // The end of a gesture that changed nothing more is still news: someone is waiting for `dragging: false`.
  assert.deepEqual(trackNews({ ...shown, dragging: true }, { ...shown, dragging: false }), { view: true, selection: false });
  assert.deepEqual(trackNews(shown, { ...shown }), { view: false, selection: false });
  // Nothing shown yet: everything is news.
  assert.deepEqual(trackNews(null, shown), { view: true, selection: true });
});

// Review, Critical 1 (the panel's half). A layer that failed is ON the map,
// as an error; the panel said it was not there.
test('with no session, the panel says what the layer manager knows', () => {
  assert.deepEqual(unboundStatus(null, 'fires'), { tone: 'error', line: 'There is no layer "fires" on the map.' });
  assert.deepEqual(unboundStatus({ title: 'Fires', status: 'error', error: { message: 'HTTP 520 for fire-2012.pmtiles' } }, 'fires'), { tone: 'error', line: 'HTTP 520 for fire-2012.pmtiles' });
  assert.deepEqual(unboundStatus({ title: 'Fires', status: 'loading' }, 'fires'), { tone: 'info', line: 'Loading "Fires"…' });
  assert.deepEqual(unboundStatus({ title: 'Roads', status: 'ready', kind: 'pmtiles-vector' }, 'roads'), { tone: 'error', line: '"Roads" is not a timeline layer.' });
});

// Review, Important 6. A live region rewritten on every step of playback is
// twelve sentences in four seconds to a screen reader.
test('while it plays, the status is not announced; when it stops, it is', () => {
  assert.equal(liveness({ playing: true }), 'off');
  assert.equal(liveness({ playing: false }), 'polite');
  assert.equal(liveness(undefined), 'polite');
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
