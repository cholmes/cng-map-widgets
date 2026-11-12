#!/usr/bin/env node
// Verifies the demo against the LIVE geoboundaries-catalog manifest
// (https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json),
// the default now that examples/geocoder-demo/index.html no longer hardcodes
// ./data/index.json. This is the first real-network measurement of the
// whole stack: manifest fetch -> index load -> search -> select() ->
// geometry fetch, over the actual CDN/data.source.coop path, not localhost.
//
// Three places, one per admin level, chosen to exercise the three distinct
// code paths the task cared about:
//   - "contra costa" (ADM2, resolution 'both' -> falls back to 'full'
//     because level 2 has no display file in the live manifest)
//   - "ile-de-france" (ADM1 -- did not exist at all in the old provisional
//     local index, which had no level-1 data; this is the first time this
//     demo has ever resolved an ADM1 feature)
//   - "united kingdom" (ADM0 -- the geometry-resolver.js fix: CGAZ ADM0 has
//     no shapeID column, so this level joins on `country`/`shapeGroup`
//     instead, per the manifest's `index_key_column`)
//
// Usage: node verify-live.mjs [port]   (serve.py must be running; the page
// itself is local, but indexUrl/boundary fetches go to data.source.coop)

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? '8123';
const url = `http://localhost:${port}/examples/geocoder-demo/index.html`; // no ?index=local: live by default

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

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
const tNav0 = Date.now();
await page.goto(url, { waitUntil: 'load' });

await page.waitForSelector('input[role="combobox"]', { timeout: 15_000 });
console.log('Combobox found.', Date.now() - tNav0, 'ms after navigation start');

// The index loads lazily on focus (design call #9) -- this click is the
// cold-load trigger, fetching the LIVE manifest + the 3.6 MB names parquet
// over the real network for the first time in this run.
const tFocus = Date.now();
await page.click('input[role="combobox"]');
await page.waitForFunction(
  () => document.getElementById('status')?.textContent?.includes('Index ready'),
  { timeout: 20_000 },
);
const coldLoadMs = Date.now() - tFocus;
const loadStatus = await page.textContent('#status');
console.log(`Cold load (click -> "Index ready"): ${coldLoadMs} ms. Status: ${loadStatus}`);

async function selectPlace(query, label, expectLevel) {
  console.log(`\n=== ${label}: "${query}" (expect ADM${expectLevel}) ===`);
  await page.evaluate(() => {
    const el = document.getElementById('status');
    if (el) el.textContent = '';
  });
  await page.fill('input[role="combobox"]', '');

  const tSearch0 = Date.now();
  await page.type('input[role="combobox"]', query, { delay: 20 });
  await page.waitForSelector('li[role="option"]', { timeout: 10_000 });
  const searchMs = Date.now() - tSearch0;
  const firstOptionText = await page.textContent('li[role="option"]');
  console.log(`[${label}] search latency (type -> first option): ${searchMs} ms. First option: ${firstOptionText}`);

  await page.keyboard.press('ArrowDown');
  const activeDescendant = await page.getAttribute('input[role="combobox"]', 'aria-activedescendant');
  if (!activeDescendant) throw new Error(`[${label}] expected aria-activedescendant after ArrowDown`);

  const tSelect0 = Date.now();
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    () => document.getElementById('status')?.textContent?.includes('Selected') || document.getElementById('status')?.textContent?.includes('outline simplified'),
    { timeout: 20_000 },
  );
  const selectMs = Date.now() - tSelect0;
  const statusAfterSelect = await page.textContent('#status');
  console.log(`[${label}] select() to visible outline: ${selectMs} ms. Status: ${statusAfterSelect}`);

  const level = await page.evaluate((lvl) => {
    const m = document.getElementById('status')?.textContent?.match(/ADM(\d)/);
    return m ? Number(m[1]) : null;
  });
  if (level !== expectLevel) {
    throw new Error(`[${label}] expected ADM${expectLevel}, status reported ADM${level}: "${statusAfterSelect}"`);
  }

  const sourceData = await page.evaluate(() => {
    const map = window.__cnmwDemo.map;
    const src = map.getSource('cnmw-area-display');
    return src ? src._data : null;
  });
  if (!sourceData || sourceData.features.length === 0) {
    throw new Error(`[${label}] expected the outline source to have at least one feature after select()`);
  }
  console.log(`[${label}] outline geometry type: ${sourceData.features[0].geometry.type}`);

  // Wait (best-effort) for the background upgrade, to measure it too.
  let upgradeMs = null;
  try {
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('full detail loaded'), { timeout: 30_000 });
    upgradeMs = Date.now() - tSelect0;
    console.log(`[${label}] time-to-upgrade (select -> area:upgraded): ${upgradeMs} ms. Status: ${await page.textContent('#status')}`);
  } catch (e) {
    console.log(`[${label}] no 'area:upgraded' within 30s (expected when the level has no display file, e.g. ADM2 -- the select already returned 'full'): ${e.message}`);
  }

  return { searchMs, selectMs, upgradeMs };
}

const results = {};
results.contraCosta = await selectPlace('contra costa', 'ADM2', 2);

// GeocoderControl's own built-in attribution line (design call #11,
// geocoder-control.js's .cnmw-attribution) populates after the first
// select(), from the manifest's `attribution` array -- check it here,
// once, rather than duplicating that UI in the demo page itself.
const attributionText = await page.textContent('.cnmw-attribution');
console.log('Attribution (GeocoderControl):', attributionText);
if (!attributionText || attributionText.trim().length === 0) {
  throw new Error('Expected GeocoderControl to render a non-empty attribution line after select()');
}
if (/tge-labs|provisional mirror/i.test(attributionText)) {
  throw new Error(`Attribution still reads like the stale provisional text: "${attributionText}"`);
}

results.ileDeFrance = await selectPlace('ile-de-france', 'ADM1', 1);
results.unitedKingdom = await selectPlace('united kingdom', 'ADM0', 0);

await page.waitForTimeout(500); // let the fitBounds camera animation settle
const screenshotPath = path.join(here, 'screenshot-live.png');
await page.screenshot({ path: screenshotPath });
console.log('\nScreenshot saved to', screenshotPath);

console.log('\n=== SUMMARY (live network timings) ===');
console.log('cold load (manifest fetch -> index ready):', coldLoadMs, 'ms');
console.log(JSON.stringify(results, null, 2));
console.log('Console errors:', consoleErrors.length);
for (const e of consoleErrors) console.error(' -', e);

await browser.close();

if (consoleErrors.length > 0) {
  console.error('\nFAILING: console errors were observed.');
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
