#!/usr/bin/env node
// Drives examples/imagery-search with Playwright against LIVE data, once for
// each of three imagery collections that agree on almost nothing: Sentinel-2
// (hive partitions, JSON assets, 12 years of scenes), NAIP (one parquet file,
// struct assets, NAD83 UTM) and OpenAerialMap (a mirror file, no declared
// columns, scenes that span time and have no instant).
//
// It is the test of what unit tests cannot reach: that a search over real
// published files returns scenes where it was asked to look, that superseding
// works against a real network, that the plan cache really removes the
// listing and footer requests, and that "Add to map" ends in pixels.
// Requires network access and serve.py on the given port.
//
// Usage: python3 serve.py 8123 &  node examples/imagery-search/verify.mjs 8123 [s2|naip|oam]
//
// Checks look at the page and the map, not at what the library believes:
// MapLibre's own source data and layer order, pixels, the DOM, and the
// browser's network log.

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8123';
const only = process.argv[3];
const base = `http://localhost:${port}/examples/imagery-search/index.html`;

// A narrower window than each preset's, for the superseding search. Each is
// known to contain scenes over the preset's view.
const CASES = {
  s2: { narrow: { start: '2025-06-20', end: '2025-06-30' } },
  naip: { narrow: { start: '2024-05-01', end: '2024-06-30' } },
  oam: { narrow: { start: '2025-10-01', end: '2025-12-31' } },
};

function diff(a, b, tol = 12) {
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol || Math.abs(a[i + 2] - b[i + 2]) > tol) changed++;
  }
  return changed / (a.length / 4);
}
const boxesIntersect = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const ms = (t) => `${(t / 1000).toFixed(1)} s`;

