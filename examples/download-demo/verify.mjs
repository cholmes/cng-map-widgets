#!/usr/bin/env node
// Drives examples/download-demo with Playwright against REAL, live data:
// the published geoBoundaries gazetteer (data.source.coop) for the area
// search, and the Fields of The World Liechtenstein GeoParquet
// (data.source.coop, 218 KB / 795 fields / 1 row group) for the download.
// No mocking, no local fixtures for the data path.
//
// Exercises the whole E5 chain the README/AGENTS.md document: Geocoder ->
// Area -> estimate() (footer metadata only) -> download() with a
// memorySink -> a real output file, through EVERY registered format
// (GeoJSON, GeoParquet, GeoPackage, Shapefile, FlatGeobuf, CSV, Esri JSON).
//
// This is the real-browser follow-up to experiments/e10-heavy-formats/
// RESULTS.md §9 ("No real browser smoke test for any CDN-URL
// dynamic-import path in this round"): sql.js (@cnmw/format-gpkg) and
// flatgeobuf (@cnmw/format-flatgeobuf) load here via a REAL
// `import('https://cdn.jsdelivr.net/...')` in a REAL Chromium page --
// not Node's setXModule() test-injection seam, which cannot exercise an
// absolute-URL dynamic import at all.
//
// Also covers three later UX additions, each its own PART below: PART 0
// (skip the Estimate click -- search then straight to a GeoJSON download),
// PART 3 (createDrawTool: drag a rectangle, download it), and PART 4
// (createEditTool: drag a vertex, then prove the download's row count
// actually changed -- not just that the UI looks different).
//
// Usage: node examples/download-demo/verify.mjs [port]   (serve.py must be running)

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? '8000';
const url = `http://localhost:${port}/examples/download-demo/index.html`;
const scratchDir = fs.mkdtempSync('/tmp/download-demo-verify-');

const failures = [];
function check(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error('FAIL:', msg);
  } else {
    console.log('ok:', msg);
  }
}

// --- format -> validation plan (per the task bar: ogrinfo for
// gpkg/shp.zip/EsriJSON, duckdb for fgb/csv) --------------------------------
const FORMATS = [
  { id: 'geojson', extension: 'geojson', validate: null },
  { id: 'geoparquet', extension: 'parquet', validate: null },
  { id: 'gpkg', extension: 'gpkg', validate: 'ogrinfo' },
  { id: 'shapefile', extension: 'shp.zip', validate: 'ogrinfo' },
  { id: 'flatgeobuf', extension: 'fgb', validate: 'duckdb' },
  { id: 'csv', extension: 'csv', validate: 'duckdb' },
  { id: 'esrijson', extension: 'json', validate: 'ogrinfo' },
];

function validateOgrinfo(file) {
  const out = execFileSync('ogrinfo', ['-al', '-so', file], { encoding: 'utf8' });
  const featureCount = /Feature Count:\s*(\d+)/.exec(out)?.[1];
  return { ok: /Feature Count:/.test(out), featureCount, raw: out };
}

