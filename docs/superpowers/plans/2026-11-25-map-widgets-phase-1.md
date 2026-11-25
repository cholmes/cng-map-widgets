# Map Widgets Phase 1 (Layer Manager) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A layer manager for MapLibre: one ordered stack of layers described by plain-JSON `LayerSpec`s, drawn as styled PMTiles, COGs or GeoJSON, with a panel to toggle, fade, reorder, remove and add them.

**Architecture:** `LayerSpec` is a versioned contract in `@cngeo/spec`. `layersFromCollection` in `@cngeo/stac` turns a STAC collection into specs without fetching. `LayerManager` in `@cngeo/maplibre` owns a bottom-first array and applies it through per-kind renderers: style-layer renderers move MapLibre layers, deck renderers contribute deck.gl layers to one shared overlay with `beforeId`. The panel is opengeos' `maplibre-gl-layer-control`, fed entirely through an adapter over `LayerManager`, plus our stylesheet, keyboard shim and Add button.

**Tech Stack:** Plain ESM + JSDoc, Node 22 `node --test`, Playwright 1.65.0. Runtime, loaded lazily through loader seams: the Phase 0 deck bundle; `pmtiles` 4.5.0; `maplibre-gl-layer-control` 0.18.3. Page-level: `maplibre-gl` 5.24.1.

**Spec:** [`docs/superpowers/specs/2026-11-25-map-widgets-design.md`](../specs/2026-11-25-map-widgets-design.md), Phase 1. Evidence it rests on: [`experiments/e12-deck-bundle/RESULTS.md`](../../../experiments/e12-deck-bundle/RESULTS.md).

## Global Constraints

