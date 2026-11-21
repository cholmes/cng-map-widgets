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
// dynamic-import path in this round"): sql.js (@cngeo/format-gpkg) and
// flatgeobuf (@cngeo/format-flatgeobuf) load here via a REAL
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
  const skipResult = await page0.evaluate(() => window.__cngLastResult);
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
// +1: `parquet-raw` (Task 11) is listed here too, but deliberately not in
// `FORMATS` -- the decode-every-format loop below asserts `result.rows` is
// truthy and matches an ogrinfo/duckdb feature count, neither of which
// holds for a raw passthrough of a dataset whose source declares no
// `rowCount` (see PART 6 below, which exercises parquet-raw on its own
// terms: a real byte-for-byte proof instead).
check(pickerRows.length === FORMATS.length + 1, `format picker lists all ${FORMATS.length} decode formats plus parquet-raw (got ${pickerRows.length})`);
const gpkgRow = pickerRows.find((r) => r.id === 'gpkg');
check(!!gpkgRow && /loads ~339 KB on first use/.test(gpkgRow.text), `GeoPackage shows its weight before selection ("${gpkgRow?.text}")`);
const fgbRow = pickerRows.find((r) => r.id === 'flatgeobuf');
check(!!fgbRow && /loads ~10 KB on first use/.test(fgbRow.text), `FlatGeobuf shows its weight before selection ("${fgbRow?.text}")`);
const shpRow = pickerRows.find((r) => r.id === 'shapefile');
check(!!shpRow && /loads ~500 B on first use/.test(shpRow.text), `Shapefile shows its weight before selection ("${shpRow?.text}")`);

// Assert NOTHING sql.js- or flatgeobuf-shaped has been fetched from the CDN
// merely from registering the descriptors / rendering the picker. (This
// must match the CDN host specifically -- `@cngeo/format-flatgeobuf`'s own
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

  const result = await page.evaluate(() => window.__cngLastResult ?? null);
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
  const armed = await drawPage.evaluate(() => window.__cngDownloadDemo.drawTool.armed);
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
  await drawPage.waitForFunction(() => window.__cngDownloadDemo.area?.provenance?.source === 'draw', undefined, { timeout: 15_000 });
  const disarmedAfterDrag = await drawPage.evaluate(() => !window.__cngDownloadDemo.drawTool.armed);
  check(disarmedAfterDrag, 'drawTool disarms itself once a non-degenerate rectangle is dragged out');
  const drawnAreaInfo = await drawPage.textContent('#areaInfo');
  console.log('areaInfo after draw:', drawnAreaInfo);
  check(/\[drawn\]/.test(drawnAreaInfo ?? ''), `areaInfo reflects the drawn area's provenance.source ("${drawnAreaInfo}")`);

  await drawPage.check('#formatPicker input[value="geojson"]');
  await drawPage.click('#downloadBtn');
  await drawPage.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:'), undefined, { timeout: 60_000 });
  const drawResult = await drawPage.evaluate(() => window.__cngLastResult);
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
  await editPage.waitForFunction(() => window.__cngDownloadDemo.area?.provenance?.source === 'draw', undefined, { timeout: 15_000 });

  // Baseline: the un-edited drawn box.
  await editPage.check('#formatPicker input[value="geojson"]');
  await editPage.click('#downloadBtn');
  await editPage.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:'), undefined, { timeout: 60_000 });
  const baselineResult = await editPage.evaluate(() => window.__cngLastResult);
  console.log('PART 4 baseline (un-edited drawn box) rows:', baselineResult?.rows);
  check(!!baselineResult?.rows, `baseline drawn-box download produced rows (${baselineResult?.rows ?? 'none'})`);

  // Enter edit mode. setCurrentArea() -> control.setArea() -> an animated
  // fitBounds -- wait for the camera to settle before computing any
  // vertex's screen pixel (project() otherwise reflects a mid-animation
  // camera that has moved again by the time the mouse gets there).
  await editPage.click('#editBtn');
  await editPage.waitForFunction(() => !window.__cngDownloadDemo.map.isMoving(), undefined, { timeout: 10_000 });

  const vertices = await editPage.evaluate(() => {
    const src = window.__cngDownloadDemo.map.getSource('cng-edit-vertices');
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
    const r = window.__cngDownloadDemo.map.getContainer().getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const project = (coord) => editPage.evaluate((c) => window.__cngDownloadDemo.map.project(c), coord);
  const p2 = await project(v2);
  const pTarget = await project(target);
  const startX = containerOrigin.x + p2.x, startY = containerOrigin.y + p2.y;
  const endX = containerOrigin.x + pTarget.x, endY = containerOrigin.y + pTarget.y;

  await editPage.mouse.move(startX, startY);
  await editPage.mouse.down();
  const cursorOnVertexDown = await editPage.evaluate(() => window.__cngDownloadDemo.map.getCanvas().style.cursor);
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
  await editPage.waitForFunction(() => !window.__cngDownloadDemo.map.isMoving(), undefined, { timeout: 10_000 });
  const editedProvenance = await editPage.evaluate(() => window.__cngDownloadDemo.area?.provenance);
  check(editedProvenance?.source === 'edited', `the finished Area's provenance.source is "edited" (got "${editedProvenance?.source}")`);
  check(typeof editedProvenance?.edited?.parentAreaId === 'string', 'provenance.edited keeps the parent Area id');

  await editPage.click('#downloadBtn');
  await editPage.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:') || (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Error'), undefined, { timeout: 60_000 });
  const editedResult = await editPage.evaluate(() => window.__cngLastResult);
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

