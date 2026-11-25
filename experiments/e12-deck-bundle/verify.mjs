#!/usr/bin/env node
// E12 Gate A: does ONE prebuilt deck.gl + deck.gl-raster module, loaded by a
// page with no build step, draw real imagery interleaved into MapLibre?
//
// Drives experiments/e12-deck-bundle/index.html with Playwright against LIVE
// data: a Sentinel-2 TCI, a NAIP quad and an OpenAerialMap scene (all 8-bit
// COGs in UTM, read straight from object storage), plus a FIRMS PMTiles
// chunk through deck.gl's MVTLayer. Requires network and serve.py.
//
// Usage: python3 serve.py 8123 &  node experiments/e12-deck-bundle/verify.mjs 8123
//
// A layer "draws" when hiding it changes the pixels inside its own bounds.
// That is a stronger claim than "no error" -- deck.gl-raster's known failure
// modes (a renamed prop, a second copy of luma.gl) are silent blank layers.

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8123';
const base = `http://localhost:${port}/experiments/e12-deck-bundle/index.html`;
const READY_TIMEOUT = 90_000;
/** Share of sampled pixels that must change when a layer is hidden. */
const DRAWS = 0.05;

/** Fraction of 64x64 RGBA pixels differing by more than `tol` in any channel. */
function diff(a, b, tol = 12) {
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol || Math.abs(a[i + 2] - b[i + 2]) > tol) changed++;
  }
  return changed / (a.length / 4);
}

const browser = await chromium.launch();
const results = [];
let failed = false;

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  const started = Date.now();
  await page.goto(`${base}?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => /^(ready|error):/.test(document.getElementById('status')?.textContent ?? ''), undefined, {
    timeout: READY_TIMEOUT,
  });
  const status = await page.textContent('#status');
  return { page, errors, status, ms: Date.now() - started };
}

/** Sample a layer's own screen area with it visible, then hidden. */
async function visibilityDiff(page, key) {
  return page.evaluate(async (k) => {
    const rect = window.E12.screenRect(window.E12.boundsOf(k));
    await window.E12.setVisible(true);
    const shown = window.E12.grab(rect);
    await window.E12.setVisible(false);
    const hidden = window.E12.grab(rect);
    await window.E12.setVisible(true);
    return { shown, hidden, rect };
  }, key);
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// --- 1. Each layer draws ----------------------------------------------------
for (const key of ['s2', 'naip', 'oam', 'mvt']) {
  const { page, errors, status, ms } = await open(`case=${key}`);
  if (!status.startsWith('ready:')) {
    record(key, false, `${status} (${ms} ms) console: ${errors.join(' | ')}`);
    await page.close();
    continue;
  }
  const { shown, hidden } = await visibilityDiff(page, key);
  const changed = diff(shown, hidden);
  if (key === 's2') {
    const info = await page.evaluate(() => ({ versions: window.E12.VERSIONS, support: window.E12.support, interleaved: window.E12.interleaved }));
    console.log('      bundle versions:', JSON.stringify(info.versions));
    console.log('      deckSupport():', JSON.stringify(info.support), 'interleaved:', info.interleaved);
  }
  record(key, changed > DRAWS && errors.length === 0, `ready in ${ms} ms, ${(changed * 100).toFixed(1)}% of pixels change when hidden, ${errors.length} console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();
}

// --- 2. The bundle served from ANOTHER origin (Review Focus 4) --------------
// The page is on localhost; the bundle comes from 127.0.0.1. A decode worker
// started with `new Worker(<cross-origin url>)` would be refused; the bundle
// starts it from a Blob URL instead.
{
  const bundle = `http://127.0.0.1:${port}/packages/maplibre/vendor/deck-stack.js`;
  const { page, errors, status, ms } = await open(`case=naip&bundle=${encodeURIComponent(bundle)}`);
  let detail = `${status} (${ms} ms)`;
  let ok = status.startsWith('ready:') && errors.length === 0;
  if (ok) {
    const { shown, hidden } = await visibilityDiff(page, 'naip');
    const changed = diff(shown, hidden);
    const usedBundle = await page.evaluate(() => window.E12.bundleUrl);
    ok = changed > DRAWS && usedBundle === bundle;
    detail = `ready in ${ms} ms from ${new URL(usedBundle).origin}, ${(changed * 100).toFixed(1)}% of pixels change`;
  } else if (errors.length) detail += ` console: ${errors.join(' | ')}`;
  record('cross-origin bundle', ok, detail);
  await page.close();
}

// --- 3. One overlay, a raster and vector tiles, and reordering --------------
// Interleaved only. Overlaid mode (`?interleaved=false`) draws on deck.gl's
// own canvas above the map, which `grab()` -- reading MapLibre's canvas --
// cannot see, and which cannot slot a raster under the labels at all. It is
// the fallback the page still supports by hand, not something to gate on.
for (const mode of ['true']) {
  const label = `stack (interleaved=${mode})`;
  const { page, errors, status, ms } = await open(`case=stack&interleaved=${mode}`);
  if (!status.startsWith('ready:')) {
    record(label, false, `${status} (${ms} ms) console: ${errors.join(' | ')}`);
    await page.close();
    continue;
  }
  const out = await page.evaluate(async () => {
    const E = window.E12;
    const rect = E.screenRect(E.boundsOf('s2'));
    const symbol = E.firstSymbolLayer();

    await E.setVisible(false);
    const hidden = E.grab(rect);
    await E.setVisible(true);

    await E.moveBefore(undefined); // raster above everything, labels covered
    const onTop = E.grab(rect);
    await E.moveBefore(symbol); // raster under the labels
    const underLabels = E.grab(rect);

    // No blank frame while re-slotting: sample every frame for ~600 ms.
    E.moveBeforeNow(undefined);
    const during = [];
    const until = performance.now() + 600;
    while (performance.now() < until) {
      await new Promise((r) => requestAnimationFrame(r));
      during.push(E.grab(rect));
    }
    return { hidden, onTop, underLabels, during, symbol };
  });
  const reorder = diff(out.onTop, out.underLabels);
  const stillDrawn = out.during.map((frame) => diff(frame, out.hidden));
  const worst = Math.min(...stillDrawn);
  const drawsOnTop = diff(out.onTop, out.hidden);
  const ok = drawsOnTop > DRAWS && worst > DRAWS && errors.length === 0 && (mode === 'false' || reorder > 0.002);
  record(
    label,
    ok,
    `ready in ${ms} ms; raster draws (${(drawsOnTop * 100).toFixed(1)}%); moving it under "${out.symbol}" changes ${(reorder * 100).toFixed(2)}% of pixels; ` +
      `${out.during.length} frames sampled during a re-slot, least-drawn frame still ${(worst * 100).toFixed(1)}% different from hidden; ${errors.length} console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`,
  );
  await page.close();
}

await browser.close();

console.log('\n=== E12 Gate A ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
if (failed) {
  console.error('\nGate A: FAILED');
  process.exit(1);
}
console.log('\nGate A: all checks passed.');