- Branch `map-widgets-phase-1`, stacked on `worktree-map-widgets` (PR #7). Never commit to `main`.
- No bare third-party specifier in `packages/*/src`. Third-party modules load through a loader with an exact pinned URL and a `set…Modules()` / `clear…Modules()` seam.
- **`@cngeo/maplibre` must not statically import `@cngeo/stac` or `@cngeo/timeline`.** Existing pages map only the packages they use; a new static import would break them. Cross-package behaviour is injected (a function passed in).
- Dependency direction stays `maplibre → {stac, extract-core, spec}`, `stac → {extract-core, spec}`. `@cngeo/stac` emits `kind` strings; renderers live only in `@cngeo/maplibre`.
- Error codes are the API and are registered in `packages/spec/src/errors.js` and its README. New in this phase: `LAYER_INVALID`, `LAYER_UNSUPPORTED` (neither retryable), `LAYER_LOAD_FAILED` (retryable).
- Every MapLibre source and layer id this phase creates starts with `cng-layer-`. The panel excludes that prefix from its own listing, so each `LayerSpec` is one row.
- Interleaved deck.gl with `beforeId` is the default (Gate A showed it sound). Every `MVTLayer` passes `loadOptions: { worker: false }`.
- Controls are keyboard-operable, themed by `--cng-*` tokens with a dark variant, and leave nothing behind on removal.
- Spatial maths uses `[w, s, e, n]` boxes with `w <= e`. Attribution entries carry both `shareAlike` and `share_alike`, as `geocoder-core` normalises them.
- `npm test` stays green: 879 at the start of this phase.

## Review Focus

1. **A layer is removed while it is still loading** (slow style fetch, slow bundle). Nothing may appear on the map afterwards, and no error may surface. → Task 3.
2. **Two layers whose style files use the same source or layer ids** (every Portolan style names its source `data`). They must not collide or restyle each other. → Task 4.
3. **A collection's style file is missing or malformed** (404, HTML error page, a layer naming a source it does not define). The layer still draws with a default style, and `list()` says why. → Task 4.
4. **Reordering a mixed stack** (style layer, raster, style layer). After any `move`, the map's draw order equals `list()`, including a raster between two vector layers. → Tasks 3 and 7.
5. **The basemap style is replaced** (`map.setStyle`). MapLibre drops every added source and layer; the manager must put its stack back in the same order and state. → Task 3.

---

### Task 1: The `LayerSpec` contract

**Files:**
- Create: `packages/spec/src/layer.js`, `packages/spec/test/layer.test.js`
- Modify: `packages/spec/src/index.js`, `packages/spec/src/errors.js`, `packages/spec/README.md`, `packages/spec/test/errors.test.js`

**Interfaces:**
- Produces, from `@cngeo/spec`:
  - `LAYER_SPEC = 'cng-layer/1.0'`
  - `LAYER_KINDS = ['pmtiles-vector','cog','scenes','geojson','timeline','table','unsupported']` (frozen)
  - `RENDERABLE_KINDS = ['pmtiles-vector','cog','scenes','geojson','timeline']` (frozen)
  - `validateLayerSpec(spec): LayerSpec` — returns a normalised copy or throws `CngError('…','LAYER_INVALID',{ context:{ field } })`
  - `layerSlug(id): string` — `id` reduced to `[A-Za-z0-9_-]`, other runs → `-`; used in MapLibre ids
- `LayerSpec`:
  ```
  { spec: 'cng-layer/1.0', id: string, title: string, kind: LayerKind,
    source: object, style?: object, bbox?: [w,s,e,n], temporal?: [string|null, string|null],
    attribution: Attribution[], group?: string, thumbnail?: string }
  ```
  `source` by kind: `pmtiles-vector` `{ url, layers: string[] }` (+ `style?: { url }`); `cog` `{ url }`; `geojson` `{ data }` or `{ url }`; `scenes` `{ collectionUrl, items: { kind: 'parquet'|'partitioned', url? }, displayAsset?: string }`; `table` `{ url }`; `unsupported` `{ reason: string, assetTypes: string[] }`; `timeline` any object (Phase 4).

- [ ] **Step 1: Write the failing tests** (`packages/spec/test/layer.test.js`)

```js
const ok = { spec: 'cng-layer/1.0', id: 'a', title: 'A', kind: 'cog', source: { url: 'https://x/y.tif' }, attribution: [] };

test('a minimal spec validates and comes back as a copy', () => {
  const out = validateLayerSpec(ok);
  assert.deepEqual(out, ok); assert.notEqual(out, ok);
});
test('title defaults to id; attribution defaults to []', () => {
  const out = validateLayerSpec({ spec: 'cng-layer/1.0', id: 'a', kind: 'cog', source: { url: 'https://x/y.tif' } });
  assert.equal(out.title, 'a'); assert.deepEqual(out.attribution, []);
});
for (const [name, patch, field] of [
  ['wrong spec version', { spec: 'cng-layer/2.0' }, 'spec'],
  ['empty id', { id: '' }, 'id'],
  ['unknown kind', { kind: 'wms' }, 'kind'],
  ['cog without a url', { source: {} }, 'source.url'],
  ['relative url', { source: { url: './y.tif' } }, 'source.url'],
  ['bbox with w > e', { bbox: [10, 0, -10, 5] }, 'bbox'],
  ['bbox with a NaN', { bbox: [0, 0, NaN, 5] }, 'bbox'],
]) test(`refuses: ${name}`, () => assert.throws(() => validateLayerSpec({ ...ok, ...patch }), (e) => e.code === 'LAYER_INVALID' && e.context.field === field));
test('pmtiles-vector needs a url and a layers array', () => {
  assert.throws(() => validateLayerSpec({ ...ok, kind: 'pmtiles-vector', source: { url: 'https://x/t.pmtiles' } }), (e) => e.context.field === 'source.layers');
});
test('geojson accepts inline data or a url, not neither', () => {
  validateLayerSpec({ ...ok, kind: 'geojson', source: { data: { type: 'FeatureCollection', features: [] } } });
  assert.throws(() => validateLayerSpec({ ...ok, kind: 'geojson', source: {} }), (e) => e.context.field === 'source');
});
test('layerSlug keeps ids usable as MapLibre ids', () => {
  assert.equal(layerSlug('a/b c:d'), 'a-b-c-d'); assert.equal(layerSlug('ok_id-1'), 'ok_id-1');
});
```
Add to `errors.test.js`: `LAYER_LOAD_FAILED` is retryable by default; `LAYER_INVALID` and `LAYER_UNSUPPORTED` are not.

- [ ] **Step 2: Run** `node --test packages/spec/test/layer.test.js packages/spec/test/errors.test.js` — Expected: FAIL (module not found; `LAYER_LOAD_FAILED` not retryable).
- [ ] **Step 3: Implement** `layer.js`; export from `index.js`; add the three codes to the typedef, `LAYER_LOAD_FAILED` to `RETRYABLE_DEFAULTS`, and a "Layers" section to the README.
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `feat(spec): the LayerSpec contract (cng-layer/1.0)`

---

### Task 2: `layersFromCollection`

**Files:**
- Create: `packages/stac/src/layers-from-collection.js`, `packages/stac/test/layers-from-collection.test.js`, `packages/stac/test/fixtures/README.md` (the six `*.collection.json` fixtures are already downloaded)
- Modify: `packages/stac/src/index.js`, `packages/stac/README.md`, `packages/extract-core/src/dataset-resolve.js` + `src/index.js` (export `attributionFromCollection`)

**Interfaces:**
- Consumes: `validateLayerSpec`, `LAYER_SPEC` (Task 1); `attributionFromCollection(collection)` from `@cngeo/extract-core` (the existing private `deriveAttribution`, exported under that name).
- Produces: `layersFromCollection(collection, { baseUrl }): LayerSpec[]` — synchronous, no fetch, never throws for an unrecognised collection (returns one `unsupported` spec). Throws `LAYER_INVALID` only if `collection` is not an object with an `id`.

Rules, applied in this order; a collection can yield more than one spec:
1. **`pmtiles-vector`** — a link with `rel: 'pmtiles'`, else an asset of type `application/vnd.pmtiles`. `source.layers` from the link's `pmtiles:layers`, else the collection's. `source.style.url` from the asset with roles `style` **and** `default`, else the only `style` asset, else none.
2. **`scenes`** — an asset with role `collection-mirror`; or `partition:scheme` plus STAC item columns (`stac_version` and `assets` in `table:columns`); or a `data` parquet asset when `table:columns` has those two columns. With several candidate parquet assets pick, in order: role `collection-mirror`; key or title matching `/stac|items/i`; the largest `file:size`; the first. `displayAsset`: the `item_assets` key with role `visual`, else key `visual` or `image`, else the first whose type contains `cloud-optimized`.
3. **`cog`** — every collection-level asset whose type contains `profile=cloud-optimized`, one spec each.
4. **`table`** — a `data` parquet asset, when rules 1–2 produced nothing and `table:columns` has no column of type `geometry`/`binary` named like the primary geometry.
5. **`unsupported`** — when nothing above matched, or the only match is spatial GeoParquet with no tiles; `reason` says which, `assetTypes` lists the media types found.

Ids: the collection id for the first spec; `<id>:<asset key>` for the rest. Every href absolutised against `baseUrl`. `bbox` from `extent.spatial.bbox[0]`, `temporal` from `extent.temporal.interval[0]`, `thumbnail` from the `thumbnail`-role asset.

- [ ] **Step 1: Write the failing tests**, one per fixture, asserting exact values:

| fixture | expected |
|---|---|
| `unosat-damage-sites` (base `…/tc20180209ton-damage-sites/collection.json`) | one spec: `pmtiles-vector`, `source.url` ends `/tc20180209ton-damage-sites.pmtiles`, `source.layers` `['damage-sites']`, `source.style.url` ends `/styles/default.json`, `bbox[0]` ≈ `-175.186`, `attribution[0].license` `'CC-BY-4.0'` |
| `worldpop-jamaica-children-5-9` | one spec: `cog`, url ends `/children-5-9.tif` (the non-COG `source` asset is ignored) |
| `naip` | two specs in order: `scenes` with `items` `{ kind:'parquet', url:'https://data.source.coop/nthh/naip/stac/naip.parquet' }`; then `cog` with id `naip:overview_national` |
| `oam-cc-by-4-0` | one spec: `scenes`, `items.url` ends `/items.parquet`, `displayAsset` `'visual'` |
| `sentinel-2-c1-l2a` | one spec: `scenes`, `items` `{ kind:'partitioned' }`, `displayAsset` `'visual'` |
| `gmw-country-change` | one spec: `table` |
| inline: only a `application/vnd+zarr` asset | one spec: `unsupported`, `assetTypes` `['application/vnd+zarr']` |
| inline: two `style` assets, the second with role `default` | the second's href is `source.style.url` |
| inline: PMTiles asset, no `rel:pmtiles` link, `pmtiles:layers` on the collection | still `pmtiles-vector` with those layers |
| `layersFromCollection(null)` | throws `LAYER_INVALID` |

Every returned spec must also pass `validateLayerSpec` unchanged.

- [ ] **Step 2: Run** `node --test packages/stac/test/layers-from-collection.test.js` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** Write `fixtures/README.md`: each fixture's source URL and the fetch date (2026-11-25), verbatim copies.
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `feat(stac): layersFromCollection -- a STAC collection as LayerSpecs`

---

### Task 3: `LayerManager` — the ordered stack

**Files:**
- Create: `packages/maplibre/src/layer-manager.js`, `packages/maplibre/test/layer-manager.test.js`, `packages/maplibre/test/helpers/fake-map.js`
- Modify: `packages/maplibre/src/index.js`

**Interfaces:**
- Consumes: `validateLayerSpec`, `RENDERABLE_KINDS`, `layerSlug`, `CngError`.
- Produces:
  ```
  registerLayerRenderer(kind: string, factory: (ctx: RendererContext) => LayerRenderer): void
  class LayerManager {
    constructor(map, options?: { beforeId?: string|null, addProtocol?: Function })
    add(spec, options?: { visible?: boolean, opacity?: number, index?: number }): Promise<LayerEntry>
    remove(id): void
    setVisible(id, visible: boolean): void
    setOpacity(id, opacity: number): void      // clamped to 0..1
    move(id, toIndex: number): void            // index in the bottom-first list
    get(id): LayerEntry | null
    list(): LayerEntry[]                       // bottom first; copies
    on(event: 'change'|'error', handler): () => void
    destroy(): void
  }
  LayerEntry   = { id, title, kind, visible, opacity, status: 'loading'|'ready'|'error', error?: CngError, note?: string, bbox?, attribution, spec }
  RendererContext = { map, spec, slug, addProtocol, deck(): Promise<DeckModules>, note(text): void }
  LayerRenderer = { add(state): Promise<void>, remove(): void, setVisible(v): void, setOpacity(o): void,
                    styleLayerIds?(): string[], deckLayers?(state, beforeId): object[] }
  ```
  `state` is `{ visible, opacity }`. A renderer implements `styleLayerIds` (it added MapLibre layers) or `deckLayers` (it contributes to the overlay), never both.
- **Ordering rule:** `list()` is bottom-first. Each entry's slot is "just below" an id: the first style-layer id of the nearest *style* entry above it, else `options.beforeId` (default: the basemap's first `symbol` layer, so the stack sits under the labels; `null` means on top of everything). Style entries are positioned with `map.moveLayer(layerId, slot)`; deck entries get `beforeId: slot`, and adjacent deck entries keep their relative order by position in the overlay's `layers` array.
- One `MapLibreOverlay({ interleaved: true })` is created on first need and removed in `destroy()`.
- `add` rejects with `LAYER_INVALID` (bad spec, or `context.reason: 'duplicate'`) or `LAYER_UNSUPPORTED` (no renderer for the kind; `table` and `unsupported` always). A renderer failure sets `status: 'error'`, keeps the entry in the list, emits `error`, and rejects.
- On the map's `style.load` after the first, every entry is re-added in order with its state (Review Focus 5).

