# Map Widgets Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the two new packages and settle the three open technical questions (deck.gl bundle, layer control, search cost) before any widget is built.

**Architecture:** Two empty-but-tested package skeletons wired into `npm test`. One esbuild script produces a single committed ESM bundle of deck.gl + deck.gl-raster, loaded lazily through a loader with an injection seam. Three experiments record measured answers in `RESULTS.md` files that later phases cite.

**Tech Stack:** Plain ESM + JSDoc, Node 22 `node --test`, Playwright 1.65.0 (existing). New build-time only: `esbuild` 0.28.2. Bundle inputs: `@deck.gl/{core,layers,geo-layers,mesh-layers,extensions,maplibre}` 9.4.2, `@loaders.gl/mvt` 4.5.5, `@developmentseed/{deck.gl-geotiff,deck.gl-raster,geotiff}` 0.10.0. Page-level: `maplibre-gl` 5.24.1, `pmtiles` 4.5.0.

**Spec:** [`docs/superpowers/specs/2026-11-25-map-widgets-design.md`](../specs/2026-11-25-map-widgets-design.md)

## Global Constraints

- All work happens in the worktree on branch `worktree-map-widgets`; never commit to `main`.
- Exactly two new packages: `@cngeo/stac`, `@cngeo/timeline`. Both at version `0.3.1`, matching every other package.
- No bare third-party specifier in any `packages/*/src` file. Third-party code is reached only through a loader module with an injection seam (`set…Modules()` / `clear…Modules()`).
- Pin every dependency to an exact version; no ranges.
- Error **codes** are the API. New codes only: `DECK_LOAD_FAILED` (retryable), `DECK_MODULES_INVALID` (not retryable). Construct with `new CngError(message, code, { retryable, context })` from `@cngeo/spec`.
- The deck bundle is committed at `packages/maplibre/vendor/deck-stack.js` and built only by `tools/build-deck-bundle.mjs`.
- `npm test` must stay green at 860 existing tests plus the new ones. Baseline measured 2026-11-25: 860 pass, 0 fail.
- Live-data verifiers are never added to CI (`.github/workflows/test.yml` forbids it).
- Experiments record results in a `RESULTS.md` beside the code, with the date and what was measured against.

## Review Focus

1. **Two widgets call `loadDeck()` at the same moment.** One network fetch, one module instance, both callers get the same object. → Task 2.
2. **A host injects modules from an older deck.gl-raster** (0.8/0.9, where exports were renamed). It must fail with `DECK_MODULES_INVALID` naming the missing export, never draw a silent blank layer. → Task 2.
3. **The bundle fetch fails once** (offline, 404, flaky CDN). `loadDeck()` rejects with retryable `DECK_LOAD_FAILED`, and the next call tries again instead of replaying a cached rejection. → Task 2.
4. **The bundle is served from a different origin than the page** (jsDelivr, GitHub Pages). The COG decode worker must still start; a cross-origin `new Worker(url)` does not. → Task 3.
5. **A browser without WebGL2, or without `EXT_texture_norm16`** (headless Chrome, some integrated GPUs). The loader reports it up front so a widget can say why nothing draws. → Task 2.

---

### Task 1: Package skeletons wired into the test run

**Files:**
- Create: `packages/stac/{package.json,LICENSE,README.md,src/index.js,test/version.test.js}`
- Create: `packages/timeline/{package.json,LICENSE,README.md,src/index.js,test/version.test.js}`
- Modify: `package.json` (the `test` script), `package-lock.json`

**Interfaces:**
- Produces: `import { VERSION } from '@cngeo/stac'` and `from '@cngeo/timeline'`, both `'0.3.1'`.

- [ ] **Step 1: Write the failing tests**

