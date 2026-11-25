# Map widgets, Phase 4: timeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A histogram timeline over time-chunked map data: any number of chunks of any period (yearly, monthly, weekly, mixed), a canvas timeline with a draggable selection and play/pause, and a map layer that draws what is selected — with PMTiles as the first chunk format and room for others.

**Architecture:** `@cngeo/timeline` holds everything that needs no map: bucket-key and axis arithmetic, chunk descriptors, the rules for which chunks load and which draw, an orchestrator that runs those rules against a `ChunkFormat`, a playback clock, and the canvas component. `@cngeo/maplibre` implements one `ChunkFormat` (PMTiles on deck.gl `MVTLayer`), a `timeline` layer renderer so the whole thing is one `LayerManager` entry, and `TimelineControl`. `@cngeo/stac` gains `chunksFromStac`.

**Tech Stack:** plain ESM, `node --test`; deck.gl 9.4.2 (`MVTLayer`, `GeoJsonLayer`, `DataFilterExtension`) from the committed bundle; pmtiles 4.5.0 via `loadPmtiles()`; MapLibre GL 5.24.1; Playwright for the live verifier.

**Spec:** `docs/superpowers/specs/2026-11-25-map-widgets-design.md`, "Phase 4 — timeline" and "Constraints carried through every phase".

**Source being ported:** `~/repos/firms-catalog/apps/firms-explorer/` — `timeline.js`, `mounted.js`, `deck-cells.js`, `archives.js` are pure and move with their tests; `deck.html` is page glue around globals and is **rewritten, not ported**. Measured facts about the live data (2026-11-25): the FIRMS collection has 27 `rel: item` links, one per year; each item has `start_datetime` / `end_datetime` and a `pmtiles` asset (`./fire-<year>.pmtiles`, roles `visual`, `tiles`); the collection itself has a `pmtiles` asset (`fire-latest.pmtiles`, a rolling week of days) and `alltime.pmtiles` (monthly buckets, whole record) sits beside it, linked from nothing.

## Global Constraints

