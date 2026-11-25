import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CngError } from '../src/errors.js';

// The retryable default belongs to the CODE, so a thrower that forgets to
// pass `retryable` still gets the documented behaviour.

test('DECK_LOAD_FAILED is retryable by default: it is a network fetch', () => {
  assert.equal(new CngError('offline', 'DECK_LOAD_FAILED').retryable, true);
});

test('DECK_MODULES_INVALID is not retryable: the same modules fail the same way', () => {
  assert.equal(new CngError('stale', 'DECK_MODULES_INVALID').retryable, false);
});

test('LAYER_LOAD_FAILED is retryable by default; a bad or unsupported layer is not', () => {
  assert.equal(new CngError('404', 'LAYER_LOAD_FAILED').retryable, true);
  assert.equal(new CngError('bad', 'LAYER_INVALID').retryable, false);
  assert.equal(new CngError('zarr', 'LAYER_UNSUPPORTED').retryable, false);
});
