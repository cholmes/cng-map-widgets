#!/usr/bin/env node
// Verifies the "upgradeDisplay" feature (design doc §1.3/§3.2 amendment,
// 2026-11-13) for real, with Playwright, against the LIVE
// geoboundaries-catalog -- the same catalog/countries verify-progressive.mjs
// already stress-tests for the underlying (pre-amendment) progressive
// select() fix. This script is specifically about what's NEW:
//
//   1. 'area:upgrading' shows a "Loading full detail… ~N vertices" notice
//      with a Cancel button, attached to the GeocoderControl.
//   2. Clicking Cancel calls geocoder.cancelUpgrade(): the outline stays
//      the simplified display geometry, 'area:upgraded' never fires for
//      that selection, and the notice announces "Keeping simplified
//      outline."
//   3. Left alone, the notice becomes "Full detail loaded." and the
//      MapLibre source's actual GeoJSON data swaps to the full-resolution
//      geometry -- checked by vertex count, not just a status-line string.
//   4. The swap itself never produces a long task over the budget, even
//      for Canada (528,021 raw vertices) -- this is the thing `scheduleIdle`
//      deferral in geocoder-control.js exists to guarantee.
//
// Screenshots examples/geocoder-demo/screenshot-upgrade-notice.png
// (committed) mid-upgrade, notice visible.
//
// Usage: node verify-upgrade-display.mjs [port]   (serve.py must be running)

const LONG_TASK_BUDGET_MS = 1500;
const UPGRADE_WAIT_MS = 90_000;

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
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.addInitScript(() => {
  window.__longTasks = [];
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
    });
    obs.observe({ type: 'longtask', buffered: true });
  } catch (e) {
    window.__longTasksUnsupported = String(e);
  }
});

console.log('Navigating to', url);
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('input[role="combobox"]', { timeout: 10_000 });
await page.click('input[role="combobox"]');
await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Index ready'), { timeout: 15_000 });
console.log('Status:', await page.textContent('#status'));

/** @returns {Promise<{ vertexCount: number, type: string }>} the display source's current geometry. */
async function readOutlineVertexCount() {
  return page.evaluate(() => {
    const src = window.__cngDemo.map.getSource('cng-area-display');
    const geom = src?._data?.features?.[0]?.geometry;
    if (!geom) return { vertexCount: 0, type: null };
    const countRings = (poly) => poly.reduce((n, ring) => n + ring.length, 0);
    const n = geom.type === 'Polygon' ? countRings(geom.coordinates) : geom.coordinates.reduce((n, poly) => n + countRings(poly), 0);
    return { vertexCount: n, type: geom.type };
  });
}