- `@cngeo/timeline` imports only `@cngeo/spec`. No map library. Only the canvas component touches the DOM.
- `@cngeo/maplibre` must not make every page map `@cngeo/timeline`: it loads it through a seam (`loadTimeline()` / `setTimelineModules()`), a dynamic `import('@cngeo/timeline')`, used only when a timeline layer is added.
- Third-party code only through the existing seams (`loadDeck`, `loadPmtiles`). No new third-party dependency.
- Dates are calendar days in UTC, as `YYYYMMDD` keys; never a `Date` in local time. Bucket units are `day` and `month`. A chunk's *span* is arbitrary.
- Error codes are the API. New: `TIMELINE_INVALID` (not retryable) for a chunk list, descriptor or declaration that cannot be used. A chunk that will not load is `LAYER_LOAD_FAILED` (retryable).
- Remote text reaches the DOM by `textContent`. Attribution is displayed. Controls are keyboard-accessible, themed by `--cng-*` tokens, removable without leaks, and survive `map.setStyle()`.
- Honour `prefers-reduced-motion`: nothing plays by itself, and playback steps no faster than once a second.
- Not carried from the source: the stats sidecar, cumulative `count_c*` columns, feature-state, the archive picker, FIRMS colours and names as defaults (they become the example's configuration). `view=` / `sel=` hash state is cut.
- **No GeoParquet format is built.** A fake format in the tests proves a second one plugs in.

## Review Focus

1. **Chunks that are not years.** Monthly chunks with day buckets, weekly chunks, and a mix of sizes: the axis, the gaps, which load and which draw must all be right. A selection that spans three monthly chunks must draw all three, not one.
2. **Overlapping chunks that disagree** (a rolling week over a year). Each bucket is counted and drawn once, from the chunk with the higher `priority`; a tie goes to the narrower.
3. **A chunk that fails to load, or never answers.** The rest keep working; its span reads as not loaded, not as zero; the failure is said, and can be retried.
4. **Fast input.** A drag across many chunk boundaries, a selection dragged while chunks are still loading, play pressed during a load: no oscillation, no blank map, no chunk loaded twice, nothing left mounted after `destroy()`.
5. **Units.** Zooming out past the cap moves to the coarser unit when the set has one and back again when zooming in; with no coarser chunk the nearest `cap` chunks load and the rest read as not loaded.

---

### Task 1: Bucket keys and the axis

**Files:**
- Create: `packages/timeline/src/keys.js`, `packages/timeline/src/axis.js`
- Test: `packages/timeline/test/keys.test.js`, `packages/timeline/test/axis.test.js` (ported from `timeline.test.mjs`, pure part)

**Interfaces:**
- Produces (`keys.js`): `daysFromCivil(y,m,d)`, `civilFromDays(z)`, `keyIndex(key, unit)`, `indexKey(index, unit)`, `compareKeys(a,b)`, `unitOfKey(key)` (`'day'`|`'month'`), `formatKey(key, unit)`, `keyToISO(key, unit)`, `isoToKey(iso, unit)`, `dayRangeOfKey(key, unit)` → `[firstDay, lastDay]`, `bucketKeyOfDay(dayKey, unit)`, `dayKeyOfDate(isoOrDate)` (UTC), `addDays(dayKey, n)`.
- Produces (`axis.js`): `makeAxis({ unit, min, max, buckets? })` → `{ unit, min, max, origin, count, declaredBuckets, keyAt(i), indexOf(key) }`; `MIN_SPAN`; `xToCoord`, `coordToX`, `bucketAt`, `clampDomain`, `zoomDomain`, `panDomain`, `domainBuckets`; `clampSelection`, `moveSelection`, `resizeSelection`; `makeSeries`, `sumRange`, `seriesFromBuckets(axis, buckets, { prefix = 'count_' })`; `quantize`; `ticks(axis, domain, width)`; `COUNT_RAMP`, `rampColor`, `liftForTrack`.

- [ ] **Step 1:** Port the tests (rename imports; `makeAxis` no longer checks a `key_format`, and throws `TIMELINE_INVALID`). Add: `dayRangeOfKey('202402','month')` → `['20240201','20240229']`; `bucketKeyOfDay('20241231','month')` → `'202412'`; `dayKeyOfDate('2000-11-01T00:13:00Z')` → `'20001101'`; `addDays('20241231', 1)` → `'20250101'`.
- [ ] **Step 2:** Run `node --test packages/timeline/test/keys.test.js packages/timeline/test/axis.test.js` — Expected: FAIL, modules not found.
- [ ] **Step 3:** Port the code. Errors become `CngError(..., 'TIMELINE_INVALID')`. Add `TIMELINE_INVALID` to `packages/spec/src/errors.js` and its README table.
- [ ] **Step 4:** Run again — Expected: PASS.
- [ ] **Step 5:** Commit — `feat(timeline): bucket keys and axis arithmetic`

### Task 2: Chunks — descriptors, and the rules for a set of them

**Files:**
- Create: `packages/timeline/src/chunks.js`
- Test: `packages/timeline/test/chunks.test.js` (ports `mounted.test.mjs`; adds the non-yearly cases)

**Interfaces:**
- Consumes: Task 1's keys.
- Produces:
  - `ChunkDescriptor`: `{ id: string, start: string, end: string, unit: 'day'|'month', format: string, url: string, priority?: number }` — `start`/`end` are day keys, inclusive.
  - `validateChunks(list)` → normalised copy (sorted by start; `priority` 0 by default). Throws `TIMELINE_INVALID` for: not an array or empty, a missing/duplicate `id`, a bad or reversed date, an unknown `unit`, a `url` that is not http(s).
  - `chunksFromTemplate({ template, period, start, end, unit = 'day', format = 'pmtiles', priority = 0 })` — `period` is `'year'|'month'|'week'|'day'` or `{ days: n }`; `start`/`end` are day keys or ISO dates; calendar periods align to the calendar (a year chunk runs 1 Jan–31 Dec, clipped to `start`/`end`); weeks and `{days}` run from `start`. Tokens: `{YYYY}` `{MM}` `{DD}` (the chunk's first day), `{start}` `{end}`. `id` is the chunk's first day, or `YYYY` / `YYYYMM` for a year / month.
  - `extentOf(chunk)` → `{ unit, min, max }` in the chunk's own bucket keys.
  - `covers(chunk, key)`; `ownerOf(chunks, key)` (higher `priority`, then the narrower span, then the earlier `id`); `ownedRanges(chunks, chunk, fromKey, toKey)` → `[[fromKey, toKey], …]`; `axisFor(chunks, unit)` → `{ unit, min, max }` or null; `gapsIn(chunks, axis)` → `[[i0, i1], …]`.
  - `forView(chunks, { from, to }, { cap = 3 })` → `{ unit, load: ChunkDescriptor[] }`. Finest unit first: take the chunks of that unit touching the window; set aside those wholly inside another touching chunk's span (overlays — always loaded); if the rest number ≤ `cap`, that is the answer. Otherwise try the next coarser unit. If none fits, the finest unit with the `cap` chunks nearest the window's middle (plus overlays).
  - `forSelection(chunks, { from, to }, unit)` → every chunk of `unit` that owns at least one bucket in the window, by start.

- [ ] **Step 1: Write the failing tests.** Ported cases, plus:
  - monthly chunks with day buckets (`chunksFromTemplate({ period: 'month', start: '20240101', end: '20241231' })`): 12 chunks; `id`s `202401`…; February ends `20240229`; `axisFor` spans the year; `gapsIn` with only March loaded hatches `[0, 59]` and `[91, 365]`.
  - weekly chunks from a Wednesday: 7-day spans from `start`, the last clipped to `end`.
  - a mixed set (years 2023, 2024 daily; a rolling week ending 20241210 with `priority: 1`; an all-time monthly chunk): `ownerOf` gives the week its days and the year the rest; `forView` of a 60-day window in 2024 → unit `day`, load `[2024, week]`; of a window spanning Dec 2023–Jan 2024 → `[2023, 2024, week]` only if the week touches, cap 2 respected; of 2019–2024 → unit `month`, load the all-time chunk; with the monthly chunk removed → unit `day`, the 2 chunks nearest the middle.
  - `forSelection` across three monthly chunks returns all three; `ownedRanges` of the year under the overlapping week excludes the week's days.
  - `validateChunks` refusals, each `TIMELINE_INVALID` naming the chunk.
- [ ] **Step 2:** Run `node --test packages/timeline/test/chunks.test.js` — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Commit — `feat(timeline): chunk descriptors and the rules for a set of them`

### Task 3: The orchestrator

**Files:**
- Create: `packages/timeline/src/orchestrator.js`, `packages/timeline/test/helpers/fake-format.js`
- Test: `packages/timeline/test/orchestrator.test.js`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `ChunkFormat`: `{ open(chunk, { signal }) → Promise<{ unit?, min?, max?, columns?, … }>, mount(ctx) → ChunkMount }`. `ctx`: `{ chunk, info, changed(), settled() }` — the mount calls `changed()` when it has new data (a tile arrived) and `settled()` when what is on screen has loaded.
  - `ChunkMount`: `{ setWindow(window|null), histogram(viewport) → { [bucketKey]: number }, freeze(), destroy() }`. `window` is `{ unit, ranges: [[fromKey, toKey], …] }` — the buckets of the selection this chunk owns; `null` means loaded but not drawing.
  - `createChunkSet({ chunks, formats, cap = 3, settleMs = 450, loadEveryMs = 150, histogramMs = 180, handoverMs = 8000, timers })` → `{ state, on('change', fn), setView({ from, to }, { dragging }), setSelection({ from, to }), setViewport(viewport), retry(id), mounts(), destroy() }`.
  - `state`: `{ unit, axis: { unit, min, max }|null, gaps: [[i0,i1]], loaded: string[], drawing: string[], outgoing: string[], pending: string[], failed: { id, error }[], histogram: { [key]: number }, partial: boolean, view, selection }`.
  - Rules: what is loaded follows the view (and whatever the selection needs, which is never evicted); while `dragging`, chunks are only added, at most every `loadEveryMs`; unit changes and evictions wait `settleMs` after the last change. What draws follows the selection: every loaded chunk owning buckets of it, each given only its own ranges. A chunk leaving the draw set while its replacements have not settled is `freeze()`d and kept until they have, or `handoverMs`. The axis is the union of the whole set at the active unit; `gaps` are what no loaded chunk covers. The histogram is each bucket's count from its owner, recomputed `histogramMs` after `changed()` or `setViewport()`; `partial` while any loaded chunk has not settled. One reconcile at a time: a call during one marks it dirty and it runs again.
- [ ] **Step 1: Write the failing tests** with a fake format (records `open`/`mount`/`setWindow`/`freeze`/`destroy`; resolves `open` on demand; has canned histograms) and fake timers: the five Review Focus lines, each as tests — monthly chunks: a 70-day selection draws three; overlap: the week's days come from the week in the histogram and in the windows; a failing `open` lands in `failed`, its span stays a gap, `retry()` loads it; a drag across six boundaries loads at most `cap` and never one twice; a selection moved before its chunk has opened draws once it has; handover freezes the leaving chunk and releases it on `settled()`; a unit switch waits `settleMs` and keeps view and selection in days; `destroy()` destroys every mount and silences every callback; reentrancy (a `changed()` fired from inside `setWindow`).
- [ ] **Step 2:** Run `node --test --test-timeout=30000 packages/timeline/test/orchestrator.test.js` — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Commit — `feat(timeline): the chunk-set orchestrator`

### Task 4: Playback

**Files:**
- Create: `packages/timeline/src/playback.js`
- Test: `packages/timeline/test/playback.test.js`

**Interfaces:**
- Produces: `createPlayback({ step, ready, speed = 4, loop = false, reducedMotion = false, timers })` → `{ state: { playing, speed, loop }, play(), pause(), toggle(), setSpeed(stepsPerSecond), setLoop(on), stepBy(n), on('change', fn), destroy() }`. `step(direction)` advances the selection one bucket and returns false when it cannot (the end); `ready()` false holds the clock without stopping it.
- [ ] **Step 1: Tests** (fake timers): plays at the speed given; pauses; at the end stops, or with `loop` starts again (`step('restart')`); holds while `ready()` is false and resumes; `stepBy(-1)` while playing pauses first; `reducedMotion` caps the speed at 1 a second; `destroy()` clears the timer.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Commit — `feat(timeline): a playback clock`

### Task 5: The canvas

**Files:**
- Create: `packages/timeline/src/timeline-canvas.js`; Modify: `packages/timeline/src/index.js`, `packages/timeline/README.md`
- Test: `packages/timeline/test/timeline-canvas.test.js` (a stub canvas and context: no DOM library)

**Interfaces:**
- Consumes: Task 1.
- Produces: `class TimelineCanvas` — the source's `Timeline`, with: `constructor(canvas, { onChange, ramp, metricLabel, theme })`; `setAxis(decl, { keep })` (re-axis without losing the view and selection, by day keys); `setValues(buckets)`; `setGaps(ranges)`; `setTheme(theme)`; `selectionDays()` / `viewDays()` → `{ from, to }` day keys; `setSelectionDays(from, to)`; `setViewDays(from, to)`; `setSpan(buckets)`; `zoomBy(factor)`; `shift(buckets)` (move the selection, following with the view); `destroy()`. `onChange({ view, selection, dragging, overflowDays })` in day keys.
- [ ] **Step 1: Tests:** `setAxis` then `setViewDays`/`setSelectionDays` round-trip through a day axis and a month axis; `setAxis(…, { keep: true })` from days to months keeps the same real dates; `shift(1)` at the right edge of the view moves the view with it; `shift` at the end of the axis returns false; keyboard arrows move the selection and emit; `destroy()` removes every listener (count them on the stub).
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Port and adapt. Colours come from `theme`, never literals in the paint code.
- [ ] **Step 4:** Run the package's tests — Expected: PASS.
- [ ] **Step 5:** Commit — `feat(timeline): the canvas timeline component`

### Task 6: Chunks from a STAC collection

**Files:**
- Create: `packages/stac/src/chunks-from-stac.js`; Modify: `packages/stac/src/index.js`, `packages/stac/README.md`
- Test: `packages/stac/test/chunks-from-stac.test.js`

**Interfaces:**
- Produces: `chunksFromStac(collection, { baseUrl, fetch, unit = 'day', format = 'pmtiles', assetType = 'application/vnd.pmtiles', concurrency = 8, timeoutMs = 60000 })` → `Promise<{ chunks: ChunkDescriptor[], skipped: { href, reason }[] }>`. One chunk per `rel: item` whose item has dates (`start_datetime`/`end_datetime`, else `datetime`) and an asset of `assetType` (preferring role `tiles`, then `visual`). An item that cannot be fetched or has no such asset is `skipped`, with why; it does not fail the rest. Plain objects: this package does not import `@cngeo/timeline`.
- [ ] **Step 1: Tests** with a fake host shaped like FIRMS (27 items, relative hrefs): 27 chunks, ids by year, absolute URLs, day keys in UTC; one 404 and one item with no PMTiles asset → 25 chunks and two `skipped`; no item links → `{ chunks: [], skipped: [] }`; a hanging item is skipped after `timeoutMs`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Commit — `feat(stac): chunksFromStac`

### Task 7: PMTiles as a chunk format

**Files:**
- Create: `packages/maplibre/src/timeline/pmtiles-meta.js`, `tile-cells.js`, `pmtiles-chunk-format.js`, `packages/maplibre/src/timeline-loader.js`
- Modify: `packages/spec/src/layer.js` (validate a `timeline` source), `packages/maplibre/src/layer-manager.js` (`ctx.redraw()`, `manager.handle(id)`), `packages/maplibre/package.json`
- Test: `packages/maplibre/test/pmtiles-meta.test.js`, `tile-cells.test.js` (ports `archives.test.mjs` and `deck-cells.test.mjs`), `pmtiles-chunk-format.test.js` (fake deck and pmtiles modules), additions to `layer-manager.test.js` and `packages/spec/test/layer.test.js`

**Interfaces:**
- Consumes: Tasks 1–3 through `loadTimeline()`.
- Produces:
  - `timelineFromMetadata(metadata, { layer, prefix = 'count_' })` → `{ declared, unit, min, max, columns: string[] }` — reads `cng:timeline`, then `firms:timeline`, else rebuilds from the layer's declared fields; `TIMELINE_INVALID` when neither gives an axis.
  - `tile-cells.js`: `DECK_TILE_SIZE`, `tileZoom`, `featureBounds`, `lngOverlaps`, `windowPlan({ columns, ranges, prefix })`, `countFor(plan, properties)`, `fillFor(count, stops)`, `TileCache({ axis, idProperty, prefix, timeProperty })` with `add`, `remove`, `histogram(z0, z1, view)`, `pointHistogram(z0, z1, view)`.
  - `pmtilesChunkFormat({ aggregate: { layer, prefix, idProperty, maxzoom? }, points?: { layer, property, minzoom, color? }, stops, byteCacheBytes = 64 MiB, loadDeck, loadPmtiles })` → a `ChunkFormat` whose mounts also have `layers({ visible, opacity }, beforeId)` → deck.gl layer objects, and `tiles()` → `{ selected, loaded }`.
  - `MVTLayer` props: `binary: false`, `tileSize: DECK_TILE_SIZE`, `refinementStrategy: 'no-overlap'`, `loadOptions: { worker: false }`, a `fetch` through the shared byte cache, `updateTriggers` on the window's signature. Points are filtered on the GPU (`DataFilterExtension`), cells re-coloured by accessor: a selection change fetches nothing.
  - `LayerManager`: a renderer's `ctx.redraw()` re-syncs the deck overlay; `manager.handle(id)` returns what the renderer's optional `handle()` returns.
  - A `timeline` `LayerSpec.source`: `{ chunks: ChunkDescriptor[], cap?, aggregate, points?, stops?, open?: { selectDays, viewDays } }`; `validateLayerSpec` requires a non-empty `chunks` with `id`, `url`, `start`, `end`.
- [ ] **Step 1: Tests.** Ported pure tests; `windowPlan` over two ranges sums only those columns; `TileCache` with a configurable id property and with none; the format against fakes: `open` reads metadata once per chunk, `mount().layers()` gives no visible layer for a `null` window, a frozen mount keeps its last window after `setWindow`, `destroy()` drops its tiles from the cache; the Chrome range-read flag is set on the source; `ctx.redraw` and `handle` on the manager.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5:** Commit — `feat(maplibre): PMTiles chunks as a timeline format`

### Task 8: The timeline layer and its control

**Files:**
- Create: `packages/maplibre/src/timeline/timeline-renderer.js`, `packages/maplibre/src/timeline-model.js`, `packages/maplibre/src/timeline-control.js`
- Modify: `packages/maplibre/src/index.js`, `packages/maplibre/README.md`
- Test: `packages/maplibre/test/timeline-model.test.js`, `timeline-renderer.test.js`

**Interfaces:**
- Consumes: Tasks 3, 4, 5, 7.
- Produces:
  - A renderer for kind `timeline`: one `LayerManager` entry; `handle()` → the session `{ set (the chunk set), format, state, on('change'), setView, setSelection, destroy }`. It feeds the map's bounds to `setViewport` on `moveend`, calls `ctx.redraw()` on every change of what draws, and `ctx.note()` for a chunk that failed.
  - `createTimelineModel({ session, playback })` → state for the panel with no DOM: `status` words (loading N of M tiles; "N days not loaded yet"; a chunk that failed), presets (`7d`, `30d`, `90d`, `1y`, `all`, kept to what the axis can show), date-input values and bounds, play state.
  - `new TimelineControl({ manager, layer, position?, presets?, metricLabel?, autoplay? = false })` — `layer` is the id of a timeline layer already in the manager, or a `LayerSpec` to add. A docked canvas (the map's width, less the gutters), presets, zoom buttons, two date inputs, play/pause with a speed menu. `control.ready`; `control.session`.
- [ ] **Step 1: Tests** for the model (status words for each state, unchanged by hover; presets filtered by axis; date inputs follow the unit) and the renderer (with a fake session factory: add → handle; `deckLayers` asks every mount; remove destroys; a failed chunk becomes a note, not a failed layer, unless every chunk failed).
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement the model, the renderer, then the control.
- [ ] **Step 4:** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5:** Commit — `feat(maplibre): the timeline layer and TimelineControl`

### Task 9: The example, verified live

**Files:**
- Create: `examples/timeline-firms/index.html`, `verify.mjs`, `screenshot.mjs`, `screenshot.png`; Modify: `examples/index.html`

- [ ] **Step 1: `verify.mjs`** (Playwright, live FIRMS data, takes a `serve.py` port). Checks:
  1. the page is ready: one `LayerManager` entry, kind `timeline`, status `ready`;
  2. the axis runs from November 2000 to this week while only the rolling week and one year are loaded, and the rest is reported as gaps;
  3. the histogram has bars, and they sum to what the loaded tiles hold in view;
  4. moving the selection re-colours the map and makes no tile request;
  5. a view dragged across 1 January loads the second year and stays daily;
  6. zooming far out moves to months (the all-time chunk draws) and zooming back in returns to days;
  7. play advances the selection, pause stops it, and with reduced motion nothing plays by itself;
  8. zoomed in, points are drawn and follow the selection;
  9. hiding the layer in the layer panel hides it; the credit is displayed;
  10. the control survives `setStyle()` and being removed and added; removing the layer leaves no deck layer, no listener and no timer;
  11. no console errors (host 5xx excused, 4xx not).
- [ ] **Step 2:** Run it — Expected: FAIL (no page).
- [ ] **Step 3:** Write the page: FIRMS chunks from `chunksFromTemplate` (years) plus the rolling week (`priority: 1`) and the all-time monthly chunk; FIRMS colours and names as configuration.
- [ ] **Step 4:** Run `node examples/timeline-firms/verify.mjs <port>` until every check passes; re-run the three earlier verifiers.
- [ ] **Step 5:** Commit — `feat(examples): timeline-firms`

## Not in this phase

A GeoParquet chunk format; hash state; drawing more than one metric; a legend; saving a timeline layer in a layer stack.
