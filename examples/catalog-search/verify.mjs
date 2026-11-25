#!/usr/bin/env node
// Drives examples/catalog-search with Playwright against the LIVE Portolan
// registry index: 20 MB of parquet on GitHub Pages, of which a search may read
// about 2.
//
// It is the test of what unit tests cannot reach: that the index opens in a
// real browser on a host that misreports its size and hides `Content-Range`;
// that the fat columns are never requested; that a typed search, the map-area
// switch and the facets do what they say against 7,000 real collections; and
// that "Add to map" ends in a layer that draws -- or in a sentence saying why
// it does not. Requires network access and serve.py on the given port.
//
// Usage: python3 serve.py 8123 &  node examples/catalog-search/verify.mjs 8123
//
// When experiments/e13-render-column/out/collections.render.parquet exists
// (node experiments/e13-render-column/build.mjs), a second pass runs on that
// index and checks the `render` path: kinds to filter by, and no request for
// a collection's JSON when it is added.

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import * as hyparquet from 'hyparquet';
import { remoteByteLength } from '../../packages/extract-core/src/index.js';

const port = process.argv[2] ?? '8123';
const base = `http://localhost:${port}/examples/catalog-search/index.html`;
const REGISTRY = 'https://registry.portolan-sdi.org/v0.1/collections.parquet';
const LOCAL = new URL('../../experiments/e13-render-column/out/collections.render.parquet', import.meta.url);
const LOCAL_URL = `http://localhost:${port}/experiments/e13-render-column/out/collections.render.parquet`;

const boxesIntersect = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const unwrap = (b) => (b[0] > b[2] ? [[b[0], b[1], 180, b[3]], [-180, b[1], b[2], b[3]]] : [b]);
const ms = (t) => `${(t / 1000).toFixed(1)} s`;
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

