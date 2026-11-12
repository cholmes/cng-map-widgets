#!/usr/bin/env node
// Drives examples/download-demo with Playwright against REAL, live data:
// the published geoBoundaries gazetteer (data.source.coop) for the area
// search, and the Fields of The World Liechtenstein GeoParquet
// (data.source.coop, 218 KB / 795 fields / 1 row group) for the download.
// No mocking, no local fixtures.
//
// Exercises the whole E5 chain the README/AGENTS.md document: Geocoder ->
// Area -> estimate() (footer metadata only) -> download() with a
// memorySink -> a real GeoJSON FeatureCollection, plus the GeoParquet
// writer on the same request.
//
// Usage: node examples/download-demo/verify.mjs [port]   (serve.py must be running)

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? '8123';
const url = `http://localhost:${port}/examples/download-demo/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

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

// --- download(): a real GeoJSON file through memorySink ------------------
await page.click('#downloadGeoJsonBtn');
await page.waitForFunction(
  () => {
    const t = document.getElementById('downloadInfo')?.textContent ?? '';
    return t.startsWith('Done:') || t.startsWith('Error') || t.startsWith('Cancelled');
  },
  undefined,
  { timeout: 120_000 },
);
const geojsonInfo = await page.textContent('#downloadInfo');
console.log('GeoJSON download:', geojsonInfo);
const geojsonResult = await page.evaluate(() => window.__cnmwLastResult ?? null);
console.log('Result object:', JSON.stringify({ rows: geojsonResult?.rows, bytes: geojsonResult?.bytes, format: geojsonResult?.format, requests: geojsonResult?.requests }));

// --- the same request through the GeoParquet writer ----------------------
await page.evaluate(() => { window.__cnmwLastResult = null; });
await page.click('#downloadGeoParquetBtn');
await page.waitForFunction(
  () => {
    const t = document.getElementById('downloadInfo')?.textContent ?? '';
    return t.startsWith('Done:') || t.startsWith('Error') || t.startsWith('Cancelled');
  },
  undefined,
  { timeout: 120_000 },
);
console.log('GeoParquet download:', await page.textContent('#downloadInfo'));
const parquetResult = await page.evaluate(() => window.__cnmwLastResult ?? null);
console.log('Result object:', JSON.stringify({ rows: parquetResult?.rows, bytes: parquetResult?.bytes, format: parquetResult?.format }));

await page.waitForTimeout(400);
await page.screenshot({ path: path.join(here, 'screenshot.png') });
console.log('Screenshot saved.');

await browser.close();

const failures = [];
if (!/Liechtenstein/i.test(areaInfo ?? '')) failures.push(`area not selected: ${areaInfo}`);
if (!/Rows:/.test(estimateInfo ?? '')) failures.push(`estimate failed: ${estimateInfo}`);
if (!geojsonResult?.rows) failures.push(`geojson download produced no rows: ${geojsonInfo}`);
if (!parquetResult?.rows) failures.push('geoparquet download produced no rows');
if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console error(s)`);

if (failures.length > 0) {
  console.error('\nFAILING:', failures.join('; '));
  process.exitCode = 1;
} else {
  console.log('\nAll download-demo checks passed.');
}