`packages/stac/test/version.test.js` and the same file under `packages/timeline/`, each:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/index.js';

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal(pkg.version, '0.3.1');
});
```

- [ ] **Step 2: Add both globs to the root `test` script and run it**

Append `packages/stac/test/*.test.js packages/timeline/test/*.test.js` to `scripts.test`.
Run: `npm test 2>&1 | tail -8` — Expected: FAIL, cannot find `../src/index.js`.

- [ ] **Step 3: Create the two packages**

Copy the shape of `packages/upload-core/package.json` exactly (fields, `files`, `exports`, `publishConfig`, `repository.directory`). Copy `LICENSE` from `packages/upload-core/LICENSE`.
- `@cngeo/stac` — description: "STAC for the map: turn a collection into layer specs, search STAC-GeoParquet imagery, and search a collections.parquet index. Headless; no DOM, no map library." `dependencies`: `@cngeo/spec` 0.3.1, `@cngeo/extract-core` 0.3.1.
- `@cngeo/timeline` — description: "A histogram timeline over time-chunked map data: chunk descriptors of any period, a chunk-set orchestrator, playback, and a canvas timeline component. No map library." `dependencies`: `@cngeo/spec` 0.3.1.
- Each `src/index.js`: a header comment in the house style and `export const VERSION = '0.3.1';`.
- Each `README.md`: title, one paragraph, and "Status: under construction — see the design doc" with the spec link.

- [ ] **Step 4: Refresh the lockfile and run the tests**

Run: `npm install && npm test 2>&1 | tail -8` — Expected: `# pass 862`, `# fail 0`.

- [ ] **Step 5: Commit** — `feat: scaffold @cngeo/stac and @cngeo/timeline`

---

### Task 2: The deck loader and its injection seam

**Files:**
- Create: `packages/maplibre/src/deck-loader.js`
- Modify: `packages/maplibre/src/index.js` (re-export)
- Test: `packages/maplibre/test/deck-loader.test.js`

**Interfaces:**
- Produces, from `@cngeo/maplibre`:
  - `DECK_BUNDLE_URL: string` — `new URL('../vendor/deck-stack.js', import.meta.url).href`
  - `DECK_REQUIRED_EXPORTS: readonly string[]` — `['MapLibreOverlay','COGLayer','MultiCOGLayer','COGSource','RasterLayer','MVTLayer','GeoJsonLayer','DataFilterExtension','MVTLoader','DecoderPool','gpuModules','VERSIONS']`
  - `APPROX_BYTES: { deck: number }` — placeholder `760_000`; Task 3 replaces it with the measured gzip size
  - `loadDeck(options?: { importer?: (url: string) => Promise<object> }): Promise<DeckModules>`
  - `setDeckModules(mods: object): void`, `clearDeckModules(): void`
  - `deckSupport(canvas?: { getContext(type: string): any }): { webgl2: boolean, norm16: boolean }`
- `DeckModules` is the bundle's namespace object: every name in `DECK_REQUIRED_EXPORTS`, with `VERSIONS: { deck: string, raster: string }`.

- [ ] **Step 1: Write the failing tests** in `packages/maplibre/test/deck-loader.test.js`

```js
const full = () => Object.fromEntries(DECK_REQUIRED_EXPORTS.map((k) => [k, k === 'VERSIONS' ? { deck: '9.4.2', raster: '0.10.0' } : {}]));

test('injected modules are returned as-is', async () => {
  const mods = full(); setDeckModules(mods);
  assert.equal(await loadDeck(), mods);
});
test('an injected set missing an export is refused, naming it', () => {
  const mods = full(); delete mods.COGSource;
  assert.throws(() => setDeckModules(mods), (e) => e.code === 'DECK_MODULES_INVALID' && e.retryable === false && e.context.missing.includes('COGSource'));
});
test('concurrent loads share one import', async () => {
  let calls = 0; const mods = full();
  const importer = async () => { calls++; return mods; };
  const [a, b] = await Promise.all([loadDeck({ importer }), loadDeck({ importer })]);
  assert.equal(calls, 1); assert.equal(a, b);
});
test('a failed load rejects retryably and is not cached', async () => {
  let calls = 0; const mods = full();
  const importer = async () => { if (++calls === 1) throw new Error('offline'); return mods; };
  await assert.rejects(loadDeck({ importer }), (e) => e.code === 'DECK_LOAD_FAILED' && e.retryable === true);
  assert.equal(await loadDeck({ importer }), mods);
});
test('a loaded bundle missing an export is refused', async () => {
  const mods = full(); delete mods.RasterLayer;
  await assert.rejects(loadDeck({ importer: async () => mods }), (e) => e.code === 'DECK_MODULES_INVALID');
});
test('deckSupport reports WebGL2 and norm16', () => {
  const gl = { getExtension: (n) => (n === 'EXT_texture_norm16' ? {} : null) };
  assert.deepEqual(deckSupport({ getContext: (t) => (t === 'webgl2' ? gl : null) }), { webgl2: true, norm16: true });
  assert.deepEqual(deckSupport({ getContext: () => null }), { webgl2: false, norm16: false });
});
```

Call `clearDeckModules()` in a `beforeEach`; it must also drop any in-flight or cached load.

- [ ] **Step 2: Run** `node --test packages/maplibre/test/deck-loader.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `deck-loader.js`**

Mirror `packages/raster-core/src/cdn.js`. The default importer is `(url) => import(/* @vite-ignore */ url)`. Cache the in-flight promise; clear it on rejection. Validate against `DECK_REQUIRED_EXPORTS` on both paths. `deckSupport()` with no argument creates a throwaway `<canvas>` when `document` exists and returns both `false` otherwise.

- [ ] **Step 4: Run** `npm test 2>&1 | tail -8` — Expected: `# fail 0`, 6 more passes than after Task 1.