// --- PART 5: "Max rows" -- no cap by default, respects an explicit value --
// The regression this whole task exists for: examples/download-demo used
// to hardcode `limit: 2000` in buildFilter(), which is why a tester
// couldn't get more than 2000 rows out of this demo. Proven here on
// OBSERVABLE behavior -- two real downloads of the smallest catalog entry
// (ftw-li, Liechtenstein) against live data, the same shape PART 8 already
// uses for its own, much larger, uncapped run. `buildFilter`/
// `currentEntry` are NOT reached into here: the controller's Ruling R4
// forbids exporting internals onto `window.__cngDownloadDemo` solely for
// test reachability -- an earlier version of this PART did exactly that
// and was rightly reverted. -------------------------------------------
console.log('\n=== PART 5: Max rows input -- no cap by default, respects an explicit value ===');
{
  const page5 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors5 = [];
  page5.on('pageerror', (e) => errors5.push(e.message));
  page5.on('console', (m) => { if (m.type() === 'error') errors5.push(m.text()); });

  await page5.goto(url, { waitUntil: 'load' });
  await page5.waitForSelector('input[role="combobox"]', { timeout: 20_000 });
  await page5.click('input[role="combobox"]');
  await page5.type('input[role="combobox"]', 'liechtenstein', { delay: 20 });
  await page5.waitForSelector('li[role="option"]', { timeout: 30_000 });
  await page5.keyboard.press('ArrowDown');
  await page5.keyboard.press('Enter');
  await page5.waitForFunction(() => !document.getElementById('areaInfo')?.textContent?.startsWith('Search for a place'), undefined, { timeout: 40_000 });

  // Run 1: Max rows left empty (the default) -- ftw-li's own natural,
  // unlimited row count for this area/filter.
  await page5.check('#formatPicker input[value="geojson"]');
  await page5.click('#downloadBtn');
  await page5.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:'), undefined, { timeout: 60_000 });
  const resultNoLimit = await page5.evaluate(() => window.__cngLastResult);
  console.log('PART 5 (Max rows empty) result:', await page5.textContent('#downloadInfo'));
  check(typeof resultNoLimit?.rows === 'number' && resultNoLimit.rows > 10, `with Max rows empty, the real download returns its natural row count, well above 10 (got ${resultNoLimit?.rows})`);

  // Run 2: Max rows = 10 -- the SAME area/dataset/format, only the limit changed.
  await page5.fill('#maxRows', '10');
  await page5.click('#downloadBtn');
  await page5.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:'), undefined, { timeout: 60_000 });
  const resultWithLimit = await page5.evaluate(() => window.__cngLastResult);
  console.log('PART 5 (Max rows = 10) result:', await page5.textContent('#downloadInfo'));
  check(resultWithLimit?.rows === 10, `with Max rows = 10, the real download is capped at exactly 10 rows (got ${resultWithLimit?.rows})`);
  check(resultWithLimit?.truncated === true, `the capped download reports truncated: true (got ${resultWithLimit?.truncated})`);
  await page5.fill('#maxRows', '');

  check(errors5.length === 0, `no console errors on the Max rows path (${errors5.length}: ${errors5.join('; ')})`);
  await page5.close();
}

