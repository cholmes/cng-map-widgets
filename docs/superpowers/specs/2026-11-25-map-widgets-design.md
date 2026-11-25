# Four new map widgets: layer manager, imagery search, catalog search, timeline

**Date:** 2026-11-25
**Status:** design approved by Chris on 2026-11-25. A builder check was run against the code in all four
source repos first; its corrections are folded in and the calls it forced are listed under "Calls I made".
**Scope:** two new packages (`@cngeo/stac`, `@cngeo/timeline`); additions to `@cngeo/maplibre`,
`@cngeo/extract-core` and `@cngeo/spec`; five new examples; two experiments (`e12`, `e13`).
**Plans:** one task-level plan per phase, written before that phase starts, in
[`docs/superpowers/plans/`](../plans/).

---

## Context

`cng-map-widgets` (`@cngeo/*`, v0.3.1 on `origin/main`) finds an area and downloads data for it. It
cannot yet *show* data: no layer list, no imagery display, no way to discover layers, no time control.
Two of Chris's standalone apps already prove the hard parts — `~/repos/firms-catalog/apps/firms-explorer`
(a histogram timeline over yearly PMTiles chunks) and `~/repos/sentinel-2-catalog/apps/explorer`
(scene search over STAC-GeoParquet, COGs drawn with deck.gl-raster). This work extracts both into
reusable widgets, generalises them, and adds the two widgets that tie everything together.

Outcome: four composable widgets that work on any conforming published data, not one dataset each.

## Decisions made by Chris (this session)

- **All work happens in a git worktree**, never on `main`. (Local `main` is at v0.3.0 and behind
  `origin/main`; fetch and branch from `origin/main`.)
- **Exactly two new packages**; everything else grows existing ones.
- **Use the open ecosystem**: deck.gl-raster for rasters, MapLibre throughout, deck.gl. Do not reinvent.
- **A prebuilt deck.gl bundle is acceptable** (one build script in this repo; consumers still need no build).
- **Timeline gets play/pause.**
- **Non-yearly chunks are proven by unit tests** with synthetic fixtures; the live demo uses yearly FIRMS.
- **Render-column experiment** on `collections.parquet`: local prototype; upstream PRs drafted, not opened.
- MapLibre only. No OpenLayers versions.

## Calls I made (check these while reading)

1. **The prebuilt bundle is the default, not the fallback.** A builder check showed the import-map
   route cannot be contained inside a package: it needs entries in the *consumer's* page import map, and
   design doc §4.4 rule 2 forbids importing bare third-party specifiers. `sentinel-2-catalog`'s
   `vite.config.js` records the same verdict from experience. One bundle also gives the timeline and the
   rasters a single shared deck.gl.
2. **The bundle is committed to git** (`packages/maplibre/vendor/`), because AGENTS.md distributes
   packages as raw files from GitHub Pages and jsDelivr `gh@tag`; a CI-only artifact would be missing
   there. CI checks it is up to date. Cost: roughly 2–3 MB added per deck.gl upgrade.
3. **Time filters on interval data mean "overlaps the window"**, per row as
   `start_datetime ?? datetime` … `end_datetime ?? datetime` (STAC API semantics). Rows with a null
   `datetime` are silently dropped today; this fixes that for downloads too.
4. **`@cngeo/stac` is broad**, which overrides the design doc's "≤ 6 KB, pure JSON" charter (§4.5, §5.4).
   `descriptorFromCollection` stays in `extract-core`; `stac` imports it.
5. **Sentinel-2 stays in the imagery demo** on the generic area search (measured below), not the
   MGRS-tile shortcut the original app uses.
6. **Deferred**: "Add all" mosaics, layer-stack save/restore, GeoParquet rendering of untiled layers.

## Package layout

| Package | Change | Holds |
|---|---|---|
| `@cngeo/stac` | **new**, headless | `layersFromCollection`; imagery profile + scene search; `collections.parquet` index search; `chunksFromStac` |
| `@cngeo/timeline` | **new**, no map library (uses a canvas) | chunk descriptors, chunk-set orchestration, axis math, playback clock, the canvas timeline, the `ChunkFormat` interface |
| `@cngeo/maplibre` | grows | `LayerManager`, four controls, renderers, the deck.gl loader and bundle |
| `@cngeo/extract-core` | additions | `queryRows`, single-file item mirrors, interval time columns, footer cache |
| `@cngeo/spec` | addition | the `LayerSpec` contract (`cng-layer/1.0`) |