function validateDuckdbFgb(file) {
  const sql = `INSTALL spatial; LOAD spatial; SELECT COUNT(*) AS n FROM ST_Read('${file}');`;
  const out = execFileSync('duckdb', ['-csv', '-c', sql], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  const n = Number(lines[lines.length - 1]);
  return { ok: n > 0, featureCount: n, raw: out };
}

function validateDuckdbCsv(file) {
  const sql = `SELECT COUNT(*) AS n FROM read_csv('${file}', header=true);`;
  const out = execFileSync('duckdb', ['-csv', '-c', sql], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  const n = Number(lines[lines.length - 1]);
  return { ok: n > 0, featureCount: n, raw: out };
}

const browser = await chromium.launch();

// --- PART 0: skip the Estimate step -- search, straight to a GeoJSON
// download, no Estimate click anywhere (feature 1). downloadBtn must be
// enabled from the moment an area exists, the download's internal ceiling
// check must still be the thing doing the work, and handle.estimate must
// auto-fill the "optional preview" box even though nobody asked for it. ---
console.log('\n=== PART 0: skip estimate -- search then straight to download ===');
{
  const page0 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors0 = [];
  page0.on('pageerror', (e) => errors0.push(e.message));
  page0.on('console', (m) => { if (m.type() === 'error') errors0.push(m.text()); });

  await page0.goto(url, { waitUntil: 'load' });
  await page0.waitForSelector('input[role="combobox"]', { timeout: 20_000 });
  await page0.click('input[role="combobox"]');
  await page0.type('input[role="combobox"]', 'liechtenstein', { delay: 20 });
  await page0.waitForSelector('li[role="option"]', { timeout: 30_000 });
  await page0.keyboard.press('ArrowDown');
  await page0.keyboard.press('Enter');
  await page0.waitForFunction(() => !document.getElementById('areaInfo')?.textContent?.startsWith('Search for a place'), undefined, { timeout: 40_000 });

  const disabledBeforeEstimate = await page0.$eval('#downloadBtn', (el) => el.disabled);
  check(disabledBeforeEstimate === false, 'downloadBtn is enabled right after a search selection -- no Estimate click required');
  const estimateInfoBeforeDownload = await page0.$eval('#estimateInfo', (el) => el.style.display);
  check(estimateInfoBeforeDownload === 'none', 'estimateInfo box is still hidden -- nobody has estimated or downloaded yet');

  await page0.check('#formatPicker input[value="geojson"]');
  await page0.click('#downloadBtn'); // the Estimate button is never clicked in this whole PART
  await page0.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:'), undefined, { timeout: 60_000 });
  const skipResult = await page0.evaluate(() => window.__cnmwLastResult);
  console.log('PART 0 download result:', await page0.textContent('#downloadInfo'));
  check(!!skipResult?.rows, `skip-estimate download produced rows (${skipResult?.rows ?? 'none'})`);

  const estimateInfoAfter = await page0.textContent('#estimateInfo');
  console.log('estimateInfo auto-filled from handle.estimate:', estimateInfoAfter);
  check(/Rows:/.test(estimateInfoAfter ?? ''), `the "optional preview" estimate box auto-filled from the download's own internal estimate, with no Estimate click (${estimateInfoAfter})`);

  check(errors0.length === 0, `no console errors on the skip-estimate path (${errors0.length}: ${errors0.join('; ')})`);
  await page0.close();
}

// --- PART 1: the happy path, every format, on one page --------------------
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

/** @type {{url: string, time: number}[]} */
const networkLog = [];
page.on('request', (req) => networkLog.push({ url: req.url(), time: Date.now() }));

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push(msg.text());
    console.log('[console.error]', msg.text());
  }
});
page.on('pageerror', (err) => {
  consoleErrors.push(`pageerror: ${err.message}`);
  console.log('[pageerror]', err.message);
});

console.log('Navigating to', url);
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('input[role="combobox"]', { timeout: 20_000 });

// --- Area: search the live gazetteer -------------------------------------
await page.click('input[role="combobox"]');
await page.type('input[role="combobox"]', 'liechtenstein', { delay: 20 });
await page.waitForSelector('li[role="option"]', { timeout: 30_000 });
console.log('First option:', await page.textContent('li[role="option"]'));
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => !document.getElementById('areaInfo')?.textContent?.startsWith('Search for a place'),
  undefined,
  { timeout: 40_000 },
);
const areaInfo = await page.textContent('#areaInfo');
console.log('Area:', areaInfo);
check(/Liechtenstein/i.test(areaInfo ?? ''), `area selected (${areaInfo})`);

// --- estimate(): parquet footer metadata only ----------------------------
await page.click('#estimateBtn');
await page.waitForFunction(
  () => {
    const t = document.getElementById('estimateInfo')?.textContent ?? '';
    return t.includes('Rows:') || t.startsWith('Error');
  },
  undefined,
  { timeout: 60_000 },
);
const estimateInfo = await page.textContent('#estimateInfo');
console.log('--- estimate ---\n' + estimateInfo);
check(/Rows:/.test(estimateInfo ?? ''), `estimate succeeded (${estimateInfo})`);