- [ ] **Step 1: Write `fake-map.js`** — records `addSource/removeSource/addLayer/removeLayer/moveLayer/setPaintProperty/setLayoutProperty/addControl/removeControl`, keeps an ordered `layers` array that `moveLayer(id, beforeId)` really reorders, serves `getStyle()`, `getLayer`, `getSource`, and `on/off/fire`.

- [ ] **Step 2: Write the failing tests.** A test-only style renderer adds one MapLibre layer `cng-layer-<slug>` and a test-only deck renderer returns `[{ id, beforeId, visible, opacity }]`; the deck modules are a stub injected with `setDeckModules`.

```js
test('add validates, renders, and lists bottom-first')            // list ids === ['a','b']; map layer order a then b, both below 'labels'
test('a duplicate id is refused')                                 // LAYER_INVALID, context.reason 'duplicate'
test('table and unsupported kinds are refused')                   // LAYER_UNSUPPORTED
test('setVisible / setOpacity reach the renderer and emit change')
test('opacity is clamped to 0..1')
test('move reorders style layers on the map')                     // [a,b,c] move a→2 => map order b,c,a
test('a raster between two vector layers gets the upper vector as its beforeId')   // Review Focus 4
test('adjacent deck layers keep list order in the overlay')
test('remove while loading leaves nothing on the map and raises no error')         // Review Focus 1
test('a renderer failure keeps the entry with status error and emits error')
test('after a second style.load the stack is rebuilt in the same order and state') // Review Focus 5
test('destroy removes every layer and the overlay')
```

