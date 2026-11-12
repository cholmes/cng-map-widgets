#!/usr/bin/env node
// Drives the geocoder-demo with Playwright: type "contra costa", pick the
// first result, wait for the outline, screenshot. Used once to produce
// examples/geocoder-demo/screenshot.png as verification evidence (not part
// of `npm test`; requires serve.py running on the given port).
//
// Usage: node verify.mjs [port]

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? '8123';
const url = `http://localhost:${port}/examples/geocoder-demo/index.html`;

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
await page.goto(url, { waitUntil: 'load' });

await page.waitForSelector('input[role="combobox"]', { timeout: 10_000 });
console.log('Combobox found.');

// The index loads lazily on focus (design call #9), not on page load --
// so focus the input first, *then* wait for the "Index ready" status.
await page.click('input[role="combobox"]');
await page.waitForFunction(
  () => document.getElementById('status')?.textContent?.includes('Index ready'),
  { timeout: 15_000 },
);
console.log('Status:', await page.textContent('#status'));

await page.type('input[role="combobox"]', 'contra costa', { delay: 30 });

await page.waitForSelector('li[role="option"]', { timeout: 10_000 });
const firstOptionText = await page.textContent('li[role="option"]');
console.log('First option:', firstOptionText);

// Keyboard-driven selection, exercising the ARIA combobox's arrow+enter path.
await page.keyboard.press('ArrowDown');
const activeDescendant = await page.getAttribute('input[role="combobox"]', 'aria-activedescendant');
console.log('aria-activedescendant after ArrowDown:', activeDescendant);
if (!activeDescendant) throw new Error('Expected aria-activedescendant to be set after ArrowDown');

await page.keyboard.press('Enter');

await page.waitForFunction(
  () => document.getElementById('status')?.textContent?.includes('Selected'),
  { timeout: 10_000 },
);
console.log('Status after select:', await page.textContent('#status'));

// Confirm the outline layer actually has geometry data (not just that the
// status text changed).
const sourceData = await page.evaluate(() => {
  const map = window.__cnmwDemo.map;
  const src = map.getSource('cnmw-area-display');
  return src ? src._data : null;
});
if (!sourceData || sourceData.features.length === 0) {
  throw new Error('Expected the outline source to have at least one feature after select()');
}
console.log('Outline feature geometry type:', sourceData.features[0].geometry.type);

await page.waitForTimeout(600); // let the fitBounds camera animation settle

const screenshotPath = path.join(here, 'screenshot.png');
await page.screenshot({ path: screenshotPath });
console.log('Screenshot saved to', screenshotPath);

if (consoleErrors.length > 0) {
  console.error('Console errors observed during the run:');
  for (const e of consoleErrors) console.error(' -', e);
}

await browser.close();

if (consoleErrors.length > 0) {
  process.exitCode = 1;
}