// --- Format picker: weight shown BEFORE any selection/load ----------------
// A marker in the network log: everything after this point is attributable
// to a deliberate user action (selecting + downloading a format), not page
// load. Captured before any format has been selected or downloaded.
const beforeAnyFormatMarker = Date.now();

const pickerRows = await page.$$eval('#formatPicker .format-option', (rows) =>
  rows.map((r) => ({
    id: r.dataset.formatId,
    text: r.textContent.trim(),
  })),
);
console.log('Format picker rows (before any selection):', pickerRows);
check(pickerRows.length === FORMATS.length, `format picker lists all ${FORMATS.length} formats (got ${pickerRows.length})`);
const gpkgRow = pickerRows.find((r) => r.id === 'gpkg');
check(!!gpkgRow && /loads ~339 KB on first use/.test(gpkgRow.text), `GeoPackage shows its weight before selection ("${gpkgRow?.text}")`);
const fgbRow = pickerRows.find((r) => r.id === 'flatgeobuf');
check(!!fgbRow && /loads ~10 KB on first use/.test(fgbRow.text), `FlatGeobuf shows its weight before selection ("${fgbRow?.text}")`);
const shpRow = pickerRows.find((r) => r.id === 'shapefile');
check(!!shpRow && /loads ~500 B on first use/.test(shpRow.text), `Shapefile shows its weight before selection ("${shpRow?.text}")`);

// Assert NOTHING sql.js- or flatgeobuf-shaped has been fetched from the CDN
// merely from registering the descriptors / rendering the picker. (This
// must match the CDN host specifically -- `@cnmw/format-flatgeobuf`'s own
// *local* ESM module path, served by serve.py at page-load time because
// index.html statically imports it, legitimately contains the substring
// "flatgeobuf" too; that eager local-module fetch is not the CDN payload
// this check is proving was deferred.)
const CDN_HOST = /cdn\.jsdelivr\.net/i;
const cdnBeforeAnySelection = networkLog.filter((r) => CDN_HOST.test(r.url) && /sql-wasm|sql\.js|flatgeobuf/i.test(r.url));
check(cdnBeforeAnySelection.length === 0, `no sql.js/flatgeobuf CDN fetch before any format is selected (saw ${cdnBeforeAnySelection.length}: ${cdnBeforeAnySelection.map((r) => r.url).join(', ')})`);

// Screenshot #1: the picker with weight labels visible, nothing loaded yet.
await page.screenshot({ path: path.join(here, 'screenshot.png') });
console.log('Screenshot (weight labels) saved.');

