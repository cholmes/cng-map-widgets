// `@cngeo/timeline` is loaded only when a timeline is used, through a seam: a
// page that shows no timeline must not have to map it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTimeline, setTimelineModules, clearTimelineModules, TIMELINE_REQUIRED_EXPORTS } from '../src/timeline-loader.js';

beforeEach(() => clearTimelineModules());

test('by default it is the @cngeo/timeline package, imported when first asked for', async () => {
  const mod = await loadTimeline();
  for (const name of TIMELINE_REQUIRED_EXPORTS) assert.ok(mod[name] !== undefined, `@cngeo/timeline has no ${name}`);
  assert.equal(await loadTimeline(), mod, 'one import, shared');
});

test('a host can hand its own in, and take it back', async () => {
  const mine = Object.fromEntries(TIMELINE_REQUIRED_EXPORTS.map((name) => [name, () => name]));
  setTimelineModules(mine);
  assert.equal(await loadTimeline(), mine);
  clearTimelineModules();
  assert.notEqual(await loadTimeline(), mine);
});

test('something that is not the timeline package is refused when handed in', () => {
  assert.throws(() => setTimelineModules({ createChunkSet() {} }), (e) => e.code === 'TIMELINE_INVALID' && /TimelineCanvas/.test(e.message));
});

test('no module of this package imports @cngeo/timeline statically', () => {
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const files = [...index.matchAll(/from '(\.\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(files.length > 10);
  for (const file of new Set(files)) {
    const text = readFileSync(new URL(`../src/${file.slice(2)}`, import.meta.url), 'utf8');
    assert.equal(/^\s*import[^;]*from\s+'@cngeo\/timeline'/m.test(text), false, `${file} imports @cngeo/timeline at the top`);
  }
});
