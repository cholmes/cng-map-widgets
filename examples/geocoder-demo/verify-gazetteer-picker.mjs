// ⚙ gazetteer picker (2026-11-13): opens from the gear, lists the three
// gazetteers with the active one marked, switches by rewriting ?index= and
// reloading, and accepts a custom manifest URL. Runs fully local — the
// custom-URL path is exercised with a locally served manifest, and the
// named options are only checked for the ?index= value they produce (no
// live catalog is fetched).
//
//   node examples/geocoder-demo/verify-gazetteer-picker.mjs 8787
//   INDEX_URL=http://localhost:8790/names/index.json node examples/geocoder-demo/verify-gazetteer-picker.mjs 8787
import { chromium } from 'playwright';

const port = process.argv[2] ?? '8787';
const localManifest = process.env.INDEX_URL ?? 'http://localhost:8790/names/index.json';

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

for (const pagePath of ['examples/geocoder-demo/index.html', 'examples/quickstart/index.html']) {
  await page.goto(`http://localhost:${port}/${pagePath}`);
  await page.waitForSelector('.cng-gaz-gear', { timeout: 45_000 });

  // Panel opens from the gear, closed by default, default marked active.
  const closed = await page.evaluate(() => document.querySelector('.cng-gaz-panel').hidden);
  if (closed !== true) throw new Error(`${pagePath}: panel should start closed`);
  await page.click('.cng-gaz-gear');
  const state = await page.evaluate(() => ({
    open: !document.querySelector('.cng-gaz-panel').hidden,
    expanded: document.querySelector('.cng-gaz-gear').getAttribute('aria-expanded'),
    options: [...document.querySelectorAll('.cng-gaz-option')].map((b) => ({
      name: b.querySelector('.cng-gaz-name').textContent,
      active: b.getAttribute('aria-pressed') === 'true',
    })),
  }));
  if (!state.open || state.expanded !== 'true') throw new Error(`${pagePath}: gear should open the panel`);
  if (state.options.length !== 3) throw new Error(`${pagePath}: expected 3 gazetteer options, got ${JSON.stringify(state.options)}`);
  if (!state.options[0].active || state.options[1].active || state.options[2].active) {
    throw new Error(`${pagePath}: default (geoBoundaries) should be the active option, got ${JSON.stringify(state.options)}`);
  }
  console.log(`PASS: ${pagePath} — gear opens a panel of 3 gazetteers, default marked active.`);

  // Choosing Overture rewrites ?index=overture and reloads. Stop the page
  // before the new index actually loads — no live fetches.
  await Promise.all([
    page.waitForURL(/index=overture/, { timeout: 15_000 }),
    page.click('.cng-gaz-option:nth-of-type(2)'),
  ]);
  console.log(`PASS: ${pagePath} — picking Overture navigates to ?index=overture.`);
  await page.goto('about:blank'); // abandon before the live Overture manifest loads

  // The custom-URL field navigates to ?index=<url> and the page actually
  // loads against it (locally served manifest; fully offline-capable).
  await page.goto(`http://localhost:${port}/${pagePath}`);
  await page.waitForSelector('.cng-gaz-gear', { timeout: 45_000 });
  await page.click('.cng-gaz-gear');
  await page.fill('.cng-gaz-custom input', localManifest);
  await Promise.all([
    page.waitForURL((u) => u.searchParams.get('index') === localManifest, { timeout: 15_000 }),
    page.click('.cng-gaz-custom button'),
  ]);
  await page.waitForSelector('.cng-gaz-gear', { timeout: 45_000 });
  // The custom URL round-trips into the input, and a search works against it.
  await page.click('.cng-gaz-gear');
  const roundTripped = await page.inputValue('.cng-gaz-custom input');
  if (roundTripped !== localManifest) throw new Error(`${pagePath}: custom URL should round-trip into the field, got ${roundTripped}`);
  await page.keyboard.press('Escape');
  await page.type('input[role="combobox"]', 'liecht', { delay: 15 });
  await page.waitForSelector('li[role="option"]', { timeout: 30_000 });
  console.log(`PASS: ${pagePath} — custom manifest URL loads and search works against it.`);
}

// Screenshot the open panel for the record (geocoder-demo, local index).
await page.goto(`http://localhost:${port}/examples/geocoder-demo/index.html`);
await page.waitForSelector('.cng-gaz-gear', { timeout: 45_000 });
await page.click('.cng-gaz-gear');
await page.screenshot({ path: new URL('./screenshot-gazetteer-picker.png', import.meta.url).pathname });

console.log('Console errors:', consoleErrors.length);
for (const e of consoleErrors) console.error(' -', e);
await browser.close();
if (consoleErrors.length > 0) { console.error('FAILING: console errors observed.'); process.exit(1); }
console.log('\nAll gazetteer-picker checks passed.');
