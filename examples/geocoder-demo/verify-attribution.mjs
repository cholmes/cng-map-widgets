// Compact-attribution widget (2026-11-13): after a selection, the map
// shows a small bottom-left ⓘ button; clicking it expands a pill with the
// attribution links; clicking outside collapses it; a new selection
// collapses it again. Runs fully local: pass a port serving this repo and
// (optionally) INDEX_URL pointing at a locally served manifest.
//
//   node examples/geocoder-demo/verify-attribution.mjs 8787
//   INDEX_URL=http://localhost:8790/names/index.json node examples/geocoder-demo/verify-attribution.mjs 8787
import { chromium } from 'playwright';

const port = process.argv[2] ?? '8787';
const indexUrl = process.env.INDEX_URL ?? 'http://localhost:8790/names/index.json';

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(`http://localhost:${port}/examples/geocoder-demo/index.html?index=${encodeURIComponent(indexUrl)}`);
await page.waitForSelector('input[role="combobox"]', { timeout: 45_000 }); // generous: basemap style may load over a slow connection

// Before any selection: no attribution widget visible.
const hostHiddenBefore = await page.evaluate(() => document.querySelector('.cng-attribution-ctrl')?.hidden);
if (hostHiddenBefore !== true) throw new Error(`attribution host should be hidden before a selection, got ${hostHiddenBefore}`);

await page.type('input[role="combobox"]', 'poland', { delay: 15 });
await page.waitForSelector('li[role="option"]', { timeout: 20_000 });
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.cng-attribution-ctrl')?.hidden === false, { timeout: 20_000 });
console.log('PASS: ⓘ appears bottom-left after a selection.');

// Host sits in MapLibre's bottom-left control corner.
const inCorner = await page.evaluate(() =>
  Boolean(document.querySelector('.maplibregl-ctrl-bottom-left .cng-attribution-ctrl')));
if (!inCorner) throw new Error('attribution host is not in the bottom-left control corner');

// Pill starts collapsed; toggle expands it and sets aria-expanded.
const pillHidden = await page.evaluate(() => document.querySelector('.cng-attribution-ctrl .cng-attribution').hidden);
if (pillHidden !== true) throw new Error('pill should start collapsed');
await page.click('.cng-attribution-toggle');
const afterToggle = await page.evaluate(() => ({
  pillHidden: document.querySelector('.cng-attribution-ctrl .cng-attribution').hidden,
  expanded: document.querySelector('.cng-attribution-toggle').getAttribute('aria-expanded'),
  text: document.querySelector('.cng-attribution-ctrl .cng-attribution').textContent,
  hasLink: Boolean(document.querySelector('.cng-attribution-ctrl .cng-attribution a[href]')),
}));
if (afterToggle.pillHidden || afterToggle.expanded !== 'true') throw new Error(`toggle should expand the pill, got ${JSON.stringify(afterToggle)}`);
if (!afterToggle.text?.trim() || !afterToggle.hasLink) throw new Error(`expanded pill should carry attribution text + link, got ${JSON.stringify(afterToggle)}`);
console.log('PASS: ⓘ expands to the attribution pill (text + clickable link).');
await page.screenshot({ path: new URL('./screenshot-attribution-pill.png', import.meta.url).pathname });

// Outside click collapses.
await page.mouse.click(600, 300);
const collapsedByOutside = await page.evaluate(() => document.querySelector('.cng-attribution-ctrl .cng-attribution').hidden);
if (collapsedByOutside !== true) throw new Error('outside click should collapse the pill');
console.log('PASS: outside click collapses the pill.');

// Expand again, then a NEW selection collapses it back to ⓘ.
await page.click('.cng-attribution-toggle');
await page.fill('input[role="combobox"]', '');
await page.type('input[role="combobox"]', 'france', { delay: 15 });
await page.waitForSelector('li[role="option"]', { timeout: 20_000 });
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.cng-attribution-ctrl .cng-attribution').hidden === true, { timeout: 20_000 });
console.log('PASS: a new selection collapses the pill back to ⓘ.');

console.log('Console errors:', consoleErrors.length);
for (const e of consoleErrors) console.error(' -', e);
await browser.close();
if (consoleErrors.length > 0) { console.error('FAILING: console errors observed.'); process.exit(1); }
console.log('\nAll attribution-widget checks passed.');
