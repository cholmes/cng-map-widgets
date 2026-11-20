#!/usr/bin/env node
// Drives the firms-explorer demo with Playwright against the REAL, live
// portolan-mirrors/firms-catalog data (data.source.coop) -- no mocking, no
// local fixtures. Exercises: dataset resolution from the collection JSON
// (source kind 'portolan-collection'), the geocoder area search, the
// required time-window picker, estimate() with its partition-prune
// narration, and a real small download. Requires network access and
// serve.py running on the given port.
//
// Usage: node verify.mjs [port]

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? '8123';
const url = `http://localhost:${port}/examples/firms-explorer/index.html`;

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

const startDate = await page.inputValue('#startDate');
const endDate = await page.inputValue('#endDate');
console.log('Default time window (last 30 days of available data):', startDate, '->', endDate);
if (!startDate || !endDate) throw new Error('Expected the default 30-day time window to be pre-filled');

// --- Area: real geocoder search for a county-sized area (same search term
// examples/geocoder-demo/verify.mjs already validates resolves to Contra
// Costa County, CA, USA, ADM2 -- a real Bay Area fire-risk area, small
// enough to keep the real download below small). A bare "california"
// collides with a Brazilian ADM2 municipality literally named
// "Califórnia" in the current geoBoundaries index (PLAN.md's noted ADM1
// data-quality gap means no US-state-level "California" is indexed yet),
// so this uses the proven, disambiguated term instead. ---
await page.click('input[role="combobox"]');
await page.waitForFunction(
  () => document.getElementById('status')?.textContent?.includes('Dataset resolved'),
  undefined,
  { timeout: 10_000 },
);
await page.type('input[role="combobox"]', 'contra costa', { delay: 30 });
await page.waitForSelector('li[role="option"]', { timeout: 10_000 });
console.log('First option:', await page.textContent('li[role="option"]'));
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('areaInfo')?.textContent?.includes('Contra Costa'), undefined, { timeout: 10_000 });
console.log('Area:', await page.textContent('#areaInfo'));

// Narrow the time window for the verification run. Two independent reasons
// not to use the live default window verbatim:
//   1. The full default 30-day window against the live, actively-appended
//      current-year partition has no usable row-group pruning (see the E6
//      report's "no narrowing" finding), so it would require reading a much
//      larger slice of the ~900MB current-year file than a verification
//      run should.
//   2. A REAL data-quality finding this run surfaced: the collection's
//      top-level `extent.temporal` end (used for the UI's default window)
//      is refreshed more often than the per-year STAC item's own
//      `start_datetime`/`end_datetime` properties, which partition-level
//      time pruning actually reads. When the two disagree (collection says
//      data extends to "today"; the year=2026 item still declares an
//      end_datetime from weeks ago), the default window can name a period
//      the item-level metadata says doesn't overlap `year=2026` at all --
//      zero files survive partition pruning, and the download legitimately
//      returns zero rows. That is this package working correctly on
//      inconsistent upstream metadata, not a bug in it; worth reporting
//      upstream, but not something to paper over here. This run instead
//      picks a window inside the year=2026 item's own declared interval
//      (2026-01-01 to 2026-09-14 at last check), so the verification
//      exercises the real download path rather than this metadata gap.
await page.fill('#startDate', '2026-09-01');
await page.fill('#endDate', '2026-09-14');
console.log('Verification-run time window (inside the year=2026 item\'s own declared interval):', '2026-09-01 -> 2026-09-14');

// --- Estimate: real, live partition enumeration + footer reads. ---
await page.click('#estimateBtn');
await page.waitForFunction(
  () => document.getElementById('estimateInfo')?.textContent?.includes('Ceiling exceeded'),
  undefined,
  { timeout: 30_000 },
);
console.log('\n=== Estimate result ===');
console.log(await page.textContent('#estimateInfo'));
console.log('\n=== Prune narration ===');
console.log(await page.textContent('#pruneInfo'));

// --- Real small download: GeoJSON, capped by the page's limit:20. FIRMS
// publishes no bbox covering column (the estimate above reports
// "no-covering"), so the engine reads row group after row group, in file
// order, until 20 rows match -- there is no index to jump straight to
// Contra Costa's detections. Measured against this exact scenario while
// building this script: 10 matches needed 45 of 515 row groups (~79MB,
// ~79s); 20 matches is comfortably inside the timeout below but genuinely
// takes tens of seconds of real network time, which is the honest cost of
// "no covering" on a real catalog, not a slow test. ---
console.log('\n=== Starting real download (GeoJSON) ===');
await page.click('#downloadGeoJsonBtn');
await page.waitForFunction(
  () => document.getElementById('downloadInfo')?.textContent?.startsWith('Done:'),
  undefined,
  { timeout: 180_000 },
);
console.log(await page.textContent('#downloadInfo'));

const result = await page.evaluate(() => window.__cngLastResult);
console.log('\n=== download() result ===');
console.log(JSON.stringify({ rows: result.rows, bytes: result.bytes, readBytes: result.readBytes, requests: result.requests, elapsedMs: result.elapsedMs }, null, 2));
if (!result || result.rows <= 0) throw new Error('Expected a real download with rows > 0');

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
