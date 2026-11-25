#!/usr/bin/env node
// Takes examples/imagery-search/screenshot.png: a search, with one scene added.
// Usage: python3 serve.py 8123 &  node examples/imagery-search/screenshot.mjs 8123 [s2|naip|oam] [out.png] [order]
//
// `order` is the text of an entry in the panel's Order menu ("Lowest cloud
// cover (%)"); with it the scene added is the first under that order.

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8123';
const key = process.argv[3] ?? 'oam';
const out = process.argv[4] ?? new URL('./screenshot.png', import.meta.url).pathname;
const order = process.argv[5];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://localhost:${port}/examples/imagery-search/index.html?collection=${key}`, { waitUntil: 'load' });
await page.waitForFunction(() => /^(ready|error):/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 120_000 });
if (order) await page.locator('.cng-is-form select').last().selectOption({ label: order });
await page.evaluate(() => window.DEMO.control.search());
await page.locator('.cng-is-card [data-role="add"]').first().click();
await page.waitForFunction(() => window.DEMO.manager.list().some((e) => e.status === 'ready' || e.status === 'error'), undefined, { timeout: 120_000 });
await page.waitForTimeout(12_000); // tiles
await page.locator('.cng-is-card').nth(1).hover().catch(() => {});
await page.screenshot({ path: out });
console.log(`wrote ${out}: ${await page.textContent('#status')}; ${await page.evaluate(() => JSON.stringify(window.DEMO.manager.list().map((e) => [e.id, e.status, e.note ?? null])))}`);
await browser.close();
