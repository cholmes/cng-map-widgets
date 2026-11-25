# E12 — deck.gl + deck.gl-raster on a no-build page

**Date:** 2026-11-25
**Question:** can the map widgets draw rasters with Development Seed's
deck.gl-raster, interleaved into MapLibre, without making consumers run a
build?
**Verdict: yes, from one prebuilt, committed bundle.** All six checks pass
against live data. The alternative (per-package CDN modules joined by an
import map) did not work in the one short attempt it was given; that is
"not established", not "impossible" — see the section on it below.

Gate A of [`docs/superpowers/specs/2026-11-25-map-widgets-design.md`](../../docs/superpowers/specs/2026-11-25-map-widgets-design.md).

## What was built

`tools/build-deck-bundle.mjs` (esbuild 0.28.2) turns
`packages/maplibre/vendor/deck-entry.js` into
`packages/maplibre/vendor/deck-stack.js`, loaded lazily by
`packages/maplibre/src/deck-loader.js`.

| | |
|---|---|
| deck.gl / luma.gl | 9.4.2 / 9.4.2 |
| deck.gl-raster, deck.gl-geotiff, geotiff | 0.10.0 |
| @loaders.gl/mvt | 4.5.5 |
| proj4 | 2.22.0 |
| Bundle size | **1,495,266 bytes raw, 446,204 bytes gzip -9** |
| Packages in the bundle | 49, listed with licence texts in `deck-stack.js.NOTICES.txt` (58 KB) |
| Reproducible | on this machine: `--check` rebuilds all three outputs to the same SHA-256 (bundle `d0e7a002e25e…`). Not yet shown across machines or Node versions |
| Copies of `@deck.gl/core` / `@luma.gl/core` | one each (`npm ls`; one module graph in, one file out). There is no runtime assertion of this yet |

The gzip size is 41% below the 760 KB the pre-research estimated for the
same stack loaded package-by-package: esbuild drops the parts of
`@deck.gl/geo-layers` nothing imports (h3, a5, 3D Tiles, terrain, WMS).

Two upstream lines are rewritten at build time. The build fails if a rewrite
does not land, checked three ways: the exact line must occur once in the
file; each rewrite must have run exactly once per build (so an upstream file
that is renamed or moved, and would silently never match, is caught); and
the finished bundle must contain the pinned wasm URL and a Blob URL, and
must not mention `./worker.js`.

1. **The COG decode worker.** `defaultDecoderPool()` starts
   `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`.
   In one file that URL points at nothing, and a real file would still be
   refused when the bundle is cross-origin. The worker is bundled to a
   string and started from a Blob URL. It is an ES-module worker, not a
   classic one: the LZW decoder initialises its wasm with top-level await.
2. **The LERC codec** looks for `lerc-wasm.wasm` beside its own module. It is
   pointed at `https://cdn.jsdelivr.net/npm/lerc@4.3.0/lerc-wasm.wasm`.
   **Not exercised by any check below** (none of the three test COGs is LERC).

### What the bundle reaches over the network at runtime

Three third-party hosts, found by listing the URLs in the built file. An
earlier version of this document named only the first; a code review caught
the other two.

| host | when | consequence |
|---|---|---|
| `cdn.jsdelivr.net` (`lerc-wasm.wasm`) | a LERC-compressed COG | LERC COGs fail offline or under a strict CSP |
| **`epsg.io`** (`/<code>.json`) | a COG whose CRS proj4 does not ship. proj4 ships 4326, 4269, 3857 and WGS84 UTM only. **NAIP is EPSG:26910 (NAD83 UTM), so the `naip` check, the cross-origin check and Gate B all made this request** | every NAIP scene would call a service nobody chose, and fail without it |
| `unpkg.com` (`@loaders.gl/…/mvt-worker.js`) | `MVTLoader` with its default `worker: true` | avoided on these pages only because they pass `worker: false` |

**What this requires of later phases:**
- Phase 2 passes a local `epsgResolver` (or registers definitions on the
  exported `proj4`) for the CRS families imagery uses, NAD83 UTM included, so
  epsg.io is a last resort and not the normal path.
- Every `MVTLayer` a widget creates passes `loadOptions: { worker: false }`.
- The decode worker has **no fallback**: `DecoderPool` rejects every decode
  once its workers have all failed. So on a page whose CSP lacks
  `worker-src blob:`, or a browser without module workers from Blob URLs
  (Safari before 15, Firefox before 114), **no COG draws at all**. Phase 2
  either detects that and passes `pool: new DecoderPool({})` (decode on the
  main thread), or states it as a hard requirement.

