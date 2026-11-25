# Map Widgets Phase 3 Implementation Plan: catalog search and the render-column experiment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search a `collections.parquet` catalog index by text, area, time and attributes, and add a found collection to the map; and measure what a `render` column in that index would buy.

**Architecture:** `CatalogIndex` in `@cngeo/stac` loads the index's light columns once through `queryRows`, searches them in memory, and resolves a result to `LayerSpec[]`: from a `render` column when the index has one, else by fetching the collection's JSON. `CatalogSearchControl` in `@cngeo/maplibre` is a view of a DOM-free model, and registers as a `LayerControl` add-provider. Experiment E13 builds an index with `render` and `thumbnail` columns from the live registry and measures it.

**Tech Stack:** hyparquet 1.33.0 (through `@cngeo/extract-core`), minisearch 7.2.0 (lazy, pinned URL, injection seam), MapLibre GL 5.24.1.

**Spec:** `docs/superpowers/specs/2026-11-25-map-widgets-design.md`, "Phase 3 — catalog search and the render-column experiment".

## What the live index is (measured 2026-11-25)

`https://registry.portolan-sdi.org/v0.1/collections.parquet`: 20,409,030 bytes, 17,585 rows (catalogs and collections), **one row group**, on GitHub Pages.

| column | type | compressed |
|---|---|---|
| `type` (`Catalog` \| `Collection`), `id`, `href`, `title`, `license`, `portolan_registry:id` | string | 0.47 MB together |
| `description` | string | 0.87 MB |
| `keywords` | list<string> | 0.53 MB |
| `parents` | list<struct{id, href}> | 0.09 MB |
| `geometry` (WKB), `bbox` (struct) | | 0.29 MB |
| `start_datetime`, `end_datetime` | timestamp | 0.01 MB |
| `links` | list<struct> | **5.6 MB** |
| `original` | JSON string | **12.5 MB** |

Everything but `links` and `original` is 2.27 MB in 3 requests.

**GitHub Pages answers `HEAD` with the gzip-encoded length** (19,030,300, `Content-Encoding: gzip`), not the file's size, and does not expose `Content-Range` to scripts. The reader takes the file size from `HEAD`, so it cannot open this file today: "parquet file invalid (footer != PAR1)". A ranged request is served unencoded (a browser adds `Accept-Encoding: identity` to any request with a `Range`).

## Global Constraints

