#!/usr/bin/env node
// Takes examples/catalog-search/screenshot.png: a search of the live registry
// over Berlin, with one found collection added to the map.
// Usage: python3 serve.py 8123 &  node examples/catalog-search/screenshot.mjs 8123 [out.png]

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8123';
const out = process.argv[3] ?? new URL('./screenshot.png', import.meta.url).pathname;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://localhost:${port}/examples/catalog-search/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => /^(ready|error):/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 120_000 });
await page.evaluate(async () => {
  const D = window.DEMO;
  D.map.jumpTo({ center: [13.405, 52.52], zoom: 12.2 });
  await D.settle();
  document.querySelector('.cng-cs-check input').click();
  await D.control.search('bäume');
});
// One of Berlin's tree inventories (the first card that mentions street trees): a layer that shows at this zoom.
await page.locator('.cng-cs-card', { hasText: 'Straßenbäume' }).first().locator('[data-role="add"]').click();
await page.waitForFunction(() => window.DEMO.manager.list().some((e) => e.status === 'ready' || e.status === 'error'), undefined, { timeout: 120_000 });
await page.evaluate(() => window.DEMO.settle());
await page.waitForTimeout(4000);
await page.locator('#info h1').hover(); // nothing hovered: no extent drawn over the picture
await page.screenshot({ path: out });
console.log(`wrote ${out}: ${await page.textContent('#status')}; ${await page.evaluate(() => JSON.stringify(window.DEMO.manager.list().map((e) => [e.title, e.status])))}`);
await browser.close();
