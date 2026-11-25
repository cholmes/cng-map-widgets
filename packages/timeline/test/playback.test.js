// The playback clock: it calls `step` at a steady rate, holds while the data
// is not ready, stops or loops at the end, and never runs faster than once a
// second for someone who has asked for reduced motion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayback } from '../src/playback.js';
import { fakeTimers } from './helpers/fake-format.js';

function make(options = {}) {
  const clock = fakeTimers();
  const steps = [];
  let left = options.steps ?? Infinity;
  const playback = createPlayback({
    step: (direction) => {
      steps.push(direction);
      if (direction === 'restart') {
        left = options.steps ?? Infinity;
        return true;
      }
      if (direction === 1) {
        if (left <= 0) return false;
        left -= 1;
      }
      return true;
    },
    timers: clock.timers,
    ...options.playback,
  });
  const changes = [];
  playback.on('change', (state) => changes.push({ ...state }));
  return { playback, clock, steps, changes };
}

test('it plays at the speed given, and pauses', () => {
  const { playback, clock, steps, changes } = make({ playback: { speed: 4 } });
  assert.deepEqual(playback.state, { playing: false, speed: 4, loop: false });
  playback.play();
  assert.equal(playback.state.playing, true);
  assert.equal(steps.length, 0, 'the first step is one interval away, not immediate');
  clock.advance(1000);
  assert.equal(steps.length, 4);
  playback.pause();
  clock.advance(1000);
  assert.equal(steps.length, 4);
  assert.deepEqual(changes.map((c) => c.playing), [true, false]);
  playback.destroy();
});

test('play() twice is one clock; toggle() flips it', () => {
  const { playback, clock, steps } = make({ playback: { speed: 2 } });
  playback.play();
  playback.play();
  clock.advance(1000);
  assert.equal(steps.length, 2);
  playback.toggle();
  assert.equal(playback.state.playing, false);
  playback.toggle();
  clock.advance(500);
  assert.equal(steps.length, 3);
  playback.destroy();
});

test('a change of speed takes effect on the next step', () => {
  const { playback, clock, steps } = make({ playback: { speed: 1 } });
  playback.play();
  clock.advance(1000);
  assert.equal(steps.length, 1);
  playback.setSpeed(10);
  assert.equal(playback.state.speed, 10);
  clock.advance(1000);
  assert.equal(steps.length, 11);
  playback.setSpeed(1000);
  assert.equal(playback.state.speed, 30, 'no faster than the screen can show');
  playback.setSpeed(0);
  assert.equal(playback.state.speed, 0.25);
  playback.destroy();
});

test('at the end it stops', () => {
  const { playback, clock, steps } = make({ steps: 3, playback: { speed: 4 } });
  playback.play();
  clock.advance(5000);
  assert.deepEqual(steps, [1, 1, 1, 1], 'three that moved and the one that could not');
  assert.equal(playback.state.playing, false);
});

test('with loop it starts again from the beginning', () => {
  const { playback, clock, steps } = make({ steps: 2, playback: { speed: 4, loop: true } });
  playback.play();
  clock.advance(1000);
  assert.deepEqual(steps, [1, 1, 1, 'restart']);
  assert.equal(playback.state.playing, true);
  clock.advance(500);
  assert.deepEqual(steps, [1, 1, 1, 'restart', 1, 1]);
  playback.setLoop(false);
  clock.advance(1000);
  assert.equal(playback.state.playing, false);
  playback.destroy();
});

test('while the data is not ready the clock holds, without stopping', () => {
  let ready = true;
  const { playback, clock, steps } = make({ playback: { speed: 4, ready: () => ready } });
  playback.play();
  clock.advance(500);
  assert.equal(steps.length, 2);
  ready = false;
  clock.advance(2000);
  assert.equal(steps.length, 2, 'held');
  assert.equal(playback.state.playing, true, 'but still playing');
  ready = true;
  clock.advance(500);
  assert.ok(steps.length >= 3 && steps.length <= 4);
  playback.destroy();
});

test('stepping by hand pauses first, and goes either way', () => {
  const { playback, clock, steps } = make({ playback: { speed: 4 } });
  playback.play();
  playback.stepBy(-1);
  assert.equal(playback.state.playing, false);
  assert.deepEqual(steps, [-1]);
  playback.stepBy(3);
  assert.deepEqual(steps, [-1, 1, 1, 1]);
  clock.advance(2000);
  assert.equal(steps.length, 4);
  playback.destroy();
});

test('reduced motion: never faster than once a second', () => {
  const { playback, clock, steps } = make({ playback: { speed: 8, reducedMotion: true } });
  assert.equal(playback.state.speed, 1);
  playback.play();
  clock.advance(3000);
  assert.equal(steps.length, 3);
  playback.setSpeed(20);
  assert.equal(playback.state.speed, 1);
  playback.setSpeed(0.5);
  assert.equal(playback.state.speed, 0.5, 'slower is always allowed');
  playback.destroy();
});

test('destroy() stops the clock and clears its timer', () => {
  const { playback, clock, steps, changes } = make({ playback: { speed: 4 } });
  playback.play();
  playback.destroy();
  assert.equal(clock.pending(), 0);
  clock.advance(5000);
  assert.equal(steps.length, 0);
  const seen = changes.length;
  playback.play();
  assert.equal(changes.length, seen);
  assert.equal(clock.pending(), 0);
});

test('a step that throws stops playback rather than ticking for ever', () => {
  const clock = fakeTimers();
  const playback = createPlayback({ step: () => { throw new Error('gone'); }, timers: clock.timers, speed: 4 });
  playback.play();
  clock.advance(1000);
  assert.equal(playback.state.playing, false);
  assert.equal(clock.pending(), 0);
});
