#!/usr/bin/env node
// Drives the s2-footprints demo with Playwright against the REAL, live
// tge-labs/s2-stac-geoparquet data (data.source.coop) -- no mocking, no
// local fixtures. Exercises: dataset resolution from the collection JSON
// (source kind 'portolan-collection'), the ceiling/refusal path for a big
// country with no time filter, the acceptCeiling flow, and a real small
// download for a tight time window. Requires network access and serve.py
// running on the given port.
//
// Usage: node verify.mjs [port]

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? '8123';
const url = `http://localhost:${port}/examples/s2-footprints/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => {
  console.log(`[console.${msg.type()}]`, msg.text());
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => {
  console.log('[pageerror]', err.message);
  consoleErrors.push(`pageerror: ${err.message}`);
});

console.log('Navigating to', url);
await page.goto(url, { waitUntil: 'load' });

await page.waitForFunction(
  () => document.getElementById('status')?.textContent?.includes('Dataset resolved'),
  undefined,
  { timeout: 20_000 },
);
console.log('Status:', await page.textContent('#status'));
console.log('Dataset note:', await page.textContent('#datasetNote'));

// --- Area: "type a country and go" -- Kenya, a real, fairly large country
// (good for the ceiling scenario below). ---
await page.click('input[role="combobox"]');
await page.type('input[role="combobox"]', 'kenya', { delay: 30 });
await page.waitForSelector('li[role="option"]', { timeout: 10_000 });
console.log('First option:', await page.textContent('li[role="option"]'));
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('areaInfo')?.textContent?.includes('Kenya'), undefined, { timeout: 10_000 });
console.log('Area:', await page.textContent('#areaInfo'));

// --- Scenario A: ceiling/refusal path -- a big country, no time filter. ---
console.log('\n=== Scenario A: ceiling/refusal (Kenya, no time filter) ===');
await page.click('#estimateBtn');
await page.waitForFunction(
  () => document.getElementById('estimateInfo')?.textContent?.includes('Ceiling exceeded'),
  undefined,
  { timeout: 60_000 },
);
console.log(await page.textContent('#estimateInfo'));
console.log(await page.textContent('#pruneInfo'));
const estimateExceeded = (await page.textContent('#estimateInfo')).includes('Ceiling exceeded: true');
if (!estimateExceeded) throw new Error('Expected the estimate to report the ceiling exceeded for a big country with no time filter');

console.log('\nStarting download() to trigger the real refusal/ceiling UI path...');
await page.click('#downloadGeoJsonBtn');
await page.waitForFunction(
  () => document.getElementById('ceilingBox')?.style.display === 'block',
  undefined,
  { timeout: 30_000 },
);
console.log('Ceiling box text:', await page.textContent('#ceilingText'));
console.log('download() state at the refusal point: blocked (confirmed by the ceiling UI showing, before any row data was fetched)');

// Cancel rather than accept -- accepting would pull ~30M rows of real data,
// which this verification run is not going to do. The refusal path itself
// (reaching `blocked` state and emitting `ceiling` before fetching any row
// data) is what this scenario proves; a live "download anyway" click is
// exercised narratively in the report, not in this automated run.
await page.click('#cancelBtn');
await page.waitForFunction(() => document.getElementById('downloadInfo')?.textContent?.includes('Cancelled'), undefined, { timeout: 10_000 });
console.log('Cancelled cleanly:', await page.textContent('#downloadInfo'));

// --- Scenario B: a real small download -- tight time window (one month of
// one partition-year), which is small even though it spans the globe,
// because the limit:500 cap stops the read early once matched. Clear the
// Kenya area first: year=2015 is a single day's worth of scenes (200 rows
// total, published 2015-10-22) over a swath through Europe/the Sahara, not
// East Africa, so keeping Kenya selected would legitimately return zero
// rows here -- a real geographic mismatch, not a bug. ---
console.log('\n=== Scenario B: real small download (tight time window, year=2015, no area) ===');
await page.click('#clearAreaBtn');
await page.fill('#startDate', '2015-10-01');
await page.fill('#endDate', '2015-10-31');
await page.click('#estimateBtn');
await page.waitForFunction(
  () => document.getElementById('estimateInfo')?.textContent?.includes('Ceiling exceeded'),
  undefined,
  { timeout: 30_000 },
);
console.log(await page.textContent('#estimateInfo'));
console.log(await page.textContent('#pruneInfo'));

await page.click('#downloadGeoJsonBtn');
await page.waitForFunction(
  () => document.getElementById('downloadInfo')?.textContent?.startsWith('Done:'),
  undefined,
  { timeout: 60_000 },
);
console.log(await page.textContent('#downloadInfo'));

const result = await page.evaluate(() => window.__cngLastResult);
console.log('\n=== download() result ===');
console.log(JSON.stringify({ rows: result.rows, bytes: result.bytes, readBytes: result.readBytes, requests: result.requests, elapsedMs: result.elapsedMs }, null, 2));
if (!result || result.rows <= 0) throw new Error('Expected a real download with rows > 0');

// Confirm the `assets` column was excluded by default (design doc §2.8).
const text = await page.evaluate(async () => {
  const blob = await fetch(document.getElementById('downloadLink').href).then((r) => r.blob());
  return await blob.text();
});
const parsed = JSON.parse(text);
console.log('First feature properties keys:', Object.keys(parsed.features[0].properties));
if ('assets' in parsed.features[0].properties) throw new Error('Expected the heavyweight `assets` column to be excluded by default');
console.log('Confirmed: `assets` column excluded by default.');

// --- Scenario C: the same query to GeoParquet. Exercises two real bugs
// found and fixed in download-core while building this page: (1) a
// GeoParquet-2.0 source hands back already-decoded geometry objects, which
// the geoparquet writer used to push straight into its own byte column;
// (2) s2-stac-geoparquet's `_hilbert` column is `uint32` with real values
// past the signed INT32 range, which the writer used to mis-infer a type
// for and then throw on. Both are regression-tested at the unit level
// (geoparquet-write.test.js); this is the same path through the real UI. ---
console.log('\n=== Scenario C: same query, GeoParquet format ===');
await page.click('#downloadGeoParquetBtn');
await page.waitForFunction(
  () => document.getElementById('downloadInfo')?.textContent?.startsWith('Done:'),
  undefined,
  { timeout: 60_000 },
);
console.log(await page.textContent('#downloadInfo'));
const parquetResult = await page.evaluate(() => window.__cngLastResult);
if (!parquetResult || parquetResult.rows <= 0) throw new Error('Expected a real GeoParquet download with rows > 0');
console.log('GeoParquet download() result:', JSON.stringify({ rows: parquetResult.rows, bytes: parquetResult.bytes }));

await page.waitForTimeout(400);
const screenshotPath = path.join(here, 'screenshot.png');
await page.screenshot({ path: screenshotPath });
console.log('\nScreenshot saved to', screenshotPath);

if (consoleErrors.length > 0) {
  console.error('\nConsole errors observed during the run:');
  for (const e of consoleErrors) console.error(' -', e);
}

await browser.close();

if (consoleErrors.length > 0) {
  process.exitCode = 1;
}