- [ ] **Step 3: Run** `node --test packages/maplibre/test/layer-manager.test.js` — Expected: FAIL, module not found.
- [ ] **Step 4: Implement** `layer-manager.js`. A per-entry generation counter makes a late `add()` resolution a no-op after `remove()`.
- [ ] **Step 5: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 6: Commit** — `feat(maplibre): LayerManager -- one ordered stack over style and deck layers`

---

### Task 4: Style-layer renderers — `pmtiles-vector` and `geojson`

**Files:**
- Create: `packages/maplibre/src/renderers/style-plan.js`, `renderers/pmtiles-vector.js`, `renderers/geojson.js`, `packages/maplibre/src/pmtiles-loader.js`, `packages/maplibre/test/style-plan.test.js`, `packages/maplibre/test/style-renderers.test.js`
- Modify: `packages/maplibre/src/index.js` (register both renderers on import; export the loader seam)

**Interfaces:**
- Consumes: `registerLayerRenderer`, `RendererContext` (Task 3).
- Produces:
  - `planStyle({ slug, styleJson, styleUrl, fallback }): { sources: Record<string, object>, layers: object[], note?: string }` — pure. Every source id becomes `cng-layer-<slug>--<id>`, every layer id `cng-layer-<slug>--<id>`; `pmtiles://` URLs are resolved against `styleUrl` and made absolute; a layer naming an undefined source is dropped with a `note`.
  - `defaultVectorStyle({ slug, url, vectorLayers }): { sources, layers }` — one source; per vector layer a `fill` + `line` pair for polygons, a `line` for lines, a `circle` for points, in a fixed palette; geometry type from the PMTiles metadata's `vector_layers[].geometry_type` when present, else all three with geometry-type filters.
  - `opacityPaint(layer, factor): Record<string, unknown>` — the paint properties to set so a layer shows at `base × factor`: number → product; expression → `['*', expr, factor]`; absent → `factor`. Covers `fill`, `line`, `circle` (+stroke), `symbol` (text + icon), `raster`, `fill-extrusion`, `heatmap`.
  - `PMTILES_CDN`, `loadPmtiles()`, `setPmtilesModules()`, `clearPmtilesModules()` — `https://cdn.jsdelivr.net/npm/pmtiles@4.5.0/+esm`.