// --- PART 6: parquet-raw -- downloads the real, original, unfiltered
// bytes, with the raw-passthrough-unfiltered warning rendered prominently
// and a copyable list of the real source URL(s) shown beside the option. -
console.log('\n=== PART 6: parquet-raw -- downloads the real, original, unfiltered bytes ===');
{
  const page6 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors6 = [];
  page6.on('pageerror', (e) => errors6.push(e.message));
  page6.on('console', (m) => { if (m.type() === 'error') errors6.push(m.text()); });

  await page6.goto(url, { waitUntil: 'load' });
  await page6.waitForSelector('input[role="combobox"]', { timeout: 20_000 });

  const formatOptionValues = await page6.$$eval('#formatPicker .format-option input', (els) => els.map((e) => e.value));
  console.log('Format option values:', formatOptionValues);
  check(formatOptionValues.includes('parquet-raw'), `format picker includes parquet-raw (${formatOptionValues.join(', ')})`);
  const rawLabel = await page6.$eval('#formatPicker .format-option[data-format-id="parquet-raw"] .format-label', (el) => el.textContent);
  check(/original files/i.test(rawLabel) && /unfiltered/i.test(rawLabel), `parquet-raw's picker label names it as original/unfiltered ("${rawLabel}")`);

  const rawUrlsText = await page6.$eval('#rawSourceUrls textarea', (el) => el.value);
  console.log('raw source URLs box (before any format is selected):', rawUrlsText);
  check(/Liechtenstein\.parquet/.test(rawUrlsText), `the raw-format source URL list names the real source file for the default dataset ("${rawUrlsText}")`);

  // ftw-li's own `where`/`columns` filter (set regardless of format, plus
  // the spatial intersects filter once an area is picked) is what trips
  // raw-passthrough-unfiltered: none of it applies on this path.
  await page6.click('input[role="combobox"]');
  await page6.type('input[role="combobox"]', 'liechtenstein', { delay: 20 });
  await page6.waitForSelector('li[role="option"]', { timeout: 30_000 });
  await page6.keyboard.press('ArrowDown');
  await page6.keyboard.press('Enter');
  await page6.waitForFunction(() => !document.getElementById('areaInfo')?.textContent?.startsWith('Search for a place'), undefined, { timeout: 40_000 });

  await page6.check('#formatPicker input[value="parquet-raw"]');
  await page6.click('#downloadBtn');

  await page6.waitForFunction(
    () => {
      const t = document.getElementById('downloadInfo')?.textContent ?? '';
      return t.startsWith('Done:') || t.startsWith('Error');
    },
    undefined,
    { timeout: 60_000 },
  );
  const downloadInfo6 = await page6.textContent('#downloadInfo');
  console.log('parquet-raw download info:', downloadInfo6);
  check(downloadInfo6.startsWith('Done:'), `parquet-raw download completed (${downloadInfo6})`);

  const prominentText = await page6.textContent('#prominentWarnings');
  console.log('prominent warnings box:', prominentText);
  check(/RAW PASSTHROUGH/.test(prominentText ?? ''), `raw-passthrough-unfiltered is rendered in the prominent warnings box ("${prominentText}")`);

  const result6 = await page6.evaluate(() => window.__cngLastResult);
  check(result6?.format === 'parquet-raw', `result.format is parquet-raw (${result6?.format})`);

  // THE strong proof: the downloaded bytes are byte-for-byte the real,
  // live, original published source file -- nothing decoded or re-encoded.
  const downloadedBase64 = await page6.evaluate(async () => {
    const link = document.getElementById('downloadLink');
    const resp = await fetch(link.href);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  });
  const downloadedBytes = Buffer.from(downloadedBase64, 'base64');
  const originalRes = await fetch(
    'https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=LI/Liechtenstein.parquet',
  );
  const originalBytes = Buffer.from(await originalRes.arrayBuffer());
  check(
    downloadedBytes.length === originalBytes.length,
    `downloaded parquet-raw file is the same size as the live original (${downloadedBytes.length} vs ${originalBytes.length})`,
  );
  check(downloadedBytes.equals(originalBytes), 'downloaded parquet-raw bytes are byte-for-byte identical to the live original source file');

  check(errors6.length === 0, `no console errors on the parquet-raw path (${errors6.length}: ${errors6.join('; ')})`);
  await page6.close();
}