// --- Download every format, in picker order ------------------------------
const results = {};
for (const fmt of FORMATS) {
  console.log(`\n=== format: ${fmt.id} ===`);
  await page.check(`#formatPicker input[value="${fmt.id}"]`);

  const markerBeforeThisDownload = Date.now();
  await page.click('#downloadBtn');

  // For the lazy, heavy formats, try to catch the "loading" state and
  // screenshot it -- it's a narrow window (a CDN round-trip), so this is
  // best-effort: a race (missing it) must not fail the whole run.
  if (fmt.id === 'gpkg' || fmt.id === 'flatgeobuf') {
    try {
      await page.waitForSelector(`#formatPicker .format-option.loading[data-format-id="${fmt.id}"]`, { timeout: 4_000 });
      await page.screenshot({ path: path.join(here, `screenshot-loading-${fmt.id}.png`) });
      console.log(`Screenshot (loading state, ${fmt.id}) saved.`);
    } catch {
      console.log(`(loading state for ${fmt.id} was too fast to screenshot -- not a failure)`);
    }
  }

  await page.waitForFunction(
    () => {
      const t = document.getElementById('downloadInfo')?.textContent ?? '';
      const e = document.getElementById('formatLoadError')?.textContent ?? '';
      return t.startsWith('Done:') || t.startsWith('Error') || t.startsWith('Cancelled') || e.length > 0;
    },
    undefined,
    { timeout: 120_000 },
  );
  const downloadInfo = await page.textContent('#downloadInfo');
  const loadError = await page.textContent('#formatLoadError');
  console.log(`${fmt.id} download info:`, downloadInfo, loadError ? `| formatLoadError: ${loadError}` : '');

  const result = await page.evaluate(() => window.__cnmwLastResult ?? null);
  check(!!result?.rows, `${fmt.id}: download produced rows (${result?.rows ?? 'none'})`);
  check(result?.format === fmt.id, `${fmt.id}: result.format matches (${result?.format})`);
  results[fmt.id] = result;

  if (fmt.id === 'gpkg') {
    // THE lazy-loading proof: sql.js's wasm must appear in the network log,
    // and every matching request must be timestamped AFTER this format was
    // selected+downloaded -- never merely from registering the descriptor
    // or rendering the picker (already checked above against
    // beforeAnyFormatMarker; this re-checks against the per-click marker).
    const sqlJsRequests = networkLog.filter((r) => CDN_HOST.test(r.url) && /sql-wasm|sql\.js/i.test(r.url));
    check(sqlJsRequests.length > 0, `sql.js was actually fetched over the real network (${sqlJsRequests.length} request(s): ${sqlJsRequests.map((r) => r.url).join(', ')})`);
    check(sqlJsRequests.every((r) => r.time >= markerBeforeThisDownload), 'every sql.js CDN request happened AFTER GeoPackage was selected+downloaded, not before');
  }
  if (fmt.id === 'flatgeobuf') {
    // Only the jsdelivr CDN fetch counts here -- the local
    // packages/format-flatgeobuf/src/*.js files (statically imported by
    // index.html, so fetched from serve.py at page load) also match
    // /flatgeobuf/i by path and would otherwise produce a false failure.
    const fgbRequests = networkLog.filter((r) => CDN_HOST.test(r.url) && /flatgeobuf/i.test(r.url));
    check(fgbRequests.length > 0, `flatgeobuf module was actually fetched over the real network (${fgbRequests.length} request(s): ${fgbRequests.map((r) => r.url).join(', ')})`);
    check(fgbRequests.every((r) => r.time >= markerBeforeThisDownload), 'every flatgeobuf CDN request happened AFTER FlatGeobuf was selected+downloaded, not before');
  }

  // Pull the bytes out of the page (memorySink -> a blob: URL) and write
  // them to a local scratch file for ogrinfo/duckdb validation.
  const base64 = await page.evaluate(async () => {
    const link = document.getElementById('downloadLink');
    if (!link || link.style.display === 'none') return null;
    const resp = await fetch(link.href);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  });
  if (base64) {
    const filePath = path.join(scratchDir, `ftw-li.${fmt.extension}`);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    console.log(`${fmt.id}: wrote ${fs.statSync(filePath).size} bytes to ${filePath}`);

    if (fmt.validate === 'ogrinfo') {
      try {
        const v = validateOgrinfo(filePath);
        check(v.ok, `${fmt.id}: ogrinfo reads it (feature count ${v.featureCount})`);
        check(Number(v.featureCount) === result?.rows, `${fmt.id}: ogrinfo feature count (${v.featureCount}) matches result.rows (${result?.rows})`);
      } catch (err) {
        check(false, `${fmt.id}: ogrinfo failed: ${err.message}`);
      }
    } else if (fmt.validate === 'duckdb') {
      try {
        const v = fmt.id === 'csv' ? validateDuckdbCsv(filePath) : validateDuckdbFgb(filePath);
        check(v.ok, `${fmt.id}: duckdb reads it (feature count ${v.featureCount})`);
        check(Number(v.featureCount) === result?.rows, `${fmt.id}: duckdb count (${v.featureCount}) matches result.rows (${result?.rows})`);
      } catch (err) {
        check(false, `${fmt.id}: duckdb failed: ${err.message}`);
      }
    }
  } else {
    check(false, `${fmt.id}: no download link / blob produced`);
  }
}