Dependencies are one-way: `maplibre → {timeline, stac, extract-core, spec}`, `stac → {extract-core, spec}`,
`timeline → spec`. The kind→renderer registry lives only in `@cngeo/maplibre`.

## Stack (versions verified against npm on 2026-11-25; pin exactly)

| Concern | Use | Note |
|---|---|---|
| Raster layers | `@developmentseed/deck.gl-geotiff` **0.10.0** (`COGLayer`, `MultiCOGLayer`, `MosaicLayer`) | pre-1.0; renamed props draw nothing silently → prop-shape assertion + pixel smoke test |
| Raster internals | `@developmentseed/deck.gl-raster` 0.10.0 (`RasterLayer`, `/gpu-modules`), plus its `geotiff`, `proj`, `affine`, `proj4` | where 0.8.1 → 0.10 breakage is likeliest |
| deck.gl | `@deck.gl/{core,layers,geo-layers,mesh-layers,extensions}` **9.4.2**, `@luma.gl/*` 9.4.2 | exactly one copy, asserted at load |
| deck ↔ MapLibre | `@deck.gl/maplibre` 9.4.2 `MapLibreOverlay`, interleaved, `beforeId` | known-good alternative: `@deck.gl/mapbox` `MapboxOverlay`, which all three existing apps use |
| MapLibre | **5.24.x** in examples (peer range already `^4 \|\| ^5`) | test against 6, do not require it |
| PMTiles | `pmtiles` 4.5.0 | zero deps |
| Parquet | `hyparquet` (already pinned in `extract-core/src/cdn.js`) | not DuckDB-WASM |
| Text search | `minisearch` 7.2.0, lazy-loaded | registry text + facets |
| Layer list UI | evaluate `maplibre-gl-layer-control` 0.18.3 first | fallback: small own control |
| Timeline UI | port Chris's own `timeline.js` | `maplibre-gl-time-slider` is a different widget |
| Dates | `Date` + `Intl.DateTimeFormat` only | `Temporal` has no Safari support |

Skip: `@geoarrow/deck.gl-layers` (pulls a second deck.gl 9.3), `maplibre-gl-raster` (pins deck.gl-raster 0.7.0),
`maplibre-gl-components`, DuckDB-WASM, `@geomatico/maplibre-cog-protocol` (EPSG:3857 only; S2/NAIP/OAM are UTM).

## Phase 0 — setup and gates

1. Fetch, create the worktree from `origin/main` (`superpowers:using-git-worktrees`), branch `map-widgets`.
2. Commit this design as `docs/superpowers/specs/2026-11-25-map-widgets-design.md`. Before each phase, write
   its task-level plan with `superpowers:writing-plans` into `docs/superpowers/plans/` (format:
   `docs/superpowers/plans/2026-11-20-bigger-downloads.md`).
3. Create both package skeletons and add their test globs to the root `package.json` `test` script now —
   it is an explicit path list, so later phases would otherwise pass `npm test` vacuously.
4. **Gate A — the deck bundle** (`experiments/e12-deck-bundle/`).
   `tools/build-deck-bundle.mjs` (esbuild devDependency) emits one ESM file with deck core, layers,
   `MVTLayer` + `MVTLoader`, `DataFilterExtension`, the MapLibre overlay, deck.gl-geotiff and deck.gl-raster
   with gpu-modules, and the geotiff decode worker (inlined or emitted beside it — `sentinel-2-catalog`'s
   `vite.config.js` documents how that worker breaks when flattened). A no-build page plus `verify.mjs`
   (Playwright, shape of `examples/s2-footprints/verify.mjs`, takes a `serve.py` port) asserts:
   - an 8-bit UTM COG draws non-blank pixels inside its bounds: S2 `TCI.tif`, one NAIP quad, one OAM scene;
   - an `MVTLayer` over a FIRMS PMTiles chunk draws from the same bundle and overlay;
   - `beforeId` slots a raster under a named style layer, and changing it re-slots without a blank frame;
   - no console errors; record raw and gzip size.
   Headless Chrome lacks `EXT_texture_norm16`, so uint16 band composites are checked on a real GPU, not in CI.
   Deliver `packages/maplibre/src/deck-loader.js` mirroring `packages/raster-core/src/cdn.js`
   (`loadDeck`, `setDeckModules`, `clearDeckModules`, `APPROX_BYTES`), loading the bundle via
   `import.meta.url` only when a deck layer is first added. Hosts with a bundler inject their own copy.
   Note in `RESULTS.md` whether the esm.sh import-map recipe works, as a documented option for hosts only.