## What was measured against

Three 8-bit COGs, one per imagery collection the widgets target, all in a
UTM zone (so every one exercises reprojection), read straight from object
storage; and one PMTiles chunk.

| case | source | CRS |
|---|---|---|
| `s2` | `sentinel-cogs.s3.us-west-2.amazonaws.com/…/18/T/WL/2026/1/S2B_18TWL_20260101_0_L2A/TCI.tif` | UTM 18N |
| `naip` | `data.source.coop/nthh/naip/ca/2024/60cm/rgb/37122/m_3712213_se_10_060_20240520.tif` | EPSG:26910 |
| `oam` | `oin-hotosm-temp.s3.us-east-1.amazonaws.com/u-589a8fa42c5435ad/94dff54c-2dbc-4c50-b68d-7223a0a6a4a9/cog-odm_orthophoto.tif` | EPSG:32614 |
| `mvt` | `data.source.coop/portolan-mirrors/firms-catalog/detections/year=2020/fire-2020.pmtiles` | — |

The NAIP and OpenAerialMap URLs came from the collections' own item tables
(`…/nthh/naip/stac/naip.parquet`, `…/oam-portolan/oam-cc-by-4-0/items.parquet`).

## Results

`node experiments/e12-deck-bundle/verify.mjs 8123`, headless Chromium
(Playwright 1.65.0), MapLibre GL 5.24.1 by script tag, `MapLibreOverlay` in
interleaved mode. A layer "draws" when hiding it changes more than 5% of a
64×64 sample taken inside its own bounds — a stronger claim than "no error",
because this stack's known failures are silent blank layers.

| check | result | time to ready | evidence |
|---|---|---|---|
| Sentinel-2 TCI | **pass** | 3.8 s | 93.6% of pixels change when hidden |
| NAIP quad | **pass** | 2.8 s | 99.2% |
| OpenAerialMap scene | **pass** | 2.5 s | 98.8% |
| FIRMS PMTiles through `MVTLayer` | **pass** | 4.6 s | 100% |
| Bundle served from another origin (`127.0.0.1` vs `localhost`) | **pass** | 2.7 s | 99.2%; decode worker started |
| Raster + vector tiles in one overlay, re-slotted with `beforeId` | **pass** | 5.9 s | see below |

Zero console errors in every case. Times include page load, the bundle, the
basemap style and the first tiles, on a home connection; they are not a
benchmark.

**Reordering is sound.** With the Sentinel-2 raster above everything and
then moved under the basemap's first symbol layer, 4.39% of the sampled
pixels change (the labels reappear over the image). Sampling every animation
frame for 600 ms while the raster is re-slotted (20 frames), the least-drawn
frame still differed from "hidden" by 93.7%: **no blank frame**.
So Phase 1's `LayerManager` defaults to interleaved mode with `beforeId`.

**`@deck.gl/maplibre`'s `MapLibreOverlay` works** with MapLibre 5.24.1. The
`@deck.gl/mapbox` fallback was not needed.

**`deckSupport()` in headless Chromium:** `{ webgl2: true, norm16: false }`.
As expected, `EXT_texture_norm16` is missing, so 16-bit band composites
(Sentinel-2 reflectance) cannot be checked in CI. Everything above is 8-bit.
**16-bit rendering is untested here** and needs a real GPU.

## The import-map alternative: not established

`importmap.html` loads the same packages from esm.sh, each with an identical
`?external=` list so that siblings stay bare specifiers for the page's import
map to resolve. One attempt, as planned:

```
Failed to resolve module specifier
"@luma.gl/shadertools/dist/lib/shader-assembly/wgsl-interface-scan".
```

A deck.gl package deep-imports a luma.gl subpath the import map does not
cover. A host could add trailing-slash mappings and keep going, but that is
the point: the recipe lives in the consumer's page, has to track upstream's
internal file layout, and cannot be shipped inside a package. It was not
pursued further. A host that wants its own deck.gl should bundle it and call
`setDeckModules()`.

## What this does not show

- That what drew was correct imagery. "Draws" means the layer's pixels
  differ from the basemap; a uniformly black layer would pass. The
  Sentinel-2 result was also checked by eye; NAIP and OpenAerialMap were not.