// After every format has loaded once, the picker should now show every
// lazy format as "loaded", not its pre-load weight caption.
const pickerRowsAfter = await page.$$eval('#formatPicker .format-option', (rows) => rows.map((r) => ({ id: r.dataset.formatId, text: r.textContent.trim() })));
console.log('Format picker rows (after every format has loaded):', pickerRowsAfter);
for (const id of ['gpkg', 'shapefile', 'flatgeobuf', 'csv', 'esrijson']) {
  const row = pickerRowsAfter.find((r) => r.id === id);
  check(!!row && /loaded/.test(row.text), `${id}: picker shows "loaded" after first use ("${row?.text}")`);
}

if (consoleErrors.length > 0) check(false, `${consoleErrors.length} console error(s) during the happy-path run`);

await page.close();

// --- PART 1b: a deterministic "loading" screenshot --------------------
// On a fast/local run the real sql.js CDN round-trip (§ above) often
// completes before a screenshot can be scheduled -- the try/catch around
// it just skips it rather than failing the whole run. For a committed
// screenshot of the loading state (the task's documentation bar), use a
// fresh page + fresh module registry and artificially delay the SAME real
// CDN response (still a genuine jsdelivr fetch, not a mock) just long
// enough to reliably capture the picker's "loading…" row.
console.log('\n=== deterministic loading-state screenshot ===');
const loadingPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await loadingPage.route(/cdn\.jsdelivr\.net\/npm\/sql\.js/i, async (route) => {
  await new Promise((r) => setTimeout(r, 1500));
  await route.continue();
});
await loadingPage.goto(url, { waitUntil: 'load' });
await loadingPage.waitForSelector('input[role="combobox"]', { timeout: 20_000 });
await loadingPage.click('input[role="combobox"]');
await loadingPage.type('input[role="combobox"]', 'liechtenstein', { delay: 20 });
await loadingPage.waitForSelector('li[role="option"]', { timeout: 30_000 });
await loadingPage.keyboard.press('ArrowDown');
await loadingPage.keyboard.press('Enter');
await loadingPage.waitForFunction(() => !document.getElementById('areaInfo')?.textContent?.startsWith('Search for a place'), undefined, { timeout: 40_000 });
await loadingPage.click('#estimateBtn');
await loadingPage.waitForFunction(() => (document.getElementById('estimateInfo')?.textContent ?? '').includes('Rows:'), undefined, { timeout: 60_000 });
await loadingPage.check('#formatPicker input[value="gpkg"]');
await loadingPage.click('#downloadBtn');
await loadingPage.waitForSelector('#formatPicker .format-option.loading[data-format-id="gpkg"]', { timeout: 10_000 });
await loadingPage.screenshot({ path: path.join(here, 'screenshot-loading-gpkg.png') });
console.log('Screenshot (deterministic loading state) saved.');
check(true, 'captured the GeoPackage "loading…" state via a delayed (but still real) CDN response');
await loadingPage.waitForFunction(
  () => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:'),
  undefined,
  { timeout: 60_000 },
);
await loadingPage.close();

// --- PART 2: FORMAT_LOAD_FAILED -- a clean failure display ----------------
// A fresh page (fresh module registry): intercept sql.js's CDN request so
// resolveFormat()'s load() rejects, and verify the UI shows a distinct
// FORMAT_LOAD_FAILED box rather than a generic/garbled error.
console.log('\n=== FORMAT_LOAD_FAILED: clean failure display ===');
const failPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await failPage.route(/cdn\.jsdelivr\.net\/npm\/sql\.js/i, (route) => route.abort('failed'));

await failPage.goto(url, { waitUntil: 'load' });
await failPage.waitForSelector('input[role="combobox"]', { timeout: 20_000 });
await failPage.click('input[role="combobox"]');
await failPage.type('input[role="combobox"]', 'liechtenstein', { delay: 20 });
await failPage.waitForSelector('li[role="option"]', { timeout: 30_000 });
await failPage.keyboard.press('ArrowDown');
await failPage.keyboard.press('Enter');
await failPage.waitForFunction(() => !document.getElementById('areaInfo')?.textContent?.startsWith('Search for a place'), undefined, { timeout: 40_000 });
await failPage.click('#estimateBtn');
await failPage.waitForFunction(() => (document.getElementById('estimateInfo')?.textContent ?? '').includes('Rows:'), undefined, { timeout: 60_000 });