const browser = await chromium.launch();
const results = [];
const timings = {};
let failed = false;
function check(collection, name, ok, detail) {
  results.push({ collection, name, ok });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${collection}] ${name} — ${detail}`);
}

/** Every check for one collection, in a page of its own. Throws only on something no check anticipated. */
async function runCase(key, expect, page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // The browser's own account of what was fetched. A parquet response says
  // how big its file is (`Content-Range: bytes a-b/TOTAL`), which is how a
  // footer read -- one that runs to the end of the file -- is told from a row
  // read without asking the library.
  /** @type {{ url: string, method: string, kind: string }[]} */
  let network = [];
  /** Requests to epsg.io over the WHOLE session; `network` is reset part-way. */
  const epsgRequests = [];
  // A request the browser never got a response to: these are the data host's
  // or the network's, and are reported apart from the page's own errors.
  const dropped = [];
  /** Requests the PAGE cancelled (a superseded search stopping its reads). */
  const aborted = [];
  page.on('requestfailed', (req) => {
    if (req.url().startsWith(`http://localhost:${port}/`)) return;
    const why = req.failure()?.errorText ?? 'failed';
    if (/ERR_ABORTED/.test(why)) aborted.push(req.url());
    else dropped.push(`${why} ${req.url().slice(0, 90)}`);
  });
  page.on('response', (res) => {
    const req = res.request();
    const url = req.url();
    if (url.startsWith(`http://localhost:${port}/`)) return;
    if (/^https?:\/\/([^/]*\.)?epsg\.io\//.test(url)) epsgRequests.push(url);
    const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers()['content-range'] ?? '');
    let kind = 'other';
    if (/epsg\.io\//.test(url)) kind = 'epsg';
    else if (/\.parquet(\?|$)/.test(url)) kind = req.method() === 'HEAD' ? 'head' : range && Number(range[2]) === Number(range[3]) - 1 ? 'footer' : range ? 'rows' : 'whole-file';
    else if (/\.json(\?|$)/.test(url) || /\/items\/[^/]+$/.test(url)) kind = 'document';
    network.push({ url, method: req.method(), kind });
  });
  const count = (kind) => network.filter((r) => r.kind === kind).length;
  /**
   * Put the pointer somewhere that hovers nothing. NOT a corner of the map:
   * a footprint is usually under it, and the map would then hover that one
   * (an earlier version of this file did exactly that and measured its own
   * pointer).
   */
  const park = async () => {
    await page.locator('#info h1').hover();
    await page.waitForFunction(() => window.DEMO?.model.state.hovered === null, undefined, { timeout: 5000 }).catch(() => {});
  };

  const started = Date.now();
  await page.goto(`${base}?collection=${key}&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => /^(ready|error):/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 120_000 });
  const status = await page.textContent('#status');

  // --- 1. Ready ------------------------------------------------------------------
  const info = status.startsWith('ready:') ? await page.evaluate(() => ({
    id: window.DEMO.profile.id,
    title: window.DEMO.profile.title,
    assets: window.DEMO.search.profile.assets,
    table: window.DEMO.search.profile.table,
    filters: window.DEMO.search.profile.filters.map((f) => f.column),
    credit: window.DEMO.profile.attribution?.[0]?.text ?? null,
    inputs: [...document.querySelectorAll('.cng-is-form input, .cng-is-form select')].length,
  })) : null;
  check(key, 'the page becomes ready', Boolean(info), info ? `${status} in ${ms(Date.now() - started)}; assets are ${info.assets}; time ${JSON.stringify(info.table.timeInterval ?? info.table.timeColumn)}; filters ${info.filters.join(', ')}; ${info.inputs} form controls` : `${status} ${errors.join(' | ')}`);
  if (!info) return;

  // --- 2. A search returns scenes, and their footprints are on the map --------------
  const first = await page.evaluate(async () => {
    const D = window.DEMO;
    const t0 = performance.now();
    await D.control.search();
    const elapsed = performance.now() - t0;
    const s = D.model.state;
    const features = await D.footprints();
    return {
      elapsed,
      status: s.status,
      error: s.error?.message ?? null,
      scenes: s.scenes.map((x) => ({ id: x.id, datetime: x.datetime, start: x.start, end: x.end, bbox: x.bbox })),
      area: s.area?.bboxes ?? null,
      footprints: features?.map((f) => f.properties.id) ?? null,
      cards: document.querySelectorAll('.cng-is-card').length,
      statusLine: document.querySelector('.cng-is-status')?.textContent ?? '',
      plan: s.plan ? { requests: s.plan.requests, rowGroups: s.plan.rowGroups, files: s.plan.files } : null,
    };
  });
  timings[key] = { first: first.elapsed, firstRequests: { document: count('document'), head: count('head'), footer: count('footer'), rows: count('rows') } };
  const timed = first.scenes.every((s) => s.id && (s.datetime || s.start));
  check(key, 'a search returns scenes with an id and a time', first.status === 'done' && first.scenes.length > 0 && timed,
    `${first.scenes.length} scenes in ${ms(first.elapsed)} (${first.status}${first.error ? `: ${first.error}` : ''}); "${first.statusLine.trim().slice(0, 110)}"`);
  check(key, 'one footprint and one card per scene', first.footprints?.length === first.scenes.length && first.cards === first.scenes.length && first.scenes.length > 0,
    `${first.scenes.length} scenes, ${first.footprints?.length} footprints in the map source, ${first.cards} cards`);

  // --- 3. Every scene is where the search looked ------------------------------------
  // Recomputed here from the scenes' own boxes and the searched area's.
  {
    const outside = first.scenes.filter((s) => !s.bbox || !(first.area ?? []).some((a) => boxesIntersect(a, s.bbox)));
    check(key, 'every scene intersects the searched area', first.area?.length > 0 && outside.length === 0,
      `area ${JSON.stringify(first.area?.map((b) => b.map((n) => Math.round(n * 100) / 100)))}; ${outside.length} of ${first.scenes.length} outside${outside.length ? `: ${outside.map((s) => s.id).join(', ')}` : ''}`);
  }

  // --- 4. A second search, started while the first is in flight, wins outright --------
  // "In flight" has to be true. The first version started the second search
  // in the same tick, before the first had sent anything, and so tested
  // nothing about a real network. Now the first search is left to announce
  // its plan -- its row reads go out at that moment -- and the browser's own
  // log must then show requests of its that were ABORTED.
  const abortedBefore = aborted.length;
  const race = await page.evaluate(async (narrow) => {
    const D = window.DEMO;
    const [from, to] = document.querySelectorAll('.cng-is-form input[type="date"]');
    const wide = D.control.search();
    const reading = await new Promise((resolve) => {
      const off = D.model.on('change', (s) => {
        if (!s.plan && s.status === 'searching') return;
        off();
        resolve(s.status === 'searching');
      });
    });
    await new Promise((r) => setTimeout(r, 0)); // let the reads actually leave
    from.value = narrow.start;
    to.value = narrow.end;
    const second = D.control.search();
    await Promise.all([wide, second]);
    const s = D.model.state;
    return { reading, status: s.status, time: s.time, scenes: s.scenes.map((x) => ({ id: x.id, at: x.datetime ?? x.start, end: x.end ?? x.datetime })) };
  }, expect.narrow);
  {
    const lo = Date.parse(`${expect.narrow.start}T00:00:00Z`);
    const hi = Date.parse(`${expect.narrow.end}T00:00:00Z`) + 86_400_000;
    const stray = race.scenes.filter((s) => !(Date.parse(s.end) >= lo && Date.parse(s.at) < hi));
    const stopped = aborted.length - abortedBefore;
    check(key, 'a search superseded while it is reading stops, and leaves only the new one\'s scenes', race.reading && stopped > 0 && race.status === 'done' && race.scenes.length > 0 && stray.length === 0,
      `the first search was reading: ${race.reading}; ${stopped} of its requests were aborted by the browser; ${race.scenes.length} scenes, all within ${expect.narrow.start}..${expect.narrow.end}: ${stray.length === 0}${stray.length ? ` (stray: ${stray.map((s) => `${s.id} ${s.at}`).join(', ')})` : ''}`);
  }

  // --- 5. The same search again pays for rows only -------------------------------------
  network = [];
  const repeat = await page.evaluate(async () => {
    const D = window.DEMO;
    const t0 = performance.now();
    await D.control.search();
    return { elapsed: performance.now() - t0, scenes: D.model.state.scenes.length, status: D.model.state.status };
  });
  timings[key].repeat = repeat.elapsed;
  timings[key].repeatRequests = { document: count('document'), head: count('head'), footer: count('footer'), rows: count('rows') };
  check(key, 'a repeated search makes no listing or footer request', repeat.status === 'done' && repeat.scenes === race.scenes.length && count('document') === 0 && count('head') === 0 && count('footer') === 0 && count('rows') > 0,
    `${ms(repeat.elapsed)} (the first search took ${ms(first.elapsed)}); requests: ${count('rows')} row reads, ${count('footer')} footers, ${count('head')} HEADs, ${count('document')} documents`);

  // --- 6. Hovering a card highlights its footprint, and the reverse ----------------------
  {
    const firstId = race.scenes[0].id;
    // What the map looks like inside the first scene before anything is hovered...
    const sampleFirst = () => page.evaluate(async () => {
      const D = window.DEMO;
      const bbox = D.model.state.scenes[0].bbox;
      const view = D.viewBox();
      await D.settle();
      return D.grab([Math.max(bbox[0], view[0]), Math.max(bbox[1], view[1]), Math.min(bbox[2], view[2]), Math.min(bbox[3], view[3])]);
    });
    const plain = await sampleFirst();
    await page.locator('.cng-is-card').first().hover();
    const hovered = await page.evaluate(async () => (await window.DEMO.footprints()).filter((f) => f.properties.hovered).map((f) => f.properties.id));
    // ...and with its card hovered: the highlight has to be something a person can SEE.
    const tinted = diff(plain, await sampleFirst(), 6);
    check(key, 'a hovered footprint is visibly highlighted', tinted > 0.5,
      `${(tinted * 100).toFixed(0)}% of the pixels inside the first scene change when its card is hovered`);
    // The other half, found live: footprints that are NOT hovered must not
    // tint the map. Scenes overlap, and a faint fill on each of 27 stacked
    // into solid colour over the basemap and over an added image. So: with
    // nothing hovered, hiding every footprint may change outlines only.
    await park();
    const unhovered = await page.evaluate(async () => {
      const D = window.DEMO;
      const bbox = D.model.state.scenes[0].bbox;
      const view = D.viewBox();
      const box = [Math.max(bbox[0], view[0]), Math.max(bbox[1], view[1]), Math.min(bbox[2], view[2]), Math.min(bbox[3], view[3])];
      const layers = ['cng-layer-imagery-footprints--fill', 'cng-layer-imagery-footprints--line'];
      await D.settle();
      const shown = D.grab(box);
      for (const id of layers) D.map.setLayoutProperty(id, 'visibility', 'none');
      await D.settle();
      const hidden = D.grab(box);
      for (const id of layers) D.map.setLayoutProperty(id, 'visibility', 'visible');
      await D.settle();
      return { shown, hidden, hovered: D.model.state.hovered, count: D.model.state.scenes.length };
    });
    const tint = diff(unhovered.shown, unhovered.hidden, 6);
    check(key, 'footprints that are not hovered do not tint the map', unhovered.hovered === null && tint < 0.15,
      `${(tint * 100).toFixed(1)}% of the pixels inside the first scene differ with all ${unhovered.count} footprints shown and hidden (outlines only)`);
    // Then from the map: move to a point the top footprint covers and see which card lights up.
    await park();
    const target = await page.evaluate(async () => {
      const D = window.DEMO;
      await D.settle();
      for (const [x, y] of [[760, 480], [900, 430], [700, 620], [1000, 600], [820, 300]]) {
        const hit = D.map.queryRenderedFeatures([x, y], { layers: ['cng-layer-imagery-footprints--fill'] })[0];
        if (hit) return { x, y, id: hit.properties.id };
      }
      return null;
    });
    let reverse = null;
    if (target) {
      await page.mouse.move(target.x, target.y);
      await page.mouse.move(target.x + 2, target.y + 2);
      await page.waitForFunction((id) => window.DEMO.model.state.hovered === id, target.id, { timeout: 5000 }).catch(() => {});
      reverse = await page.evaluate(() => ({ model: window.DEMO.model.state.hovered, card: document.querySelector('.cng-is-card.is-hovered')?.dataset.sceneId ?? null }));
    }
    check(key, 'hovering a card highlights its footprint, and a footprint its card', hovered.length === 1 && hovered[0] === firstId && Boolean(target) && reverse?.model === target.id && reverse?.card === target.id,
      `card ${firstId} -> footprint ${JSON.stringify(hovered)}; map point ${target ? `(${target.x}, ${target.y}) over ${target.id}` : 'none found'} -> card ${reverse?.card}`);
    await park();
  }

  // --- 6b. The Order menu orders, at once ---------------------------------------------------
  // Oldest first for every collection; then, where the collection has cloud
  // cover, least cloudy first -- which is also the scene worth adding below
  // (a deck of white cloud over a pale basemap is a poor test of "it drew").
  // Choosing an order has to change the list THEN, not at the next Search
  // (Phase 2 review, M2) -- and, since every match is already here, without
  // asking the network again.
  {
    const before = network.length;
    const sortBy = async (label) => page.evaluate(async (text) => {
      const D = window.DEMO;
      const select = [...document.querySelectorAll('.cng-is-form select')].at(-1);
      const option = [...select.options].find((o) => o.textContent === text);
      if (!option) return null;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      const s = D.model.state;
      return {
        status: s.status,
        error: s.error?.message ?? null,
        scenes: s.scenes.map((x) => ({ at: Date.parse(x.datetime ?? x.start), cloud: x.properties['eo:cloud_cover'] ?? null })),
        cards: [...document.querySelectorAll('.cng-is-card')].map((c) => c.dataset.sceneId).join('|') === s.scenes.map((x) => x.id).join('|'),
      };
    }, label);
    const ascending = (values) => values.every((v, i) => i === 0 || values[i - 1] <= v);
    const oldest = await sortBy('Oldest first');
    const cloud = await sortBy('Lowest cloud cover (%)');
    const oldestOk = oldest?.status === 'done' && oldest.scenes.length > 0 && oldest.cards && ascending(oldest.scenes.map((s) => s.at));
    const cloudOk = cloud === null || (cloud.status === 'done' && cloud.scenes.length > 0 && cloud.cards && ascending(cloud.scenes.map((s) => s.cloud)));
    if (cloud === null) await sortBy('Newest first');
    const asked = network.length - before;
    check(key, 'the Order menu reorders the list at once, with no new request', oldestOk && cloudOk && asked === 0,
      `oldest first: ${oldest?.scenes.length} scenes, ${oldest?.status}${oldest?.error ? ` (${oldest.error})` : ''}, in date order: ${oldestOk}; ${cloud === null ? 'no cloud cover to order by' : `least cloudy first: ${cloud.scenes.slice(0, 4).map((s) => s.cloud?.toFixed(1)).join(', ')}… (${cloud.status}${cloud.error ? `: ${cloud.error}` : ''})`}; ${asked} requests made`);
  }

  // --- 7. "Add to map" ends in a ready layer and in pixels --------------------------------
  {
    const firstScene = await page.evaluate(() => {
      const s = window.DEMO.model.state.scenes[0];
      return { id: s.id, bbox: s.bbox };
    });
    await page.locator('.cng-is-card [data-role="add"]').first().click();
    await page.waitForFunction(() => {
      const D = window.DEMO;
      return D.manager.list().some((e) => e.status === 'ready' || e.status === 'error') || Boolean(D.model.state.addError);
    }, undefined, { timeout: 120_000 }).catch(() => {});
    const added = await page.evaluate(() => {
      const D = window.DEMO;
      return {
        list: D.manager.list().map((e) => ({ id: e.id, kind: e.kind, status: e.status, group: e.spec?.group ?? null, url: e.spec?.source?.url ?? null, error: e.error?.message ?? null, note: e.note ?? null })),
        addError: D.model.state.addError ? `${D.model.state.addError.error?.code}: ${D.model.state.addError.error?.message}` : null,
        button: document.querySelector('.cng-is-card [data-role="add"]')?.textContent,
        added: [...D.model.state.added],
      };
    });
    const layer = added.list[0];
    const ok = added.list.length === 1 && layer.kind === 'cog' && layer.status === 'ready' && layer.group === info.id && added.added.includes(firstScene.id) && added.button === 'Added';
    check(key, '"Add to map" adds the scene as a ready cog layer in the collection\'s group', ok,
      layer ? `${layer.id}: ${layer.kind}, ${layer.status}, group ${layer.group}; button reads "${added.button}"${layer.error ? `; error: ${layer.error}` : ''}${layer.note ? `; note: ${layer.note}` : ''}` : `nothing was added; ${added.addError}`);

    // Pixels: the part of the scene that is in view, with the layer shown and
    // hidden. Polled, because tiles arrive after the layer is "ready".
    //
    // Only pixels inside the scene's FOOTPRINT are counted, not its bounding
    // box: a Sentinel-2 scene is often a slice of its tile (the edge of the
    // satellite's swath), and the rest of the box is no-data that rightly
    // draws nothing. The first version of this check sampled the box and
    // failed on a scene that was drawing perfectly.
    let drew = { inside: 0, changed: 0, box: 0 };
    let waited = 0;
    if (ok) {
      const t0 = Date.now();
      while (Date.now() - t0 < 90_000) {
        drew = await page.evaluate(async ({ id, bbox }) => {
          const D = window.DEMO;
          const scene = D.model.state.scenes.find((s) => `${D.profile.id}:${s.id}` === id);
          const view = D.viewBox();
          const box = [Math.max(bbox[0], view[0]), Math.max(bbox[1], view[1]), Math.min(bbox[2], view[2]), Math.min(bbox[3], view[3])];
          // Outer rings only; even-odd.
          const rings = scene.geometry?.type === 'Polygon' ? [scene.geometry.coordinates[0]] : scene.geometry?.type === 'MultiPolygon' ? scene.geometry.coordinates.map((p) => p[0]) : null;
          const inRing = ([x, y], ring) => {
            let hit = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              const [xi, yi] = ring[i], [xj, yj] = ring[j];
              if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
            }
            return hit;
          };
          await D.settle();
          const shown = D.grabWithCoords(box);
          D.manager.setVisible(id, false);
          await D.settle();
          const hidden = D.grabWithCoords(box);
          D.manager.setVisible(id, true);
          await D.settle();
          let inside = 0, changed = 0, boxChanged = 0;
          for (let p = 0; p < shown.coords.length; p++) {
            const i = p * 4;
            const differs = Math.abs(shown.pixels[i] - hidden.pixels[i]) > 12 || Math.abs(shown.pixels[i + 1] - hidden.pixels[i + 1]) > 12 || Math.abs(shown.pixels[i + 2] - hidden.pixels[i + 2]) > 12;
            if (differs) boxChanged++;
            if (rings && !rings.some((ring) => inRing(shown.coords[p], ring))) continue;
            inside++;
            if (differs) changed++;
          }
          return { inside: inside / shown.coords.length, changed: inside ? changed / inside : 0, box: boxChanged / shown.coords.length };
        }, { id: layer.id, bbox: firstScene.bbox });
        if (drew.inside > 0.02 && drew.changed > 0.8) break;
        await page.waitForTimeout(1500);
      }
      waited = Date.now() - t0;
    }
    check(key, 'the added scene draws', drew.inside > 0.02 && drew.changed > 0.8,
      `${(drew.changed * 100).toFixed(1)}% of the pixels inside its footprint change when it is hidden (the footprint is ${(drew.inside * 100).toFixed(0)}% of the part of its bounding box in view; ${(drew.box * 100).toFixed(1)}% of that whole box changes), after ${ms(waited)}; ${layer?.url ?? ''}`);

    // --- 8. The footprints stay above the imagery, under the labels ----------------------
    const order = await page.evaluate(() => {
      const D = window.DEMO;
      const all = D.map.getLayersOrder();
      const label = all.find((id) => !id.startsWith('cng-layer-') && !id.startsWith('deck-maplibre-layer-group') && D.map.getLayer(id)?.type === 'symbol');
      return {
        fill: all.indexOf('cng-layer-imagery-footprints--fill'),
        line: all.indexOf('cng-layer-imagery-footprints--line'),
        label: all.indexOf(label),
        deck: all.map((id, i) => (id.startsWith('deck-maplibre-layer-group') ? i : -1)).filter((i) => i >= 0),
        labelId: label,
      };
    });
    check(key, 'footprints are drawn above the added image and below the labels', order.deck.length > 0 && order.deck.every((i) => i < order.fill) && order.line === order.fill + 1 && order.label === order.line + 1,
      `deck.gl group at ${JSON.stringify(order.deck)}, fill ${order.fill}, line ${order.line}, first label "${order.labelId}" at ${order.label}`);

    // --- 9. Credit ------------------------------------------------------------------------
    const credit = await page.evaluate(() => ({
      map: [...document.querySelectorAll('.cng-layer-attribution, .maplibregl-ctrl-attrib')].map((el) => el.textContent.trim()).join(' || '),
      panel: document.querySelector('.cng-is-credit')?.textContent.trim() ?? '',
    }));
    check(key, "the collection's credit is displayed, on the map and in the panel", Boolean(info.credit) && credit.map.includes(info.credit) && credit.panel.includes(info.credit),
      `"${info.credit}" — panel: "${credit.panel}"`);
  }

  // --- 9b. The panel's words stay put (Phase 2 review, I5) -------------------------------------
  // Hovering a card used to rebuild the whole status: an opened narration
  // snapped shut, and the announced line was re-inserted for a screen reader
  // on every pointer move.
  {
    await park();
    const out = await page.evaluate(async () => {
      const details = document.querySelector('.cng-is-plan');
      const live = document.querySelector('.cng-is-status-line');
      details.open = true;
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(live, { childList: true, characterData: true, subtree: true });
      const cards = [...document.querySelectorAll('.cng-is-card')];
      for (const card of cards.slice(0, 3)) {
        card.dispatchEvent(new MouseEvent('mouseenter'));
        card.dispatchEvent(new MouseEvent('mouseleave'));
      }
      await new Promise((r) => setTimeout(r, 50));
      observer.disconnect();
      return { open: details.open, mutations, hidden: details.hidden, stages: details.querySelectorAll('li').length, live: live.getAttribute('aria-live'), text: live.textContent };
    });
    check(key, 'hovering does not close the plan narration or re-announce the status', out.open && !out.hidden && out.stages > 0 && out.mutations === 0 && out.live === 'polite',
      `narration open after three hovers: ${out.open} (${out.stages} stages); ${out.mutations} changes to the live region ("${out.text}")`);
  }

  // --- 9c. `map.setStyle()` (Phase 2 review, I3) -------------------------------------------------
  // The footprints are style layers, and a new style drops them. They have to
  // come back by themselves -- above the image, which the manager restores.
  {
    const out = await page.evaluate(async () => {
      const D = window.DEMO;
      const before = (await D.footprints())?.length ?? 0;
      const loaded = new Promise((resolve) => D.map.once('style.load', resolve));
      D.map.setStyle(D.styleUrl, { diff: false });
      await loaded;
      await new Promise((resolve) => D.map.once('idle', resolve));
      await D.settle();
      const all = D.map.getLayersOrder();
      const label = all.find((id) => !id.startsWith('cng-layer-') && !id.startsWith('deck-maplibre-layer-group') && D.map.getLayer(id)?.type === 'symbol');
      return {
        before,
        after: (await D.footprints())?.length ?? null,
        fill: all.indexOf('cng-layer-imagery-footprints--fill'),
        line: all.indexOf('cng-layer-imagery-footprints--line'),
        label: all.indexOf(label),
        deck: all.map((id, i) => (id.startsWith('deck-maplibre-layer-group') ? i : -1)).filter((i) => i >= 0),
        layers: D.manager.list().map((e) => e.status),
      };
    });
    check(key, 'after map.setStyle() the footprints are back, above the image and below the labels',
      out.before > 0 && out.after === out.before && out.fill >= 0 && out.line === out.fill + 1 && out.label === out.line + 1 && out.deck.length > 0 && out.deck.every((i) => i < out.fill),
      `${out.after} of ${out.before} footprints; deck.gl group at ${JSON.stringify(out.deck)}, fill ${out.fill}, line ${out.line}, first label at ${out.label}; layers ${out.layers.join(', ')}`);
  }

  // --- 9d. Remove the control and add it again (Phase 2 review, I4) --------------------------------
  // What a React wrapper does to one instance: mount, unmount, mount.
  {
    const out = await page.evaluate(async () => {
      const D = window.DEMO;
      D.map.removeControl(D.control);
      const gone = {
        panels: document.querySelectorAll('.cng-imagery-search').length,
        source: Boolean(D.map.getSource('cng-layer-imagery-footprints')),
        layers: D.map.getLayersOrder().filter((id) => id.startsWith('cng-layer-imagery-footprints')).length,
      };
      D.map.addControl(D.control, 'top-left');
      await D.control.ready;
      await D.control.search();
      const s = D.model.state;
      return {
        gone,
        panels: document.querySelectorAll('.cng-imagery-search').length,
        title: document.querySelector('.cng-is-header h3')?.textContent ?? '',
        status: s.status,
        scenes: s.scenes.length,
        cards: document.querySelectorAll('.cng-is-card').length,
        footprints: (await D.footprints())?.length ?? null,
      };
    });
    check(key, 'the control can be removed and added again', out.gone.panels === 0 && !out.gone.source && out.gone.layers === 0 && out.panels === 1 && Boolean(out.title) && out.status === 'done' && out.scenes > 0 && out.cards === out.scenes && out.footprints === out.scenes,
      `removed: ${out.gone.panels} panels, source left: ${out.gone.source}, ${out.gone.layers} layers left; added again: "${out.title}", ${out.status}, ${out.scenes} scenes, ${out.cards} cards, ${out.footprints} footprints`);
  }

  // --- 10. Thumbnails are lazy and http(s); nothing went to epsg.io; no console errors -----
  {
    const thumbs = await page.evaluate(() => [...document.querySelectorAll('.cng-is-card img')].map((img) => ({ lazy: img.loading === 'lazy', http: /^https?:\/\//.test(img.getAttribute('src') ?? '') })));
    check(key, 'thumbnails are lazy and from http(s) only', thumbs.every((t) => t.lazy && t.http), `${thumbs.length} thumbnail images`);
    check(key, 'no request went to epsg.io', epsgRequests.length === 0, `${epsgRequests.length} requests${epsgRequests.length ? `: ${epsgRequests.join(', ')}` : ''}`);
    // A request the network dropped, or that the data host answered with a
    // 5xx, is logged by the browser as a console error. Every search above
    // still had to succeed for its check to pass -- the reader makes a failed
    // read once more -- so these are the system working: reported, not
    // failed. (Seen live: two HTTP 520s and a QUIC drop in one run, all
    // checks green.) A 4xx is not excused: that is a wrong request.
    const hostTrouble = (e) => /Failed to load resource: (net::ERR_|the server responded with a status of 5\d\d)/.test(e);
    const own = errors.filter((e) => !hostTrouble(e));
    const excused = errors.length - own.length;
    check(key, 'no console errors', own.length === 0,
      `${own.length ? own.join(' | ').slice(0, 600) : 'none of the page\'s own'}${excused ? `; ${excused} from the data host or network (5xx or a dropped request), each retried${dropped.length ? `: ${dropped.join(' | ').slice(0, 200)}` : ''}` : ''}`);
  }
}

for (const [key, expect] of Object.entries(CASES)) {
  if (only && only !== key) continue;
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  try {
    await runCase(key, expect, page);
  } catch (err) {
    // Almost always: an earlier check failed (a search that ended in an
    // error) and a later one had nothing to look at.
    check(key, 'the run got to the end', false, String(err?.message ?? err).split('\n')[0].slice(0, 300));
  } finally {
    await page.close();
  }
}

await browser.close();

console.log('\n=== imagery-search ===');
for (const [key, t] of Object.entries(timings)) {
  const r = (x) => (x ? `${x.rows} row reads, ${x.footer} footers, ${x.head} HEADs, ${x.document} documents` : 'n/a');
  console.log(`${key}: first search ${ms(t.first)} (page load + first search: ${r(t.firstRequests)}); repeat ${t.repeat ? ms(t.repeat) : 'n/a'} (${r(t.repeatRequests)})`);
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED:\n${bad.map((r) => `  [${r.collection}] ${r.name}`).join('\n')}` : `\nAll ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