- A tile error arriving after a page first reports ready.
- LERC-compressed COGs (the wasm URL rewrite is untested).
- 16-bit and multi-file band composites (`MultiCOGLayer`), which need
  `EXT_texture_norm16`.
- Memory behaviour over a long session, or texture clean-up on layer removal.
- Safari and Firefox. Module workers from Blob URLs need Safari 15+ and
  Firefox 114+.
- MapLibre GL 6 (ES-module only; the page uses 5.24.1's script build).

## Gate B — is `maplibre-gl-layer-control` a fit for the layer manager?

**Date:** 2026-11-25. `maplibre-gl-layer-control@0.18.3` (opengeos, MIT),
loaded from jsDelivr as published, on `layer-control.html` with one MapLibre
style layer and one deck.gl `COGLayer` registered through the control's
`CustomLayerAdapter`. Run: `node experiments/e12-deck-bundle/layer-control.verify.mjs 8123`.

| # | requirement | result | evidence |
|---|---|---|---|
| 1 | Loads with no build and no import-map entries | **pass** | page ready, 0 console errors; the published ESM has no bare imports |
| 2 | Add and remove a layer at runtime | **pass** | a deck layer (via the adapter's `onLayerChange`) and a style layer both appear and disappear as rows |
| 3 | deck.gl layers toggle | **pass** | the row's checkbox calls `adapter.setVisibility(false)`; 100% of the raster's pixels change |
| 4 | Opacity for both kinds | **pass** | slider sets the deck layer's `opacity` to 0.3 and the style layer's `fill-opacity` to 0.2 |
| 5 | Reorder, reported to the host | **pass** | dragging a row reorders the list and fires `onLayerReorder(["user-poly","cog-naip"])`. Only this direction was tested: whether an order the *host* sets is reflected back in the list was not |
| 6 | Theming with CSS variables, and dark mode | **fail** | its stylesheet uses 0 CSS custom properties and has 0 `prefers-color-scheme` rules; the panel is `rgb(255,255,255)` in both light and dark |
| 7 | Keyboard access to every action | **fail** | Space toggles and arrow keys change opacity; the focused checkbox shows a focus outline; the slider has an accessible name (its `title`). But the checkbox has no accessible name, the drag handle cannot take focus, and although the context menu *opens* from the keyboard, none of its items (Rename, Zoom to Layer, Move Up, Move to Top, …) can take focus or carries a role — so remove, move, rename and zoom are mouse-only |

**Verdict under the plan's rule ("adopt only if all seven pass"): build own.**

That rule was written before the measurement, and the result is closer than
the rule anticipated, so both readings are recorded for Chris to choose:

- **What it already does that we would otherwise write:** the deck.gl adapter
  seam, runtime add/remove, drag-and-drop reorder, per-layer opacity, groups,
  zoom-to-bounds, a right-click menu with remove and move, a paint-property
  style editor, and grouping the basemap's layers under one "Background" row.
- **What adopting it would still need from us:**
  - an override stylesheet mapping its classes onto the `--cng-*` tokens, with
    a dark variant (it exposes no variables, so this tracks its class names);
  - keyboard operation of its whole context menu (focusable items, roles,
    arrow/Enter/Escape handling), a name for the checkbox, and a keyboard
    path for reordering — as a shim over its DOM, or sent upstream. This is
    the larger of the two gaps: it is behaviour, not styling;
  - applying the reported order to deck layers ourselves: deck layers are not
    in the MapLibre style, so `onLayerReorder` is only a notification and the
    host must translate it into `beforeId` (the `LayerManager` does this either way);
  - an "Add layer" entry point, which it does not have.
- **Risks of adopting:** the override stylesheet and the shim both depend on
  its internal DOM, which can change in any release. (The pre-research also
  reported one maintainer and 30.6 KB gzip; neither was re-measured here, and
  its groups feature was not exercised.)

Either way the `LayerManager` (the ordered stack and its two executors) is
ours; the question is only whether the panel that drives it is this control
or a small one of our own.

**Decision (Chris, 2026-11-25): adopt it, with a wrapper.** Phase 1 uses
`maplibre-gl-layer-control` and adds an override stylesheet (the `--cng-*`
tokens and dark mode) and a keyboard shim for its context menu and
reordering, and offers both fixes upstream. This sets aside the plan's
all-seven rule on purpose: the five functional requirements pass, and the two
gaps are ones a wrapper can close.