// --- PART 7: a large-download warning gates the download behind an
// explicit confirm click, BEFORE anything is fetched -- using a real,
// live, tiny Liechtenstein download against an artificially low
// `largeDownloadBytes` threshold (a documented estimate()/download()
// option, overridable here only via a `?largeDownloadBytes=` query param
// this page reads for exactly this reason) so the warning is reachable
// without needing a multi-GB live file. -----------------------------------
console.log('\n=== PART 7: large-download triggers an explicit confirm gate before anything starts ===');
{
  const page7 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors7 = [];
  page7.on('pageerror', (e) => errors7.push(e.message));
  page7.on('console', (m) => { if (m.type() === 'error') errors7.push(m.text()); });

  await page7.goto(`${url}?largeDownloadBytes=1000`, { waitUntil: 'load' });
  await page7.waitForSelector('input[role="combobox"]', { timeout: 20_000 });
  await page7.click('input[role="combobox"]');
  await page7.type('input[role="combobox"]', 'liechtenstein', { delay: 20 });
  await page7.waitForSelector('li[role="option"]', { timeout: 30_000 });
  await page7.keyboard.press('ArrowDown');
  await page7.keyboard.press('Enter');
  await page7.waitForFunction(() => !document.getElementById('areaInfo')?.textContent?.startsWith('Search for a place'), undefined, { timeout: 40_000 });

  await page7.check('#formatPicker input[value="geojson"]');
  await page7.click('#downloadBtn');

  // The confirm box must appear BEFORE any download result -- the only
  // real network activity so far is a metadata-only footer read.
  await page7.waitForFunction(() => document.getElementById('confirmBox')?.style.display === 'block', undefined, { timeout: 30_000 });
  const statusText = await page7.textContent('#confirmBox');
  console.log('confirm box text:', statusText);
  check(/confirm/i.test(statusText ?? ''), `an artificially small largeDownloadBytes threshold gates the download behind an explicit confirm ("${statusText}")`);
  const downloadInfoBeforeConfirm = await page7.textContent('#downloadInfo');
  check(!downloadInfoBeforeConfirm?.startsWith('Done:'), 'nothing has completed yet while the confirm box is showing -- the user has not acted');

  await page7.click('#confirmDownloadBtn');
  await page7.waitForFunction(() => (document.getElementById('downloadInfo')?.textContent ?? '').startsWith('Done:'), undefined, { timeout: 60_000 });
  const result7 = await page7.evaluate(() => window.__cngLastResult);
  console.log('PART 7 post-confirm result:', await page7.textContent('#downloadInfo'));
  check(!!result7?.rows, `after confirming, the download actually runs and produces rows (${result7?.rows ?? 'none'})`);

  check(errors7.length === 0, `no console errors on the confirm-gate path (${errors7.length}: ${errors7.join('; ')})`);
  await page7.close();
}

// --- PART 8: the headline regression -- a real download, no Max rows set,
// exceeding the old hardcoded 2000-row cap on real, live data. CGAZ ADM2
// (DATASETS' `cgaz-adm2` entry) is 49,349 units in one file; "no area"
// means the whole dataset, so this is guaranteed to exceed 2000 without
// depending on how many units happen to fall inside some search result. ---
console.log('\n=== PART 8: no Max rows set -- a real download exceeds the old 2000-row cap ===');
{
  const page8 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors8 = [];
  page8.on('pageerror', (e) => errors8.push(e.message));
  page8.on('console', (m) => { if (m.type() === 'error') errors8.push(m.text()); });

  await page8.goto(url, { waitUntil: 'load' });
  await page8.waitForSelector('#dataset', { timeout: 20_000 });
  await page8.selectOption('#dataset', 'cgaz-adm2');
  // Deliberately no area, no Max rows value: the whole 49,349-row file.
  await page8.check('#formatPicker input[value="geojson"]');
  await page8.click('#downloadBtn');

  await page8.waitForFunction(
    () => {
      const t = document.getElementById('downloadInfo')?.textContent ?? '';
      return t.startsWith('Done:') || t.startsWith('Error');
    },
    undefined,
    { timeout: 180_000 },
  );
  const downloadInfo8 = await page8.textContent('#downloadInfo');
  console.log('PART 8 (cgaz-adm2, no area, no Max rows) download info:', downloadInfo8);
  const result8 = await page8.evaluate(() => window.__cngLastResult);
  check(downloadInfo8.startsWith('Done:'), `the uncapped cgaz-adm2 download completed (${downloadInfo8})`);
  check(typeof result8?.rows === 'number' && result8.rows > 2000, `the real row count (${result8?.rows}) exceeds the old hardcoded 2000-row cap`);

  check(errors8.length === 0, `no console errors on the uncapped-download path (${errors8.length}: ${errors8.join('; ')})`);
  await page8.close();
}

await browser.close();

console.log('\n--- scratch files kept at', scratchDir, '---');

if (failures.length > 0) {
  console.error(`\nFAILING (${failures.length}):`, failures.join('\n  - '));
  process.exitCode = 1;
} else {
  console.log('\nAll download-demo checks passed (every format, lazy-load network proof, FORMAT_LOAD_FAILED).');
}
