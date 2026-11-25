#!/usr/bin/env node
// Takes examples/timeline-firms/screenshot.png: the last week of fires over
// Africa, with a few months of daily bars in the track.
// Usage: python3 serve.py 8123 &  node examples/timeline-firms/screenshot.mjs 8123 [out.png]

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8123';
const out = process.argv[3] ?? new URL('./screenshot.png', import.meta.url).pathname;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://localhost:${port}/examples/timeline-firms/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => /^(ready|error):/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 180_000 });
await page.evaluate(() => window.DEMO.settle());
// The layer panel closed, so the map is the picture.
await page.evaluate(() => document.querySelector('.maplibregl-ctrl-top-right button')?.click());
await page.waitForTimeout(1500);
await page.locator('#info h1').hover();
await page.screenshot({ path: out });
console.log(`wrote ${out}: ${await page.textContent('#status')}; ${await page.textContent('.cng-tl-status')}`);
await browser.close();
