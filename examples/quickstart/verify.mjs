#!/usr/bin/env node
// Verifies examples/quickstart/index.html against the LIVE published
// geoBoundaries gazetteer at data.source.coop. No fixtures, no local index.
//
// Then verifies the root README's quickstart block *itself*: the first
// ```html fence in README.md is extracted to a temporary file next to this
// one, served, and driven the same way. That is what lets the README claim
// its copy-paste example works -- not "a file like it" works.
//
// Usage: node examples/quickstart/verify.mjs [port]   (serve.py must be running)

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
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

// --- phase 2: the README's own quickstart block --------------------------
console.log('\n--- README.md quickstart block ---');
const readme = readFileSync(path.join(here, '..', '..', 'README.md'), 'utf8');
const fence = readme.match(/```html\n([\s\S]*?)\n```/);
const blockFailures = [];
const blockPath = path.join(here, '_readme-block.html');

if (!fence) {
  blockFailures.push('no ```html block found in README.md');
} else {
  writeFileSync(blockPath, `${fence[1]}\n`);
  try {
    const blockPage = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const blockErrors = [];
    const blockLogs = [];
    blockPage.on('pageerror', (err) => blockErrors.push(`pageerror: ${err.message}`));
    blockPage.on('console', (msg) => {
      if (msg.type() === 'error') blockErrors.push(`console.error: ${msg.text()}`);
      if (msg.type() === 'log') blockLogs.push(msg.text());
    });

    await blockPage.goto(`http://localhost:${port}/examples/quickstart/_readme-block.html`, { waitUntil: 'load' });
    await blockPage.waitForSelector('input[role="combobox"]', { timeout: 20_000 });
    await blockPage.click('input[role="combobox"]');
    await blockPage.type('input[role="combobox"]', 'contra costa', { delay: 20 });
    await blockPage.waitForSelector('li[role="option"]', { timeout: 40_000 });
    console.log('First option:', await blockPage.textContent('li[role="option"]'));
    await blockPage.keyboard.press('ArrowDown');
    await blockPage.keyboard.press('Enter');
    // The block's own `select` handler console.logs the area it received.
    await blockPage.waitForFunction(
      () => document.querySelector('.cnmw-attribution')?.textContent?.trim().length > 0,
      undefined,
      { timeout: 40_000 },
    );
    console.log('Page logged:', JSON.stringify(blockLogs));
    console.log('Attribution:', (await blockPage.textContent('.cnmw-attribution'))?.slice(0, 48), '…');

    if (!blockLogs.some((l) => /Contra Costa/.test(l))) {
      blockFailures.push("the block's select handler never logged a selected area");
    }
    blockFailures.push(...blockErrors);
    await blockPage.close();
  } finally {
    rmSync(blockPath, { force: true });
  }
}

await browser.close();

const failures = [...blockFailures.map((f) => `README block: ${f}`)];
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