await failPage.check('#formatPicker input[value="gpkg"]');
await failPage.click('#downloadBtn');
await failPage.waitForFunction(
  () => (document.getElementById('formatLoadError')?.textContent ?? '').length > 0,
  undefined,
  { timeout: 60_000 },
);
const loadErrorText = await failPage.textContent('#formatLoadError');
console.log('formatLoadError box:', loadErrorText);
check(/FORMAT_LOAD_FAILED/.test(loadErrorText ?? ''), `FORMAT_LOAD_FAILED is shown in the dedicated failure box ("${loadErrorText}")`);
const downloadInfoHiddenDuringFailure = await failPage.$eval('#downloadInfo', (el) => el.style.display === 'none' || el.textContent.trim() === '');
check(downloadInfoHiddenDuringFailure, 'the generic downloadInfo box does not also show a garbled error alongside the clean one');
const gpkgRowFailed = await failPage.$eval('#formatPicker .format-option[data-format-id="gpkg"]', (el) => el.className);
check(/failed/.test(gpkgRowFailed), `the GeoPackage picker row reflects the failed load state (class="${gpkgRowFailed}")`);

await failPage.screenshot({ path: path.join(here, 'screenshot-format-load-failed.png') });
console.log('Screenshot (FORMAT_LOAD_FAILED) saved.');

await failPage.close();

// --- PART 3: draw a box (createDrawTool), download it ---------------------
// A "draw mode active" screenshot (the task's documentation bar) is taken
// mid-drag, with the preview rectangle and the armed button both visible.
console.log('\n=== PART 3: draw a box, then download it ===');
{
  const drawPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors3 = [];
  drawPage.on('pageerror', (e) => errors3.push(e.message));
  drawPage.on('console', (m) => { if (m.type() === 'error') errors3.push(m.text()); });

  await drawPage.goto(url, { waitUntil: 'load' });
  await drawPage.waitForSelector('#drawBoxBtn', { timeout: 20_000 });

  await drawPage.click('#drawBoxBtn');
  const armed = await drawPage.evaluate(() => window.__cnmwDownloadDemo.drawTool.armed);
  check(armed === true, 'drawTool.armed is true after clicking "Draw box"');
  const armedBtnClass = await drawPage.$eval('#drawBoxBtn', (el) => el.className);
  check(/armed/.test(armedBtnClass), `"Draw box" button reflects the armed state (class="${armedBtnClass}")`);

  // Kept clear of the floating #panel (top:10, right:10, width:380) --
  // a vertex/rectangle corner under the panel is unclickable by a real
  // mouse too, so this stays in the uncovered left portion of the map.
  const canvas = await drawPage.$('.maplibregl-canvas');
  const box = await canvas.boundingBox();
  const x0 = box.x + box.width * 0.15, y0 = box.y + box.height * 0.6;
  const x1 = box.x + box.width * 0.55, y1 = box.y + box.height * 0.25;
  await drawPage.mouse.move(x0, y0);
  await drawPage.mouse.down();
  await drawPage.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 8 });

  // Mid-drag screenshot: armed button text + the live preview rectangle.
  await drawPage.screenshot({ path: path.join(here, 'screenshot-draw-active.png') });
  console.log('Screenshot (draw mode active, mid-drag) saved.');

  await drawPage.mouse.move(x1, y1, { steps: 8 });
  await drawPage.mouse.up();
  await drawPage.waitForFunction(() => window.__cnmwDownloadDemo.area?.provenance?.source === 'draw', undefined, { timeout: 15_000 });
  const disarmedAfterDrag = await drawPage.evaluate(() => !window.__cnmwDownloadDemo.drawTool.armed);
  check(disarmedAfterDrag, 'drawTool disarms itself once a non-degenerate rectangle is dragged out');
  const drawnAreaInfo = await drawPage.textContent('#areaInfo');
  console.log('areaInfo after draw:', drawnAreaInfo);
  check(/\[drawn\]/.test(drawnAreaInfo ?? ''), `areaInfo reflects the drawn area's provenance.source ("${drawnAreaInfo}")`);

  await drawPage.check('#formatPicker input[value="geojson"]');
  await drawPage.click('#downloadBtn');
  await drawPage.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:'), undefined, { timeout: 60_000 });
  const drawResult = await drawPage.evaluate(() => window.__cnmwLastResult);
  console.log('PART 3 download result:', await drawPage.textContent('#downloadInfo'));
  check(!!drawResult?.rows, `drawn-box download produced rows (${drawResult?.rows ?? 'none'})`);

  check(errors3.length === 0, `no console errors on the draw-box path (${errors3.length}: ${errors3.join('; ')})`);
  await drawPage.close();
}

