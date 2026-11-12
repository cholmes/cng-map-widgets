import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveResolutionMode } from '../src/geocoder.js';

// select()'s manifest-driven resolution decision (design doc §3.2's
// GeometryResolverOptions.resolution; task "If the manifest has no
// display file for a level, fall back gracefully to 'full' path").

test('resolveResolutionMode: defaults to display when unspecified', () => {
  assert.equal(resolveResolutionMode(undefined, true), 'display');
});

test('resolveResolutionMode: display stays display when a display file exists', () => {
  assert.equal(resolveResolutionMode('display', true), 'display');
});

test('resolveResolutionMode: display falls back to full with no display file', () => {
  assert.equal(resolveResolutionMode('display', false), 'full');
});

test('resolveResolutionMode: both stays both when a display file exists', () => {
  assert.equal(resolveResolutionMode('both', true), 'both');
});

test('resolveResolutionMode: both falls back to full with no display file', () => {
  assert.equal(resolveResolutionMode('both', false), 'full');
});

test('resolveResolutionMode: full is never affected by display-file presence', () => {
  assert.equal(resolveResolutionMode('full', true), 'full');
  assert.equal(resolveResolutionMode('full', false), 'full');
});