- [ ] **Step 5: Commit** — `feat(maplibre): deck.gl loader with an injection seam`

---

### Task 3: Gate A — build the deck bundle and prove it on a no-build page

**Files:**
- Create: `tools/build-deck-bundle.mjs`, `packages/maplibre/vendor/deck-entry.js`, `packages/maplibre/vendor/deck-stack.js` (generated, committed), `packages/maplibre/vendor/README.md`
- Create: `experiments/e12-deck-bundle/{index.html,verify.mjs,RESULTS.md}`
- Modify: `packages/maplibre/package.json` (`devDependencies`, add `vendor` to `files`), root `package.json` (`esbuild` devDependency, script `build:deck`), `packages/maplibre/src/deck-loader.js` (`APPROX_BYTES`)

**Interfaces:**
- Consumes: `loadDeck`, `deckSupport`, `DECK_REQUIRED_EXPORTS` from Task 2.
- Produces: the committed bundle; `npm run build:deck`; `node tools/build-deck-bundle.mjs --check` exits non-zero when the committed bundle differs from a fresh build.

- [ ] **Step 1: Write the entry module** `packages/maplibre/vendor/deck-entry.js`

Re-export exactly the names in `DECK_REQUIRED_EXPORTS`, plus `ScatterplotLayer`, `PathLayer`, `COORDINATE_SYSTEM`, `WebMercatorViewport`, `MultiCOGSource`, `MosaicLayer` and `proj4`. `gpuModules` is `export * as gpuModules from '@developmentseed/deck.gl-raster/gpu-modules'`. `VERSIONS` is built from the two packages' own `package.json` versions at build time (an esbuild `define`).

- [ ] **Step 2: Write `tools/build-deck-bundle.mjs`**

esbuild: `bundle: true`, `format: 'esm'`, `platform: 'browser'`, `target: 'es2022'`, `minify: true`, `legalComments: 'linked'`, one output file. The geotiff decode worker must end up **inlined as a Blob URL** (Review Focus 4): bundle `@developmentseed/geotiff/pool/worker` as a separate IIFE/ESM string first, then inject it so `DecoderPool` is constructed from a Blob. Read `~/repos/sentinel-2-catalog/apps/explorer/vite.config.js` and `~/repos/portolan-browser/src/components/maps/StacMapLayer.js` (the `?worker` import and shared `DecoderPool`) for how the pool is created. `--check` builds to a temp directory and compares SHA-256.

- [ ] **Step 3: Build and record sizes**

Run: `npm run build:deck && ls -l packages/maplibre/vendor/deck-stack.js && gzip -9 -c packages/maplibre/vendor/deck-stack.js | wc -c`
Put the gzip byte count into `APPROX_BYTES.deck`. Run `node tools/build-deck-bundle.mjs --check` — Expected: exit 0.

- [ ] **Step 4: Write the page** `experiments/e12-deck-bundle/index.html`

No bundler. `maplibre-gl@5.24.1` by script tag; `pmtiles@4.5.0` from jsDelivr `+esm`; an import map for `@cngeo/*` only. Basemap: the style the other examples use. `?case=` selects one scenario; `?bundle=` overrides the bundle URL. `#status` reads `ready: <case>` when the layer's `onViewportLoad` fires, or `error: <code> <message>`. `window.E12 = { map, overlay, setVisible(bool), moveBefore(layerId) }`.
Cases:
- `s2` — `COGLayer`, `https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/18/T/WL/2026/1/S2B_18TWL_20260101_0_L2A/TCI.tif`
- `naip`, `oam` — one `assets.image.href` / `assets.visual.href` each, taken with DuckDB from `https://data.source.coop/nthh/naip/stac/naip.parquet` and `https://data.source.coop/geospatialjeff/oam-portolan/oam-cc-by-4-0/items.parquet`; record both URLs in `RESULTS.md`.
- `mvt` — `MVTLayer` over `https://data.source.coop/portolan-mirrors/firms-catalog/detections/year=2020/fire-2020.pmtiles`, tiles fetched through `PMTiles.getZxy` as `~/repos/firms-catalog/apps/firms-explorer/deck.html` does.
- `stack` — `s2` and `mvt` together in one overlay.

- [ ] **Step 5: Write `verify.mjs`** (shape of `examples/s2-footprints/verify.mjs`; takes a port)

For each case: wait for `ready:`; screenshot the map clipped to the layer's screen bounds with the layer visible, then hidden; assert the two differ in more than 5% of pixels. Also:
- `s2` again with `?bundle=http://127.0.0.1:<port>/packages/maplibre/vendor/deck-stack.js` while the page is on `localhost` — a cross-origin bundle; must reach `ready:` (Review Focus 4).
- `stack`: `E12.moveBefore(<first symbol layer id>)` then `E12.moveBefore(undefined)`; assert a label pixel region differs between the two orders, and that no frame during the move is blank over the raster (poll screenshots across 500 ms).
- Print `deckSupport()` and the bundle's `VERSIONS`.
- Fail on any console error.

