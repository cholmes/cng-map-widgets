// The layer panel's loader: the seam a bundled host uses to hand in its own
// copy of maplibre-gl-layer-control. AGENTS.md names it; nothing exercised it.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_CONTROL_VERSION,
  LAYER_CONTROL_CDN,
  loadLayerControl,
  setLayerControlModules,
  clearLayerControlModules,
  ensureLayerControlCss,
} from '../src/layer-control-loader.js';

afterEach(() => clearLayerControlModules());

test('the panel is pinned to one exact version, script and stylesheet alike', () => {
  assert.match(LAYER_CONTROL_VERSION, /^\d+\.\d+\.\d+$/);
  for (const url of [LAYER_CONTROL_CDN.js, LAYER_CONTROL_CDN.css]) {
    assert.ok(url.includes(`maplibre-gl-layer-control@${LAYER_CONTROL_VERSION}/`), url);
  }
});

test('an injected module is what loadLayerControl() gives, with no fetch', async () => {
  class LayerControl {}
  const mine = { LayerControl };
  setLayerControlModules(mine);
  assert.equal(await loadLayerControl(), mine);
  assert.equal(await loadLayerControl(), mine);
});

test('a host that injected the panel loads its stylesheet itself: none is added', () => {
  const added = [];
  const doc = {
    getElementById: () => null,
    createElement: (tag) => ({ tag }),
    head: { appendChild: (node) => added.push(node) },
  };
  setLayerControlModules({ LayerControl: class {} });
  ensureLayerControlCss(doc);
  assert.equal(added.length, 0);

  clearLayerControlModules();
  ensureLayerControlCss(doc);
  assert.equal(added.length, 1);
  assert.equal(added[0].href, LAYER_CONTROL_CDN.css);
  assert.equal(added[0].rel, 'stylesheet');
});

test('the stylesheet is added once', () => {
  const added = [];
  const doc = {
    getElementById: (id) => added.find((n) => n.id === id) ?? null,
    createElement: () => ({}),
    head: { appendChild: (node) => added.push(node) },
  };
  ensureLayerControlCss(doc);
  ensureLayerControlCss(doc);
  assert.equal(added.length, 1);
});
