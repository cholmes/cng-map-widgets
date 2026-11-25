#!/usr/bin/env node
// E12 Gate B: is opengeos' maplibre-gl-layer-control@0.18.3 a fit for the
// @cngeo layer manager? Seven requirements, one check each, against
// experiments/e12-deck-bundle/layer-control.html. Adopt only if all pass.
//
// Usage: python3 serve.py 8123 &  node experiments/e12-deck-bundle/layer-control.verify.mjs 8123
//
// This script REPORTS a verdict; it exits 0 whichever way the verdict goes,
// and non-zero only if the evaluation itself could not run.

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8123';
const url = `http://localhost:${port}/experiments/e12-deck-bundle/layer-control.html`;

function diff(a, b, tol = 12) {
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol || Math.abs(a[i + 2] - b[i + 2]) > tol) changed++;
  }
  return changed / (a.length / 4);
}

const browser = await chromium.launch();
const rows = [];
const row = (n, requirement, pass, evidence) => {
  rows.push({ n, requirement, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}. ${requirement} — ${evidence}`);
};

async function open(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, ...options });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => /^(ready|error):/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 90_000 });
  return { page, errors, status: await page.textContent('#status') };
}

const { page, errors, status } = await open();
if (!status.startsWith('ready:')) {
  console.error('The evaluation page did not load:', status, errors);
  await browser.close();
  process.exit(2);
}
const item = (id) => page.locator(`.layer-control-item[data-layer-id="${id}"]`);

// 1. No build, no import-map entries of its own.
row(1, 'Loads with no build and no import-map entries', errors.length === 0, `page ready, ${errors.length} console errors; module has no bare imports`);

// 2. Add and remove at runtime, both kinds, without recreating the control.
{
  await page.evaluate(() => {
    window.GB.addCog('naip2');
    window.GB.map.addSource('user-line', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-122.44, 37.75], [-122.36, 37.81]] } } });
    window.GB.map.addLayer({ id: 'user-line', type: 'line', source: 'user-line', paint: { 'line-color': '#c23b22', 'line-width': 3 } });
  });
  const added = await Promise.all([item('cog-naip2').waitFor({ timeout: 5000 }).then(() => true, () => false), item('user-line').waitFor({ timeout: 5000 }).then(() => true, () => false)]);
  await page.evaluate(() => { window.GB.removeCog('naip2'); window.GB.map.removeLayer('user-line'); });
  const removed = await Promise.all([item('cog-naip2').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false), item('user-line').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false)]);
  row(2, 'Add and remove a layer at runtime', added.every(Boolean) && removed.every(Boolean), `deck layer row added=${added[0]} removed=${removed[0]}; style layer row added=${added[1]} removed=${removed[1]}`);
}

// 3. deck.gl layers: the checkbox really hides the raster.
{
  const before = await page.evaluate(async () => { await window.GB.settle(); return window.GB.grab(window.GB.COGS.naip.bounds); });
  await item('cog-naip').locator('.layer-control-checkbox').click();
  const after = await page.evaluate(async () => { await window.GB.settle(); return window.GB.grab(window.GB.COGS.naip.bounds); });
  const state = await page.evaluate(() => window.GB.deckState.get('cog-naip').visible);
  await item('cog-naip').locator('.layer-control-checkbox').click();
  await page.evaluate(() => window.GB.settle());
  const changed = diff(before, after);
  row(3, 'deck.gl layers toggle', state === false && changed > 0.05, `adapter.setVisibility(false) called; ${(changed * 100).toFixed(1)}% of the raster's pixels change`);
}

// 4. Opacity for both kinds.
{
  const setSlider = (id, value) => item(id).locator('.layer-control-opacity').evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await setSlider('cog-naip', 0.3);
  await setSlider('user-poly', 0.2);
  const got = await page.evaluate(() => ({ deck: window.GB.deckState.get('cog-naip').opacity, style: window.GB.map.getPaintProperty('user-poly', 'fill-opacity') }));
  await setSlider('cog-naip', 1);
  row(4, 'Opacity for both kinds', Math.abs(got.deck - 0.3) < 0.011 && Math.abs(got.style - 0.2) < 0.011, `deck layer opacity -> ${got.deck}; style layer fill-opacity -> ${got.style}`);
}

// 5. Reorder: a drag is reported to the host with the new order.
{
  const order = () => page.evaluate(() => [...document.querySelectorAll('.layer-control-item')].map((el) => el.dataset.layerId));
  const before = await order();
  const from = item('user-poly').locator('.layer-control-drag-handle');
  const to = item('cog-naip').locator('.layer-control-row');
  let dragError = null;
  try {
    await from.dragTo(to, { targetPosition: { x: 40, y: 3 }, timeout: 8000 });
  } catch (err) {
    dragError = err.message.split('\n')[0];
  }
  await page.waitForTimeout(400);
  const after = await order();
  const reported = await page.evaluate(() => window.GB.log.reorder);
  const moved = JSON.stringify(before) !== JSON.stringify(after);
  const mapOrder = await page.evaluate(() => window.GB.map.getStyle().layers.map((l) => l.id).filter((id) => id === 'user-poly' || id.startsWith('cog-')));
  row(5, 'Reorder, reported to the host', moved && reported.length > 0, `list ${JSON.stringify(before)} -> ${JSON.stringify(after)}; onLayerReorder fired ${reported.length}x${reported.length ? ` with ${JSON.stringify(reported.at(-1))}` : ''}; deck layers are not in the style (style order: ${JSON.stringify(mapOrder)}), so the host must apply beforeId itself${dragError ? `; drag error: ${dragError}` : ''}`);
}

// 6. Theming: CSS custom properties we can redeclare, and dark mode.
{
  const css = await (await fetch('https://cdn.jsdelivr.net/npm/maplibre-gl-layer-control@0.18.3/dist/maplibre-gl-layer-control.css')).text();
  const customProps = (css.match(/var\(--/g) ?? []).length;
  const darkRules = (css.match(/prefers-color-scheme/g) ?? []).length;
  const light = await page.evaluate(() => getComputedStyle(document.querySelector('.layer-control-panel')).backgroundColor);
  const dark = await open({ colorScheme: 'dark' });
  const darkBg = await dark.page.evaluate(() => getComputedStyle(document.querySelector('.layer-control-panel')).backgroundColor);
  await dark.page.close();
  row(6, 'Theming with CSS variables, and dark mode', customProps > 0 && light !== darkBg, `${customProps} uses of CSS custom properties in its stylesheet; ${darkRules} prefers-color-scheme rules; panel background light=${light} dark=${darkBg}`);
}

// 7. Keyboard: every action reachable, controls named.
{
  const info = await page.evaluate(() => {
    const panel = document.querySelector('.layer-control-panel');
    const r = panel.querySelector('.layer-control-item[data-layer-id="user-poly"]');
    const handle = r.querySelector('.layer-control-drag-handle');
    const checkbox = r.querySelector('.layer-control-checkbox');
    const slider = r.querySelector('.layer-control-opacity');
    const named = (el) => Boolean(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label'));
    return { handleFocusable: handle.tabIndex >= 0, handleRole: handle.getAttribute('role'), checkboxNamed: named(checkbox), sliderNamed: named(slider), rowFocusable: r.tabIndex >= 0 };
  });
  // Toggle by keyboard.
  const checkbox = item('user-poly').locator('.layer-control-checkbox');
  await checkbox.focus();
  const visBefore = await page.evaluate(() => window.GB.map.getLayoutProperty('user-poly', 'visibility') ?? 'visible');
  await page.keyboard.press('Space');
  const visAfter = await page.evaluate(() => window.GB.map.getLayoutProperty('user-poly', 'visibility') ?? 'visible');
  await page.keyboard.press('Space');
  // Opacity by keyboard.
  const slider = item('user-poly').locator('.layer-control-opacity');
  await slider.focus();
  const opBefore = await page.evaluate(() => window.GB.map.getPaintProperty('user-poly', 'fill-opacity'));
  await page.keyboard.press('ArrowRight');
  const opAfter = await page.evaluate(() => window.GB.map.getPaintProperty('user-poly', 'fill-opacity'));
  // Remove / move by keyboard: the context menu is the only route. Can the keyboard open it?
  await checkbox.focus();
  await page.keyboard.press('ContextMenu');
  await page.waitForTimeout(300);
  let menu = await page.locator('.layer-control-context-menu').isVisible().catch(() => false);
  if (!menu) {
    await page.keyboard.press('Shift+F10');
    await page.waitForTimeout(300);
    menu = await page.locator('.layer-control-context-menu').isVisible().catch(() => false);
  }
  const toggleOk = visBefore !== visAfter;
  const opacityOk = opBefore !== opAfter;
  const pass = toggleOk && opacityOk && info.handleFocusable && menu && info.checkboxNamed && info.sliderNamed;
  row(7, 'Keyboard access to every action', pass, `Space toggles=${toggleOk}; arrow changes opacity=${opacityOk}; drag handle focusable=${info.handleFocusable} (role=${info.handleRole}); context menu (remove, move) opens from the keyboard=${menu}; checkbox has an accessible name=${info.checkboxNamed}; slider has one=${info.sliderNamed}`);
}

await page.close();
await browser.close();

const failed = rows.filter((r) => !r.pass);
console.log('\n=== E12 Gate B ===');
for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}. ${r.requirement}`);
console.log(`\nVerdict: ${failed.length === 0 ? 'ADOPT' : `BUILD OWN (${failed.length} of ${rows.length} requirements not met: ${failed.map((r) => r.n).join(', ')})`}`);
