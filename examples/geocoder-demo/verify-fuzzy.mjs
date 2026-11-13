#!/usr/bin/env node
// Verifies the fuzzy-match fallback (design doc §3.2 amendment,
// 2026-11-13; adapted from Development Seed's gazet -- see
// packages/geocoder-core/src/fuzzy.js) end to end in a real browser,
// against two real indexes:
//
//   - "liechtenstien" (typo) on the LIVE geoBoundaries manifest: the
//     prefix search finds nothing, the fallback scans the full-loaded
//     52K-row index and must surface Liechtenstein, rank.matchClass
//     'fuzzy'.
//   - "brookln" (typo) on the Overture index (?index=overture, range
//     strategy): the fallback scans the eagerly-loaded 108,919-row
//     PROMINENT index -- never a range read -- and must surface Brooklyn
//     (USA), which only clears the noise because the population promotion
//     applies to fuzzy ranks too.
//   - "bag" on geoBoundaries: a 3-char query with real prefix matches --
//     asserts the fallback did NOT fire (no fuzzy matchClass anywhere).
//
// Usage: node examples/geocoder-demo/verify-fuzzy.mjs [port]
// (demo-server.py must be running on [port]; boundary/index fetches go to
// data.source.coop for geoBoundaries and localhost:8788 for Overture.)

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? '8787';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

async function openDemo(query) {
  const url = `http://localhost:${port}/examples/geocoder-demo/index.html${query}`;
  console.log('Navigating to', url);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('input[role="combobox"]', { timeout: 15_000 });
  await page.click('input[role="combobox"]');
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent?.includes('Index ready'),
    { timeout: 60_000 },
  );
  console.log('Status:', await page.textContent('#status'));
}

/** Type a query and return { options, results } once the dropdown settles
 *  (or after a grace period when no options are expected). */
async function typeAndCollect(query, { expectOptions }) {
  await page.fill('input[role="combobox"]', '');
  const t0 = Date.now();
  await page.type('input[role="combobox"]', query, { delay: 20 });
  if (expectOptions) {
    await page.waitForSelector('li[role="option"]', { timeout: 20_000 });
  } else {
    await page.waitForTimeout(2_000);
  }
  const ms = Date.now() - t0;
  // The last 'results' emission for this query, straight off the geocoder
  // -- the source of truth for rank.matchClass, which the dropdown text
  // doesn't carry.
  const results = await page.evaluate(async (q) => {
    const r = await window.__cnmwDemo.geocoder.search(q);
    return r.map((x) => ({ name: x.name, country: x.country, level: x.level, matchClass: x.rank.matchClass, similarity: x.rank.similarity }));
  }, query);
  const options = await page.$$eval('li[role="option"]', (els) => els.map((el) => el.textContent.trim()));
  console.log(`"${query}" -> ${options.length} dropdown options in ${ms} ms;`, JSON.stringify(results.slice(0, 3)));
  return { options, results };
}

// ── 1. Typo on the LIVE geoBoundaries index (full-load path) ────────────────
await openDemo('');
{
  const { options, results } = await typeAndCollect('liechtenstien', { expectOptions: true });
  const hit = results.find((r) => r.name === 'Liechtenstein');
  if (!hit) throw new Error(`"liechtenstien": expected Liechtenstein, got ${JSON.stringify(results)}`);
  if (hit.matchClass !== 'fuzzy') throw new Error(`"liechtenstien": expected matchClass 'fuzzy', got '${hit.matchClass}'`);
  if (!(hit.similarity > 0.9)) throw new Error(`"liechtenstien": expected similarity > 0.9, got ${hit.similarity}`);
  if (!options.some((o) => o.includes('Liechtenstein'))) throw new Error('Liechtenstein not visible in the dropdown');
  console.log('PASS: typo "liechtenstien" surfaces Liechtenstein as a fuzzy match (full-load index).');
}

// ── 2. Prefix matches present: the fallback must NOT fire ────────────────────
{
  const { results } = await typeAndCollect('bag', { expectOptions: true });
  if (results.length === 0) throw new Error('"bag": expected prefix results');
  const fuzzy = results.filter((r) => r.matchClass === 'fuzzy');
  if (fuzzy.length > 0) throw new Error(`"bag": fuzzy fallback fired despite prefix matches: ${JSON.stringify(fuzzy)}`);
  console.log('PASS: non-empty prefix results are never augmented with fuzzy matches.');
}

// Screenshot the geoBoundaries fuzzy dropdown for the record.
await page.fill('input[role="combobox"]', '');
await page.type('input[role="combobox"]', 'liechtenstien', { delay: 20 });
await page.waitForSelector('li[role="option"]', { timeout: 20_000 });
const screenshotPath = path.join(here, 'screenshot-fuzzy-fallback.png');
await page.screenshot({ path: screenshotPath });
console.log('Screenshot saved to', screenshotPath);

// ── 3. Typo on the Overture index (range strategy, prominent-index scan) ────
await openDemo('?index=overture');
{
  const { results } = await typeAndCollect('brookln', { expectOptions: true });
  const brooklyn = results.find((r) => r.name === 'Brooklyn' && r.country === 'USA');
  if (!brooklyn) throw new Error(`"brookln": expected Brooklyn (USA), got ${JSON.stringify(results)}`);
  if (brooklyn.matchClass !== 'fuzzy') throw new Error(`"brookln": expected matchClass 'fuzzy', got '${brooklyn.matchClass}'`);
  if (results.findIndex((r) => r === brooklyn) !== 0) {
    throw new Error(`"brookln": Brooklyn should rank first (population promotion), got ${JSON.stringify(results.slice(0, 3))}`);
  }
  console.log('PASS: typo "brookln" surfaces Brooklyn first via the prominent-index fuzzy scan (range mode).');
}

console.log('\nConsole errors:', consoleErrors.length);
for (const e of consoleErrors) console.error(' -', e);

await browser.close();

if (consoleErrors.length > 0) {
  console.error('\nFAILING: console errors were observed.');
  process.exitCode = 1;
} else {
  console.log('\nAll fuzzy-fallback checks passed.');
}
