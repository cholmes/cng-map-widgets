#!/usr/bin/env node
// Drives examples/timeline-firms with Playwright against the LIVE FIRMS
// archives: 29 PMTiles chunks on Source Cooperative (a year each since 2000,
// a rolling week, a monthly overview).
//
// It is the test of what unit tests cannot reach: that deck.gl really draws
// the chunks, that a selection re-colours the map without fetching anything,
// that a view crossing New Year loads the next chunk, that zooming out moves
// to months and back, that playback moves the selection, and that the whole
// thing is one layer that can be hidden, restyled under, and removed.
// Requires network access and serve.py on the given port.
//
// Usage: python3 serve.py 8123 &  node examples/timeline-firms/verify.mjs 8123

import { chromium } from 'playwright';

const port = process.argv[2] ?? '8123';
const base = `http://localhost:${port}/examples/timeline-firms/index.html`;

const browser = await chromium.launch();
const results = [];
let failed = false;
function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}
const ready = (page) => page.waitForFunction(() => /^(ready|error):/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 180_000 });
/** How different two small pictures of the map are: the mean difference per channel, 0..255. */
const difference = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
/** Every request for tile bytes: a range read of a .pmtiles archive. */
let tileRequests = 0;
page.on('request', (req) => { if (/\.pmtiles(\?|$)/.test(req.url())) tileRequests += 1; });

const state = () => page.evaluate(() => {
  const s = window.DEMO.session.state;
  return { unit: s.unit, axis: s.axis, gaps: s.gaps, loaded: s.loaded, drawing: s.drawing, outgoing: s.outgoing, pending: s.pending, failed: s.failed.map((f) => `${f.id}: ${f.error?.message}`), partial: s.partial, view: s.view, selection: s.selection, bars: Object.keys(s.histogram).length, histogram: s.histogram };
});
const settle = () => page.evaluate(() => window.DEMO.settle());
const total = (histogram, from, to, width = 8) => Object.entries(histogram).filter(([k]) => k.length === width && k >= from.slice(0, width) && k <= to.slice(0, width)).reduce((n, [, v]) => n + v, 0);