const browser = await chromium.launch();
const results = [];
let failed = false;
function check(pass, name, ok, detail) {
  results.push({ pass, name, ok });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${pass}] ${name} — ${detail}`);
}

/** Where each top-level column's chunk sits in the index, read here in Node, independently of the page. */
async function columnRanges(url) {
  const byteLength = await remoteByteLength(url, fetch);
  const file = await hyparquet.asyncBufferFromUrl({ url, byteLength, requestInit: { headers: { 'Accept-Encoding': 'identity' } } });
  const metadata = await hyparquet.parquetMetadataAsync(file, { geoparquet: false });
  const ranges = {};
  for (const rg of metadata.row_groups) for (const col of rg.columns) {
    const m = col.meta_data;
    const start = Number(m.dictionary_page_offset ?? m.data_page_offset);
    const end = start + Number(m.total_compressed_size);
    const top = m.path_in_schema[0];
    ranges[top] = ranges[top] ? [Math.min(ranges[top][0], start), Math.max(ranges[top][1], end)] : [start, end];
  }
  return { byteLength, ranges };
}

async function runPass(pass, indexUrl) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  /** @type {{ url: string, method: string, range: string|null, status: number }[]} */
  const network = [];
  // The bytes the browser really RECEIVED for each open-ended request to the
  // index, from its own network protocol. (Playwright's `request.sizes()`
  // reports the declared Content-Length for a request that was cancelled --
  // the first version of this check used it and "found" a 20 MB download
  // that never happened.)
  const sizeProbes = new Map();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (e) => {
    const range = e.request.headers.Range ?? e.request.headers.range;
    if (e.request.url === indexUrl && range === 'bytes=0-') sizeProbes.set(e.requestId, { received: 0, end: 'pending' });
  });
  cdp.on('Network.dataReceived', (e) => {
    const probe = sizeProbes.get(e.requestId);
    if (probe) probe.received += e.dataLength;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const probe = sizeProbes.get(e.requestId);
    if (probe) probe.end = 'finished';
  });
  cdp.on('Network.loadingFailed', (e) => {
    const probe = sizeProbes.get(e.requestId);
    if (probe) probe.end = e.canceled ? 'cancelled' : `failed (${e.errorText})`;
  });
  page.on('response', (res) => {
    const req = res.request();
    if (req.url().startsWith(`http://localhost:${port}/`) && req.url() !== indexUrl) return;
    network.push({ url: req.url(), method: req.method(), range: req.headers().range ?? null, status: res.status() });
  });
  const jsonRequests = () => network.filter((r) => /collection\.json(\?|$)/.test(r.url));
  const state = () => page.evaluate(() => {
    const s = window.DEMO.model.state;
    return { status: s.status, total: s.total, count: s.count, hasRender: s.hasRender, error: s.error?.message ?? null, addNote: s.addNote, added: [...s.added], facets: s.facets, results: s.results.map((r) => ({ key: r.key, id: r.id, title: r.title, description: r.description, bbox: r.bbox, catalog: r.catalog, license: r.license, kinds: r.kinds, fit: r.fit, score: r.score })) };
  });
  const search = async (text) => {
    await page.evaluate((t) => window.DEMO.control.search(t), text);
    return state();
  };
  const cardOf = (key) => page.locator(`.cng-cs-card[data-key="${key}"]`);

  try {
    const started = Date.now();
    await page.goto(`${base}?verify=1${indexUrl === REGISTRY ? '' : `&index=${encodeURIComponent(indexUrl)}`}`, { waitUntil: 'load' });
    await page.waitForFunction(() => /^(ready|error):/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 120_000 });
    const status = await page.textContent('#status');
    const first = status.startsWith('ready:') ? await state() : null;

    // --- 1. The index loads, and only the light part of it --------------------------------
    check(pass, 'the index loads in the browser', Boolean(first) && first.count > 5000 && first.status === 'done' && first.results.length > 0,
      first ? `${status} in ${ms(Date.now() - started)}: ${first.count.toLocaleString()} collections, ${first.results.length} listed, hasRender ${first.hasRender}` : `${status} ${errors.join(' | ')}`);
    if (!first) return;

    const { byteLength, ranges } = await columnRanges(indexUrl);
    const reads = network.filter((r) => r.url === indexUrl && r.range).map((r) => /bytes=(\d+)-(\d*)/.exec(r.range)).filter(Boolean).map((m) => ({ start: Number(m[1]), end: m[2] === '' ? null : Number(m[2]) + 1 }));
    const bounded = reads.filter((r) => r.end !== null);
    const read = bounded.reduce((sum, r) => sum + (r.end - r.start), 0);
    const fat = ['original', 'links'].filter((c) => ranges[c]);
    const touched = fat.filter((c) => bounded.some((r) => r.start < ranges[c][1] && ranges[c][0] < r.end));
    const heads = network.filter((r) => r.url === indexUrl && r.method === 'HEAD').length;
    check(pass, 'only the light columns are read, and no HEAD is sent', touched.length === 0 && heads === 0 && read < Math.max(4_500_000, byteLength / 4) && bounded.length > 0,
      `${bounded.length} range reads, ${mb(read)} of ${mb(byteLength)}; ${fat.length ? `${fat.join(' and ')} untouched: ${touched.length === 0}` : 'this index has no fat columns'}; ${heads} HEAD requests`);

    // On a host that hides Content-Range (GitHub Pages) the size is asked for
    // with an open-ended range, whose body must NOT then be downloaded.
    if (sizeProbes.size) {
      const probes = [...sizeProbes.values()];
      check(pass, 'the size probe on a host that hides Content-Range does not download the file', probes.every((p) => p.end === 'cancelled' && p.received < byteLength / 100),
        `${probes.length} open-ended request(s): ${probes.map((p) => `${p.end} after ${p.received.toLocaleString()} bytes`).join(', ')}, of a ${mb(byteLength)} file`);
    } else {
      check(pass, 'the size probe needed one byte', reads.some((r) => r.start === 0 && r.end === 1), 'Content-Range was readable: no open-ended request was made');
    }

    // --- 2. Typing finds things by their words ----------------------------------------------
    {
      await page.locator('.cng-cs-form input[type="search"]').fill('');
      await page.locator('.cng-cs-form input[type="search"]').pressSequentially('damage sites tonga cyc', { delay: 15 });
      await page.waitForFunction(() => window.DEMO.model.state.status === 'done' && window.DEMO.model.state.text === 'damage sites tonga cyc', undefined, { timeout: 30_000 });
      const s = await state();
      const words = ['damage', 'tonga'];
      const off = s.results.filter((r) => !words.every((w) => `${r.title} ${r.description} ${r.id}`.toLowerCase().includes(w)));
      const cards = await page.locator('.cng-cs-card').count();
      check(pass, 'typing searches, and every result carries the words', s.total > 0 && s.total < 20 && off.length === 0 && cards === s.results.length,
        `"damage sites tonga cyc" (the last word unfinished): ${s.total} results, ${cards} cards; first: "${s.results[0]?.title}"; ${off.length} without the words`);
    }

    // --- 3. A typed search is superseded cleanly -----------------------------------------------
    {
      const out = await page.evaluate(async () => {
        const D = window.DEMO;
        const a = D.control.search('roads');
        const b = D.control.search('mangrove country');
        await Promise.all([a, b]);
        return { text: D.model.state.text, titles: D.model.state.results.map((r) => r.title) };
      });
      check(pass, 'the last search typed is the one shown', out.text === 'mangrove country' && out.titles.length > 0 && out.titles.every((t) => /mangrove/i.test(t)),
        `${out.titles.length} results for "${out.text}": ${out.titles.slice(0, 3).join(' | ')}`);
    }

    // --- 4. "Only this map area" ------------------------------------------------------------------
    {
      const out = await page.evaluate(async () => {
        const D = window.DEMO;
        D.map.jumpTo({ center: [36.9, -1.3], zoom: 9.5 });
        await D.settle();
        document.querySelector('.cng-cs-form input[type="search"]').value = '';
        const box = document.querySelector('.cng-cs-check input');
        if (!box.checked) box.click();
        await D.control.search('');
        const b = D.map.getBounds();
        return { view: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], useView: D.model.state.useView };
      });
      const s = await state();
      const outside = s.results.filter((r) => !r.bbox || !unwrap(r.bbox).some((b) => boxesIntersect(b, out.view)));
      const fits = s.results.map((r) => r.fit);
      const descending = fits.every((f, i) => i === 0 || fits[i - 1] >= f - 1e-12);
      const extentArea = (r) => unwrap(r.bbox).reduce((sum, b) => sum + (b[2] - b[0]) * (b[3] - b[1]), 0);
      check(pass, 'the map-area switch keeps what intersects the view, the most local first', out.useView && s.total > 0 && s.total < first.count && outside.length === 0 && descending && extentArea(s.results[0]) < extentArea(s.results.at(-1)),
        `${s.total.toLocaleString()} of ${first.count.toLocaleString()} collections touch a view of Nairobi; ${outside.length} of the ${s.results.length} shown are outside it; first "${s.results[0]?.title.slice(0, 50)}" (${fits[0]?.toFixed(3)} of it in view), last ${fits.at(-1)?.toExponential(1)}`);

      // It follows the map.
      const moved = await page.evaluate(async () => {
        const D = window.DEMO;
        const before = D.model.state.total;
        D.map.jumpTo({ center: [13.4, 52.52], zoom: 10 });
        await new Promise((r) => setTimeout(r, 600));
        await D.control.ready;
        for (let i = 0; i < 50 && D.model.state.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
        return { before, after: D.model.state.total, first: D.model.state.results[0]?.catalog ?? null };
      });
      check(pass, 'moving the map searches the new area', moved.after > 0 && moved.after !== moved.before, `Nairobi ${moved.before.toLocaleString()} -> Berlin ${moved.after.toLocaleString()} collections; first from "${moved.first}"`);
      await page.evaluate(() => document.querySelector('.cng-cs-check input').click());
    }

    // --- 5. A facet narrows, and its count was right ---------------------------------------------------
    {
      const before = await search('buildings');
      const choice = before.facets.license[1] ?? before.facets.license[0];
      const select = page.locator('.cng-cs-facets select').nth(1);
      const menu = await select.locator('option').allTextContents();
      await select.selectOption(choice.value);
      await page.waitForFunction((v) => window.DEMO.model.state.status === 'done' && window.DEMO.model.state.filters.license === v, choice.value, { timeout: 30_000 });
      const after = await state();
      check(pass, 'choosing a licence leaves exactly as many results as its count said', after.total === choice.count && after.results.every((r) => r.license === choice.value) && menu.some((t) => t.startsWith(`${choice.value} (`)),
        `"buildings": ${before.total}; licence "${choice.value}" promised ${choice.count}, gave ${after.total}; the menu still offers ${after.facets.license.length} licences`);
      await select.selectOption('');
      await page.waitForFunction(() => window.DEMO.model.state.status === 'done' && !window.DEMO.model.state.filters.license, undefined, { timeout: 30_000 });
    }

    // --- 6. Add a styled vector-tile collection: it has to draw ------------------------------------------
    let addedLayer = null;
    {
      const s = await search('damage sites tonga cyclone');
      const target = s.results[0];
      const json0 = jsonRequests().length;
      await page.evaluate((bbox) => window.DEMO.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { animate: false, padding: 80 }), target.bbox);
      // Hovering its card shows its extent.
      await cardOf(target.key).hover();
      const extent = await page.evaluate(async () => {
        const D = window.DEMO;
        await D.settle();
        return { hovered: D.model.state.hovered, drawn: D.map.queryRenderedFeatures({ layers: ['cng-layer-catalog-extent--line'] }).length };
      });
      check(pass, 'hovering a card shows that collection\'s extent on the map', extent.hovered === target.key && extent.drawn > 0, `"${target.title.slice(0, 60)}": ${extent.drawn} extent feature(s) rendered`);

      await cardOf(target.key).locator('[data-role="add"]').click();
      await page.waitForFunction(() => {
        const D = window.DEMO;
        return D.manager.list().some((e) => e.status === 'ready' || e.status === 'error') || Boolean(D.model.state.addNote);
      }, undefined, { timeout: 120_000 }).catch(() => {});
      const out = await page.evaluate(async () => {
        const D = window.DEMO;
        await D.settle();
        const list = D.manager.list();
        const entry = list[0];
        return {
          list: list.map((e) => ({ id: e.id, kind: e.kind, status: e.status, error: e.error?.message ?? null, note: e.note ?? null })),
          features: entry ? D.renderedFeatures(entry.id) : 0,
          note: D.model.state.addNote,
          button: document.querySelector('.cng-cs-card [data-role="add"]')?.textContent,
          credits: D.credits(),
          attribution: entry?.spec?.attribution?.[0]?.text ?? null,
        };
      });
      addedLayer = out.list[0] ?? null;
      const usedJson = jsonRequests().length - json0;
      check(pass, '"Add to map" adds a vector-tile layer that is ready and draws features', out.list.length === 1 && addedLayer.kind === 'pmtiles-vector' && addedLayer.status === 'ready' && out.features > 0 && out.button === 'Added' && !out.note,
        addedLayer ? `${addedLayer.id}: ${addedLayer.kind}, ${addedLayer.status}, ${out.features} features on screen, with its published style: ${!addedLayer.note}; button "${out.button}"${addedLayer.error ? `; ${addedLayer.error}` : ''}` : `nothing added: ${JSON.stringify(out.note)}`);
      check(pass, "the collection's credit is displayed", Boolean(out.attribution) && out.credits.includes(out.attribution), `"${out.attribution}" in: ${out.credits.slice(0, 160)}`);
      if (first.hasRender) check(pass, 'with a render column, adding a collection fetches no collection JSON', usedJson === 0, `${usedJson} collection.json request(s)`);
      else check(pass, 'without a render column, adding a collection fetches its JSON once', usedJson === 1, `${usedJson} collection.json request(s)`);
    }

    // --- 7. A result with nothing to draw says so (Review Focus 3) ----------------------------------------
    {
      const s = await search('mangrove gain loss country');
      const table = s.results.find((r) => /gain and loss by country/i.test(r.title));
      const layersBefore = await page.evaluate(() => window.DEMO.manager.list().length);
      let out = { note: null, layers: layersBefore, button: null, text: '' };
      if (table) {
        await cardOf(table.key).locator('[data-role="add"]').click();
        await page.waitForFunction((k) => window.DEMO.model.state.addNote?.id === k || window.DEMO.model.state.added.has(k), table.key, { timeout: 60_000 }).catch(() => {});
        out = await page.evaluate((k) => ({
          note: window.DEMO.model.state.addNote,
          layers: window.DEMO.manager.list().length,
          button: document.querySelector(`.cng-cs-card[data-key="${k}"] [data-role="add"]`)?.textContent,
          text: document.querySelector(`.cng-cs-card[data-key="${k}"] .cng-cs-note`)?.textContent ?? '',
        }), table.key);
      }
      check(pass, 'a collection that is only a table adds nothing and says why, on its card', Boolean(table) && out.layers === layersBefore && out.button === 'Add to map' && /table/i.test(out.text) && out.note?.id === table.key,
        table ? `"${table.title}": ${out.layers - layersBefore} layers added; the card says "${out.text}"` : 'the table collection was not found by the search');

      // And one that is partly drawable adds what it can, and names the rest.
      const mixed = (await search('annual mangrove extent vector')).results.find((r) => /annual mangrove extent, vector/i.test(r.title));
      let part = { text: '', added: false, layers: 0 };
      if (mixed) {
        await cardOf(mixed.key).locator('[data-role="add"]').click();
        await page.waitForFunction((k) => window.DEMO.model.state.added.has(k) || window.DEMO.model.state.addNote?.id === k, mixed.key, { timeout: 120_000 }).catch(() => {});
        part = await page.evaluate((k) => ({
          text: document.querySelector(`.cng-cs-card[data-key="${k}"] .cng-cs-note`)?.textContent ?? '',
          added: window.DEMO.model.state.added.has(k),
          layers: window.DEMO.manager.list().length,
        }), mixed.key);
      }
      check(pass, 'a partly drawable collection adds what it can and names the rest', Boolean(mixed) && part.added && part.layers === layersBefore + 1 && /^Added 1 layer\. Not added: .*imagery/i.test(part.text),
        mixed ? `"${mixed.title}": ${part.layers - layersBefore} layer added; the card says "${part.text.slice(0, 130)}"` : 'the collection was not found by the search');
    }

    // --- 8. With a render column: kinds on the cards and in a menu -----------------------------------------
    if (first.hasRender) {
      const s = await search('buildings');
      const kindsMenu = await page.locator('.cng-cs-facets label').nth(2).isVisible();
      const drawable = s.facets.kinds.find((k) => k.value === 'pmtiles-vector');
      await page.locator('.cng-cs-facets select').nth(2).selectOption('pmtiles-vector');
      await page.waitForFunction(() => window.DEMO.model.state.status === 'done' && window.DEMO.model.state.filters.kinds === 'pmtiles-vector', undefined, { timeout: 30_000 });
      const after = await state();
      const badges = await page.locator('.cng-cs-card .cng-cs-badge').count();
      check(pass, 'with a render column, results can be narrowed to what draws', kindsMenu && Boolean(drawable) && after.total === drawable.count && after.results.every((r) => r.kinds.includes('pmtiles-vector')) && badges >= after.results.length,
        `"buildings": ${s.total}; ${drawable?.count} draw as vector tiles, and choosing that gives ${after.total}; ${badges} kind badges on ${after.results.length} cards`);
      await page.locator('.cng-cs-facets select').nth(2).selectOption('');
    } else {
      const kindsMenu = await page.locator('.cng-cs-facets label').nth(2).isVisible();
      check(pass, 'without a render column, no "draws as" menu is offered', kindsMenu === false, 'the index does not say what collections draw as, and the panel does not pretend to');
    }

    // --- 9. The status line stays put; setStyle; remove and add ----------------------------------------------
    {
      await search('roads');
      const out = await page.evaluate(async () => {
        const live = document.querySelector('.cng-cs-status');
        let mutations = 0;
        const observer = new MutationObserver((records) => { mutations += records.length; });
        observer.observe(live, { childList: true, characterData: true, subtree: true });
        for (const card of [...document.querySelectorAll('.cng-cs-card')].slice(0, 3)) {
          card.dispatchEvent(new MouseEvent('mouseenter'));
          card.dispatchEvent(new MouseEvent('mouseleave'));
        }
        await new Promise((r) => setTimeout(r, 50));
        observer.disconnect();
        return { mutations, text: live.textContent, live: live.getAttribute('aria-live') };
      });
      check(pass, 'hovering does not re-announce the status', out.mutations === 0 && out.live === 'polite' && Boolean(out.text), `${out.mutations} changes to the live region ("${out.text}")`);
    }
    {
      const out = await page.evaluate(async () => {
        const D = window.DEMO;
        const layersBefore = D.manager.list().map((e) => e.id);
        const loaded = new Promise((resolve) => D.map.once('style.load', resolve));
        D.map.setStyle(D.styleUrl, { diff: false });
        await loaded;
        await new Promise((resolve) => D.map.once('idle', resolve));
        await D.settle();
        const all = D.map.getLayersOrder();
        const label = all.find((id) => !id.startsWith('cng-layer-') && !id.startsWith('deck-maplibre-layer-group') && D.map.getLayer(id)?.type === 'symbol');
        return { source: Boolean(D.map.getSource('cng-layer-catalog-extent')), fill: all.indexOf('cng-layer-catalog-extent--fill'), line: all.indexOf('cng-layer-catalog-extent--line'), label: all.indexOf(label), layers: D.manager.list().map((e) => `${e.id}=${e.status}`), same: D.manager.list().map((e) => e.id).join() === layersBefore.join() };
      });
      check(pass, 'after map.setStyle() the extent layers and the added layers are back, in place', out.source && out.fill >= 0 && out.line === out.fill + 1 && out.label === out.line + 1 && out.same,
        `extent fill ${out.fill}, line ${out.line}, first label ${out.label}; ${out.layers.length} layers restored`);
    }
    {
      const out = await page.evaluate(async () => {
        const D = window.DEMO;
        D.map.removeControl(D.control);
        const gone = { panels: document.querySelectorAll('.cng-catalog-search').length, source: Boolean(D.map.getSource('cng-layer-catalog-extent')) };
        D.map.addControl(D.control, 'top-left');
        await D.control.ready;
        await D.control.search('tonga');
        const s = D.model.state;
        return { gone, panels: document.querySelectorAll('.cng-catalog-search').length, status: s.status, results: s.results.length, cards: document.querySelectorAll('.cng-cs-card').length };
      });
      check(pass, 'the control can be removed and added again', out.gone.panels === 0 && !out.gone.source && out.panels === 1 && out.status === 'done' && out.results > 0 && out.cards === out.results,
        `removed: ${out.gone.panels} panels, source left: ${out.gone.source}; added again: ${out.status}, ${out.results} results, ${out.cards} cards`);
    }

    // --- 10. Hygiene ---------------------------------------------------------------------------------------
    {
      const thumbs = await page.evaluate(() => [...document.querySelectorAll('.cng-cs-card img')].map((img) => ({ lazy: img.loading === 'lazy', http: /^https?:\/\//.test(img.getAttribute('src') ?? '') })));
      check(pass, 'thumbnails are lazy and from http(s) only', thumbs.every((t) => t.lazy && t.http), `${thumbs.length} thumbnail images`);
      const hostTrouble = (e) => /Failed to load resource: (net::ERR_|the server responded with a status of 5\d\d)/.test(e);
      const own = errors.filter((e) => !hostTrouble(e));
      check(pass, 'no console errors', own.length === 0, `${own.length ? own.join(' | ').slice(0, 600) : "none of the page's own"}${errors.length - own.length ? `; ${errors.length - own.length} from a data host or the network` : ''}`);
    }
  } catch (err) {
    check(pass, 'the run got to the end', false, String(err?.message ?? err).split('\n')[0].slice(0, 300));
  } finally {
    await page.close();
  }
}

await runPass('registry', REGISTRY);
if (existsSync(LOCAL)) await runPass('with render', LOCAL_URL);
else console.log('\n(skipped the "with render" pass: run `node experiments/e13-render-column/build.mjs` to build that index)');

await browser.close();
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED:\n${bad.map((r) => `  [${r.pass}] ${r.name}`).join('\n')}` : `\ncatalog-search: all ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