// --- PART 4: edit a boundary (createEditTool) -- the changed-row-count
// proof. Draws a box (a simple quad is easier to reason about shrinking
// than the real country polygon's concave boundary), downloads it
// un-edited as the baseline, then drags one corner vertex deep toward the
// box's centre (a visible shrink -- a "kite" shape, still a valid simple
// polygon) and downloads again. The whole point of this PART is the
// strict inequality at the end: a real spatial-filter row count, not a
// UI-only check. --------------------------------------------------------
console.log('\n=== PART 4: edit a boundary, then prove the download changed ===');
{
  const editPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors4 = [];
  editPage.on('pageerror', (e) => errors4.push(e.message));
  editPage.on('console', (m) => { if (m.type() === 'error') errors4.push(m.text()); });

  await editPage.goto(url, { waitUntil: 'load' });
  await editPage.waitForSelector('#drawBoxBtn', { timeout: 20_000 });

  await editPage.click('#drawBoxBtn');
  const canvas = await editPage.$('.maplibregl-canvas');
  const box = await canvas.boundingBox();
  const x0 = box.x + box.width * 0.15, y0 = box.y + box.height * 0.6;
  const x1 = box.x + box.width * 0.55, y1 = box.y + box.height * 0.25;
  await editPage.mouse.move(x0, y0);
  await editPage.mouse.down();
  await editPage.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 });
  await editPage.mouse.move(x1, y1, { steps: 5 });
  await editPage.mouse.up();
  await editPage.waitForFunction(() => window.__cnmwDownloadDemo.area?.provenance?.source === 'draw', undefined, { timeout: 15_000 });

  // Baseline: the un-edited drawn box.
  await editPage.check('#formatPicker input[value="geojson"]');
  await editPage.click('#downloadBtn');
  await editPage.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:'), undefined, { timeout: 60_000 });
  const baselineResult = await editPage.evaluate(() => window.__cnmwLastResult);
  console.log('PART 4 baseline (un-edited drawn box) rows:', baselineResult?.rows);
  check(!!baselineResult?.rows, `baseline drawn-box download produced rows (${baselineResult?.rows ?? 'none'})`);

  // Enter edit mode. setCurrentArea() -> control.setArea() -> an animated
  // fitBounds -- wait for the camera to settle before computing any
  // vertex's screen pixel (project() otherwise reflects a mid-animation
  // camera that has moved again by the time the mouse gets there).
  await editPage.click('#editBtn');
  await editPage.waitForFunction(() => !window.__cnmwDownloadDemo.map.isMoving(), undefined, { timeout: 10_000 });

  const vertices = await editPage.evaluate(() => {
    const src = window.__cnmwDownloadDemo.map.getSource('cnmw-edit-vertices');
    return src ? src._data.features.map((f) => ({ index: f.properties.index, coord: f.geometry.coordinates })) : null;
  });
  check(Array.isArray(vertices) && vertices.length === 4, `edit tool renders 4 vertex handles for the drawn rectangle (got ${vertices?.length})`);

  // Screenshot (the task's documentation bar: "edit mode with vertex
  // handles") -- two animation frames + a short settle so the just-added
  // vertex/midpoint/outline layers have actually painted once before the
  // capture (addLayer() + setData() do not guarantee a painted frame by
  // the next microtask).
  await editPage.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await editPage.waitForTimeout(150);
  await editPage.screenshot({ path: path.join(here, 'screenshot-edit-handles.png') });
  console.log('Screenshot (edit mode, vertex handles) saved.');

  // Drag the diagonal-opposite-to-index-0 vertex (index 2) 75% of the way
  // toward the rectangle's centre -- a visible, deep shrink.
  const v0 = vertices.find((v) => v.index === 0).coord;
  const v2 = vertices.find((v) => v.index === 2).coord;
  const center = [(v0[0] + v2[0]) / 2, (v0[1] + v2[1]) / 2];
  const target = [v2[0] * 0.25 + center[0] * 0.75, v2[1] * 0.25 + center[1] * 0.75];

  const containerOrigin = await editPage.evaluate(() => {
    const r = window.__cnmwDownloadDemo.map.getContainer().getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const project = (coord) => editPage.evaluate((c) => window.__cnmwDownloadDemo.map.project(c), coord);
  const p2 = await project(v2);
  const pTarget = await project(target);
  const startX = containerOrigin.x + p2.x, startY = containerOrigin.y + p2.y;
  const endX = containerOrigin.x + pTarget.x, endY = containerOrigin.y + pTarget.y;

  await editPage.mouse.move(startX, startY);
  await editPage.mouse.down();
  const cursorOnVertexDown = await editPage.evaluate(() => window.__cnmwDownloadDemo.map.getCanvas().style.cursor);
  check(cursorOnVertexDown === 'grabbing', `mousedown on the vertex handle starts a drag (cursor="${cursorOnVertexDown}")`);
  await editPage.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 8 });
  await editPage.mouse.move(endX, endY, { steps: 8 });
  await editPage.mouse.up();
  await editPage.waitForTimeout(150);

  const areaInfoAfterEdit = await editPage.textContent('#areaInfo');
  console.log('areaInfo after vertex drag:', areaInfoAfterEdit);
  check(/\(edited\)/.test(areaInfoAfterEdit ?? ''), `areaInfo reflects the live-edited area while still in edit mode ("${areaInfoAfterEdit}")`);

  // Finish editing -- commits the edited Area as `area`, re-fits the camera.
  await editPage.click('#editBtn');
  await editPage.waitForFunction(() => !window.__cnmwDownloadDemo.map.isMoving(), undefined, { timeout: 10_000 });
  const editedProvenance = await editPage.evaluate(() => window.__cnmwDownloadDemo.area?.provenance);
  check(editedProvenance?.source === 'edited', `the finished Area's provenance.source is "edited" (got "${editedProvenance?.source}")`);
  check(typeof editedProvenance?.edited?.parentAreaId === 'string', 'provenance.edited keeps the parent Area id');

  await editPage.click('#downloadBtn');
  await editPage.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:') || (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Error'), undefined, { timeout: 60_000 });
  const editedResult = await editPage.evaluate(() => window.__cnmwLastResult);
  console.log('PART 4 edited-area download result:', await editPage.textContent('#downloadInfo'));

  // THE proof: a real, strictly-smaller row count after an edit that
  // visibly shrank the area -- not just a UI difference.
  check(!!editedResult?.rows, `edited-area download produced rows (${editedResult?.rows ?? 'none'})`);
  check(
    typeof editedResult?.rows === 'number' && editedResult.rows < baselineResult.rows,
    `edited-area download row count (${editedResult?.rows}) is strictly less than the un-edited baseline (${baselineResult?.rows}) -- the edit actually changed what gets downloaded`,
  );

  check(errors4.length === 0, `no console errors on the edit-boundary path (${errors4.length}: ${errors4.join('; ')})`);
  await editPage.close();
}

await browser.close();

console.log('\n--- scratch files kept at', scratchDir, '---');

if (failures.length > 0) {
  console.error(`\nFAILING (${failures.length}):`, failures.join('\n  - '));
  process.exitCode = 1;
} else {
  console.log('\nAll download-demo checks passed (every format, lazy-load network proof, FORMAT_LOAD_FAILED).');
}