try {
  const started = Date.now();
  await page.goto(`${base}?verify=1`, { waitUntil: 'load' });
  await ready(page);
  const status = await page.textContent('#status');
  const up = status.startsWith('ready:') && (await page.evaluate(() => Boolean(window.DEMO?.session)));

  // --- 1. One layer ----------------------------------------------------------------------------
  const list = up ? await page.evaluate(() => window.DEMO.manager.list().map((e) => ({ id: e.id, kind: e.kind, status: e.status, note: e.note ?? null }))) : [];
  check('the timeline is one layer, and it is ready', up && list.length === 1 && list[0].kind === 'timeline' && list[0].status === 'ready',
    up ? `${status} in ${((Date.now() - started) / 1000).toFixed(1)} s; layers: ${JSON.stringify(list)}` : `${status} ${errors.join(' | ').slice(0, 300)}`);
  if (!up) throw new Error('the page did not come up');

  await settle();
  const first = await state();
  const chunks = await page.evaluate(() => window.DEMO.chunks.map((c) => ({ id: c.id, start: c.start, end: c.end, unit: c.unit })));
  const latest = chunks.find((c) => c.id === 'latest');
  const thisYear = chunks.filter((c) => /^\d{4}$/.test(c.id)).at(-1);

  // --- 2. The axis is the whole record; what is loaded is a little of it -----------------------------
  {
    const days = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8)) - Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8))) / 86400000) + 1;
    const axisDays = days(first.axis.min, first.axis.max);
    const gapDays = first.gaps.reduce((n, [a, b]) => n + (b - a + 1), 0);
    check('the axis is the whole record, with only the rolling week and this year loaded', first.unit === 'day' && first.axis.min === '20001101' && first.axis.max >= latest.end && first.loaded.length === 2 && first.loaded.includes('latest') && first.loaded.includes(thisYear.id) && gapDays > axisDays * 0.9,
      `axis ${first.axis.min}..${first.axis.max} (${axisDays.toLocaleString()} days); loaded: ${first.loaded.join(', ')}; ${gapDays.toLocaleString()} days reported as not loaded`);
    check('the rolling week draws the days it owns, though the year has them too', first.drawing.length === 1 && first.drawing[0] === 'latest' && first.selection.from >= latest.start,
      `selection ${first.selection.from}..${first.selection.to}; drawing: ${first.drawing.join(', ')} (the week is ${latest.start}..${latest.end})`);
  }

  // --- 3. The histogram --------------------------------------------------------------------------
  {
    const inSelection = total(first.histogram, first.selection.from, first.selection.to);
    const line = await page.textContent('.cng-tl-status');
    const outside = Object.keys(first.histogram).filter((k) => k < thisYear.start || k > first.axis.max);
    check('the track has a bar for the days that are loaded, and the panel says what is selected', first.bars > 200 && inSelection > 0 && outside.length === 0 && line.includes(inSelection.toLocaleString('en-US')) && /detections in view/.test(line),
      `${first.bars} days with detections, none outside ${thisYear.id}; the selection holds ${inSelection.toLocaleString('en-US')}; the panel says "${line}"`);
  }

  // --- 4. A selection re-colours the map and fetches nothing -----------------------------------------
  {
    const before = await page.evaluate(() => ({ picture: window.DEMO.snapshot(), trigger: window.DEMO.manager.deckLayers().at(-1).props.updateTriggers.getFillColor }));
    const requestsBefore = tileRequests;
    // The first two days of the rolling week instead of the last five: the same chunk, already loaded.
    const to = await page.evaluate((week) => {
      const D = window.DEMO;
      const T = D.session.timeline;
      const end = T.addDays(week.start, 1);
      D.control._canvas.setSelectionDays(week.start, end);
      return end;
    }, latest);
    await settle();
    const after = await page.evaluate(() => ({ picture: window.DEMO.snapshot(), trigger: window.DEMO.manager.deckLayers().at(-1).props.updateTriggers.getFillColor, selection: window.DEMO.session.state.selection, line: document.querySelector('.cng-tl-status').textContent }));
    const moved = difference(before.picture, after.picture);
    check('moving the selection re-colours the map and requests no tile', tileRequests === requestsBefore && moved > 0.5 && before.trigger !== after.trigger && after.selection.to === to,
      `${tileRequests - requestsBefore} requests; the map changed by ${moved.toFixed(1)} of 255 per channel; now ${after.selection.from}..${after.selection.to}: "${after.line}"`);
  }

  // --- 5. Across New Year ---------------------------------------------------------------------------
  {
    const year = Number(thisYear.id);
    await page.evaluate((y) => window.DEMO.control._canvas.setViewDays(`${y - 1}1115`, `${y}0215`), year);
    await settle();
    const s = await state();
    const before = total(s.histogram, `${year - 1}1115`, `${year - 1}1231`);
    const after = total(s.histogram, `${year}0101`, `${year}0215`);
    check('a view across 1 January loads the year before, and stays daily', s.unit === 'day' && s.loaded.includes(String(year - 1)) && s.loaded.includes(String(year)) && before > 0 && after > 0 && s.failed.length === 0,
      `loaded: ${s.loaded.join(', ')}; ${before.toLocaleString('en-US')} detections before the boundary and ${after.toLocaleString('en-US')} after, in one track`);
  }

  // --- 6. Out to months, and back -----------------------------------------------------------------------
  {
    await page.evaluate(() => window.DEMO.control._canvas.showAll());
    await settle();
    const wide = await state();
    const monthly = Object.keys(wide.histogram).filter((k) => k.length === 6).length;
    const shown = await page.evaluate(() => ({ unit: window.DEMO.control._canvas.axis.unit, selection: window.DEMO.control._canvas.selectionDays(), inputType: document.querySelector('.cng-timeline input').type }));
    check('zoomed out to the whole record, the track is in months and the monthly chunk draws', wide.unit === 'month' && wide.loaded.join() === 'alltime' && wide.drawing.join() === 'alltime' && monthly > 250 && shown.unit === 'month' && shown.inputType === 'month' && wide.selection.from === shown.selection.from,
      `unit ${wide.unit}; loaded: ${wide.loaded.join(', ')}; ${monthly} months with detections; selected ${wide.selection.from}..${wide.selection.to}; date inputs are type "${shown.inputType}"`);

    await page.evaluate(() => {
      const c = window.DEMO.control._canvas;
      const sel = c.selectionDays();
      c.setViewDays(window.DEMO.session.timeline.addDays(sel.to, -45), sel.to);
    });
    await settle();
    const back = await state();
    check('zoomed back in, it is days again, from a yearly chunk', back.unit === 'day' && back.loaded.length >= 1 && back.loaded.every((id) => id !== 'alltime') && back.drawing.length >= 1 && back.bars > 20,
      `unit ${back.unit}; loaded: ${back.loaded.join(', ')}; drawing: ${back.drawing.join(', ')}; ${back.bars} days with detections`);
  }

  // --- 7. Playback ------------------------------------------------------------------------------------------
  {
    const out = await page.evaluate(async () => {
      const D = window.DEMO;
      const c = D.control._canvas;
      const view = c.viewDays();
      // A three-day selection near the start of what is in view, so there is room to play into.
      c.setSelectionDays(D.session.timeline.addDays(view.from, 2), D.session.timeline.addDays(view.from, 4));
      await D.settle();
      const start = D.session.state.selection;
      const button = document.querySelector('.cng-tl-play');
      button.click();
      const pressed = button.getAttribute('aria-pressed');
      await new Promise((r) => setTimeout(r, 1600));
      const playing = D.session.state.selection;
      button.click();
      const paused = D.session.state.selection;
      await new Promise((r) => setTimeout(r, 900));
      return { start, playing, paused, after: D.session.state.selection, pressed, label: button.textContent, now: button.getAttribute('aria-pressed') };
    });
    const width = (s) => Number(s.to) - Number(s.from);
    check('play moves the selection forward at its own width, and pause stops it', out.pressed === 'true' && out.playing.from > out.start.from && width(out.playing) === width(out.start) && out.after.from === out.paused.from && out.now === 'false' && out.label === 'Play',
      `${out.start.from}..${out.start.to} played to ${out.playing.from}..${out.playing.to}, paused at ${out.paused.from}, still ${out.after.from} a moment later`);
  }

  // --- 8. Zoomed in: points -------------------------------------------------------------------------------------
  {
    // Somewhere that is burning in the selected days: the busiest of a few regions, by the histogram itself.
    const found = await page.evaluate(async (week) => {
      const D = window.DEMO;
      D.control._canvas.setViewDays(D.session.timeline.addDays(week.end, -30), week.end);
      D.control._canvas.setSelectionDays(week.start, week.end);
      const places = [[30.5, 7.5], [20.5, 7.5], [-1.0, 9.6], [8.0, 9.5], [-8.5, 11.5], [34.5, 10.5], [103.5, 13.5]];
      let best = null;
      for (const center of places) {
        D.map.jumpTo({ center, zoom: 9.6 });
        await D.settle(45_000);
        const s = D.session.state;
        const n = Object.entries(s.histogram).filter(([k]) => k >= week.start && k <= week.end).reduce((sum, [, v]) => sum + v, 0);
        if (!best || n > best.n) best = { center, n };
        if (n > 40) break;
      }
      D.map.jumpTo({ center: best.center, zoom: 9.6 });
      await D.settle(45_000);
      // What the layer puts on the map, measured where it can be seen: the
      // pixels, at full resolution, that differ from the map with it hidden.
      // (A 48-pixel thumbnail cannot see a day's worth of points. An earlier
      // version of this check used one, and I read its blindness as a bug.)
      D.manager.setVisible('fires', false);
      await D.settle();
      const hidden = D.fullPicture();
      D.manager.setVisible('fires', true);
      await D.settle();
      const weekLit = D.litAgainst(hidden);
      const all = Object.entries(D.session.state.histogram).filter(([k]) => k >= week.start && k <= week.end).reduce((sum, [, v]) => sum + v, 0);
      const requests = performance.getEntriesByType('resource').filter((r) => /\.pmtiles/.test(r.name)).length;
      // One day of the eight: fewer points, not none, and nothing fetched for it.
      D.control._canvas.setSelectionDays(week.start, week.start);
      await D.settle();
      const dayLit = D.litAgainst(hidden);
      const line = document.querySelector('.cng-tl-status').textContent;
      return { best, all, weekLit, dayLit, line, zoom: D.map.getZoom(), fetched: performance.getEntriesByType('resource').filter((r) => /\.pmtiles/.test(r.name)).length - requests };
    }, latest);
    const oneDayCount = Number(/· ([\d,]+) detections/.exec(found.line)?.[1].replaceAll(',', '') ?? 0);
    check('zoomed in, single detections are drawn, counted, and follow the selection', found.all > 0 && found.weekLit > 200 && oneDayCount > 0 && oneDayCount < found.all && found.dayLit > 20 && found.dayLit < found.weekLit && found.fetched === 0,
      `at [${found.best.center}] zoom ${found.zoom.toFixed(1)}: the week's ${found.all.toLocaleString('en-US')} detections light ${found.weekLit.toLocaleString('en-US')} pixels; one day of it (${oneDayCount} detections) lights ${found.dayLit.toLocaleString('en-US')}, with ${found.fetched} requests`);
  }

  // --- 9. One layer: hide it, credit it ------------------------------------------------------------------------------
  {
    const out = await page.evaluate(async (week) => {
      const D = window.DEMO;
      D.map.jumpTo({ center: [22, 4], zoom: 2.6 });
      D.control._canvas.setSelectionDays(week.start, week.end);
      await D.settle();
      const shown = D.snapshot();
      // Through the layer panel's own checkbox, as a person would.
      const rows = [...document.querySelectorAll('.layer-control-item[data-layer-id]')];
      const box = document.querySelector('.layer-control-item[data-layer-id="fires"] .layer-control-checkbox');
      box?.click();
      await D.settle();
      const hidden = D.snapshot();
      const visibleAfterHide = D.manager.get('fires').visible;
      const deckVisible = D.manager.deckLayers().map((l) => l.props.visible);
      box?.click();
      await D.settle();
      return { shown, hidden, back: D.snapshot(), visibleAfterHide, deckVisible, box: Boolean(box), rows: rows.map((r) => r.dataset.layerId), credits: D.credits() };
    }, latest);
    const gone = difference(out.shown, out.hidden);
    const returned = difference(out.shown, out.back);
    // The first version of this check looked for the checkbox with a selector
    // that matched nothing, clicked nothing, and then described the layers as
    // "all invisible". It says what it found now.
    check('the timeline is one row in the layer panel, and its checkbox hides every chunk', out.box && out.rows.filter((id) => id === 'fires').length === 1 && out.visibleAfterHide === false && out.deckVisible.length >= 1 && out.deckVisible.every((v) => v === false) && gone > 2 && returned < gone / 4,
      out.box ? `rows: ${out.rows.join(', ')}; unchecked: layer visible ${out.visibleAfterHide}, chunk layers visible [${out.deckVisible.join(', ')}], the map changed by ${gone.toFixed(1)} of 255; checked again: within ${returned.toFixed(2)} of before` : `no checkbox was found for the layer (rows: ${out.rows.join(', ') || 'none'})`);
    check('the data is credited', /NASA FIRMS/.test(out.credits), out.credits.slice(0, 160));
  }

  // --- 10. The panel ---------------------------------------------------------------------------------------------------
  {
    const out = await page.evaluate(async () => {
      const root = document.querySelector('.cng-timeline');
      const live = document.querySelector('.cng-tl-status');
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(live, { childList: true, characterData: true, subtree: true });
      // Panning the track changes what is in view, not what is selected.
      window.DEMO.control._canvas.zoomBy(0.8);
      window.DEMO.control._canvas.zoomBy(1.25);
      await new Promise((r) => setTimeout(r, 300));
      observer.disconnect();
      const attribution = document.querySelector('.maplibregl-ctrl-bottom-right').getBoundingClientRect();
      const panel = root.getBoundingClientRect();
      const mapBox = window.DEMO.map.getContainer().getBoundingClientRect();
      return {
        mutations, live: live.getAttribute('aria-live'),
        buttons: [...root.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
        unlabelled: [...root.querySelectorAll('button, input, select, canvas')].filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim())).length,
        canvasFocusable: root.querySelector('canvas').tabIndex === 0,
        width: Math.round(panel.width), mapWidth: Math.round(mapBox.width), creditAbove: attribution.bottom <= panel.top + 1,
      };
    });
    check('the panel spans the map, the credit sits above it, and everything in it has a name', out.width >= out.mapWidth - 24 && out.creditAbove && out.unlabelled === 0 && out.canvasFocusable && out.buttons.includes('Play'),
      `${out.width}px of a ${out.mapWidth}px map; credit above: ${out.creditAbove}; controls: ${out.buttons.join(', ')}; ${out.unlabelled} unnamed`);
    check('changing the view does not re-announce the status', out.mutations === 0 && out.live === 'polite', `${out.mutations} changes to the live region`);
  }

  // --- 11. Under a new basemap; removed and added; the layer removed ------------------------------------------------------
  {
    const out = await page.evaluate(async () => {
      const D = window.DEMO;
      const session = D.session;
      const before = D.session.state.selection;
      const loaded = new Promise((resolve) => D.map.once('style.load', resolve));
      D.map.setStyle(D.styleUrl, { diff: false });
      await loaded;
      await D.settle();
      const order = D.map.getLayersOrder();
      const deckGroups = order.filter((id) => id.startsWith('deck-maplibre-layer-group')).length;
      return { same: D.session === session, selection: D.session.state.selection, before, layers: D.manager.deckLayers().map((l) => l.id), status: D.manager.get('fires').status, deckGroups, line: document.querySelector('.cng-tl-status').textContent, bars: Object.keys(D.session.state.histogram).length };
    });
    check('after map.setStyle() the same timeline is still drawing', out.same && out.status === 'ready' && out.layers.length >= 1 && out.deckGroups >= 1 && out.selection.from === out.before.from && out.bars > 0,
      `${out.layers.length} chunk layers (${out.layers.join(', ')}), ${out.deckGroups} deck.gl group(s) in the new style; selection kept; "${out.line}"`);
  }
  {
    const out = await page.evaluate(async () => {
      const D = window.DEMO;
      D.map.removeControl(D.control);
      const gone = { panels: document.querySelectorAll('.cng-timeline').length, lifted: D.map.getContainer().classList.contains('cng-has-timeline'), layers: D.manager.list().length };
      D.map.addControl(D.control, 'bottom-left');
      await D.control.ready;
      await D.settle();
      const s = D.session?.state;
      return { gone, panels: document.querySelectorAll('.cng-timeline').length, bound: Boolean(D.session), axis: D.control._canvas?.axis?.unit ?? null, line: document.querySelector('.cng-tl-status').textContent, bars: s ? Object.keys(s.histogram).length : 0 };
    });
    check('the control can be removed and added again; the layer stays', out.gone.panels === 0 && !out.gone.lifted && out.gone.layers === 1 && out.panels === 1 && out.bound && out.axis === 'day' && out.bars > 0,
      `removed: ${out.gone.panels} panels, ${out.gone.layers} layer still on the map; added again: bound, ${out.bars} bars, "${out.line}"`);
  }
  {
    const requestsBefore = tileRequests;
    const out = await page.evaluate(async () => {
      const D = window.DEMO;
      const session = D.session;
      D.manager.remove('fires');
      await new Promise((r) => setTimeout(r, 400));
      D.map.jumpTo({ center: [-60, -10], zoom: 4 }); // somewhere new: a live layer would fetch
      await new Promise((r) => setTimeout(r, 2500));
      return { layers: D.manager.list().length, deck: D.manager.deckLayers().length, destroyed: session.destroyed, mounts: session.set.mounts().length, bound: Boolean(D.session), line: document.querySelector('.cng-tl-status').textContent, playDisabledOrIdle: !D.control.playing };
    });
    check('removing the layer leaves nothing behind: no chunk layer, no request', out.layers === 0 && out.deck === 0 && out.destroyed && out.mounts === 0 && !out.bound && tileRequests === requestsBefore,
      `${out.deck} deck.gl layers, ${out.mounts} mounted chunks, ${tileRequests - requestsBefore} tile requests after moving the map; the panel says "${out.line}"`);
  }

  // --- 12. Hygiene -----------------------------------------------------------------------------------------------------------
  {
    const hostTrouble = (e) => /Failed to load resource: (net::ERR_|the server responded with a status of 5\d\d)/.test(e);
    const own = errors.filter((e) => !hostTrouble(e));
    check('no console errors', own.length === 0, `${own.length ? own.join(' | ').slice(0, 600) : "none of the page's own"}${errors.length - own.length ? `; ${errors.length - own.length} from a data host or the network` : ''}`);
  }
} catch (err) {
  check('the run got to the end', false, String(err?.message ?? err).split('\n')[0].slice(0, 300));
} finally {
  await page.close();
}

// --- 13. Reduced motion: nothing plays by itself -------------------------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const quiet = await context.newPage();
  try {
    await quiet.goto(`${base}?verify=1&autoplay=1`, { waitUntil: 'load' });
    await ready(quiet);
    const out = await quiet.evaluate(async () => {
      const D = window.DEMO;
      await D.settle(60_000);
      const start = D.session.state.selection;
      await new Promise((r) => setTimeout(r, 1500));
      const speeds = [...document.querySelectorAll('.cng-timeline select option')].map((o) => Number(o.value));
      return { playing: D.control.playing, moved: D.session.state.selection.from !== start.from, speeds };
    });
    check('with reduced motion asked for, autoplay does not play and no speed is faster than a step a second', !out.playing && !out.moved && out.speeds.length > 0 && out.speeds.every((s) => s <= 1),
      `playing: ${out.playing}; the selection moved: ${out.moved}; speeds offered: ${out.speeds.join(', ')}`);
  } catch (err) {
    check('the reduced-motion page came up', false, String(err?.message ?? err).split('\n')[0].slice(0, 300));
  } finally {
    await context.close();
  }
}

await browser.close();
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED:\n${bad.map((r) => `  ${r.name}`).join('\n')}` : `\ntimeline-firms: all ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
