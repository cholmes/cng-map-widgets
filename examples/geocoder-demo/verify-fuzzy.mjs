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
  // doesn't carry. On a range-mode index this evaluate()'s search can race
  // the widget's own debounced keystroke search: whichever starts last
  // supersedes the other, and a superseded search resolves [] by contract.
  // So when options are expected, retry an empty answer a few times until
  // the widget has settled and our search is the last one standing.
  let results = [];
  for (let attempt = 0; attempt < (expectOptions ? 6 : 1); attempt += 1) {
    results = await page.evaluate(async (q) => {
      const r = await window.__cnmwDemo.geocoder.search(q);
      return r.map((x) => ({ name: x.name, country: x.country, level: x.level, matchClass: x.rank.matchClass, similarity: x.rank.similarity }));
    }, query);
    if (results.length > 0 || !expectOptions) break;
    await page.waitForTimeout(1_000);
  }
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
  const strayNote = await page.$('li.cnmw-fuzzy-note');
  if (strayNote) throw new Error('"bag": fuzzy caption rendered on prefix results');
  console.log('PASS: no fuzzy caption on prefix results.');
}

// Screenshot the geoBoundaries fuzzy dropdown for the record, and assert the
// "close matches" caption renders above fuzzy results (and only there).
await page.fill('input[role="combobox"]', '');
await page.type('input[role="combobox"]', 'liechtenstien', { delay: 20 });
await page.waitForSelector('li[role="option"]', { timeout: 20_000 });
{
  const note = await page.textContent('li.cnmw-fuzzy-note');
  if (!note || !note.includes('close matches')) {
    throw new Error(`fuzzy caption missing or wrong: ${JSON.stringify(note)}`);
  }
  const noteRole = await page.getAttribute('li.cnmw-fuzzy-note', 'role');
  if (noteRole !== 'presentation') throw new Error(`fuzzy caption role should be presentation, got ${noteRole}`);
  console.log('PASS: fuzzy caption "No exact matches — showing close matches." renders with role=presentation.');
  // Keyboard sanity with the caption present: ArrowDown must select the first
  // real option, not the caption row.
  await page.keyboard.press('ArrowDown');
  const active = await page.getAttribute('input[role="combobox"]', 'aria-activedescendant');
  if (!active || !active.includes('-option-0')) {
    throw new Error(`ArrowDown with caption present should activate option 0, got ${active}`);
  }
  console.log('PASS: keyboard navigation skips the caption row.');
}
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

// ── 4. The LIVE Who's On First catalog (range strategy + eager prominent) ───
// Published 2026-11-13 with names/wof_names_prominent.parquet (285,735 rows,
// english_guarantee): the file this fuzzy scan reads in range mode.
await openDemo('?index=wof');
{
  const { options, results } = await typeAndCollect('liechtenstien', { expectOptions: true });
  const hit = results.find((r) => r.name === 'Liechtenstein');
  if (!hit) throw new Error(`WOF "liechtenstien": expected Liechtenstein, got ${JSON.stringify(results)}`);
  if (hit.matchClass !== 'fuzzy') throw new Error(`WOF "liechtenstien": expected matchClass 'fuzzy', got '${hit.matchClass}'`);
  if (!options.some((o) => o.includes('Liechtenstein'))) throw new Error('WOF: Liechtenstein not visible in the dropdown');
  console.log('PASS: typo "liechtenstien" surfaces Liechtenstein via the live WOF prominent index (range mode).');
  const wofShot = path.join(here, 'screenshot-fuzzy-wof.png');
  await page.screenshot({ path: wofShot });
  console.log('Screenshot saved to', wofShot);
}
{
  // WOF's 9.5M names include a real locality literally spelled "Bagdhad"
  // (India), so this typo is an EXACT match there and the fallback must
  // stay out of the way -- the sharpest live proof of the zero-results
  // trigger condition.
  const { results } = await typeAndCollect('bagdhad', { expectOptions: true });
  if (results.length === 0) throw new Error('WOF "bagdhad": expected prefix/exact results');
  if (results.some((r) => r.matchClass === 'fuzzy')) {
    throw new Error(`WOF "bagdhad": fuzzy fired despite real matches: ${JSON.stringify(results.slice(0, 3))}`);
  }
  console.log('PASS: "bagdhad" is a real WOF place (exact match) and the fallback correctly stays silent.');
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