5. **Gate B — layer-control evaluation**, same experiment. Checklist for `maplibre-gl-layer-control`:
   runtime add/remove, deck-layer adapter, groups, reorder hook, `--cng-*` theming, MapLibre 5, keyboard
   access. Adopt if all pass; otherwise build the small control in Phase 1.
6. **Gate C — search cost, partly measured already.** A Nairobi-sized area, one month of Sentinel-2
   through today's `extract-core`: pruning works (825 row groups → 21 by native geometry statistics,
   35 requests, 5.2 MB) but planning takes about 6 s and is **repaid on every call** because footers are
   not cached; reading takes 3.4 s. So the footer cache and streaming results in Phase 2 are essential,
   not polish. Still to check here: whether the S2 parts carry Parquet offset indexes (decides whether one
   row's `assets` can be read alone), and the same timings for NAIP and OAM.

## Phase 1 — Layer manager

- **`LayerSpec`** in `@cngeo/spec`:
  `{ spec:'cng-layer/1.0', id, title, kind, source, style?, bbox?, temporal?, attribution[], group? }`,
  `kind` ∈ `pmtiles-vector | cog | scenes | geojson | timeline | table | unsupported`
  (`timeline`'s renderer arrives in Phase 4).
- **`layersFromCollection(collection, { baseUrl })`** in `@cngeo/stac` → `LayerSpec[]`, synchronous, no
  fetch — built here so the layer manager has real input. Rules, in order: `rel:"pmtiles"` link or PMTiles
  asset (+ style) → `pmtiles-vector`; collection-level COG → `cog`; `collection-mirror` asset, STAC item
  columns, or COG `item_assets` → `scenes`; parquet with no geometry column → `table`; else `unsupported`.
  Port raster stretch handling from `portolan-browser/src/utils/renders.js` and `renderOrder.js`
  (`renders`, `portolan:render_order`; its `assetKey()` needs only the plain-object branch).
- **`LayerManager`** (`packages/maplibre/src/layer-manager.js`): one bottom-first array is the truth.
  `add / remove / setVisible / setOpacity / move / list`, events `change`, `error`. Two executors: style
  layers (`moveLayer`, `setLayoutProperty`, opacity by layer type) and deck layers (overlay props +
  `beforeId`, precedent in `packages/maplibre/src/area-layer.js`). If Gate A shows interleaved reordering is
  unsound, rasters stay on top and the control says so.
- **Renderers** by `kind`: `pmtiles-vector` (the `style`-role asset, default role wins; fallback style by
  geometry type from the archive's `vector_layers`), `cog`, `geojson`.
- **`LayerControl`** (`IControl`): **decided 2026-11-25 after Gate B — wrap
  `maplibre-gl-layer-control` 0.18.3, do not build our own.** It already provides toggle, opacity,
  drag-reorder, remove, zoom-to and a deck.gl adapter (5 of 7 requirements in
  `experiments/e12-deck-bundle/RESULTS.md`). Ours to add:
  - a `CustomLayerAdapter` over `LayerManager`, with `onLayerReorder` translated into
    `LayerManager.move` (deck layers are not in the style, so the control only notifies);
  - an override stylesheet mapping its classes onto the `--cng-*` tokens, with dark mode;
  - a keyboard shim: focusable, operable context-menu items, a name for the checkbox, and a keyboard
    path for reordering;
  - an **Add** button opening registered add-providers (paste-a-URL now; catalog search in Phase 3),
    and attribution, reusing `injectCssOnce` and the compact attribution from
    `packages/maplibre/src/geocoder-control.js`.
  Load it through a loader seam with an exact pinned URL, like every other third-party module. Draft the
  theming and keyboard fixes as upstream contributions; **do not open them without Chris's go-ahead.**
  Verify that an order set by the host is reflected back in its list (untested in Gate B). Legend model:
  `portolan-browser/src/components/maps/LayerControl.vue`.
- Example `examples/layers-demo/` with `verify.mjs`.

**Phase 1 as built, 2026-11-25 — two things moved to later, both on purpose:**
- *Raster stretch handling* (`renders`, `portolan:render_order`, named above under
  `layersFromCollection`) was **not** ported. A `cog` layer draws with deck.gl-raster's default pipeline,
  which covers display-ready 8-bit imagery; a COG that needs a stretch (single-band Float32, 16-bit
  reflectance) is reported as an error, not drawn wrong. `LayerSpec.style` is reserved for it.
  *(Revised when Phase 2 was planned: Phase 2 adds a scene as an ordinary `cog` layer, so it has no scene
  renderer to carry this. Stretches and band composites are proposed as their own later piece of work,
  "imagery rendering". This is the implementer's call, flagged for Chris.)*
- *The upstream contributions* to `maplibre-gl-layer-control` (theming, keyboard access) have **not been
  drafted**. The wrapper does both jobs from outside. Drafting them is outstanding and opening them
  still needs Chris's go-ahead.
- Three members of that control are reached privately, all feature-detected: its list order
  (`state.layerStates` + `buildLayerItems`), its move (`moveLayerUp/Down`), and its `targetLayers`
  memory, which must be pruned when a layer is removed from code or the panel lists raw style layers.

## Phase 2 — imagery search

**`@cngeo/extract-core`** (it resolves, prunes and reads already; it only writes files today)
- `queryRows(dataset, area, filter, options)`: row objects with decoded geometry, delivered as row groups
  arrive. Implement as an opt-in `rowFormat: 'objects'` on the engine context so `run()` hands over matched
  rows directly instead of transposing in `buildBatch` (`src/engine-hyparquet.js`); writers are untouched.
- **Plan cache** per session, plus a `warm(dataset)` call for a control to use on open. It must hold
  **both** the resolved part list and the footers: E14 measured a Sentinel-2 plan as 13 part-listing
  requests (1.5–4.7 s) plus the 7.92 MB footer (about 3 s), all repaid on every call today. A footer
  cache alone leaves the listing repaid. *(Amended 2026-11-25 after E14 and its review.)*
- `estimate().requests` models one request per row group; the engine sends one per column chunk and
  planning adds more (Sentinel-2: 35 modelled, 100 measured). Fix or relabel it before a UI shows it.
- Single-file item tables: a non-partitioned `collection-mirror` asset (OpenAerialMap) falls through to
  `DATASET_UNSUPPORTED` today. Resolve it, and a `data` parquet carrying STAC columns (NAIP), to
  `{ kind:'parquet', url }` with STAC table defaults — **not** `stac-geoparquet`, whose enumeration path
  (`src/partitions.js`) would read the item table as a list of partition files.
- Interval time columns (call 3): touches `deriveTimeColumn`, `columns.js`, `pruneRowGroupsByTime`
  (min of start, max of end), the row predicate in the engine, and two messages in `estimate.js`.

**`@cngeo/stac`**
- `imageryProfile(collection, overrides?)` absorbs the measured differences:

  | | NAIP | OpenAerialMap | Sentinel-2 |
  |---|---|---|---|
  | items file | `data`-role parquet asset | `collection-mirror` asset | hive partitions, no asset |
  | `assets` column | struct | struct | JSON string, ~18 KB a row |
  | time | `datetime` | start/end only | `datetime` |
  | picture asset | `image`, role `visual` | `visual`, role `data` | `visual`, role `visual` |
  | thumbnail | none per item | per item | per item |

  Display-asset detection: role `visual` → key `visual`/`image` → first COG `data` asset. Filters offered
  come from `table:columns` / `summaries` (`eo:cloud_cover`, `gsd`, `naip:state`, …).
- Asset resolution, first that applies: struct `assets` read with the search (small); a profile
  `assetHref(scene)` shortcut (S2's thumbnail-directory convention — the only path the original app
  proves); a single-row read when the file has offset indexes (Gate C); else a clear refusal.
  *(E14, 2026-11-25: the single-row branch buys nothing for these three collections — only NAIP has
  offset indexes and NAIP does not need it — and would need reader work. Keeping it is Chris's call.
  Two unmeasured Sentinel-2 alternatives to the shortcut: fetch the scene's 6.5 MB `assets` chunk only
  on "Add to map", or fetch the scene's own STAC item JSON.)*
- `ImagerySearch.search({ area, time, where, sort, limit })` → scenes streamed plus the `estimate()` prune
  narration. A superseded search resolves `[]`, as `Geocoder.search` does. Port the pure parts of
  `sentinel-2-catalog/apps/explorer/results.js`: filter/sort, "null means unknown", and `whyFiltered`.

**`@cngeo/maplibre`**
- `ImagerySearchControl`: area from the current `Area`, draw tool or viewport; date range; generated
  property filters; sort; result cards with lazy thumbnails; card ↔ footprint hover; **Add to map**.
  Warms footers on open; shows progress and `est.requests`.
- Footprints as a MapLibre `geojson` source, so they order like any style layer.
- `scenes` renderer: start from 0.10's `COGLayer` / `MultiCOGLayer` default pipelines. From
  `sentinel-2-catalog/apps/explorer/cog.js` take the ideas, re-derived against 0.10 rather than copied (it
  is a custom layer on `RasterLayer` + gpu-modules written for 0.8.1): the local UTM `epsgResolver`, the
  staleness protocol, texture clean-up, memoised `source` identity, percentile stretch from the overview,
  thumbnail-first preview. Port `portolan-browser/src/utils/cogProjection.js` (proj4 EPSG:3857 `over`) with
  a delete-when-fixed note; `cogSource.js` is superseded by 0.10's range coalescing.
- Three runtime requirements E12 found *(added 2026-11-25)*: pass a local `epsgResolver` covering the CRS
  families imagery uses, NAD83 UTM included (the bundle's default asks `epsg.io`; NAIP is EPSG:26910);
  pass `loadOptions: { worker: false }` on every `MVTLayer` (the default fetches a worker from unpkg);
  and handle a decode worker that cannot start (CSP without `worker-src blob:`, old Safari/Firefox) by
  falling back to `new DecoderPool({})`, since otherwise no COG draws at all.
- Example `examples/imagery-search/` with a collection picker preset to Sentinel-2, NAIP and OpenAerialMap,
  and one `verify.mjs` run per collection.

**Phase 2 as built, 2026-11-25 — where it differs from the above:**
- *No scene renderer, no stretches.* A found scene is added as an ordinary `cog` layer of its display
  asset, so none of the `cog.js` ideas listed above (staleness protocol, percentile stretch,
  thumbnail-first preview, the `cogProjection.js` port) were needed or built. Band composites and 16-bit
  rasters remain errors. Still proposed as later "imagery rendering" work; still the implementer's call.
- *A Sentinel-2 scene's files come from its own STAC item* (one request to Earth Search, from the row's
  `links`), not from the thumbnail-directory convention. `profile.assetHref` remains for a collection
  that wants a convention. The single-row read with offset indexes was not built: E14 showed none of the
  three collections needs it.
- *The cache holds part listings as well as footers*, has a time limit per load, and checks a file's size
  and `Last-Modified` on every read made against a kept footer.
- *The reader retries a failed row-group read* (once for a download, twice for a search, after a short
  wait). This was not planned; live runs lost whole searches to one dropped request or one HTTP 520.
- *Downloads changed in four places*, against the plan's own constraint, each recorded in the pull
  request: that retry; `dropGeometry` with no area returning rows instead of none; a bare file's
  `datetime` filter being applied instead of skipped; a mirror-only collection resolving to its item file.
- *"Null means unknown" is in* (a numeric filter keeps a scene with no value). *`whyFiltered` is not*: it
  explained client-side filtering of scenes already loaded, and here filters are pushed into the read, so
  a filtered scene never arrives to be explained. For Chris to accept or reject.
- *The panel defaults a partitioned archive to its last 30 days*; a single-file collection has no default.
- *Local projections are `proj4.defs()`*, not an `epsgResolver` prop: the bundle's registry answers from
  proj4. `loadOptions: { worker: false }` on `MVTLayer` waits for Phase 4, where the first one is built.
- *`LayerManager.setTopLayers()`* was added so the footprints stay above an added image: deck.gl puts its
  layer group directly under whatever it is slotted beneath.
- *The control has no unit tests* — the suite has no DOM. Its decisions live in a tested model; its DOM is
  checked in a real browser by the example's verifier (20 checks per collection).

## Phase 3 — catalog search and the render-column experiment

- `CatalogIndex` in `@cngeo/stac`: takes a catalog URL (follows the `rel:"data"` parquet link) or a
  `collections.parquet` URL. Loads light columns only — never `original` (56.7 MB of text in the live
  registry's 19.2 MB file). `search({ text, area, time, license, kinds, within })` with facet counts;
  ranking favours collections whose extent fits the viewport over global ones. `resolve(result)` →
  `LayerSpec[]` from the `render` column when present, else one fetch of the collection JSON at `href`.
- **`experiments/e13-render-column/`**: a Node script runs `layersFromCollection` over every `original` in
  the live registry and writes an enriched parquet with `render`
  (`list<struct<kind, href, type, layers, style, default, title, bytes>>`) and `thumbnail`. Measure bytes
  added, coverage by kind, agreement with a live fetch on a sample, and click-to-layer time with and
  without. Baseline measured: ~4,550 PMTiles + GeoParquet, ~2,050 non-spatial tables, ~330 imagery,
  61 COG, ~39 untiled spatial GeoParquet (17 over 500 MB). Deliver `RESULTS.md`, a draft paragraph for
  `portolan-spec/specs/incubating/stac-geoparquet.md`, and a draft patch for
  `portolan-registry/scripts/registry/catalog_index.py`. **Do not open either upstream.**
- `CatalogSearchControl` in `@cngeo/maplibre`: search box, "this map area" toggle, facet chips, result
  cards (thumbnail, kind badge, extent on hover), **Add to map**. Registers as a `LayerControl`
  add-provider. `indexUrl` defaults to `https://registry.portolan-sdi.org/v0.1/collections.parquet`.
- Example `examples/catalog-search/`.

**Phase 3 as built, 2026-11-25 — where it differs from the above:**
- *The registry index could not be opened at all* until the reader stopped trusting `HEAD`: GitHub Pages
  answers it with the gzip-encoded length and hides `Content-Range`. `remoteByteLength()` in
  `@cngeo/extract-core` asks with a ranged request instead, for every parquet file opened. The index is
  20.4 MB (not 19.2), of which a search reads 2.2 MB.
- *17,585 rows, not ~7,000*: 10,536 are catalogs. 108 collection rows repeat another's `href` — the same
  collection under a second catalog — so an entry's identity is its `href` and it lists every catalog it
  is under. Collection ids are not unique either (23 are shared by drawable collections), so the panel
  tells two layers apart by their source, not their id.
- *Three columns, not two*: `attribution` beside `render` and `thumbnail`. A layer added from the index
  alone has no other way to be credited. The `render` struct is
  `kind, id, title, url, style, layers, display_asset, items, reason`, not the one sketched above.
- *E13's numbers*: the three columns are 454 KB as zstd parquet (about 0.5 MB from the registry's own
  writer) against the 2.1 MB a search loads; 4,842 of 7,049 collections draw as one layer and 2,047 are
  tables; rebuilt from the columns, 6,940 of 6,941 collections give identical layers. The spec draft
  does NOT slot into the incubating document as it stands — that document says Portolan defines no
  variant of the catalog index — and says so. Nothing was proposed or uploaded.
- *`fit` is the share of a collection's extent inside the view*, not an intersection-over-union: the
  latter scores a small local dataset near zero, like a global one.
- *Text search* folds accents and gives one letter only on words of six or more; `within` was not built
  (the `catalog` filter covers the registry's case).
- *Facets are menus, not chips* (100 catalogs, 21 licences). *The control takes an `index`*, so it has no
  URL default; the example supplies the registry's. *`catalogAddProvider(control)`* opens the panel
  already on the map rather than building a second one in the layer panel's popover.
- *`kinds` filtering and request-free adding exist only for an index with a `render` column.* Against the
  registry today, what a collection draws as is known only once it is opened.
- *A Phase 1 bug surfaced*: a published style whose tiles are `pmtiles://https://…/{z}/{x}/{y}` had its
  address mangled. Fixed in `style-plan.js`.

## Phase 4 — timeline

Source: `~/repos/firms-catalog/apps/firms-explorer/`. `timeline.js`, `mounted.js` and `deck-cells.js` are
already pure and already `node --test`; they move with their tests. `deck.html`'s mounting code is page
glue around globals (`S`, `_painted`, `_plans`, `_caches`) and is **rewritten, not ported** — budget for
roughly 800 lines (`readArchive`, `widenedExtent`, `splitFetch`, `renderTile`, `activateOwner`, `buildLayers`).

- **`@cngeo/timeline`**
  - `ChunkDescriptor { id, start, end, unit, format, url, priority }`, in day keys. Sources:
    `chunksFromTemplate({ template, period, start, end })` for any period, an explicit list, or
    `chunksFromStac` (in `@cngeo/stac`). Bucket units stay `day` and `month`; chunk *spans* are arbitrary,
    so weekly chunks carry day buckets.
  - Replace the yearly logic (`chooseArchive`, `planMounts` in years, `listYears`, ids used as type tags)
    with `forView(window, { cap })` and `forSelection(window)` over descriptors, and unify the three
    "domain" shapes the source uses. Keep the three rules it earned by fixing bugs: the axis is the union
    of the chunk set and may be wider than what is loaded (gaps hatched); what is *loaded* follows the view
    while what *draws* follows the selection; ownership is per bucket.
  - **The orchestrator lives here**: which chunk draws, which load, the outgoing-chunk handover, merging
    histograms by bucket ownership, debounce, and a reentrancy guard.
  - `ChunkFormat`: `open(descriptor)` → metadata; `mount(ctx)` →
    `{ setWindow, histogram(viewport), freeze, destroy }`, `histogram` returning `{ bucketKey: count }`.
    A minimal fake format in the tests proves a second format plugs in; **no GeoParquet format is built**.
  - Playback clock: play, pause, speed, loop, step; waits on chunk mounts at boundaries; honours
    `prefers-reduced-motion`.
- **`@cngeo/maplibre`**
  - `pmtilesChunkFormat` on deck.gl `MVTLayer` (draw and load roles, tile cache, byte LRU,
    `chromeWindowsNoCache`). Two time encodings: **bucket columns** (`count_YYYYMMDD` style; prefix
    configurable; reads `cng:timeline` then `firms:timeline` metadata) and **time property** (a per-feature
    attribute through `DataFilterExtension`).
  - `TimelineControl`: docked canvas, presets, play/pause, date inputs; one `LayerManager` entry.
    `view=` / `sel=` hash state is the last item and can be cut.
- Leave behind: the stats-sidecar path and cumulative columns (dead in production), feature-state
  (measured 13× worse, twice). FIRMS colours, metric names and breaks become config in
  `examples/timeline-firms/` (distinct from the existing download demo `examples/firms-explorer/`).
- Tests cover monthly, weekly and mixed-size chunk lists with synthetic fixtures.

**Phase 4 as built, 2026-11-25 — where it differs from the above:**
- *What draws is every loaded chunk that owns part of the selection*, each given only its own buckets —
  not "which chunk draws" in the singular. With monthly chunks a single drawing chunk would show a third
  of a ten-week selection. The cost: an aggregate cell present in two drawing chunks is drawn twice, each
  coloured by its own share.
- *`forView` also asks that no coarser unit would show a whole bucket (32 days) more of the window*,
  not only "within the cap". (First built as "at least as much": the review showed that an up-to-date
  monthly overview, which runs to the end of its last month, then beat the daily chunks by the five days
  left in November and the timeline could not reach days at the recent end. It worked live only because
  the published overview was two months stale.) Overlay chunks (a rolling week inside its year) do not
  count against the cap.
- *`@cngeo/maplibre` loads `@cngeo/timeline` through a seam* (`loadTimeline`), a dynamic import: a static
  one would have made every existing page map the new package or stop loading. A test holds the line.
- *The control goes through the layer manager*: a `timeline` renderer, a session at
  `manager.handle(id)`, and a new `ctx.redraw()` for a renderer whose deck.gl layers change by themselves.
- *A point's colour can be data* (`{ property, stops }`), because a `LayerSpec` source must be plain data.
- *`describePmtilesChunk()`*, not planned: a rolling week and an overview do not carry their span in
  their name, and the live all-time archive ends two months before today.
- *The histogram counts cells at the current tile zoom*, not across a pyramid band. Whether a view has
  loaded: deck.gl says when one finishes and never when one starts, so the first tile request of a burst
  is the "loading" signal (reading deck.gl's tile set after the map moves is kept as a second opinion).
- *Changed by the whole-branch review:* a layer fails only if it has never shown anything (one chunk
  failing mid-session is a note with a Retry); a hidden layer keeps loading and paints nothing (deck.gl
  loads nothing for an invisible layer); opacity and hiding are named in `updateTriggers` so deck.gl sees
  them; opened archives (eight) and tile bytes outlive a chunk's mount; the track forwards to the session
  only what it changed, so an exact selection survives a trip through the monthly track; a `dragging`
  view counts as at rest after two seconds of silence; ownership of a selection is a sweep, not a
  comparison of every chunk with every other; dates with no zone are UTC.
- *Also in the orchestrator, not in the plan:* `selectionCap` (cap × 4) and `openTimeoutMs` (60 s); and a
  tile that fails is a note on the layer, with a count.
- *Not built:* hash state (cut, as allowed); the stats sidecar (the digest of the source found it live,
  not dead: here the all-time histogram comes from tiles like any other); cumulative columns; a
  `container` option for the control; a GeoParquet format (by decision).
- *Found by running it against the live archives:* the bundled MVT parser needs its own defaults merged in
  when called directly (without them every tile split into nothing).
- *One pre-existing test suite reads live data inside `npm test`* (two tests against Source Cooperative)
  and failed three times in this phase on HTTP 520s. Not touched; worth an issue.

## Phase 5 — docs and release

- `AGENTS.md` recipes for all four widgets, each snippet executed by `docs/verify-snippets.mjs`.
- READMEs for the two new packages. Amend the design doc: §3.1 package table, §4.5 and §5.4
  (`@cngeo/stac`'s charter), §5.1 (an adapter now holds layer state; `@cngeo/timeline` touches a canvas),
  §5 and open item O13 (deck.gl adopted), §8.
- CI builds and checks the deck bundle. Do not add the live-data verifiers to CI
  (`.github/workflows/test.yml` forbids it).
- Version 0.4.0. **Chris's step:** the first publish of `@cngeo/stac` and `@cngeo/timeline` needs a
  short-lived granular npm token (`release.yml` notes npm cannot attach a trusted publisher to a package
  that does not exist yet); configure trusted publishing right after.

## Constraints carried through every phase

- Third-party code only through a loader seam with exact pinned versions and a `set…Modules()` injection
  point; no bare third-party specifiers in package source.
- Range reads use `cache: 'no-store'`; coerce `BigInt`; spatial maths on `area.bboxes`, never `area.bbox`.
- Error **codes** are the API (`CngError`); a superseded search resolves `[]`; attribution and
  share-alike are always displayed.
- Controls are keyboard-accessible, themed by `--cng-*` tokens, and removable without leaks.

## Verification

```bash
npm test                                        # unit tests, incl. the two new packages from Phase 0 on
node docs/verify-snippets.mjs                   # every documented snippet against live data
python3 serve.py 8000 &
node experiments/e12-deck-bundle/verify.mjs 8000
node examples/layers-demo/verify.mjs 8000
node examples/imagery-search/verify.mjs 8000    # Sentinel-2, NAIP, OpenAerialMap
node examples/catalog-search/verify.mjs 8000
node examples/timeline-firms/verify.mjs 8000
```

Each `verify.mjs` waits on a visible status string, asserts on real state (`LayerManager.list()`,
`map.getSource(...)._data`, a sampled canvas pixel for rasters), and fails on any console error. A phase is
done when its verify script and `npm test` pass; each phase lands as its own PR.
