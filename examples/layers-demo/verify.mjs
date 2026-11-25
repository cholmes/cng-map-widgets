#!/usr/bin/env node
// Drives examples/layers-demo with Playwright against LIVE data: a styled
// PMTiles collection (Jamaica's parishes), an OpenAerialMap COG and an inline
// GeoJSON polygon, all over Jamaica, in one LayerManager with a LayerControl.
//
// This is the test of everything in @cngeo/maplibre's layer code that needs a
// real map: that layers draw, that the panel drives the manager and the
// manager drives the map, that order holds for a raster among vector layers,
// that failures are reported, that credit is shown, that the panel is themed
// and keyboard-operable, and that nothing is left behind. Requires network
// access and serve.py on the given port.
//
// Usage: python3 serve.py 8123 &  node examples/layers-demo/verify.mjs 8123
//
// Each check tries to look at the MAP, not at what the library believes about
// the map: pixels, MapLibre's own layer order (`getLayersOrder()`, which
// includes deck.gl's custom layers), paint and layout properties as the map
// holds them. Two earlier versions of checks here passed while the thing they
// named was broken; the comments on checks 2 and 6 say how.

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8123';
const url = `http://localhost:${port}/examples/layers-demo/index.html?verify=1`;
// A second 8-bit RGB scene, to add by URL.
const EXTRA_TIF = 'https://oin-hotosm-temp.s3.us-east-1.amazonaws.com/691e7375628460062aec8bca/0/691e7375628460062aec8bcb.tif';
// A real COG that deck.gl-raster cannot draw with its default pipeline:
// single-band Float32. It must end up an ERROR, not a silent "ready".
const UNDRAWABLE_TIF = 'https://storage.googleapis.com/carto-open-catalogs/worldpop-jamaica/main/children-5-9/children-5-9.tif';

function diff(a, b, tol = 12) {
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol || Math.abs(a[i + 2] - b[i + 2]) > tol) changed++;
  }
  return changed / (a.length / 4);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const browser = await chromium.launch();
