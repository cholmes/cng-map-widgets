#!/usr/bin/env node
// Drives examples/raster-demo with Playwright against REAL, live data:
//   * the published geoBoundaries gazetteer (data.source.coop) for the area,
//   * a real Sentinel-2 L2A COG on AWS Open Data (sentinel-cogs, CORS *,
//     Accept-Ranges: bytes) for the pixels, via its Earth Search STAC Item.
// No mocking, no local fixtures: geotiff.js is loaded from its pinned CDN
// URL by @cnmw/raster-core at runtime, exactly as a zero-build consumer
// would get it.
//
// What it proves, in the browser:
//   1. openRaster() describes the COG from its header (size/dtype/CRS/
//      overviews/tiles) in one or two range reads;
//   2. bands come from the item's eo:bands/raster:bands metadata;
//   3. a county-sized area at native resolution BREACHES the memory ceiling
//      and is refused (the refusal path, not a crash);
//   4. a map-view-sized area estimates, then downloads a real multi-band
//      uint16 GeoTIFF, which the page reads back with geotiff.js and draws;
//   5. the bytes fetched are a small fraction of the source files.
//
// Usage: node examples/raster-demo/verify.mjs [port]   (serve.py must be running)
// Writes: examples/raster-demo/screenshot.png
//         examples/raster-demo/clip.tif  (when --keep-tif is passed)

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv.find((a) => /^\d+$/.test(a)) ?? '8123';
const keepTif = process.argv.includes('--keep-tif');
const url = `http://localhost:${port}/examples/raster-demo/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1340, height: 940 } });

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

// Record every response from the COG host, independently of what the page
// claims, so a "windowed read" that quietly downloaded whole files cannot
// pass. Playwright's header view of a 206 is unreliable for size, so the
// authoritative number comes from the browser's own Resource Timing
// (transferSize) at the end.
const cogResponses = [];
page.on('response', (res) => {
  if (!/sentinel-cogs|data\.source\.coop/.test(res.url())) return;
  if (!/\.tif/.test(res.url())) return;
  cogResponses.push({
    method: res.request().method(),
    status: res.status(),
    range: res.headers()['content-range'] ?? null,
    length: Number(res.headers()['content-length'] ?? 0),
  });
});

console.log('Navigating to', url);
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('#openBtn');

// --- 1. open the real COG ------------------------------------------------
await page.click('#openBtn');
await page.waitForFunction(
  () => /header read in|Error/.test(document.getElementById('sourceInfo').textContent),
  undefined,
  { timeout: 60_000 },
);
const sourceInfo = await page.textContent('#sourceInfo');
console.log('--- source ---\n' + sourceInfo);

const bands = await page.$$eval('input.band', (els) => els.map((e) => e.value));
console.log('bands offered:', bands.join(', '));

// --- 2. a county-sized area: the ceiling must refuse ---------------------
await page.waitForSelector('input[role="combobox"]', { timeout: 30_000 });
await page.click('input[role="combobox"]');
await page.type('input[role="combobox"]', 'alameda', { delay: 20 });
await page.waitForSelector('li[role="option"]', { timeout: 40_000 });
console.log('first suggestion:', await page.textContent('li[role="option"]'));
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => !document.getElementById('areaInfo').textContent.startsWith('Search for a place'),
  undefined,
  { timeout: 60_000 },
);
console.log('area:', (await page.textContent('#areaInfo')).replace(/\n/g, ' | '));

await page.click('#estimateBtn');
await page.waitForFunction(
  () => /px x|Error/.test(document.getElementById('estimateInfo').textContent),
  undefined,
  { timeout: 60_000 },
);
const bigEstimate = await page.textContent('#estimateInfo');
console.log('--- county-sized estimate ---\n' + bigEstimate);
const ceilingVisible = await page.isVisible('#ceilingBox');
const ceilingText = ceilingVisible ? await page.textContent('#ceilingText') : '';
console.log('ceiling shown:', ceilingVisible, '|', ceilingText.trim().slice(0, 160));

// --- 3. a map-view-sized area: estimate, then really download ------------
await page.evaluate(() => {
  window.__cnmwLastResult = null;
  // a ~9 x 11 km window over Oakland -- the window E11 validated with GDAL
  window.map.jumpTo({ center: [-122.25, 37.8], zoom: 12.4 });
});
await page.waitForTimeout(800);
await page.click('#useViewBtn');
await page.click('#estimateBtn');
await page.waitForFunction(
  () => /px x|Error/.test(document.getElementById('estimateInfo').textContent),
  undefined,
  { timeout: 60_000 },
);
const estimateInfo = await page.textContent('#estimateInfo');
console.log('--- map-view estimate ---\n' + estimateInfo);
const estimateObj = await page.evaluate(() => window.__cnmwLastEstimate);

await page.click('#downloadBtn');
await page.waitForFunction(
  () => /^(Done:|Error|Cancelled)/.test(document.getElementById('downloadInfo').textContent),
  undefined,
  { timeout: 180_000 },
);
const downloadInfo = await page.textContent('#downloadInfo');
console.log('--- download ---\n' + downloadInfo);
const result = await page.evaluate(() => window.__cnmwLastResult);
console.log('result:', JSON.stringify({
  filename: result?.filename, bytes: result?.bytes, width: result?.width, height: result?.height,
  bands: result?.bands, dtype: result?.dtype, epsg: result?.epsg, requests: result?.requests,
  readBytes: result?.readBytes, elapsedMs: result?.elapsedMs,
}));
const previewVisible = await page.isVisible('#preview');
console.log('preview drawn (page re-read its own GeoTIFF):', previewVisible);
const timing = await page.evaluate(() =>
  performance
    .getEntriesByType('resource')
    .filter((e) => /\.tif/.test(e.name))
    .reduce((acc, e) => ({ requests: acc.requests + 1, transferred: acc.transferred + (e.transferSize || 0), encoded: acc.encoded + (e.encodedBodySize || 0) }), { requests: 0, transferred: 0, encoded: 0 }),
);
console.log(`network to the COG host (Resource Timing): ${timing.requests} requests, ` +
  `${(timing.transferred / 1e6).toFixed(2)} MB transferred, ${(timing.encoded / 1e6).toFixed(2)} MB body`);
const gets = cogResponses.filter((r) => r.method === 'GET');
const partial = gets.filter((r) => r.status === 206).length;
console.log(`responses: ${cogResponses.length} total, ${gets.length} GETs, ${partial} of those 206 Partial Content`);
console.log('first ranges:', cogResponses.slice(0, 4).map((r) => r.range).join(' | '));

if (keepTif) {
  const b64 = await page.evaluate(async () => {
    const href = document.getElementById('downloadLink').href;
    const buf = new Uint8Array(await (await fetch(href)).arrayBuffer());
    let s = '';
    for (const byte of buf) s += String.fromCharCode(byte);
    return btoa(s);
  });
  fs.writeFileSync(path.join(here, 'clip.tif'), Buffer.from(b64, 'base64'));
  console.log('wrote', path.join(here, 'clip.tif'), '- run gdalinfo on it');
}

// Scroll the panel so the committed screenshot shows what matters: the
// estimate, the download result and the preview the page drew by reading
// its own GeoTIFF back.
await page.evaluate(() => {
  const panel = document.getElementById('panel');
  panel.scrollTop = panel.scrollHeight;
});
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(here, 'screenshot.png') });
console.log('Screenshot saved.');
await browser.close();

const failures = [];
if (!/UInt16|uint16/.test(sourceInfo)) failures.push('source not described as uint16');
if (!/overviews/.test(sourceInfo)) failures.push('overviews not reported');
if (!bands.includes('B04')) failures.push(`bands not from eo:bands: ${bands}`);
if (!ceilingVisible) failures.push('a county-sized native-resolution clip did not breach the ceiling');
if (!estimateObj?.decodedBytes?.exact) failures.push('estimate decodedBytes not exact');
if (!result?.bytes) failures.push(`download produced nothing: ${downloadInfo}`);
if (result && result.dtype !== 'uint16') failures.push(`dtype ${result.dtype}`);
if (result && result.epsg !== 32610) failures.push(`epsg ${result.epsg}`);
if (result && result.bands.length < 2) failures.push(`only ${result.bands.length} band(s)`);
if (result && result.readBytes > 40e6) failures.push(`read ${result.readBytes} bytes -- windowing is not working`);
if (!result?.readBytes) failures.push('the result reported no bytes read');
// NOTE: Resource Timing reports 0 bytes for these responses -- S3 sends no
// Timing-Allow-Origin, so transferSize is opaque cross-origin. The honest
// in-page number is raster-core's own counter (result.readBytes), which
// counts decoded ArrayBuffer bytes, and the 206 check below proves the
// reads were partial.
if (partial !== gets.length) failures.push(`${gets.length - partial} GET(s) were not 206 Partial Content`);
if (result && result.naiveBytes / result.readBytes < 10) failures.push('less than 10x better than a full download');
if (!previewVisible) failures.push('the written GeoTIFF could not be read back and drawn');
if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console error(s)`);

if (failures.length > 0) {
  console.error('\nFAILING:', failures.join('; '));
  process.exitCode = 1;
} else {
  console.log('\nAll raster-demo checks passed.');
}
