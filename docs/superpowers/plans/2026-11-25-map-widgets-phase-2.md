# Map Widgets Phase 2 (Imagery Search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search any STAC-GeoParquet imagery collection by area, time and attributes from the browser, see the scenes as footprints and thumbnails, and add a scene to the layer stack as imagery.

**Architecture:** `@cngeo/extract-core` already resolves, prunes and reads; it gains a way to hand rows back (not just write files), a cache of what planning learns, and a time model for interval data. `@cngeo/stac` turns a collection into an *imagery profile* (where its item table is, how its time and assets are shaped, what to filter on) and runs searches through it. A scene becomes an ordinary `cog` `LayerSpec`, so Phase 1's `LayerManager` draws it with no new renderer. `@cngeo/maplibre` adds the search panel and the footprints.

**Tech Stack:** Plain ESM + JSDoc, Node 22 `node --test`, Playwright 1.65.0. hyparquet 1.33.0 (existing). The Phase 0 deck bundle, rebuilt once to export deck.gl-raster's projection registry.

**Spec:** [`docs/superpowers/specs/2026-11-25-map-widgets-design.md`](../specs/2026-11-25-map-widgets-design.md), Phase 2. Evidence: [`experiments/e14-search-cost/RESULTS.md`](../../../experiments/e14-search-cost/RESULTS.md), [`experiments/e12-deck-bundle/RESULTS.md`](../../../experiments/e12-deck-bundle/RESULTS.md).

## Global Constraints

- Branch `map-widgets-phase-2`, stacked on `map-widgets-phase-1` (PR #8). Never commit to `main`.
- **Existing download behaviour must not change** except where the spec says so (call 3: interval time). `download()`, `estimate()`, their events, error codes and the 430+ existing extract-core tests stay as they are. Every extract-core change is additive or behind a new option.
- No bare third-party specifier in `packages/*/src`. `@cngeo/maplibre` must not statically import `@cngeo/stac`.
- Range reads use `cache: 'no-store'`. `BigInt` values are coerced before they leave a package. Spatial maths uses `area.bboxes`, never `area.bbox`.
- A superseded search resolves `[]`, never rejects (the `Geocoder.search` contract).
- Time filters on interval data mean **overlaps the window**: a row's span is `start_datetime ?? datetime` … `end_datetime ?? datetime` (spec call 3).
- A scene's `assets` are never read for every row of a search unless they are a struct (E14: Sentinel-2's JSON `assets` is 6.5 MB per row group).
- Error codes are the API. New: `SCENE_ASSETS_UNAVAILABLE` (not retryable). Registered in `packages/spec`.
- Text from a remote document reaches the DOM through `textContent` only; a URL becomes an `href` or `src` only if it is `http(s)`.
- `npm test` stays green: 1,017 at the start of this phase.

## Review Focus

