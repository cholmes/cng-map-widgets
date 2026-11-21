#!/usr/bin/env node
// Drives the upload-demo with Playwright: search "fiji" and select it
// (the antimeridian case, through @cngeo/openlayers' projection bridge),
// then upload examples/upload-demo/fixtures/needs-repair.geojson (via the
// demo's hidden file input -- see the note below on why, not actual
// OS drag-and-drop), assert both produced features on their respective
// vector layers, screenshot. Used to produce
// examples/upload-demo/screenshot.png as verification evidence (not part
// of `npm test`; requires serve.py (or equivalent) running on the given
// port, serving the repo root).
//
// Usage: node verify.mjs [port]
//
// NOTE on "drop" vs file-input: real OS-level drag-and-drop of a file
// cannot be simulated by a WebDriver/CDP client without fighting the
// browser's DataTransfer security model (synthetic DragEvents cannot
// carry real File objects from outside the page). The demo therefore
// also wires a hidden <input type="file"> to the exact same
// `areaFromFile()` call `attachDropTarget`'s `drop` handler makes --
// Playwright's `setInputFiles` drives that input directly. This
// exercises the identical upload-core code path a real drop would
// (dispatching into the same `handleUploadResult`), just via the
// browser-automation-friendly entry point.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? '8123';
const url = `http://localhost:${port}/examples/upload-demo/index.html`;
const fixturePath = path.join(here, 'fixtures', 'needs-repair.geojson');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

const consoleErrors = [];
page.on('console', (msg) => {
  console.log(`[console.${msg.type()}]`, msg.text());
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => {
  console.log('[pageerror]', err.message);
  consoleErrors.push(`pageerror: ${err.message}`);
});

console.log('Navigating to', url);
await page.goto(url, { waitUntil: 'load' });

await page.waitForSelector('input[role="combobox"]', { timeout: 10_000 });
console.log('Combobox found.');

// The index loads lazily on focus (design call #9), not on page load.
await page.click('input[role="combobox"]');
await page.waitForFunction(
  () => document.getElementById('status')?.textContent?.includes('Index ready'),
  { timeout: 15_000 },
);
console.log('Status:', await page.textContent('#status'));

// --- Part 1: search "fiji" and select it -- the antimeridian case,
// exercised through @cngeo/openlayers' OL Control + projection bridge.
await page.type('input[role="combobox"]', 'fiji', { delay: 30 });
await page.waitForSelector('li[role="option"]', { timeout: 10_000 });
console.log('First option:', await page.textContent('li[role="option"]'));

await page.keyboard.press('ArrowDown');
const activeDescendant = await page.getAttribute('input[role="combobox"]', 'aria-activedescendant');
if (!activeDescendant) throw new Error('Expected aria-activedescendant to be set after ArrowDown');

await page.keyboard.press('Enter');
await page.waitForFunction(
  () => document.getElementById('status')?.textContent?.includes('Selected'),
  { timeout: 10_000 },
);
console.log('Status after search select:', await page.textContent('#status'));

const searchAreaInfo = await page.evaluate(() => {
  const control = window.__cngUploadDemo.searchControl;
  const area = control.area;
  return area
    ? { crossesAntimeridian: area.crossesAntimeridian, bboxesCount: area.bboxes.length, name: area.name }
    : null;
});
console.log('Search Area:', JSON.stringify(searchAreaInfo));
if (!searchAreaInfo) throw new Error('Expected the GeocoderControl to have a selected Area after Enter');
if (!searchAreaInfo.crossesAntimeridian) {
  console.warn('WARNING: "fiji" did not resolve to an antimeridian-crossing Area in this data build -- continuing anyway.');
}

// Confirm the search outline layer (inside GeocoderControl, via
// addAreaLayer) actually received a feature with real geometry.
const searchLayerFeatureCount = await page.evaluate(() => {
  const map = window.__cngUploadDemo.map;
  const vectorLayers = map
    .getLayers()
    .getArray()
    .filter((l) => typeof l.getSource === 'function' && typeof l.getSource()?.getFeatures === 'function');
  // The search control's display-outline layer is the first VectorLayer
  // added (before the upload outline, added later in index.html).
  return vectorLayers.map((l) => l.getSource().getFeatures().length);
});
console.log('Vector layer feature counts after search select:', searchLayerFeatureCount);
if (!searchLayerFeatureCount.some((n) => n > 0)) {
  throw new Error('Expected at least one OL vector layer to have features after selecting "fiji"');
}

await page.waitForTimeout(500); // let the view.fit() animation settle

// --- Part 2: upload the fixture with deliberate repairs, via the hidden
// file input (see the NOTE above for why, not a simulated OS drop).
await page.setInputFiles('#file-input', fixturePath);
await page.waitForFunction(
  () => document.getElementById('status')?.textContent?.startsWith('Uploaded'),
  { timeout: 10_000 },
);
console.log('Status after upload:', await page.textContent('#status'));

const noticesText = await page.textContent('#notices');
console.log('Notices panel:', noticesText);
for (const expectedKind of ['dropped-non-areal', 'closed-ring', 'rewound-ring', 'dropped-z', 'deduped-points']) {
  if (!noticesText.includes(expectedKind)) {
    throw new Error(`Expected the notices panel to mention repair kind "${expectedKind}"`);
  }
}

const uploadAreaInfo = await page.evaluate(() => {
  const outline = window.__cngUploadDemo.uploadOutline;
  const area = outline.getArea ? outline.getArea() : null;
  return area ? { name: area.name, combine: area.provenance.combine } : null;
});
console.log('Upload Area (via outline, if exposed):', JSON.stringify(uploadAreaInfo));

const allVectorFeatureCounts = await page.evaluate(() => {
  const map = window.__cngUploadDemo.map;
  return map
    .getLayers()
    .getArray()
    .filter((l) => typeof l.getSource === 'function' && typeof l.getSource()?.getFeatures === 'function')
    .map((l) => l.getSource().getFeatures().length);
});
console.log('Vector layer feature counts after upload:', allVectorFeatureCounts);
const layersWithFeatures = allVectorFeatureCounts.filter((n) => n > 0).length;
if (layersWithFeatures < 2) {
  throw new Error(
    `Expected at least 2 OL vector layers with features (search outline + upload outline), got ${layersWithFeatures} of ${allVectorFeatureCounts.length}`,
  );
}

await page.waitForTimeout(600); // let the upload outline's view.fit() animation settle

const screenshotPath = path.join(here, 'screenshot.png');
await page.screenshot({ path: screenshotPath });
console.log('Screenshot saved to', screenshotPath);

if (consoleErrors.length > 0) {
  console.error('Console errors observed during the run:');
  for (const e of consoleErrors) console.error(' -', e);
}

await browser.close();

if (consoleErrors.length > 0) {
  process.exitCode = 1;
}