const results = [];
let failed = false;
function check(name, ok, detail) {
  const n = results.length + 1;
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
const grab = (which) => page.evaluate((w) => window.DEMO.grab(window.DEMO.bbox[w]), which);
const ids = await page.evaluate(() => window.DEMO.ids);
/** The panel's rows for our layers must be exactly list(), top-first: one row per LayerSpec. */
const rowsMatchList = async () => {
  const rows = (await rowIds()).filter((r) => r !== 'Background');
  const list = (await state()).list.map((e) => e.id).reverse();
  return { ok: same(rows, list), rows, list };
};
const setSlider = (id, value) => row(id).locator('.layer-control-opacity').evaluate((el, v) => {
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, value);

// --- Three layers, ready -------------------------------------------------------
{
  const s = await state();
  check('three layers load and report ready', status === 'ready: 3 layers' && same(s.list.map((e) => e.kind), ['cog', 'pmtiles-vector', 'geojson']) && s.list.every((e) => e.status === 'ready'),
    `${status}; ${s.list.map((e) => `${e.kind}=${e.status}`).join(', ')}`);
}

// --- The PMTiles collection drew with its PUBLISHED style -----------------------
// "Its layers exist" is not "it drew": the first version of this check passed
// while every tile request was failing. It now counts features on screen.
{
  const out = await page.evaluate(async () => {
    const D = window.DEMO;
    const entry = D.manager.get(D.ids.parishes);
    const style = await fetch(entry.spec.source.style.url).then((r) => r.json());
    const want = style.layers.filter((l) => l.type !== 'background').map((l) => `cng-layer-${D.slug(D.ids.parishes)}--${l.id}`);
    const have = D.map.getStyle().layers.map((l) => l.id);
    await D.settle();
    return { want, missing: want.filter((id) => !have.includes(id)), note: entry.note ?? null, features: D.renderedFeatures(D.ids.parishes) };
  });
  check('the vector collection is drawn with its published style', out.want.length > 0 && out.missing.length === 0 && out.note === null && out.features > 0,
    `${out.want.length} style layers expected, ${out.missing.length} missing; ${out.features} features rendered from its tiles; note: ${out.note}`);
}

// --- One row per LayerSpec, top-first, plus the basemap -------------------------
{
  const rows = await rowIds();
  const names = await page.evaluate(() => [...document.querySelectorAll('.layer-control-item[data-layer-id] .layer-control-checkbox')].map((el) => el.getAttribute('aria-label')));
  check('the panel lists one named row per layer, top first', same(rows, [ids.aoi, ids.parishes, ids.imagery, 'Background']) && names.every(Boolean),
    `rows ${JSON.stringify(rows)}; ${names.filter(Boolean).length} of ${names.length} checkboxes named`);
}

// --- A row's checkbox hides its layer: state and pixels, raster and vector -------
{
  await settle();
  const out = {};
  for (const which of ['imagery', 'aoi']) {
    // Sample where this layer is the only thing changing: the raster's own
    // footprint for the image; the box's margin outside the image for the box.
    const area = which;
    const before = await page.evaluate((w) => window.DEMO.grabFor(w), area);
    await row(ids[which]).locator('.layer-control-checkbox').click();
    await settle();
    const hidden = await page.evaluate((w) => window.DEMO.grabFor(w), area);
    const visible = (await state()).list.find((e) => e.id === ids[which]).visible;
    const onMap = which === 'aoi' ? await page.evaluate((id) => window.DEMO.visibilityOnMap(id), ids.aoi) : null;
    await row(ids[which]).locator('.layer-control-checkbox').click();
    await settle();
    const again = await page.evaluate((w) => window.DEMO.grabFor(w), area);
    out[which] = { visible, changed: diff(before, hidden), back: diff(before, again), onMap };
  }
  const ok = out.imagery.visible === false && out.imagery.changed > 0.3 && out.imagery.back < 0.02
    && out.aoi.visible === false && out.aoi.changed > 0.3 && out.aoi.back < 0.02 && out.aoi.onMap.every((v) => v === 'none');
  check('a checkbox hides and shows its layer, raster and vector', ok,
    `raster: ${(out.imagery.changed * 100).toFixed(0)}% of pixels change, ${(out.imagery.back * 100).toFixed(1)}% differ once shown again; ` +
    `vector: ${(out.aoi.changed * 100).toFixed(0)}% change, ${(out.aoi.back * 100).toFixed(1)}% after; its map layers while hidden: ${JSON.stringify(out.aoi.onMap)}`);
}

// --- Opacity from the panel reaches both kinds of layer, in pixels ---------------
{
  await settle();
  const base = await page.evaluate(() => window.DEMO.fillOpacity(window.DEMO.ids.parishes));
  const full = await page.evaluate(() => window.DEMO.grabFor('imagery'));
  await setSlider(ids.imagery, 0.4);
  await setSlider(ids.parishes, 0.5);
  await settle();
  const faded = await page.evaluate(() => window.DEMO.grabFor('imagery'));
  const s = await state();
  const imagerySlug = await page.evaluate(() => window.DEMO.slug(window.DEMO.ids.imagery));
  const deck = s.deck.find((l) => l.id === `cng-layer-${imagerySlug}`);
  const scaled = await page.evaluate(() => window.DEMO.fillOpacity(window.DEMO.ids.parishes));
  await setSlider(ids.imagery, 1);
  await setSlider(ids.parishes, 1);
  await settle();
  const restored = await page.evaluate(() => window.DEMO.fillOpacity(window.DEMO.ids.parishes));
  const rasterChanged = diff(full, faded);
  check('opacity reaches the raster (in pixels) and the vector layer', Math.abs(deck.opacity - 0.4) < 0.011 && rasterChanged > 0.3 && !same(scaled, base) && same(restored, base),
    `raster: deck opacity ${deck.opacity}, ${(rasterChanged * 100).toFixed(0)}% of its pixels change; vector fill-opacity ${JSON.stringify(base)} -> ${JSON.stringify(scaled)} -> ${JSON.stringify(restored)}`);
}

// --- Reordering a mixed stack (Review Focus 4) ------------------------------------
// `snapshot().orderMatches` compares list() with MapLibre's own layer order,
// deck.gl's custom layers included. The first version read the raster's
// position from the manager, and could not have seen it in the wrong place.
{
  const steps = [];
  for (const [label, toIndex] of [['raster on top', 2], ['raster between the two vector layers', 1], ['raster at the bottom', 0]]) {
    await page.evaluate(([id, i]) => window.DEMO.manager.move(id, i), [ids.imagery, toIndex]);
    await settle();
    const s = await state();
    const panel = await rowsMatchList();
    steps.push({ label, ok: s.orderMatches && panel.ok, why: s.orderWhy, panelOk: panel.ok });
  }
  check("after every move MapLibre's real layer order equals list(), and the panel follows", steps.every((x) => x.ok),
    steps.map((x) => `${x.label}: map=${x.ok || x.panelOk === false ? (x.why || 'ok') : x.why}, panel=${x.panelOk}`).join('; '));
}

// --- Credit is displayed, and follows visibility -----------------------------------
{
  const out = await page.evaluate(async () => {
    const D = window.DEMO;
    await D.settle();
    const parishesCredit = D.manager.get(D.ids.parishes).attribution[0]?.text ?? null;
    const shown = D.credits();
    D.manager.setVisible(D.ids.imagery, false);
    await D.settle();
    const withoutImagery = D.credits();
    D.manager.setVisible(D.ids.imagery, true);
    await D.settle();
    return { parishesCredit, shown, withoutImagery, back: D.credits() };
  });
  const ok = Boolean(out.parishesCredit) && out.shown.includes(out.parishesCredit) && out.shown.includes('OpenAerialMap')
    && !out.withoutImagery.includes('OpenAerialMap') && out.back.includes('OpenAerialMap');
  check("each layer's credit is displayed while it is shown", ok,
    `vector credit "${out.parishesCredit}" shown=${out.shown.includes(out.parishesCredit ?? '\u0000')}; raster credit shown=${out.shown.includes('OpenAerialMap')}, gone when hidden=${!out.withoutImagery.includes('OpenAerialMap')}, back when shown=${out.back.includes('OpenAerialMap')}`);
}

// --- Add by URL; remove from the panel's menu; remove from code --------------------
{
  await page.fill('#addUrl', EXTRA_TIF);
  await page.press('#addUrl', 'Enter');
  await page.waitForFunction(() => window.DEMO.manager.list().length === 4 && window.DEMO.manager.list().every((e) => e.status === 'ready'), undefined, { timeout: 60_000 });
  const added = (await state()).list.at(-1);
  // The panel hears of the layer through its adapter and adds the row a moment later.
  const hasRow = await row(added.id).waitFor({ timeout: 5000 }).then(() => true, () => false);

  await row(added.id).locator('.layer-control-row').click({ button: 'right' });
  await page.locator('.layer-control-context-menu .context-menu-item', { hasText: /remove/i }).click();
  const confirm = page.locator('.layer-control-remove-confirm-btn-confirm');
  if (await confirm.count()) await confirm.first().click();
  await page.waitForFunction(() => window.DEMO.manager.list().length === 3, undefined, { timeout: 10_000 }).catch(() => {});
  await settle();
  const afterMenu = await rowsMatchList();

  // The same again, but removed by CODE. With the upstream panel as shipped,
  // this made every raw `cng-layer-*` style layer appear as its own row.
  await page.evaluate((u) => window.DEMO.addUrl(u), EXTRA_TIF);
  await row(added.id).waitFor({ timeout: 10_000 }).catch(() => {});
  await page.evaluate((id) => window.DEMO.manager.remove(id), added.id);
  await settle();
  await page.waitForTimeout(400); // the panel re-lists on a short timer
  const afterCode = await rowsMatchList();
  const rawRows = afterCode.rows.filter((r) => r.startsWith('cng-layer-'));

  check('a pasted .tif URL adds a layer and a row; removing it by menu or by code leaves one row per layer',
    added.kind === 'cog' && hasRow && afterMenu.ok && afterMenu.list.length === 3 && afterCode.ok && afterCode.list.length === 3 && rawRows.length === 0,
    `added ${added.kind}, row present=${hasRow}; after menu remove rows==list ${afterMenu.ok} (${afterMenu.rows.length} rows); after manager.remove() rows==list ${afterCode.ok}, ${rawRows.length} raw style-layer rows`);
}

// --- A file that cannot be drawn becomes an error, and says why --------------------
{
  await page.fill('#addUrl', UNDRAWABLE_TIF);
  await page.press('#addUrl', 'Enter');
  const reached = await page.waitForFunction(() => window.DEMO.manager.list().some((e) => e.status === 'error'), undefined, { timeout: 60_000 }).then(() => true, () => false);
  const s = await state();
  const bad = s.list.find((e) => e.status === 'error') ?? s.list.at(-1);
  const noteShown = reached ? await row(bad.id).locator('.cng-layer-note').textContent({ timeout: 5000 }).catch(() => null) : null;
  await page.evaluate((id) => window.DEMO.manager.remove(id), bad.id);
  await settle();
  check('a COG that cannot be drawn is reported as an error on its row, not left "ready"', reached && Boolean(bad.error) && Boolean(noteShown),
    `status=${bad.status}; error: ${bad.error}; shown on the row: ${noteShown ? 'yes' : 'no'}`);
}

// --- Keyboard only ------------------------------------------------------------------
{
  // Reach the row with Tab alone, starting from the panel's Add button.
  await page.locator('.cng-layer-add-btn').focus();
  let tabbed = false;
  for (let i = 0; i < 40 && !tabbed; i++) {
    await page.keyboard.press('Tab');
    tabbed = await page.evaluate((id) => document.activeElement?.classList.contains('layer-control-checkbox') && document.activeElement.closest('.layer-control-item')?.dataset.layerId === id, ids.aoi);
  }
  const focusRing = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return !s.outlineStyle.startsWith('none') && s.outlineWidth !== '0px'; });

  await page.keyboard.press('Space');
  const toggled = (await state()).list.find((e) => e.id === ids.aoi).visible === false;
  await page.keyboard.press('Space');

  const orderBefore = (await state()).list.map((e) => e.id);
  await page.keyboard.press('Alt+ArrowDown');
  await settle();
  const orderAfter = (await state()).list.map((e) => e.id);
  const moved = orderBefore.indexOf(ids.aoi) - orderAfter.indexOf(ids.aoi) === 1;
  const focusKept = await page.evaluate((id) => document.activeElement?.closest('.layer-control-item')?.dataset.layerId === id, ids.aoi);

  // Open the menu from the keyboard; an item must take focus.
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(250);
  const menu = await page.evaluate(() => {
    const m = document.querySelector('.layer-control-context-menu');
    const a = document.activeElement;
    return { open: Boolean(m && m.style.display !== 'none'), role: m?.getAttribute('role'), focusedRole: a?.getAttribute('role') };
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

  check('keyboard only: reach a row with Tab, toggle, reorder, and operate the menu',
    tabbed && focusRing && toggled && moved && focusKept && menu.open && menu.role === 'menu' && menu.focusedRole === 'menuitem' && reached && onTop && closed.hidden && closed.focusBack,
    `Tab reaches the row=${tabbed}, with a visible focus ring=${focusRing}; Space toggles=${toggled}; Alt+ArrowDown moves=${moved}, focus kept=${focusKept}; ` +
    `Shift+F10 opens the menu=${menu.open} (role=${menu.role}, focused item role=${menu.focusedRole}); arrow to "Move to Top"=${reached}, Enter applies it=${onTop}; Escape closes=${closed.hidden}, focus returns=${closed.focusBack}`);
}

// --- Dark mode ----------------------------------------------------------------------
{
  const light = await page.evaluate(() => getComputedStyle(document.querySelector('.layer-control-panel')).backgroundColor);
  const dark = await open({ colorScheme: 'dark' });
  const darkBg = dark.status.startsWith('ready:') ? await dark.page.evaluate(() => getComputedStyle(document.querySelector('.layer-control-panel')).backgroundColor) : dark.status;
  await dark.page.close();
  check('the panel follows the --cng-* tokens into dark mode', light === 'rgb(255, 255, 255)' && darkBg === 'rgb(30, 31, 34)', `light ${light}; dark ${darkBg}`);
}

// --- Replacing the basemap style puts the stack back (Review Focus 5) ----------------
// With NON-default state (a hidden layer, a faded one), checked on the map
// itself, for both the default call and `{ diff: false }`.
{
  await page.evaluate(() => {
    const D = window.DEMO;
    D.manager.setVisible(D.ids.aoi, false);
    D.manager.setOpacity(D.ids.parishes, 0.5);
  });
  await settle();
  const before = await state();
  const fadedBefore = await page.evaluate(() => window.DEMO.fillOpacity(window.DEMO.ids.parishes));
  const runs = [];
  for (const [label, options] of [['default', undefined], ['{ diff: false }', { diff: false }]]) {
    await page.evaluate(async (opts) => {
      const D = window.DEMO;
      const loaded = new Promise((resolve) => D.map.once('style.load', resolve));
      D.map.setStyle(D.styleUrl, opts);
      await loaded;
      await D.manager.settled();
      await D.settle();
    }, options);
    const after = await state();
    const out = await page.evaluate(() => ({
      aoi: window.DEMO.visibilityOnMap(window.DEMO.ids.aoi),
      faded: window.DEMO.fillOpacity(window.DEMO.ids.parishes),
      features: window.DEMO.renderedFeatures(window.DEMO.ids.parishes),
    }));
    const listSame = same(after.list.map((e) => [e.id, e.status, e.visible, e.opacity]), before.list.map((e) => [e.id, e.status, e.visible, e.opacity]));
    runs.push({
      label,
      ok: listSame && after.orderMatches && same(after.ours, before.ours) && out.aoi.length > 0 && out.aoi.every((v) => v === 'none') && same(out.faded, fadedBefore) && out.features > 0,
      detail: `list same=${listSame}, real order ${after.orderMatches ? 'ok' : after.orderWhy}, ${after.ours.length}/${before.ours.length} map layers back, hidden layer still hidden=${out.aoi.every((v) => v === 'none')}, faded layer still faded=${same(out.faded, fadedBefore)}, ${out.features} features drawn`,
    });
  }
  await page.evaluate(() => {
    const D = window.DEMO;
    D.manager.setVisible(D.ids.aoi, true);
    D.manager.setOpacity(D.ids.parishes, 1);
  });
  await settle();
  check('after map.setStyle() the stack is back in the same order and state, on the map', runs.every((r) => r.ok), runs.map((r) => `${r.label}: ${r.detail}`).join(' | '));
}

// --- Remove and re-add the control quickly: still one panel --------------------------
{
  const out = await page.evaluate(async () => {
    const D = window.DEMO;
    // What React's StrictMode does to an effect: mount, unmount, mount.
    D.map.removeControl(D.control);
    D.map.addControl(D.control, 'top-right');
    D.map.removeControl(D.control);
    D.map.addControl(D.control, 'top-right');
    await D.control.ready;
    await D.settle();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      panels: document.querySelectorAll('.layer-control-panel').length,
      rowsForAoi: document.querySelectorAll(`.layer-control-item[data-layer-id="${D.ids.aoi}"]`).length,
      addButtons: document.querySelectorAll('.cng-layer-add-btn').length,
    };
  });
  check('removing and re-adding the control twice in a row leaves exactly one panel', out.panels === 1 && out.rowsForAoi === 1 && out.addButtons === 1,
    `${out.panels} panel(s), ${out.rowsForAoi} row(s) for one layer, ${out.addButtons} Add button(s)`);
}

// --- Removal leaves nothing behind ----------------------------------------------------
{
  const left = await page.evaluate(() => {
    const D = window.DEMO;
    D.map.removeControl(D.control);
    D.manager.destroy();
    return {
      // MapLibre's real layer order: our style layers AND deck.gl's custom layers.
      layers: D.oursInRealOrder(),
      sources: Object.keys(D.map.getStyle().sources).filter((id) => id.startsWith('cng-layer-')),
      dom: document.querySelectorAll('.layer-control-panel, .cng-layer-control, .layer-control-context-menu, .cng-layer-attribution').length,
    };
  });
  check('removing the control and destroying the manager leaves nothing behind', left.layers.length === 0 && left.sources.length === 0 && left.dom === 0,
    `${left.layers.length} layers (deck.gl groups included), ${left.sources.length} sources, ${left.dom} panel or credit elements left`);
}

check('no console errors', errors.length === 0, errors.length ? errors.join(' | ') : 'none');

await page.close();
await browser.close();

console.log('\n=== layers-demo ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}. ${r.name}`);
if (failed) {
  console.error('\nlayers-demo: FAILED');
  process.exit(1);
}
console.log(`\nlayers-demo: all ${results.length} checks passed.`);
