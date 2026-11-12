import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationGuard } from '../src/generation-guard.js';

// The cancellation primitive behind "a new select() supersedes the
// pending background upgrade" (design doc task). select() itself can
// only be exercised end-to-end against a real network + CDN import (see
// select.test.js for why), but this primitive is pure and dependency-free.

test('GenerationGuard: next() returns increasing generation numbers', () => {
  const guard = new GenerationGuard();
  assert.equal(guard.next(), 1);
  assert.equal(guard.next(), 2);
  assert.equal(guard.next(), 3);
});

test('GenerationGuard: isCurrent is true only for the latest generation', () => {
  const guard = new GenerationGuard();
  const gen1 = guard.next();
  assert.equal(guard.isCurrent(gen1), true);
  const gen2 = guard.next();
  assert.equal(guard.isCurrent(gen1), false);
  assert.equal(guard.isCurrent(gen2), true);
});

test('GenerationGuard: next() aborts the controller attached to the previous generation', () => {
  const guard = new GenerationGuard();
  guard.next();
  const controller = new AbortController();
  guard.attach(controller);
  assert.equal(controller.signal.aborted, false);

  guard.next(); // supersede
  assert.equal(controller.signal.aborted, true);
});

test('GenerationGuard: detach() clears the controller without aborting it', () => {
  const guard = new GenerationGuard();
  guard.next();
  const controller = new AbortController();
  guard.attach(controller);
  guard.detach(controller);

  guard.next(); // nothing attached anymore -- must not touch `controller`
  assert.equal(controller.signal.aborted, false);
});

test('GenerationGuard: detach() is a no-op for a controller that was already superseded', () => {
  const guard = new GenerationGuard();
  guard.next();
  const first = new AbortController();
  guard.attach(first);

  guard.next(); // supersedes `first` and aborts it
  const second = new AbortController();
  guard.attach(second);

  guard.detach(first); // stale handle: must not clear `second`
  guard.next();
  assert.equal(second.signal.aborted, true);
});

test('GenerationGuard: cancelAll() aborts the pending controller and bumps the generation', () => {
  const guard = new GenerationGuard();
  const gen = guard.next();
  const controller = new AbortController();
  guard.attach(controller);

  guard.cancelAll();
  assert.equal(controller.signal.aborted, true);
  assert.equal(guard.isCurrent(gen), false);
});
