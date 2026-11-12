#!/usr/bin/env node
// Verifies examples/quickstart/index.html -- the copy-paste example the
// root README's quickstart reproduces verbatim -- against the LIVE
// published geoBoundaries gazetteer at data.source.coop. No fixtures, no
// local index: if this passes, the snippet in the README works.
//
// Usage: node examples/quickstart/verify.mjs [port]   (serve.py must be running)

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8321';
const url = `http://localhost:${port}/examples/quickstart/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

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
console.log('Combobox rendered.');

// The index loads lazily on focus (design call #9).
const t0 = Date.now();
await page.click('input[role="combobox"]');
await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Index ready'), {
  timeout: 30_000,
});
console.log(`Cold load (focus -> "Index ready"): ${Date.now() - t0} ms`);
console.log('Status:', await page.textContent('#status'));

await page.type('input[role="combobox"]', 'contra costa', { delay: 20 });
await page.waitForSelector('li[role="option"]', { timeout: 15_000 });
const firstOption = await page.textContent('li[role="option"]');
console.log('First option:', firstOption);

await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('ADM'), {
  timeout: 30_000,
});
const selectStatus = await page.textContent('#status');
console.log('After select:', selectStatus);

const outline = await page.evaluate(() => {
  const src = window.__cnmwQuickstart.map.getSource('cnmw-area-display');
  const data = src?._data;
  return data ? { features: data.features.length, type: data.features[0]?.geometry?.type } : null;
});
console.log('Outline source:', JSON.stringify(outline));

const attribution = (await page.textContent('.cnmw-attribution'))?.trim();
console.log('Attribution:', attribution);

await page.waitForTimeout(600); // let fitBounds settle
await page.screenshot({ path: new URL('./screenshot.png', import.meta.url).pathname });
console.log('Screenshot saved.');

await browser.close();

const failures = [];
if (!outline || outline.features === 0) failures.push('no outline feature after select()');
if (!/Contra Costa/i.test(selectStatus ?? '')) failures.push(`unexpected status after select: ${selectStatus}`);
if (!attribution) failures.push('empty attribution line');
if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console error(s)`);

if (failures.length > 0) {
  console.error('\nFAILING:', failures.join('; '));
  process.exitCode = 1;
} else {
  console.log('\nAll quickstart checks passed.');
}