1. **A second search starts before the first finishes** (a user dragging the date range). The first must stop reading, resolve `[]`, and never deliver scenes into the second's results. → Task 6.
2. **Rows with a null `datetime`** (all of OpenAerialMap). A time filter must select them by their start/end, and an open-ended window must not drop them. → Task 1.
3. **A scene whose assets cannot be resolved** (no struct, no link to its item, a 404). Adding it must fail with `SCENE_ASSETS_UNAVAILABLE` and say which scene, not add a blank layer. → Task 6.
4. **An area that crosses the antimeridian, or no area at all.** Both must search, the first over both boxes. → Task 6.
5. **A cached plan gone stale** (Sentinel-2's `live` parts are rewritten). A cache older than its lifetime is not used; a read against a file whose size changed re-plans once. → Task 2.

---

### Task 1: Interval time in `extract-core`

**Files:**
- Modify: `packages/extract-core/src/prune.js`, `engine-hyparquet.js`, `columns.js`, `estimate.js`, `dataset-resolve.js`
- Test: `packages/extract-core/test/time-interval.test.js`

**Interfaces:**
- Produces:
  - `table.timeInterval?: { start: string, end: string }` on a resolved `DatasetDescriptor.table`, beside the existing `table.timeColumn`.
  - `timeSpanPredicate(time, { instant, start, end }): ((row) => boolean) | null` from `prune.js` — the row test: a row's span is `row[start] ?? row[instant]` … `row[end] ?? row[instant]`; it matches when the span overlaps the window under `time.closed`; a row with no time at all is rejected; an unreadable value is kept.
  - `pruneRowGroupsByTime(rowGroups, timeColumn, time, interval?)` gains the optional fourth argument: a row group is dropped only when the largest known end is before the window or the smallest known start is after it; missing statistics on any column it needs keep the group.
  - `inferTableFromSchema` sets `timeColumn: 'datetime'` when the file has that column, and `timeInterval` when it has both `start_datetime` and `end_datetime`. `deriveFromCollection` does the same from `table:columns`.
- `timeRowPredicate` keeps its signature and behaviour; with no `timeInterval` nothing changes.
- Also here, because it is the other reason an item table cannot be read today: `deriveSource` resolves a
  **non-partitioned** `collection-mirror` asset to `{ kind: 'parquet', url }` (OpenAerialMap falls through
  to `DATASET_UNSUPPORTED` now). Not `stac-geoparquet`: that kind's enumeration would read the item table
  as a list of partition files. Test: `descriptorFromCollection(oam fixture)` gives that source.

- [ ] **Step 1: Write the failing tests**

```js
test('a row with only start/end is matched by overlap')          // start 06-10, end 06-12 vs window [06-11, 06-20) -> true
test('a row that ends before the window, or starts at/after its end, is rejected')
test('a row with a null datetime and a null start/end is rejected')
test('start/end fall back to datetime per row, each independently')
test('an open-ended window keeps a row with only start/end')     // Review Focus 2
test('closed "[]" includes a row starting exactly at the window end')
test('row groups: dropped only when max(end) < start or min(start) >= end; missing stats keep the group')
test('inferTableFromSchema finds datetime, and the interval pair, by name')
test('with no timeInterval, timeRowPredicate and pruneRowGroupsByTime behave exactly as before')
```
plus one engine-level test on the existing fake parquet host: a file whose rows have `start_datetime`/`end_datetime` and a null `datetime`, filtered by a window, returns the overlapping rows (today it returns none).

- [ ] **Step 2: Run** `node --test packages/extract-core/test/time-interval.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** `resolveReadColumns` adds the interval columns when a time filter is set. `estimate.js`'s `row-group-stats` basis names the columns used.
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `feat(extract-core): time filters on interval data (start/end columns)`

---

### Task 2: A plan cache

**Files:**
- Create: `packages/extract-core/src/plan-cache.js`, `packages/extract-core/test/plan-cache.test.js`
- Modify: `packages/extract-core/src/estimate.js` (`planRequest`), `parquet-io.js` (`openParquetFile`), `partitions.js`, `index.js`

**Interfaces:**
- Produces, from `@cngeo/extract-core`:
  - `createPlanCache({ maxAgeMs = 600_000, now = Date.now }): PlanCache` — `{ parts, footers, clear(), stats(): { partListings, footers, hits, misses } }`.
  - `options.cache?: PlanCache` on `estimate()`, `planRequest()`, the engine's `plan()`, and `download()`. Absent: exactly today's behaviour.
  - `openParquetFile(url, fetch, { signal, cache })`: on a hit, no request at all — a new `AsyncBuffer` is built with the cached `byteLength` (hyparquet skips its HEAD when given one) and the cached `metadata`/`rowGroups` are reused. The buffer is always new, because it carries this call's `signal`.
  - Part listings (`enumeratePartitions`) are cached under the source's enumeration identity.
- A hit that returns a `416`/short read (the file changed size) evicts the entry and re-plans once (Review Focus 5).
- An in-flight read is shared: two concurrent plans for one URL make one footer request.

- [ ] **Step 1: Write the failing tests** on the fake parquet host, counting requests:

```js
test('a second plan with the same cache makes no listing and no footer requests')
test('without a cache, a second plan repeats them (unchanged behaviour)')
test('two concurrent plans share one footer read')
test('an entry older than maxAgeMs is not used')                 // injected `now`
test('each cached open carries its own signal: aborting one read does not abort another')
test('a file that changed size is re-planned once, then succeeds') // Review Focus 5
test('a failed footer read is not cached')
```

- [ ] **Step 2: Run** — Expected: FAIL, module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `feat(extract-core): a plan cache for part listings and footers`

---

### Task 3: `queryRows`

**Files:**
- Create: `packages/extract-core/src/query.js`, `packages/extract-core/test/query-rows.test.js`
- Modify: `packages/extract-core/src/engine-hyparquet.js`, `index.js`, `packages/extract-core/README.md`

**Interfaces:**
- Consumes: `options.cache` (Task 2), `timeInterval` (Task 1).
- Produces:
  ```
  queryRows(dataset, area, filter, options?: {
    onRows?: (rows: object[]) => void | Promise<void>,   // per row group, in row-group order
    geometry?: 'geojson' | 'wkb' | 'none',               // default 'geojson'
    signal?, cache?, fetch?, maxConcurrentRequests?
  }): Promise<{ rows: object[], truncated: boolean, plan: { files, rowGroups, prune } }>
  ```
  Each row is a plain object of the output columns; with `geometry: 'geojson'` the geometry column holds decoded GeoJSON, `'wkb'` the raw bytes, `'none'` omits it (and it is not read unless the filter needs it). `BigInt` values are coerced to numbers when safe.
  - The engine gains `ctx.rowFormat: 'objects'`: `run()` then delivers `{ rows: n, objects: object[] }` straight from the matched rows instead of calling `buildBatch`. Writers never set it.
- `filter.limit` is honoured; `truncated` says whether it bound. Cancellation rejects with `CANCELLED`.

- [ ] **Step 1: Write the failing tests** (fake parquet host):

```js
test('rows come back as objects with decoded geometry, in file order')
test('onRows is called once per row group, in order, before the promise resolves')
test('area + time + where are applied; columns.include projects')
test("geometry: 'none' returns no geometry and, with a bbox covering, does not read it")
test('limit truncates and reports it')
test('an INT64 column comes back as a number')
test('aborting rejects with CANCELLED and stops reading')
test('download() through the same engine is unchanged')           // a byte-for-byte GeoJSON download before and after
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `feat(extract-core): queryRows -- filtered rows as objects, not a file`

---

### Task 4: Imagery profile

**Files:**
- Create: `packages/stac/src/imagery-profile.js`, `packages/stac/test/imagery-profile.test.js`
- Modify: `packages/stac/src/index.js`, `packages/stac/README.md`

**Interfaces:**
- Consumes: `layersFromCollection` (Phase 1).
- Produces: `imageryProfile(collection, { baseUrl, overrides? }): ImageryProfile` — synchronous, no fetch. Throws `LAYER_UNSUPPORTED` when the collection has no `scenes` layer.
  ```
  ImageryProfile = {
    id, title, collectionUrl, attribution, bbox?, temporal?,
    dataset: DatasetDescriptor,                      // { kind:'parquet', url } or the portolan-collection to resolve
    table: { idColumn: 'id', geometryColumn: 'geometry', timeColumn?, timeInterval? },
    displayAsset?: string,                           // item asset key to draw
    thumbnail?: { column?: string, asset?: string }, // a URL column (S2's thumbnail_url) or an asset key
    assets: 'struct' | 'json' | 'unknown',           // how the `assets` column is encoded
    filters: { column, label, kind: 'max'|'min'|'range'|'enum', type }[],
    searchColumns: string[],                         // what a search reads
    assetHref?: (scene) => string | undefined        // optional convention shortcut
  }
  ```
- `filters` come from `table:columns`, in this order of preference: `eo:cloud_cover` (`max`), `gsd` (`max`), then string columns whose name ends `:state`, `:platform_type`, `platform`, `constellation` (`enum`), then `*:year` (`range`). At most six.
- `searchColumns`: id, the time columns, `bbox`, geometry, each filter column, the thumbnail column, and `assets` **only when it is a struct**.

- [ ] **Step 1: Write the failing tests**, one block per fixture:

| fixture | expected |
|---|---|
| `naip` | `dataset` `{kind:'parquet', url: …/naip.parquet}`; `timeColumn` `'datetime'`; `displayAsset` `'image'`; `assets` `'struct'`; filters include `gsd`, `naip:state` (enum), `naip:year` (range); `searchColumns` includes `'assets'` |
| `oam-cc-by-4-0` | `dataset.url` ends `/items.parquet`; `timeInterval` `{start:'start_datetime', end:'end_datetime'}`; `displayAsset` `'visual'`; thumbnail asset `'thumbnail'` |
| `sentinel-2-c1-l2a` | `dataset.source.kind` `'portolan-collection'`; `assets` `'json'`; `searchColumns` does **not** include `'assets'`; thumbnail column `'thumbnail_url'`; filters include `eo:cloud_cover` (max) |
| `unosat-damage-sites` | throws `LAYER_UNSUPPORTED` |
| overrides | `overrides.displayAsset`, `overrides.filters`, `overrides.assetHref` replace the derived values |

OpenAerialMap and NAIP publish no `table:columns` type for some of these; where the fixture does not say, the test asserts `'unknown'` and Task 5 settles it from the file's schema.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `feat(stac): imageryProfile -- how to search and show an imagery collection`

---

### Task 5: `ImagerySearch`

**Files:**
- Create: `packages/stac/src/imagery-search.js`, `packages/stac/test/imagery-search.test.js`, `packages/stac/test/helpers/fake-items.js`
- Modify: `packages/stac/src/index.js`, `packages/stac/README.md`, `packages/spec/src/errors.js` + README

**Interfaces:**
- Consumes: `queryRows`, `createPlanCache`, `resolveDataset`, `estimate` (extract-core); `ImageryProfile` (Task 4).
- Produces:
  ```
  class ImagerySearch {
    constructor(profile, options?: { cache?, fetch?, maxAgeMs? })
    warm(): Promise<void>                                   // resolve the dataset and list its parts; no footers
    search({ area?, time?, where?, sort?, limit = 200, onScenes? }): Promise<{ scenes: Scene[], truncated, plan }>
    resolveAssets(scene): Promise<Record<string, { href, type?, roles? }>>
    layerSpecFor(scene, { asset? }): Promise<LayerSpec>     // kind 'cog', group = profile.id
    close(): void
  }
  Scene = { id, datetime: string|null, start: string|null, end: string|null, bbox: [w,s,e,n]|null,
            geometry: GeoJSON|null, properties: object, thumbnail: string|null, assets?: object }
  ```
- `search` runs one generation at a time: starting a new one aborts the previous, which resolves `{ scenes: [], truncated: false, plan: null, superseded: true }` and whose `onScenes` is never called again (Review Focus 1).
- `sort`: `{ by: 'datetime'|<filter column>, order: 'asc'|'desc' }`, default newest first; nulls last.
- `resolveAssets`, first that applies: the row's own `assets` (struct, or JSON string when it was read); `profile.assetHref(scene)` (wrapped as the display asset); the item's own STAC JSON, from the row's `links` (`rel: self`, `http(s)`), one request; else `SCENE_ASSETS_UNAVAILABLE` naming the scene (Review Focus 3). `links` is added to `searchColumns` only when `assets` is not a struct.
- `layerSpecFor` returns `{ spec, id: '<profile.id>:<scene.id>', title, kind: 'cog', source: { url }, bbox, temporal, attribution, group: profile.id, thumbnail }`; the asset is `options.asset ?? profile.displayAsset`, and its `href` must be `http(s)` and a COG type or `.tif`.
- A STAC-GeoParquet `bbox` that is a list `[w,s,e,n]` and one that is a struct both become `[w,s,e,n]`.

- [ ] **Step 1: Write `fake-items.js`** — builds a small in-memory STAC-GeoParquet item table with `hyparquet-writer` (already a devDependency of extract-core) in the three shapes: NAIP-like (struct assets, `datetime`), OAM-like (struct assets, start/end, null `datetime`), S2-like (JSON-string assets, list bbox, `links`, `thumbnail_url`), and serves it through a `fetch` stub that honours `Range`.

- [ ] **Step 2: Write the failing tests**

```js
test('search returns scenes with id, time, bbox, geometry, properties and thumbnail')   // each of the three shapes
test('area, time and where narrow the result; sort and limit apply')
test('interval items are found by a window overlapping their span')                     // OAM-like
test('an area crossing the antimeridian searches both boxes; no area searches everything')  // Review Focus 4
test('a superseded search resolves [] and delivers nothing further')                    // Review Focus 1
test('onScenes streams batches before the promise resolves')
test('a second search re-uses the plan cache: no listing, no footer requests')
test('resolveAssets: struct assets come from the row')
test('resolveAssets: with JSON assets unread, the item link is fetched once')
test('resolveAssets: profile.assetHref wins over the item link')
test('resolveAssets: nothing to go on -> SCENE_ASSETS_UNAVAILABLE naming the scene')    // Review Focus 3
test('layerSpecFor gives a valid cog LayerSpec in the collection\'s group')
test('layerSpecFor refuses an asset that is not an http(s) COG')
```

- [ ] **Step 3: Run** — Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 6: Commit** — `feat(stac): ImagerySearch -- scenes from STAC-GeoParquet, by area, time and attributes`

---

### Task 6: Projections and the decode worker, without third-party round trips

**Files:**
- Create: `packages/maplibre/src/projections.js`, `packages/maplibre/test/projections.test.js`
- Modify: `packages/maplibre/vendor/deck-entry.js` (export `registerProjection`, `PROJECTION_REGISTRY`), the three generated bundle files, `packages/maplibre/src/deck-loader.js` (`DECK_REQUIRED_EXPORTS`, `APPROX_BYTES`), `packages/maplibre/src/renderers/cog.js`, `packages/maplibre/test/helpers/fake-map.js`

**Interfaces:**
- Produces:
  - `utmDefinition(epsg): string | null` — a proj4 string for the projected UTM families imagery uses, by EPSG range: WGS84 326xx/327xx, NAD83 269xx (zones 1–23), NAD83(2011) 6328–6348, ETRS89 258xx (28–38), SIRGAS 2000 31965–31985, GDA94 283xx (48–58), GDA2020 78xx (46–59). `null` for anything else.
  - `registerKnownProjections(deck): number` — registers every code above on the bundle's registry once; returns how many.
  - The `cog` renderer calls it before its first layer, so a NAIP (EPSG:26910) or OpenAerialMap (EPSG:31981) scene opens with **no request to epsg.io** (E12 found the default makes one).
  - The `cog` renderer passes a `pool`: the bundle's default worker pool when a module worker can be started from a Blob URL, else `new DecoderPool({})` (decode on the main thread), decided once per page by a probe. A page whose CSP forbids `blob:` workers then still draws.

- [ ] **Step 1: Write the failing tests**

```js
test('utmDefinition: one known code per family gives the right zone, hemisphere and datum')   // 32618, 32721, 26910, 6339, 25832, 31981, 28355, 7855
test('utmDefinition: codes just outside each range, and non-UTM codes, give null')
test('registerKnownProjections registers each code once, and is idempotent')
test('the cog renderer registers projections before building its first layer')
test('the cog renderer passes a pool, and falls back to a workerless pool when the probe fails')
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**, then `npm run build:deck`, update `APPROX_BYTES`, `npm run check:deck`.
- [ ] **Step 4: Run** `npm test`, then `node experiments/e12-deck-bundle/verify.mjs 8123` — Expected: `# fail 0`; Gate A still passes. Add to that verifier: the `naip` case makes **no** request to `epsg.io`.
- [ ] **Step 5: Commit** — `feat(maplibre): local UTM projections and a decode-pool fallback for COGs`

---

### Task 7: `ImagerySearchControl` and footprints

**Files:**
- Create: `packages/maplibre/src/imagery-search-control.js`, `imagery-search-model.js`, `packages/maplibre/test/imagery-search-model.test.js`
- Modify: `packages/maplibre/src/index.js`, `packages/maplibre/README.md`

**Interfaces:**
- Consumes: an `ImagerySearch`-shaped object (injected — this package does not import `@cngeo/stac`), `LayerManager`.
- Produces:
  - `createImagerySearchModel({ search, profile, manager })` — pure state, no DOM: `{ state, setArea(area|null), setTime({start,end}), setFilter(column, value), setSort(sort), run(): Promise<void>, hover(id|null), add(id): Promise<void>, on('change', fn), destroy() }`. `state` is `{ status: 'idle'|'searching'|'done'|'error', scenes, truncated, plan, error?, hovered, added: Set<id>, area, time, filters, sort }`. `run()` debounces nothing itself; a new `run()` supersedes the last.
  - `footprintsGeoJson(scenes, hoveredId): FeatureCollection` — one polygon feature per scene (its geometry, else its bbox), `properties: { id, hovered }`.
  - `class ImagerySearchControl implements IControl { constructor({ search, profile, manager, area?: () => Area|null, position? }) }` — a panel: collection title, "Search this view" / "Search the selected area", date range, generated filter inputs, sort, result cards (thumbnail, id, date, the filter values), "Add to map" per card, a status line with the plan narration, and attribution.
- Footprints are one MapLibre `geojson` source and two layers (`cng-layer-imagery-footprints--fill`/`--line`) owned by the control, drawn above the stack and below the labels; hovering a card highlights its footprint and the reverse.
- Thumbnails load lazily (`loading="lazy"`), only from `http(s)` URLs.

- [ ] **Step 1: Write the failing model tests** with a stub search:

```js
test('run() searches with the current area, time, filters and sort')
test('a filter set to its empty value is not sent')
test('a second run supersedes the first; only the second\'s scenes land')
test('add() resolves the scene\'s LayerSpec and adds it to the manager once')
test('a failed add records the error on the model and leaves `added` unchanged')
test('footprintsGeoJson uses the geometry, falls back to the bbox, and skips a scene with neither')
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the model, then the control (DOM; verified in Task 8).
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `feat(maplibre): ImagerySearchControl and scene footprints`

---

### Task 8: The demo and its verifier

**Files:**
- Create: `examples/imagery-search/index.html`, `examples/imagery-search/verify.mjs`
- Modify: `examples/index.html`, `experiments/e14-search-cost/RESULTS.md` (the measured effect of the cache)

The page: MapLibre 5.24.1; a `LayerManager` + `LayerControl`; an `ImagerySearchControl`; a collection picker with three presets (Sentinel-2 C1 L2A, NAIP, OpenAerialMap CC-BY-4.0) chosen by `?collection=`. `#status` reads `ready: <collection>` when the profile is built and warmed. `window.DEMO = { map, manager, search, model, profile }`.

- [ ] **Step 1: Write `verify.mjs`** (takes a port; live data; fails on any console error). For **each** of the three collections, over a fixed small area and window:
  1. the page becomes ready;
  2. a search returns at least one scene, each with an id and a time, and footprints equal in number to the scenes are on the map (`map.getSource(...)._data`);
  3. every scene's footprint intersects the searched area;
  4. a second, different search made while the first is in flight leaves only the second's scenes;
  5. the repeat of a search makes **no** listing or footer request (counted from the page's network log), and its time is recorded;
  6. "Add to map" on the first scene adds a `cog` layer that reaches `ready` and changes pixels inside the scene's bounds;
  7. the scene's credit is displayed;
  8. no request went to `epsg.io`.
- [ ] **Step 2: Run it** — Expected: FAIL, the page does not exist.
- [ ] **Step 3: Write the page.** Fix what the verifier finds, each fix with a unit test where one is possible.
- [ ] **Step 4: Run** the verifier and `npm test`; add the measured first-search and repeat-search times per collection to E14's `RESULTS.md`.
- [ ] **Step 5: Commit** — `feat(examples): imagery-search for Sentinel-2, NAIP and OpenAerialMap`

## Not in this phase

Band composites and stretches (`MultiCOGLayer`, `renders`, `portolan:render_order`, 16-bit), "Add all" mosaics, and a `scenes`-kind layer that draws a whole collection. A scene is added as its single display asset, which is 8-bit true colour for all three target collections.

**This is a second deferral of stretch handling, and it is a call made here, not one Chris made.** The design put it in Phase 1; Phase 1's review moved it to "Phase 2's scene renderer". But adding a scene as an ordinary `cog` layer means Phase 2 needs no scene renderer, and search is useful without stretches. So stretches and composites are proposed as their own later piece of work ("imagery rendering"), after the four widgets exist. What it costs until then: single-band and 16-bit rasters (Sentinel-2's individual bands, WorldPop's grids) are reported as errors instead of drawn; only true-colour display assets show.