- The `pmtiles://` protocol is registered once per page through `ctx.addProtocol` (default `globalThis.maplibregl?.addProtocol`); with neither, `add` fails with `LAYER_UNSUPPORTED` saying to pass `addProtocol`.
- A style that cannot be fetched or parsed is **not** an error: the renderer falls back to `defaultVectorStyle` and calls `ctx.note('style unavailable: …')` (Review Focus 3).

- [ ] **Step 1: Write the failing pure tests** (`style-plan.test.js`), using the real UNOSAT style document inline:

```js
test('ids are namespaced and the pmtiles url is absolute')   // source 'cng-layer-x--data', url 'pmtiles://https://…/tc20180209ton-damage-sites.pmtiles'
test('two layers with the same source name do not collide')  // Review Focus 2: plan slug 'a' and slug 'b' share no id
test('a layer naming a missing source is dropped with a note')
test('opacityPaint: number, expression, absent, and circle stroke')
test('defaultVectorStyle: polygon -> fill+line, line -> line, point -> circle; unknown -> all three filtered')
```

- [ ] **Step 2: Write the failing renderer tests** (`style-renderers.test.js`) against `fake-map.js`, with `fetch` and the pmtiles module stubbed:

```js
test('pmtiles-vector adds the style\'s sources and layers, namespaced')
test('a 404 style falls back to the default style and sets a note')       // Review Focus 3
test('an HTML error page instead of JSON falls back the same way')
test('setOpacity scales each layer from its own base opacity')
test('setVisible sets layout visibility on every layer')
test('remove takes away every layer, then every source')
test('geojson: inline data draws with a default style by geometry type')
```

