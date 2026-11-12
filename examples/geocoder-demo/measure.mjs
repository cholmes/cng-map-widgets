#!/usr/bin/env node
// Speed-pass measurement script (client-side speed pass task): cold-load,
// first-suggestion, select-to-outline per level, and request counts/bytes
// (with a Content-Range-aware byte count -- see below -- so a HEAD or a
// CDN that echoes the full resource size in Content-Length on a 206
// doesn't inflate the numbers). Mirrors verify-live.mjs's approach but
// adds network accounting and is parameterized by indexUrl/queries so the
// same script runs against either the live geoBoundaries-catalog manifest
// or a local/staging one (e.g. the Overture names index on :8788) --
// run it once before a change and once after to compare, or just once to
// see current numbers. Not wired into `npm test`; it is a measurement
// tool, not a pass/fail check.
//
// Usage: node measure.mjs <port> [indexUrl|LIVE] <label> <query1:level1> [query2:level2 ...]
// Example: node measure.mjs 8787 LIVE geoboundaries "contra costa:2" "ile-de-france:1" "united kingdom:0"
//          node measure.mjs 8787 http://localhost:8788/names/index.json overture "zurich:1" "paris:2"

import { chromium } from 'playwright';

const [, , portArg, indexUrlArg, labelArg, ...queryArgs] = process.argv;
const port = portArg ?? '8787';
const indexUrl = indexUrlArg === 'LIVE' ? null : indexUrlArg;
const label = labelArg ?? 'run';
const queries = queryArgs.map((q) => {
  const [query, level] = q.split(':');
  return { query, level: Number(level) };
});

const base = `http://localhost:${port}/examples/geocoder-demo/index.html`;
const url = indexUrl ? `${base}?index=${encodeURIComponent(indexUrl)}` : base;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

const netLog = [];
page.on('response', async (res) => {
  try {
    const req = res.request();
    const headers = res.headers();
    // Prefer Content-Range's own span (the actual bytes this particular
    // response carried) over Content-Length: some CDNs echo the full
    // resource size in Content-Length even on a 206 Partial Content
    // response, which would silently misreport every ranged fetch as a
    // full-file read.
    const method = req.method();
    const range = headers['content-range'];
    let bytes;
    if (method === 'HEAD') {
      bytes = 0; // a HEAD's Content-Length states the full resource size but transfers no body
    } else {
      const m = range && /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(range);
      if (m) bytes = Number(m[2]) - Number(m[1]) + 1;
      else bytes = Number(headers['content-length'] ?? 0);
    }
    netLog.push({ url: req.url(), method, status: res.status(), bytes, range: range ?? null, resourceType: req.resourceType() });
  } catch {
    // ignore races on page navigation/teardown
  }
});

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

function netSince(markIndex) {
  const slice = netLog.slice(markIndex);
  const relevant = slice.filter((r) => /\.parquet|index\.json/.test(r.url));
  return {
    requests: relevant.length,
    bytes: relevant.reduce((s, r) => s + r.bytes, 0),
    files: relevant.map((r) => ({ url: r.url.split('/').pop(), method: r.method, bytes: r.bytes, range: r.range })),
  };
}

await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('input[role="combobox"]', { timeout: 15_000 });

const markLoad = netLog.length;
const tFocus = Date.now();
await page.click('input[role="combobox"]');
await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Index ready'), { timeout: 30_000 });
const coldLoadMs = Date.now() - tFocus;
const loadStatus = await page.textContent('#status');
const loadNet = netSince(markLoad);

const results = [];
for (const { query, level } of queries) {
  await page.evaluate(() => { const el = document.getElementById('status'); if (el) el.textContent = ''; });
  await page.fill('input[role="combobox"]', '');

  const markSearch = netLog.length;
  const tSearch0 = Date.now();
  await page.type('input[role="combobox"]', query, { delay: 15 });
  await page.waitForSelector('li[role="option"]', { timeout: 10_000 });
  const firstSuggestionMs = Date.now() - tSearch0;
  const firstOption = await page.textContent('li[role="option"]');
  const searchNet = netSince(markSearch);

  await page.keyboard.press('ArrowDown');
  const markSelect = netLog.length;
  const tSelect0 = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent?.includes('Selected') || document.getElementById('status')?.textContent?.includes('outline simplified'),
    { timeout: 20_000 },
  );
  const selectToOutlineMs = Date.now() - tSelect0;
  const statusAfterSelect = await page.textContent('#status');
  const selectNet = netSince(markSelect);

  let upgradeMs = null;
  try {
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('full detail loaded'), { timeout: 15_000 });
    upgradeMs = Date.now() - tSelect0;
  } catch {
    // no display/full split for this level, or it's slow: fine, reported as null
  }

  results.push({ query, level, firstOption, firstSuggestionMs, selectToOutlineMs, upgradeMs, statusAfterSelect, searchNet, selectNet });
}

await browser.close();

console.log(JSON.stringify({
  label,
  url,
  coldLoadMs,
  loadStatus,
  loadNet,
  results,
  consoleErrors,
}, null, 2));