async function select(query) {
  await page.evaluate(() => {
    const el = document.getElementById('status');
    if (el) el.textContent = '';
  });
  await page.fill('input[role="combobox"]', '');
  await page.type('input[role="combobox"]', query, { delay: 20 });
  await page.waitForSelector('li[role="option"]', { timeout: 10_000 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

const notice = () => page.locator('.cng-upgrade-notice');
const noticeCancel = () => page.locator('.cng-upgrade-notice-cancel');

/**
 * Poll for the notice's text to match `pattern`, rather than merely
 * "visible" -- a *previous* selection's transient "Full detail loaded."
 * message can still be on screen (it auto-hides after ~2.6s) at the exact
 * moment a new selection's own 'select'/'area:upgrading' events haven't
 * fired yet (both wait on the new selection's own display-geometry fetch),
 * so "visible" alone can observe stale, leftover text from the one before.
 */
async function waitForNoticeText(pattern, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await notice().textContent().catch(() => null))?.trim() ?? null;
    if (last && pattern.test(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`notice text never matched ${pattern}; last seen: ${JSON.stringify(last)}`);
}

// --- Test 1: UK -- notice appears, estimate shown, un-cancelled flow swaps
//     the outline (vertex count via the map source data), long-task budget.
console.log('\n=== UK: notice appears, un-cancelled upgrade swaps the outline ===');
await select('united kingdom');

const noticeTextDuringUpgrade = await waitForNoticeText(/Loading full detail/);
console.log('notice text while upgrading:', JSON.stringify(noticeTextDuringUpgrade));
const cancelVisible = await noticeCancel().isVisible();
console.log('cancel button visible while upgrading:', cancelVisible);
if (!cancelVisible) throw new Error('expected the Cancel affordance to be visible while an upgrade is in flight');

const beforeUpgrade = await readOutlineVertexCount();
console.log('outline vertex count before upgrade:', beforeUpgrade);

// Screenshot the notice mid-upgrade -- committed to the repo per the task.
await page.waitForTimeout(150);
const noticeScreenshotPath = path.join(here, 'screenshot-upgrade-notice.png');
await page.screenshot({ path: noticeScreenshotPath });
console.log('notice screenshot saved to', noticeScreenshotPath);

await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('full detail loaded'), { timeout: UPGRADE_WAIT_MS });
console.log('status after upgrade:', await page.textContent('#status'));

// The notice's transient "Full detail loaded." message, before it
// auto-hides (~2.6s) -- poll briefly rather than assume the exact timing.
let afterUpgradeText = null;
for (let i = 0; i < 20 && afterUpgradeText === null; i++) {
  const t = (await notice().textContent())?.trim();
  if (t && t.includes('Full detail loaded')) afterUpgradeText = t;
  else await page.waitForTimeout(100);
}
console.log('notice text right after upgrade:', JSON.stringify(afterUpgradeText));
if (!afterUpgradeText) throw new Error('expected the notice to say "Full detail loaded." right after the upgrade');

// The actual map-source swap is deferred one idle slot behind the
// 'area:upgraded' event (geocoder-control.js's `scheduleIdle` --
// deliberately: see the design doc amendment / this package's README for
// why), so poll for it rather than assume it's already landed the instant
// the status line says "full detail loaded".
let afterUpgrade = await readOutlineVertexCount();
for (let i = 0; i < 20 && afterUpgrade.vertexCount <= beforeUpgrade.vertexCount * 3; i++) {
  await page.waitForTimeout(100);
  afterUpgrade = await readOutlineVertexCount();
}
console.log('outline vertex count after upgrade:', afterUpgrade);
if (!(afterUpgrade.vertexCount > beforeUpgrade.vertexCount * 3)) {
  throw new Error(`expected the outline's actual vertex count to jump to full-resolution scale; before=${beforeUpgrade.vertexCount} after=${afterUpgrade.vertexCount}`);
}

const longTasksUK = await page.evaluate(() => window.__longTasks);
const maxLongTaskUK = longTasksUK.length ? Math.max(...longTasksUK) : 0;
console.log(`UK: ${longTasksUK.length} long tasks observed, max ${maxLongTaskUK.toFixed(0)} ms`);

// --- Test 2: Canada -- cancel keeps the simplified outline, no upgrade event.
console.log('\n=== Canada: cancelUpgrade() keeps the simplified outline ===');
await page.evaluate(() => { window.__cngUpgradedFired = false; });
await page.evaluate(() => {
  window.__cngDemo.geocoder.on('area:upgraded', () => { window.__cngUpgradedFired = true; });
});

await select('canada');
const canadaNoticeText = await waitForNoticeText(/Loading full detail/);
console.log('notice text while upgrading (Canada):', JSON.stringify(canadaNoticeText));

const beforeCancel = await readOutlineVertexCount();
console.log('outline vertex count before cancel:', beforeCancel);

await noticeCancel().click();

let cancelledText = null;
for (let i = 0; i < 30 && cancelledText === null; i++) {
  const t = (await notice().textContent())?.trim();
  if (t && t.includes('Keeping simplified outline')) cancelledText = t;
  else await page.waitForTimeout(100);
}
console.log('notice text after cancel:', JSON.stringify(cancelledText));
if (!cancelledText) throw new Error('expected the notice to say "Keeping simplified outline." after clicking Cancel');

console.log('status after cancel:', await page.textContent('#status'));

// Give any in-flight (and now-superseded-by-nothing) work a moment, then
// confirm the outline never changed and 'area:upgraded' never fired.
await page.waitForTimeout(1500);
const afterCancel = await readOutlineVertexCount();
console.log('outline vertex count after cancel (should be unchanged):', afterCancel);
if (afterCancel.vertexCount !== beforeCancel.vertexCount) {
  throw new Error(`cancelUpgrade() must leave the outline exactly as it was: before=${beforeCancel.vertexCount} after=${afterCancel.vertexCount}`);
}
const upgradedFired = await page.evaluate(() => window.__cngUpgradedFired);
console.log("'area:upgraded' fired after cancel (must be false):", upgradedFired);
if (upgradedFired) throw new Error("'area:upgraded' must never fire for a selection whose upgrade was cancelled");

const longTasksCanadaCancel = await page.evaluate(() => window.__longTasks);
const maxLongTaskCanadaCancel = longTasksCanadaCancel.length ? Math.max(...longTasksCanadaCancel) : 0;
console.log(`Canada (cancelled): ${longTasksCanadaCancel.length} total long tasks observed so far, max ${maxLongTaskCanadaCancel.toFixed(0)} ms`);

console.log('\nConsole errors:', consoleErrors.length);
for (const e of consoleErrors) console.error(' -', e);

await browser.close();

const failures = [];
if (maxLongTaskUK > LONG_TASK_BUDGET_MS) failures.push(`UK: a long task of ${maxLongTaskUK.toFixed(0)}ms exceeded the ${LONG_TASK_BUDGET_MS}ms budget during the upgradeDisplay swap`);
if (maxLongTaskCanadaCancel > LONG_TASK_BUDGET_MS) failures.push(`Canada: a long task of ${maxLongTaskCanadaCancel.toFixed(0)}ms exceeded the ${LONG_TASK_BUDGET_MS}ms budget`);
if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console error(s)`);

console.log('\n=== SUMMARY ===');
console.log(JSON.stringify({
  uk: { beforeUpgrade, afterUpgrade, maxLongTaskMs: maxLongTaskUK, longTaskCount: longTasksUK.length },
  canadaCancel: { beforeCancel, afterCancel, maxLongTaskMsSoFar: maxLongTaskCanadaCancel },
}, null, 2));

if (failures.length > 0) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(' -', f);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