- Branch `map-widgets-phase-3`, stacked on `map-widgets-phase-2` (PR #9). Never commit to `main`.
- `original` and `links` are never read by a search or by loading the index. `original` is read only by E13's script.
- No bare third-party specifier in `packages/*/src`. minisearch loads from an exact pinned URL through a loader with `setMinisearchModules()`. `@cngeo/maplibre` must not statically import `@cngeo/stac`.
- Range reads use `cache: 'no-store'`. `BigInt` and `Date` values are coerced before they leave a package. Spatial maths uses `area.bboxes`, never `area.bbox`.
- A superseded search resolves empty, never rejects.
- Text from a remote document reaches the DOM through `textContent` only; a URL becomes an `href` or `src` only if it is `http(s)`.
- Error codes are the API. New: `CATALOG_INDEX_INVALID` (not retryable), for an index that is not a collections index.
- **Upstream drafts are written, not opened.** The spec paragraph and the registry patch live in `experiments/e13-render-column/`; nothing is pushed to `portolan-spec` or `portolan-registry`, and nothing is uploaded anywhere.
- `npm test` stays green: 1,171 at the start of this phase.

## Review Focus

1. **An index on a host that misreports its size** (GitHub Pages, the registry itself). It must open, in a browser and in Node. → Task 1.
2. **A search typed quickly.** Each keystroke supersedes the last; results never arrive out of order. → Task 3.
3. **A result with nothing to draw** (a table, zarr, an unsupported kind, a collection whose JSON is gone). Adding it must say why, not add nothing silently. → Tasks 4, 6.
4. **A global-extent collection and a tiny local one for the same words.** In a zoomed-in view the local one ranks first; with no area they rank by text alone. → Task 3.
5. **An index with no `render` column** (the live registry today) and one with it. Both search; the first resolves by fetching, the second without a request. → Tasks 3, 4.

---

### Task 1: Open a parquet file without trusting `HEAD`

**Files:**
- Modify: `packages/extract-core/src/parquet-io.js`, `README.md`; test helpers that classify requests
- Test: `packages/extract-core/test/byte-length.test.js`

**Interfaces:**
- Produces: `remoteByteLength(url, fetchImpl, { signal }): Promise<number>` — the file's real size, never from `HEAD`:
  1. `GET` with `Range: bytes=0-0`; a `206` whose `Content-Range` total is readable gives the size.
  2. A `206` whose `Content-Range` is hidden (CORS): `GET` with `Range: bytes=0-`, take `Content-Length` (always readable), abort the body.
  3. A `200` (the server ignores `Range`): its `Content-Length`, body cancelled.
  Anything else rejects `NETWORK` with the status in context.
- `openParquetFile` uses it and passes `byteLength` to hyparquet (which then makes no `HEAD`). The cached path is unchanged: a cached footer still costs no request.

- [ ] **Step 1: Write the failing tests** (a fake host modelled on GitHub Pages: `HEAD` returns the wrong, smaller length; ranges are honoured; `Content-Range` present or stripped)

```js
test('a host whose HEAD reports a compressed length still opens: the size comes from a ranged request')
test('where Content-Range is hidden, the size comes from the Content-Length of an open-ended range, and its body is not downloaded')
test('a server that ignores Range gives its Content-Length')
test('opening makes no HEAD request')
test('a 404 rejects NETWORK with the status')
test('an aborted signal rejects CANCELLED')
```

- [ ] **Step 2: Run** `node --test packages/extract-core/test/byte-length.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** Update request-classifying test helpers so the one-byte probe is not counted as a row read.
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `fix(extract-core): find a file's size with a ranged request, not HEAD`

---

### Task 2: `CatalogIndex` — load

**Files:**
- Create: `packages/stac/src/catalog-index.js`, `packages/stac/test/catalog-index.test.js`, `packages/stac/test/helpers/fake-index.js`
- Modify: `packages/stac/src/index.js`, `packages/spec/src/errors.js` + README

**Interfaces:**
- Consumes: `queryRows`, `describeDataset`, `createPlanCache` (extract-core).
- Produces:
  ```
  class CatalogIndex {
    constructor(url, options?: { fetch?, cache?, timeoutMs? })     // a collections.parquet URL, or a catalog.json URL
    load(): Promise<void>                                          // idempotent; a failure is not remembered
    entries: CatalogEntry[]                                        // collections only, after load()
    catalogs: { id, title, href }[]                                // the rows of type 'Catalog'
    hasRender: boolean
    close(): void
  }
  CatalogEntry = { id, title, description, href, license: string|null, keywords: string[],
                   catalog: string|null,              // `portolan_registry:id`, else the top parent's id
                   parents: { id, href }[], bbox: [w,s,e,n]|null, start: string|null, end: string|null,
                   kinds: string[],                   // from `render`; [] when the index has none
                   thumbnail: string|null, render: object[]|null }
  ```
- A `catalog.json` URL: fetch it, follow its `rel: "data"` link whose type or href is parquet (resolved against the catalog URL). No such link → `CATALOG_INDEX_INVALID`.
- Columns read: every column the index has out of `type, id, href, title, description, license, keywords, parents, bbox, start_datetime, end_datetime, portolan_registry:id, render, thumbnail`. Never `original`, `links`, `geometry`. An index without `id` or `href` → `CATALOG_INDEX_INVALID` naming what is missing.

- [ ] **Step 1: Write `fake-index.js`** (a small index with hyparquet-writer: 2 catalogs, 8 collections with mixed extents, licenses, times; a variant with `render` and `thumbnail`; a fat `original` column; a Range-serving fetch that logs byte ranges) **and the failing tests**:

```js
test('load() reads the light columns once and gives collections and catalogs apart')
test('the fat columns are never requested')                         // no logged range overlaps `original`'s chunk
test('bbox, times and keywords are plain values; a row with no bbox has null')
test('a catalog.json URL is followed to its rel:data parquet link')
test('a catalog with no parquet link is CATALOG_INDEX_INVALID')
test('an index with no id or href column is CATALOG_INDEX_INVALID, naming it')
test('an index with a render column reports hasRender and kinds per entry')
test('load() is idempotent, and a failed load is tried again')
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement. Step 4:** `npm test` — `# fail 0`.
- [ ] **Step 5: Commit** — `feat(stac): CatalogIndex -- load a collections.parquet index`

---

### Task 3: `CatalogIndex.search`

**Files:**
- Create: `packages/stac/src/minisearch-loader.js`, `packages/stac/test/catalog-search.test.js`
- Modify: `packages/stac/src/catalog-index.js`, `index.js`, `README.md`

**Interfaces:**
- Produces:
  ```
  search({ text?, area?, time?, license?, catalog?, kinds?, limit = 50 }):
    Promise<{ results: CatalogResult[], total: number, facets: { license, catalog, kinds } , superseded?: true }>
  CatalogResult = CatalogEntry & { score: number, fit: number|null }
  facets.x = { value: string, count: number }[]      // most frequent first; counted over the matches WITHOUT that facet's own filter
  ```
- `text`: minisearch 7.2.0 over `title` (boost 3), `keywords` (2), `id` (2), `description` (1); prefix on the last term, fuzzy 0.2. Empty text matches everything. The index is built once, on the first text search.
- `area`: an entry matches when its bbox intersects any of `area.bboxes`; an entry with no bbox does not match an area search. `fit` = intersection area / max(view area, extent area), over the best box — 1 for an extent the size of the view, near 0 for a global one.
- `time`: `{ start?, end? }` overlaps `[entry.start, entry.end]`; a null end is open. An entry with no times matches only when no time is asked for.
- `license`, `catalog`, `kinds`: a value or a list; `kinds` matches an entry having any of them.
- Order: `score = text score (1 when no text) * (0.25 + 0.75 * fit)` when an area is given, else the text score; ties by title.
- One search at a time: a new call supersedes the last, which resolves `{ results: [], total: 0, facets: {…empty}, superseded: true }`.
- `loadMinisearch()`, `setMinisearchModules({ MiniSearch })`, `clearMinisearchModules()`, `MINISEARCH_URL` (exact version).

- [ ] **Step 1: Write the failing tests**

```js
test('text finds by title, keyword and description, best first, and by a prefix of the last word')
test('a misspelling still finds it')
test('area keeps what intersects, and a local collection outranks a global one for the same words')     // Review Focus 4
test('with no area the same two rank by text alone')
test('an area across the antimeridian matches on both sides')
test('time keeps what overlaps; an open-ended collection matches a later window')
test('license, catalog and kinds filter; kinds needs a render column')
test('facet counts ignore their own filter and respect the others')
test('limit cuts results, total does not')
test('a superseded search resolves empty and marked')                                                    // Review Focus 2
test('the text index is built once')
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement. Step 4:** `npm test` — `# fail 0`.
- [ ] **Step 5: Commit** — `feat(stac): CatalogIndex.search -- text, area, time and facets`

---

### Task 4: `CatalogIndex.resolve` and the `render` column's shape

**Files:**
- Create: `packages/stac/src/render-column.js`, `packages/stac/test/render-column.test.js`
- Modify: `packages/stac/src/catalog-index.js`, `README.md`

**Interfaces:**
- Produces:
  - `renderFromLayers(layers: LayerSpec[]): RenderEntry[]` and `layersFromRender(entry: CatalogEntry): LayerSpec[]` — inverse enough that `layersFromRender` of `renderFromLayers(layersFromCollection(c))` draws the same thing.
    ```
    RenderEntry = { kind, id, title, url: string|null, style: string|null, layers: string[]|null,
                    display_asset: string|null, items: string|null, reason: string|null }
    ```
    `url` is the PMTiles/COG/parquet address; `style` a style JSON URL; `layers` the PMTiles source layers; `items`/`display_asset` for `scenes`; `reason` for `unsupported`. Attribution, bbox and temporal come from the entry's own columns, not from `render`.
  - `resolve(result): Promise<{ layers: LayerSpec[], source: 'render'|'collection', drawable: LayerSpec[], undrawable: { title, kind, reason }[] }>` — from `render` when the entry has it (no request); else fetch `href` and run `layersFromCollection`. A fetch failure rejects `LAYER_LOAD_FAILED` (retryable) naming the collection.
- Every LayerSpec returned passes `validateLayerSpec`.

- [ ] **Step 1: Write the failing tests** (the six real collection fixtures)

```js
test('renderFromLayers then layersFromRender gives the same kind, source and style, for each fixture')
test('a render entry is small: no attribution, no bbox, no description')
test('resolve uses render when present and makes no request')                // Review Focus 5
test('resolve fetches the collection when the index has no render column')
test('resolve sorts layers into drawable and undrawable, with reasons')      // Review Focus 3
test('a collection whose JSON is gone rejects LAYER_LOAD_FAILED naming it')
test('a malformed render value is ignored and the collection is fetched instead')
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement. Step 4:** `npm test` — `# fail 0`.
- [ ] **Step 5: Commit** — `feat(stac): resolve a catalog result to layers, from a render column or the collection`

---

### Task 5: Experiment E13 — a `render` column for the registry

**Files:**
- Create: `experiments/e13-render-column/build.mjs`, `measure.mjs`, `RESULTS.md`, `spec-paragraph.md`, `catalog_index.patch.md`, `.gitignore` (the built parquet is not committed)

**What it does**
- `build.mjs`: read the live index whole (the one time `original` is read), run `layersFromCollection` over every `original`, and write `out/collections.render.parquet` = the index's columns **minus `original` and `links`**, plus `render` (a list of the struct above) and `thumbnail` (string). Also write `out/coverage.json`.
- `measure.mjs`: report, as measured numbers with their method:
  1. bytes: the live index, the light columns alone, `render` and `thumbnail` compressed;
  2. coverage: collections by first drawable kind, and how many have nothing to draw and why;
  3. agreement: for a random sample of 60 collections (seeded), does `layersFromRender` equal `layersFromCollection` of the collection's JSON fetched live now? Report mismatches by cause;
  4. time from "result chosen" to "LayerSpec in hand", with `render` and with a fetch, over that sample.
- `RESULTS.md`: the question, the short answer, the numbers, what it decides, what it does not show.
- `spec-paragraph.md`: a draft paragraph for `portolan-spec/specs/incubating/stac-geoparquet.md`.
- `catalog_index.patch.md`: a draft change for `portolan-registry/scripts/registry/catalog_index.py` (read from the local clone if one exists at `~/repos/portolan-registry`; otherwise described against the column list above and marked unverified).

- [ ] **Step 1:** Write `build.mjs`; run it. Expected: a parquet with as many rows as the live index and a `render` column.
- [ ] **Step 2:** Write `measure.mjs`; run it. Record every number in `RESULTS.md` with how it was measured.
- [ ] **Step 3:** Write the two drafts. **Do not open anything upstream.**
- [ ] **Step 4: Commit** — `experiment(e13): a render column for the catalog index`

---

### Task 6: `CatalogSearchControl`

**Files:**
- Create: `packages/maplibre/src/catalog-search-model.js`, `catalog-search-control.js`, `packages/maplibre/test/catalog-search-model.test.js`
- Modify: `packages/maplibre/src/index.js`, `add-providers.js`, `README.md`

**Interfaces:**
- Consumes: a `CatalogIndex`-shaped object (injected), `LayerManager`.
- Produces:
  - `createCatalogSearchModel({ index, manager })` — `{ state, setText, setUseView(bool), setArea, setFacet(name, value|null), run(), add(id), hover(id|null), on('change'), destroy() }`; `state = { status, results, total, facets, text, useView, filters, hovered, added: Set, adding: Set, addNote: { id, text }|null, error? }`. `add(id)` resolves the result, adds every drawable layer, and sets `addNote` when some or all could not be drawn (with the reasons) — never silently nothing.
  - `catalogStatusOf(state)` — the panel's words, as in Phase 2.
  - `extentsGeoJson(results, hoveredId)` — one box per result with a bbox.
  - `class CatalogSearchControl implements IControl { constructor({ index, manager, position?, collapsed? }) }` — search box (debounced 200 ms), "this map area" toggle, facet chips, result cards (thumbnail, kind badges, catalog, license), the hovered result's extent on the map, **Add to map**.
  - `catalogAddProvider({ index, manager })` — a `LayerControl` add-provider that opens the same panel.

- [ ] **Step 1: Write the failing model tests** with a stub index:

```js
test('run() searches with the text, the view area when asked, and the chosen facets')
test('a second run supersedes the first')
test('add() adds every drawable layer once and marks the result added')
test('add() of a result with nothing drawable adds nothing and says why')            // Review Focus 3
test('add() of a partly drawable result adds what it can and names the rest')
test('a failed resolve is reported on the result, and can be tried again')
test('a layer removed from the map can be added again')
test('catalogStatusOf: the words for each state, unchanged by hover')
test('extentsGeoJson: one box per result with a bbox, the hovered one marked, an antimeridian box split')
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement** the model, then the control. **Step 4:** `npm test` — `# fail 0`.
- [ ] **Step 5: Commit** — `feat(maplibre): CatalogSearchControl`

---

### Task 7: The demo and its verifier

**Files:**
- Create: `examples/catalog-search/index.html`, `verify.mjs`, `screenshot.png`
- Modify: `examples/index.html`

The page: MapLibre 5.24.1; `LayerManager` + `LayerControl` (with the catalog add-provider and the URL one); a `CatalogSearchControl` on the live registry, or on `?index=<url>` (E13's local file, to show the `render` path). `#status` reads `ready: <n> collections`. `window.DEMO = { map, manager, index, control }`.

- [ ] **Step 1: Write `verify.mjs`** (a port; live data; fails on the page's own console errors). Against the live registry:
  1. the index loads: over 10,000 collections, and the browser's network log shows no request overlapping the `original` or `links` chunks, and under 4 MB read;
  2. typing a query returns results whose titles or descriptions carry the words;
  3. "this map area" on a small view returns only collections that intersect it, a local one above a global one;
  4. a facet chip narrows the results and the counts add up;
  5. hovering a card draws its extent;
  6. **Add to map** on a styled-PMTiles result adds a layer that reaches `ready` and draws features;
  7. a result with nothing to draw says why and adds nothing;
  8. its credit is displayed;
  9. the control survives remove/add and `setStyle()`.
  And, when `experiments/e13-render-column/out/collections.render.parquet` exists: 10. adding a result makes **no** request for a collection JSON.
- [ ] **Step 2: Run it** — Expected: FAIL, no page. **Step 3: Write the page**; fix what the verifier finds, each with a unit test where one is possible.
- [ ] **Step 4: Run** the verifier, `npm test`, and the Phase 1 and 2 verifiers. **Step 5: Commit** — `feat(examples): catalog-search`

## Not in this phase

Drawing GeoParquet that has no tiles (the ~39 untiled spatial collections), drawing `scenes` collections as a layer (they open in the imagery search instead — a later link between the two controls), saving a layer stack, and opening anything upstream.