- [ ] **Step 6: Run it**

Run: `python3 serve.py 8123 & node experiments/e12-deck-bundle/verify.mjs 8123`
Expected: every case prints `PASS`. If interleaved reordering fails, record it and re-run the reorder check with `interleaved: false`; if `MapLibreOverlay` itself is the problem, swap the entry to `@deck.gl/mapbox` `MapboxOverlay` exported under the same name and record that.

- [ ] **Step 7: Write `RESULTS.md`**

Date; versions; raw and gzip bundle size; per-case pass/fail and time-to-ready; whether interleaved `beforeId` reordering is sound (this decides the Phase 1 `LayerManager` default); which overlay class shipped; `deckSupport()` in headless Chrome; whether the bundle build is byte-reproducible. One paragraph on the esm.sh import-map recipe as a host-only option — try it once with a five-minute budget and report what happened.

- [ ] **Step 8: Commit** — `feat(maplibre): prebuilt deck.gl + deck.gl-raster bundle (experiment E12)`

---

### Task 4: Gate B — evaluate `maplibre-gl-layer-control`

**Files:**
- Create: `experiments/e12-deck-bundle/layer-control.html`, `experiments/e12-deck-bundle/layer-control.verify.mjs`
- Modify: `experiments/e12-deck-bundle/RESULTS.md` (a "Gate B" section)

**Interfaces:**
- Produces: a recorded verdict, `adopt` or `build own`, that Phase 1's plan starts from.

- [ ] **Step 1: Write the page**

`maplibre-gl-layer-control@0.18.3` from jsDelivr `+esm`, MapLibre 5.24.1, the deck bundle, one PMTiles vector layer and the `s2` COG layer registered through the control's custom-layer adapter.

- [ ] **Step 2: Write the verifier**, one assertion per checklist row

| # | Requirement | Passes when |
|---|---|---|
| 1 | Loads with no build and no import-map entries of its own | page reaches `ready` with zero console errors |
| 2 | Add and remove a layer at runtime | a row appears and disappears without recreating the control |
| 3 | deck layers | toggling the COG row hides and shows the raster (screenshot diff) |
| 4 | Opacity for both kinds | slider changes the vector layer's paint opacity and the deck layer's `opacity` prop |
| 5 | Reorder | a public method or event lets the host change order and see it reflected in the list |
| 6 | Theming | redeclaring `--cng-*`-equivalent variables or a class changes its colours; it respects dark mode |
| 7 | Keyboard | every action reachable by Tab/Space/arrow keys, with visible focus |

- [ ] **Step 3: Run it and record the verdict**

Run: `node experiments/e12-deck-bundle/layer-control.verify.mjs 8123`
Rule: **adopt only if all seven pass.** Otherwise the verdict is `build own`, and `RESULTS.md` lists which rows failed and which ideas are worth borrowing.

- [ ] **Step 4: Commit** — `docs(e12): layer-control evaluation`

---

### Task 5: Gate C — measure imagery search cost

**Files:**
- Create: `experiments/e14-search-cost/{measure.mjs,RESULTS.md}`

**Interfaces:**
- Produces: measured numbers Phase 2's plan sizes the footer cache, streaming and asset resolution against.

- [ ] **Step 1: Write `measure.mjs`** (Node; inject hyparquet as AGENTS.md §Setup shows)

For each of Sentinel-2 (`…/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json`, resolved), NAIP and OpenAerialMap (hand-written `{ kind:'parquet', url }` descriptors, since resolution does not support them yet), over a city-sized area and a one-month window with columns `id` + time + one property:
- time `resolveDataset`, `estimate` twice, engine `plan`, engine `run`; record files, row groups before/after, requests, read bytes, rows;
- from the footer, report whether column chunks carry `offset_index_offset` (decides the single-row `assets` read);
- report the `assets` column's physical type and its compressed bytes per row group.

- [ ] **Step 2: Run it three times and write `RESULTS.md`**

Run: `node experiments/e14-search-cost/measure.mjs`
Record medians in one table per dataset, the date, and three conclusions stated plainly: what a footer cache saves per search, whether a single-row `assets` read is possible on each dataset, and the first-search time a user will see. Reference point already measured on 2026-11-25 for Sentinel-2: 825 → 21 row groups, 35 requests, 5.2 MB, about 6 s planning and 3.4 s reading.

- [ ] **Step 3: Commit** — `docs(e14): imagery search cost measurements`
