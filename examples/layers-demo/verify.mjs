#!/usr/bin/env node
// Drives examples/layers-demo with Playwright against LIVE data: a styled
// PMTiles collection (Jamaica's parishes), an OpenAerialMap COG and an inline
// GeoJSON polygon, all over Jamaica, in one LayerManager with a LayerControl.
//
// This is the test of everything in @cngeo/maplibre's layer code that needs a
// real map: that layers draw, that the panel drives the manager and the
// manager drives the map, that order holds for a raster among vector layers,
// that the panel is themed and keyboard-operable, and that nothing is left
// behind. Requires network access and serve.py on the given port.
//
// Usage: python3 serve.py 8123 &  node examples/layers-demo/verify.mjs 8123

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8123';
const url = `http://localhost:${port}/examples/layers-demo/index.html?verify=1`;
const EXTRA_TIF = 'https://oin-hotosm-temp.s3.us-east-1.amazonaws.com/691e7375628460062aec8bca/0/691e7375628460062aec8bcb.tif';

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
function check(n, name, ok, detail) {
  results.push({ n, name, ok });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}. ${name} — ${detail}`);
}

async function open(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, ...options });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => /^(ready|error):/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 120_000 });
  return { page, errors, status: await page.textContent('#status') };
}

const { page, errors, status } = await open();
if (!status.startsWith('ready:')) {
  console.error('The demo did not become ready:', status, errors);
  await browser.close();
  process.exit(1);
}

const state = () => page.evaluate(() => window.DEMO.snapshot());
const row = (id) => page.locator(`.layer-control-item[data-layer-id="${id}"]`);
const rowIds = () => page.evaluate(() => [...document.querySelectorAll('.layer-control-item[data-layer-id]')].map((el) => el.dataset.layerId));
const settle = () => page.evaluate(() => window.DEMO.settle());
const ids = await page.evaluate(() => window.DEMO.ids);

// 1. Three layers, ready.
{
  const s = await state();
  check(1, 'three layers load and report ready', status === 'ready: 3 layers' && JSON.stringify(s.list.map((e) => e.kind)) === '["cog","pmtiles-vector","geojson"]' && s.list.every((e) => e.status === 'ready'),
    `${status}; ${s.list.map((e) => `${e.kind}=${e.status}`).join(', ')}`);
}

// 2. The PMTiles collection drew with its PUBLISHED style.
{
  const out = await page.evaluate(async () => {
    const D = window.DEMO;
    const entry = D.manager.get(D.ids.parishes);
    const style = await fetch(entry.spec.source.style.url).then((r) => r.json());
    const want = style.layers.filter((l) => l.type !== 'background').map((l) => `cng-layer-${D.slug(D.ids.parishes)}--${l.id}`);
    const have = D.map.getStyle().layers.map((l) => l.id);
    await D.settle();
    // Layers existing is not tiles drawing: count what is actually on screen.
    return { want, missing: want.filter((id) => !have.includes(id)), note: entry.note ?? null, features: D.renderedFeatures(D.ids.parishes) };
  });
  check(2, 'the vector collection is drawn with its published style', out.want.length > 0 && out.missing.length === 0 && out.note === null && out.features > 0,
    `${out.want.length} style layers expected, ${out.missing.length} missing; ${out.features} features rendered from its tiles; note: ${out.note}`);
}

// 3. One row per LayerSpec, top-first, plus the basemap.
{
  const rows = await rowIds();
  const want = [ids.aoi, ids.parishes, ids.imagery, 'Background'];
  const names = await page.evaluate(() => [...document.querySelectorAll('.layer-control-item[data-layer-id] .layer-control-checkbox')].map((el) => el.getAttribute('aria-label')));
  check(3, 'the panel lists one named row per layer, top first', JSON.stringify(rows) === JSON.stringify(want) && names.every(Boolean),
    `rows ${JSON.stringify(rows)}; checkbox names ${JSON.stringify(names)}`);
}

// 4. A row's checkbox hides its layer: state and pixels.
{
  const before = await page.evaluate(async () => { await window.DEMO.settle(); return window.DEMO.grab(window.DEMO.bbox.imagery); });
  await row(ids.imagery).locator('.layer-control-checkbox').click();
  await settle();
  const hidden = await page.evaluate(() => window.DEMO.grab(window.DEMO.bbox.imagery));
  const visible = (await state()).list.find((e) => e.id === ids.imagery).visible;
  await row(ids.imagery).locator('.layer-control-checkbox').click();
  await settle();
  const again = await page.evaluate(() => window.DEMO.grab(window.DEMO.bbox.imagery));
  const changed = diff(before, hidden);
  check(4, 'a checkbox hides and shows its layer', visible === false && changed > 0.3 && diff(before, again) < 0.02,
    `manager says visible=${visible}; ${(changed * 100).toFixed(1)}% of pixels change when hidden; ${(diff(before, again) * 100).toFixed(1)}% differ after showing again`);
}

// 5. Opacity from the panel reaches both kinds of layer.
{
  const setSlider = (id, value) => row(id).locator('.layer-control-opacity').evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  const base = await page.evaluate(() => window.DEMO.fillOpacity(window.DEMO.ids.parishes));
  await setSlider(ids.imagery, 0.4);
  await setSlider(ids.parishes, 0.5);
  await settle();
  const s = await state();
  const imagerySlug = await page.evaluate(() => window.DEMO.slug(window.DEMO.ids.imagery));
  const deck = s.deck.find((l) => l.id === `cng-layer-${imagerySlug}`);
  const scaled = await page.evaluate(() => window.DEMO.fillOpacity(window.DEMO.ids.parishes));
  await setSlider(ids.imagery, 1);
  await setSlider(ids.parishes, 1);
  await settle();
  const restored = await page.evaluate(() => window.DEMO.fillOpacity(window.DEMO.ids.parishes));
  check(5, 'opacity reaches the raster and the vector layer', Math.abs(deck.opacity - 0.4) < 0.011 && JSON.stringify(scaled) !== JSON.stringify(base) && JSON.stringify(restored) === JSON.stringify(base),
    `deck layer opacity ${deck.opacity}; vector fill-opacity ${JSON.stringify(base)} -> ${JSON.stringify(scaled)} -> ${JSON.stringify(restored)}`);
}

// 6. Reordering a mixed stack: the map's draw order equals list(), and the panel follows. (Review Focus 4)
{
  const steps = [];
  for (const [label, toIndex] of [['raster on top', 2], ['raster between the two vector layers', 1], ['raster at the bottom', 0]]) {
    await page.evaluate(([id, i]) => window.DEMO.manager.move(id, i), [ids.imagery, toIndex]);
    await settle();
    const s = await state();
    const rows = await rowIds();
    const panelOk = JSON.stringify(rows.filter((r) => r !== 'Background')) === JSON.stringify([...s.list.map((e) => e.id)].reverse());
    steps.push({ label, ok: s.orderMatches && panelOk, why: s.orderWhy, panelOk });
  }
  check(6, 'after every move the map order equals list(), and the panel follows', steps.every((x) => x.ok),
    steps.map((x) => `${x.label}: map=${x.ok ? 'ok' : x.why}, panel=${x.panelOk}`).join('; '));
}

// 7. Add by URL, then remove from the panel's menu.
{
  await page.fill('#addUrl', EXTRA_TIF);
  await page.press('#addUrl', 'Enter');
  await page.waitForFunction(() => window.DEMO.manager.list().length === 4 && window.DEMO.manager.list().every((e) => e.status === 'ready'), undefined, { timeout: 60_000 });
  const added = (await state()).list.at(-1);
  // The panel hears of the layer through its adapter and adds the row a moment later.
  const hasRow = await row(added.id).waitFor({ timeout: 5000 }).then(() => 1, () => 0);
  await row(added.id).locator('.layer-control-row').click({ button: 'right' });
  await page.locator('.layer-control-context-menu .context-menu-item', { hasText: /remove/i }).click();
  const confirm = page.locator('.layer-control-remove-confirm-btn-confirm');
  if (await confirm.count()) await confirm.first().click();
  await page.waitForFunction(() => window.DEMO.manager.list().length === 3, undefined, { timeout: 10_000 }).catch(() => {});
  const after = await state();
  check(7, 'a pasted .tif URL adds a layer and a row; the panel menu removes both', added.kind === 'cog' && hasRow === 1 && after.list.length === 3 && (await row(added.id).count()) === 0,
    `added ${added.kind} "${added.title}", row present=${hasRow === 1}; after remove: ${after.list.length} layers`);
}

// 8. Keyboard only.
{
  const checkbox = row(ids.aoi).locator('.layer-control-checkbox');
  await checkbox.focus();
  await page.keyboard.press('Space');
  const toggled = (await state()).list.find((e) => e.id === ids.aoi).visible === false;
  await page.keyboard.press('Space');

  const orderBefore = (await state()).list.map((e) => e.id);
  await row(ids.aoi).locator('.layer-control-checkbox').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await settle();
  const orderAfter = (await state()).list.map((e) => e.id);
  const moved = orderBefore.indexOf(ids.aoi) - orderAfter.indexOf(ids.aoi) === 1;
  const focusKept = await page.evaluate((id) => document.activeElement?.closest('.layer-control-item')?.dataset.layerId === id, ids.aoi);

  // Open the menu from the keyboard; an item must take focus.
  await row(ids.aoi).locator('.layer-control-checkbox').focus();
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(250);
  const menu = await page.evaluate(() => {
    const m = document.querySelector('.layer-control-context-menu');
    const a = document.activeElement;
    return { open: Boolean(m && m.style.display !== 'none'), role: m?.getAttribute('role'), focusedRole: a?.getAttribute('role'), focusedText: a?.textContent?.trim() };
  });
  // Arrow to "Move to Top" and activate it with Enter.
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    reached = await page.evaluate(() => /move to top/i.test(document.activeElement?.textContent ?? ''));
    if (!reached) await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  await settle();
  const onTop = (await state()).list.at(-1).id === ids.aoi;

  // Escape closes the menu and returns focus to the row.
  await row(ids.aoi).locator('.layer-control-checkbox').focus();
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  const closed = await page.evaluate((id) => ({
    hidden: document.querySelector('.layer-control-context-menu')?.style.display === 'none',
    focusBack: document.activeElement?.closest('.layer-control-item')?.dataset.layerId === id,
  }), ids.aoi);

  check(8, 'keyboard: toggle, reorder, and operate the menu', toggled && moved && focusKept && menu.open && menu.role === 'menu' && menu.focusedRole === 'menuitem' && reached && onTop && closed.hidden && closed.focusBack,
    `Space toggles=${toggled}; Alt+ArrowDown moves=${moved}, focus kept=${focusKept}; menu opens=${menu.open} role=${menu.role}, focused item role=${menu.focusedRole} ("${menu.focusedText}"); reached "Move to Top"=${reached}, Enter moved it to the top=${onTop}; Escape closes=${closed.hidden}, focus returns=${closed.focusBack}`);
}

// 9. Dark mode.
{
  const light = await page.evaluate(() => getComputedStyle(document.querySelector('.layer-control-panel')).backgroundColor);
  const dark = await open({ colorScheme: 'dark' });
  const darkBg = dark.status.startsWith('ready:') ? await dark.page.evaluate(() => getComputedStyle(document.querySelector('.layer-control-panel')).backgroundColor) : dark.status;
  await dark.page.close();
  check(9, 'the panel follows the --cng-* tokens into dark mode', light === 'rgb(255, 255, 255)' && darkBg === 'rgb(30, 31, 34)', `light ${light}; dark ${darkBg}`);
}

// 10. Replacing the basemap style puts the stack back. (Review Focus 5)
{
  const before = await state();
  await page.evaluate(async () => {
    const D = window.DEMO;
    D.map.setStyle(D.styleUrl, { diff: false });
    await new Promise((resolve) => D.map.once('style.load', resolve));
    await D.manager.settled();
    await D.settle();
  });
  const after = await state();
  const same = JSON.stringify(after.list.map((e) => [e.id, e.status, e.visible, e.opacity])) === JSON.stringify(before.list.map((e) => [e.id, e.status, e.visible, e.opacity]));
  check(10, 'after map.setStyle() the stack is back in the same order and state', same && after.orderMatches && after.ours.length === before.ours.length,
    `list unchanged=${same}; map order ${after.orderMatches ? 'ok' : after.orderWhy}; ${after.ours.length} of ${before.ours.length} style layers restored`);
}

// 11. Removal leaves nothing behind.
{
  const left = await page.evaluate(() => {
    const D = window.DEMO;
    D.map.removeControl(D.control);
    D.manager.destroy();
    const style = D.map.getStyle();
    return {
      layers: style.layers.map((l) => l.id).filter((id) => id.startsWith('cng-layer-')),
      sources: Object.keys(style.sources).filter((id) => id.startsWith('cng-layer-')),
      panel: document.querySelectorAll('.layer-control-panel, .cng-layer-control, .layer-control-context-menu').length,
    };
  });
  check(11, 'removing the control and destroying the manager leaves nothing behind', left.layers.length === 0 && left.sources.length === 0 && left.panel === 0,
    `${left.layers.length} layers, ${left.sources.length} sources, ${left.panel} panel elements left`);
}

check(12, 'no console errors', errors.length === 0, errors.length ? errors.join(' | ') : 'none');

await page.close();
await browser.close();

console.log('\n=== layers-demo ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}. ${r.name}`);
if (failed) {
  console.error('\nlayers-demo: FAILED');
  process.exit(1);
}
console.log('\nlayers-demo: all checks passed.');