- [ ] **Step 3: Run** both test files — Expected: FAIL, modules not found.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 6: Commit** — `feat(maplibre): pmtiles-vector and geojson renderers`

---

### Task 5: The `cog` renderer

**Files:**
- Create: `packages/maplibre/src/renderers/cog.js`, `packages/maplibre/test/cog-renderer.test.js`
- Modify: `packages/maplibre/src/index.js`

**Interfaces:**
- Consumes: `registerLayerRenderer`, `ctx.deck()` (Task 3); `COGLayer` from the deck modules.
- Produces: a renderer whose `deckLayers(state, beforeId)` returns one `COGLayer` with `id: 'cng-layer-<slug>'`, `source: spec.source.url`, `visible`, `opacity`, `beforeId`. It builds a new layer object on every call (deck.gl's idiom) with the same id and the same `source` string.

- [ ] **Step 1: Write the failing tests**, with deck modules stubbed by a `COGLayer` class that records its props:

```js
test('contributes one COGLayer carrying url, visibility, opacity and beforeId')
test('the layer id and source are stable across calls')     // or deck.gl reopens the file
test('add() loads deck and resolves; a load failure rejects with DECK_LOAD_FAILED')
```

- [ ] **Step 2: Run** — Expected: FAIL, module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `feat(maplibre): cog renderer on deck.gl-raster's COGLayer`

---

### Task 6: `LayerControl` — the panel

**Files:**
- Create: `packages/maplibre/src/layer-control.js`, `layer-control-adapter.js`, `layer-control-loader.js`, `layer-control-theme.js`, `layer-control-a11y.js`, `add-providers.js`, `packages/maplibre/test/layer-control-adapter.test.js`, `packages/maplibre/test/add-providers.test.js`
- Modify: `packages/maplibre/src/index.js`, `packages/maplibre/README.md`

**Interfaces:**
- Consumes: `LayerManager` (Task 3).
- Produces:
  - `LAYER_CONTROL_CDN = { js, css }` (jsDelivr, `maplibre-gl-layer-control@0.18.3`), `loadLayerControl()`, `setLayerControlModules()`, `clearLayerControlModules()`.
  - `createControlAdapter(manager): CustomLayerAdapter` — pure mapping: `type: 'cng'`; `getLayerIds()` **top first** (the panel lists top-down; the manager is bottom-first); `getLayerState`, `setVisibility`, `setOpacity`, `getName`, `getSymbolType` (`raster` for `cog`/`scenes`, else `fill`), `getBounds`, `removeLayer`, `onLayerChange` (from the manager's `change` events).
  - `applyPanelOrder(manager, topFirstIds): void` — turns the panel's reported order into `manager.move` calls; ids it does not know are ignored.
  - `urlAddProvider({ layersFromCollection, fetch? }): AddProvider` and `specsFromUrl(url, deps): Promise<LayerSpec[]>` — `.pmtiles` → one `pmtiles-vector` spec whose `layers` are read from the archive at add time (`layers: []` is allowed for this kind only when `source.discover === true`); `.tif`/`.tiff` → one `cog` spec; anything else is fetched as JSON and passed to the injected `layersFromCollection`.
  - `AddProvider = { id: string, label: string, open(ctx: { manager, map, anchor: HTMLElement, close(): void }): void }`
  - `class LayerControl implements IControl { constructor({ manager, addProviders?: AddProvider[], basemapStyleUrl?: string, collapsed?: boolean, position? }); onAdd(map); onRemove(); ready: Promise<void> }`
- The opengeos control is constructed with `customLayerAdapters: [adapter]`, `excludeLayers: ['cng-layer-*']`, `onLayerReorder: (order) => applyPanelOrder(manager, order)`.
- `layer-control-theme.js` injects one stylesheet (once) restyling the panel's classes from `--cng-*` tokens, with a `prefers-color-scheme: dark` block; token names and defaults are those in `geocoder-control.js`.
- `layer-control-a11y.js` runs on a `MutationObserver` over the panel: names each row's checkbox (`aria-label="Show <layer name>"`); makes context-menu items `role="menuitem"`, focusable, activated by Enter/Space, moved between with arrow keys, closed with Escape with focus returned to the row; gives each row "Move up"/"Move down" by `Alt+ArrowUp`/`Alt+ArrowDown` on its checkbox, calling `manager.move`.
- The Add button sits in the panel header; with one provider it opens it, with several it shows a menu.

- [ ] **Step 1: Write the failing tests.**

`layer-control-adapter.test.js`, with a real `LayerManager` over `fake-map.js` and the test-only renderers:
```js
test('getLayerIds is top-first')
test('visibility, opacity, name, bounds and removal go through the manager')
test('onLayerChange reports add and remove, and its unsubscribe stops it')
test('applyPanelOrder makes the manager match a reported order')      // incl. the reverse order, and an unknown id ignored
```
`add-providers.test.js`:
```js
test('specsFromUrl: a .pmtiles url gives one discoverable pmtiles-vector spec')
test('specsFromUrl: a .tif url gives one cog spec')
test('specsFromUrl: a collection url is fetched and handed to layersFromCollection with its baseUrl')
test('specsFromUrl: a non-JSON response rejects with LAYER_LOAD_FAILED')
```

- [ ] **Step 2: Run** both — Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** the six modules. `validateLayerSpec` gains the `source.discover` allowance (add its test to `packages/spec/test/layer.test.js` first).
- [ ] **Step 4: Run** `npm test` — Expected: `# fail 0`.
- [ ] **Step 5: Commit** — `feat(maplibre): LayerControl -- the layer panel, on maplibre-gl-layer-control`

---

### Task 7: The demo and its verifier

**Files:**
- Create: `examples/layers-demo/index.html`, `examples/layers-demo/verify.mjs`
- Modify: `examples/index.html` (link the demo)

**Interfaces:**
- Consumes: everything above; `layersFromCollection` from `@cngeo/stac`.

The page: MapLibre 5.24.1, an import map for `@cngeo/{spec,extract-core,stac,maplibre}`, a `LayerManager`, a `LayerControl` with `urlAddProvider({ layersFromCollection })`. It starts with three layers, bottom to top: the WorldPop Jamaica COG, the UNOSAT damage-sites PMTiles collection (resolved through `layersFromCollection`), and one inline GeoJSON polygon. `#status` reads `ready: 3 layers` when all three report `ready`. A hidden `<input id="addUrl">` adds a URL through the same code path as the Add button (the path automation can drive). `window.DEMO = { map, manager, control }`.

- [ ] **Step 1: Write `verify.mjs`** (shape of `examples/s2-footprints/verify.mjs`; takes a port; fails on any console error). Assertions:
  1. `ready: 3 layers`; `manager.list()` has kinds `['cog','pmtiles-vector','geojson']`, all `status: 'ready'`.
  2. The UNOSAT layer drew with its published style: a map layer `cng-layer-…--damage-sites-points` exists with a `match` expression in `circle-color`.
  3. The panel has exactly three `cng` rows plus Background, top-first.
  4. Clicking a row's checkbox hides that layer: `list()` says so and the pixels inside its bounds change.
  5. Opacity from the panel reaches the COG (`deck` layer `opacity`) and the vector layer (paint opacity scaled).
  6. `manager.move` of the COG to the top, then between the two vector layers: after each, the map's draw order (style-layer order plus the deck layer's `beforeId`) equals `list()`. (Review Focus 4)
  7. Typing a `.tif` URL into `#addUrl` adds a fourth layer and a fourth row; removing it from the panel's menu removes both.
  8. Keyboard only: Tab to a row's checkbox, Space toggles it; `Alt+ArrowUp` moves the row; the context menu opens, an item takes focus and Enter activates it.
  9. Dark mode: with `colorScheme: 'dark'` the panel background is not `rgb(255, 255, 255)`.
  10. `map.setStyle(sameStyleUrl)`: afterwards `list()` and the map's draw order are as before. (Review Focus 5)
  11. `map.removeControl(control); manager.destroy()`: no `cng-layer-` layer or source remains.

- [ ] **Step 2: Run it** — `python3 serve.py 8123 & node examples/layers-demo/verify.mjs 8123` — Expected: FAIL, the page does not exist.
- [ ] **Step 3: Write the page.** Fix what the verifier finds in Tasks 3–6, each fix with a unit test where one is possible.
- [ ] **Step 4: Run** the verifier, then `npm test` — Expected: every check `PASS`; `# fail 0`.
- [ ] **Step 5: Commit** — `feat(examples): layers-demo`
