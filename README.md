# Cloud-native map widgets

Composable browser widgets for finding an area and acting on it:

- **Search a place** — type "contra costa", get its boundary, in about a
  millisecond warm. Over a *published cloud-native gazetteer*: a names index
  parquet plus a small JSON manifest, sitting on object storage.
- **Or bring your own area** — drag in a GeoJSON file and get the identical
  object, repairs reported.
- **Then download a dataset clipped to it** — any GeoParquet table, STAC
  item collection or hive-partitioned catalog, filtered in the browser, with a
  real pre-download estimate and a ceiling you have to explicitly override.

**Pure static. No API, no server, no build step.** Everything runs in the
browser against object storage over HTTP range requests. The packages are plain
ESM with JSDoc; an import map is the entire setup.

The seam that makes this composable is one plain JSON object, the
[`Area`](packages/spec/README.md#the-area). The geocoder emits one, the upload
widget emits one, a map draw tool could emit one, and the download widget
consumes one. Nothing else couples.

> **Status: experimental.** Nothing is published to npm yet. The APIs work and
> are verified against live data, but they are not frozen, and this is a
> research repo graduating toward a public widgets library. See
> [Status](#status) and [Known issues](#known-issues) before depending on it.

---

## 30-second quickstart

A whole geocoder on a map, in one file. Nothing to install, nothing to build.
This is [`examples/quickstart/index.html`](examples/quickstart/index.html)
verbatim — clone the repo, run `python3 serve.py`, and open
`http://localhost:8000/examples/quickstart/index.html`.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" />
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>

<!-- Plain ESM, no bundler. Nothing is on npm yet, so these point at this
     repo's own packages/. When they publish, this block is the only thing
     that changes: swap each line for
     https://cdn.jsdelivr.net/npm/@cnmw/<name>@0.1.0/src/index.js -->
<script type="importmap">
{
  "imports": {
    "@cnmw/spec": "../../packages/spec/src/index.js",
    "@cnmw/geocoder-core": "../../packages/geocoder-core/src/index.js",
    "@cnmw/maplibre": "../../packages/maplibre/src/index.js"
  }
}
</script>
<style>html, body { margin: 0; height: 100%; } #map { position: absolute; inset: 0; }</style>
</head>
<body>
<div id="map"></div>
<script type="module">
import { Geocoder } from '@cnmw/geocoder-core';
import { GeocoderControl } from '@cnmw/maplibre';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [10, 25],
  zoom: 2,
});

// The live, published geoBoundaries gazetteer: 52,398 named admin units
// across ADM0/1/2, CC-BY-4.0. Static files on object storage -- there is
// no API and no server anywhere in this page.
const geocoder = new Geocoder({
  indexUrl: 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json',
  limit: 8,
  // Show the small pre-simplified outline immediately, then upgrade the
  // filter geometry from the full-resolution file in the background.
  geometry: { resolution: 'both' },
});

geocoder.on('select', ({ result, area }) => {
  console.log(result.name, area.bbox, area.vertexCount.display);
  // `area` is now ready to hand to @cnmw/download-core.
});

// The control owns the combobox, the outline layer, fitBounds and the
// attribution line. The index is fetched lazily on first focus.
const control = new GeocoderControl({ geocoder, placeholder: 'Search for a place…' });
map.on('load', () => map.addControl(control, 'top-left'));
</script>
</body>
</html>
```

Measured on this exact file against the live catalog: first focus → usable
index in **5.3 s** (3.9 MB, full-load), warm keystroke **~1 ms**, "contra
costa" → a drawn ADM2 outline in **~2.7 s**. Driven on every check by
[`examples/quickstart/verify.mjs`](examples/quickstart/verify.mjs).

The 5.3 s cold load does **not** meet the design's 1 s budget; see
[Known issues](#known-issues).

**Why `serve.py` and not `python3 -m http.server`:** the latter answers HTTP
`Range` requests with the whole file and a 200, which silently turns every
range read into a full download. `serve.py` implements real partial content.
`npx serve` works too.

---

## Architecture

```
    PUBLISHED DATA (static files on object storage, versioned, licensed)
    ┌──────────────────────────────────────────────────────────────────┐
    │  cloud-native gazetteer = names index parquet + index.json       │
    │                           + per-level boundary files             │
    │                                                                  │
    │  geoboundaries-catalog      52,398 names, ADM0/1/2, CC-BY-4.0    │
    │  cn-gazetteer-overture      5.6M names, 5 levels, ODbL-1.0       │
    └───────────────────────────────┬──────────────────────────────────┘
                                    │  HTTP range reads, no server
    THE WIDGETS (plain ESM, zero build)
    ┌───────────────────────────────▼──────────────────────────────────┐
    │  @cnmw/geocoder-core    @cnmw/upload-core    (a draw tool)       │
    │  names index → ranked   GeoJSON file →       map draw →          │
    │  results → geometry     repair →                                 │
    │          │                      │                    │           │
    │          └──────────►  A r e a  ◄────────────────────┘           │
    │                           │        ← the only coupling           │
    │                           ▼                                      │
    │               @cnmw/download-core    ◄── DatasetDescriptor       │
    │               resolve / prune /          + FilterSpec            │
    │               estimate / download        (plain JSON, also the   │
    │                           │               QGIS-shared artifact)  │
    │           ┌───────────────┼───────────────┐                      │
    │           ▼               ▼               ▼                      │
    │      geojson writer  geoparquet     format plugins               │
    │        (in core)      (in core)     (lazy, weight shown)         │
    │                                                                  │
    │  @cnmw/spec   the Area + error taxonomy + pure geo helpers       │
    │  @cnmw/maplibre · @cnmw/openlayers   thin UI adapters            │
    └───────────────────────────────┬──────────────────────────────────┘
                                    │
    CONSUMING APPS
    ┌───────────────────────────────▼──────────────────────────────────┐
    │  a custom page (examples/)   portolan-browser (Vue widget hook)  │
    │  a future stac-browser widget     a QGIS plugin (shares the      │
    │                                    JSON contracts, not the code) │
    └──────────────────────────────────────────────────────────────────┘
```

Three ideas carry the design:

1. **The data products are the product.** A gazetteer is a published,
   versioned, licensed catalog with a documented file layout — not an
   implementation detail of a widget. The widgets read a contract
   ([design doc §6](docs/design/widgets-architecture.md#6-index-file-interface)),
   so a new gazetteer needs no code change. Naming follows that split: the
   **data** is a *cloud-native gazetteer*, the **client widget** keeps
   *geocoder* naming, because that is the word developers search for.
2. **Contracts are JSON, not code.** `Area`, `DatasetDescriptor`, `FilterSpec`
   and `OutputRequest` are plain serializable documents. A `DownloadRequest` can
   be pasted into a web app, a notebook, or the Python QGIS plugin and produce
   the same rows. That is the test that proves the spec is real.
3. **Nothing heavy is implicit.** hyparquet is the only engine in core
   (DuckDB-WASM would be 3–9 MB, 15–45× the whole widget). Heavy formats
   register themselves with their weight declared up front and only load if
   selected.

---

## Packages

| package | what it does | size (gz, comments stripped) |
|---|---|---|
| [`@cnmw/spec`](packages/spec/README.md) | The `Area` contract, the `CnmwError` taxonomy, and pure helpers: bbox + antimeridian split, Visvalingam simplify (sync + chunked async), WKB → GeoJSON, name normalization. **No I/O, no dependencies.** | 6.2 KiB |
| [`@cnmw/geocoder-core`](packages/geocoder-core/README.md) | Manifest + index load (full or HTTP-range), prefix search, ranking with result diversity, geometry resolution → `Area`. No DOM. | 11.0 KiB |
| [`@cnmw/upload-core`](packages/upload-core/README.md) | GeoJSON file/drop/paste → the same `Area`, with every repair reported. | 4.3 KiB |
| [`@cnmw/download-core`](packages/download-core/README.md) | Collection resolution, the metadata-only pruning cascade, estimates with a ceiling, streaming sinks, `geojson` + `geoparquet` writers. | 19.8 KiB |
| [`@cnmw/maplibre`](packages/maplibre/README.md) | MapLibre adapter: search combobox control, `Area` outline layer, viewport provider, antimeridian-aware fitBounds. | 4.3 KiB |
| [`@cnmw/openlayers`](packages/openlayers/README.md) | The same five things in OpenLayers, plus the EPSG:4326 ⇄ view-projection bridge. | 5.1 KiB |

Sizes are `cat src/*.js | gzip -9` with comments stripped — the honest stand-in
for the minified build that does not exist yet. Every package is inside its
[design-doc §4.5 budget](docs/design/widgets-architecture.md#45-bundle-weight-budget).
Add `hyparquet` (46.9 KiB gz) and `hyparquet-compressors` (69.1 KiB as
fetched) for anything that reads parquet.

Other directories under `packages/` are work in flight; each gets a row here
once it has a README.

## Examples

Six working demos, every one driven by a Playwright script against live data.
Open [`examples/index.html`](examples/index.html) for the gallery with
screenshots and readable source.

| demo | what it shows |
|---|---|
| [`quickstart`](examples/quickstart/) | The whole library in one file — the snippet above. |
| [`geocoder-demo`](examples/geocoder-demo/) | All three admin levels, progressive `select({ resolution: 'both' })`, and `?index=overture` to swap in the 5.6M-name multilingual gazetteer. |
| [`upload-demo`](examples/upload-demo/) | The composability seam on OpenLayers: a searched area and a dropped GeoJSON produce the same `Area`. Fiji exercises the antimeridian split and the projection bridge. |
| [`download-demo`](examples/download-demo/) | Search → estimate → download, three real remote datasets, both writers, the ceiling refusal, cancel. |
| [`firms-explorer`](examples/firms-explorer/) | NASA FIRMS: 632M rows across 27 `year=` partitions, resolved from the collection JSON, with the pruning cascade narrated stage by stage. |
| [`s2-footprints`](examples/s2-footprints/) | "Type a country, download every Sentinel-2 footprint over it." 30M STAC-GeoParquet rows, the ceiling path, default column projection. |

## The gazetteers

Two live catalogs, both published as Portolan catalogs on
[Source Cooperative](https://source.coop/):

| | geoBoundaries | Overture |
|---|---|---|
| manifest | [`geoboundaries-catalog/names/index.json`](https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json) | [`cn-gazetteer-overture/names/index.json`](https://data.source.coop/portolan-mirrors/cn-gazetteer-overture/names/index.json) |
| names | 52,398 | 5,604,413 (3.57M primary + 2.03M alternate-language) |
| levels | ADM0–2 | country/dependency, region, county, localadmin, locality |
| index size | 3.9 MB (full-load) | 409 MB (range path) + an 8.6 MB eager "prominent" subset |
| multilingual | no | yes |
| **license** | **CC-BY-4.0** — clean | **ODbL-1.0, share-alike** + CC-BY components |

geoBoundaries is the default because its license is the cleanest. The Overture
catalog is an opt-in sibling with share-alike obligations that the widget
surfaces: every manifest carries an `attribution` array, it lands on
`Area.provenance.attribution`, and the adapters render it. `estimate()` raises
a `share-alike` warning when downloaded output inherits one.

Adding a gazetteer is a data task, not a code task: satisfy
[design doc §6](docs/design/widgets-architecture.md#6-index-file-interface) and
pass its URL as `indexUrl`.

---

## For AI agents

[**AGENTS.md**](AGENTS.md) is written for you: terse, complete, verified
recipes — instantiate a geocoder against a live catalog, consume an `Area`,
build a `DownloadRequest` for each dataset kind, run a download with
estimate/ceiling handling, the manifest contract, and the pitfalls that cause
silent wrong answers. Every snippet in it is executed by
`node docs/verify-snippets.mjs`.

## Documentation

| | |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Recipes for agents and anyone in a hurry. |
| [`docs/design/widgets-architecture.md`](docs/design/widgets-architecture.md) | **The normative API design**, ~3,000 lines, with dated amendments. If a README and this disagree, the README describes what the code does and the design doc describes what it should do. |
| [`PLAN.md`](PLAN.md) | The experiment plan, data-source decisions, and current status. |
| [`experiments/*/RESULTS.md`](experiments/) | The measurements behind the design calls: data recon, the search-index benchmark, the ADM3/4 licensing survey. |
| each package's `README.md` | API reference generated from the actual exports, with per-package gotchas. |

## Development

```bash
npm install                  # npm workspaces; nothing to build
npm test                     # node --test across every package
python3 serve.py             # a static server WITH working Range support, port 8000
node docs/verify-snippets.mjs   # executes every snippet in every README + AGENTS.md
```

Then, with the server running:

```bash
node examples/quickstart/verify.mjs 8000       # the README quickstart, live
node examples/geocoder-demo/verify-live.mjs 8000
node examples/download-demo/verify.mjs 8000
node examples/firms-explorer/verify.mjs 8000
node examples/s2-footprints/verify.mjs 8000
node examples/upload-demo/verify.mjs 8000
```

Those hit the real published catalogs. There are no fixtures and no mocks in
the example verifiers: if they pass, the thing works against live data.

**Rules the source obeys**, because each one is a way to silently break
zero-build consumption (design doc §4.4):

1. No Node builtins, no `process`, no `Buffer`, no `__dirname`.
2. **No dynamic `import()` of a bare specifier** — it throws without a bundler
   or an import map. Heavy features are *registered*; a plugin's own `load()`
   imports an exact pinned absolute CDN URL.
3. No top-level `await` in core packages.
4. No CSS imports, no JSON import assertions. Adapters inline their (tiny) CSS
   as a string.
5. Named exports only, no default exports. Every package exports `VERSION`.
6. `fetch` always goes through an injected `options.fetch`, and every range
   read passes `cache: 'no-store'` — Chrome serializes concurrent reads of one
   URL behind its cache lock (2.1 s → 0.4 s for the same eight reads,
   measured).

---

## Status

Verified working, against live published data, as of 2026-11-12:

- **`@cnmw/spec`** — `Area` build/validate/round-trip, antimeridian split,
  sync and async simplification, WKB decode.
- **`@cnmw/geocoder-core`** — full-load and range index paths, ranking with
  dedupe and viewport boost, `select()` at ADM0/1/2 including the
  `geometry_ref` fast path and the ADM0 join-on-country special case,
  progressive display→full upgrade, two-wave search against a
  `prominent_index`.
- **`@cnmw/upload-core`** — GeoJSON read, the full repair pipeline,
  multi-feature collect, every refusal path.
- **`@cnmw/download-core`** — single-file, hive-partitioned and
  STAC-GeoParquet sources resolved from collection JSON; the pruning cascade
  (27 FIRMS files → 1 on a time filter); estimates; the ceiling refusal and
  `acceptCeiling()`; GeoJSON and GeoParquet output with a GeoParquet 1.1
  covering; real downloads from FTW, FIRMS and Sentinel-2.
- **`@cnmw/maplibre` / `@cnmw/openlayers`** — the combobox control, outline
  layer with a filter-geometry ghost, antimeridian fit, and (OpenLayers) the
  4326 ⇄ 3857 bridge.

Not built: exact `clip`, GeoPackage in core, a DuckDB engine, multi-source
search, the published JSON Schemas, and any build step at all (no
`dist/`, no minification, no `.d.ts`). Each is a documented default in
[design doc §7](docs/design/widgets-architecture.md#7-open-items).

### Known issues

Honest list, all measured:

| | |
|---|---|
| **Cold index load is ~5 s, not the 1 s budget.** | 3.9 MB over the public path, plus hyparquet's 27-file module waterfall. Fixes, in order of value: a prebundled hyparquet, a `prominent_index` on the geoBoundaries catalog, and the range path for a cold first keystroke. Warm keystrokes are ~1 ms. |
| **Attribution keys are inconsistent.** | A geocoder `Area` carries the manifest's `snake_case` (`share_alike`); a download descriptor's derived attribution uses `shareAlike`. Read `a.shareAlike ?? a.share_alike`. **This matters for ODbL data** — checking only `shareAlike` silently reports no obligation. Needs one normalization in `@cnmw/spec`. |
| **A `blocked` download handle's `result` never settles on its own.** | The design doc says it rejects with `CeilingExceededError`; it waits. Call `acceptCeiling()` or `cancel()`. Never `await handle.result` without inspecting `handle.estimate` first. |
| **Cancelling during planning reports `NETWORK`, not `CANCELLED`.** | The abort hits the in-flight footer fetch and is wrapped as a network error, so `state` lands on `'failed'`. Cancelling a running download is correct. |
| **`geometryRef.row` is a `BigInt`,** so `JSON.stringify(searchResult)` throws. | Parquet `INT64`. Strip or stringify it when persisting results. |
| **Version-skew checking is inert** against the live catalogs. | They publish no `cnmw:catalog_version` footer key, so the check reads `null` and no-ops rather than erroring. Identity is still safe: resolution always re-locates rows by key, never by a cached offset. |
| **`maxConcurrentRequests` is accepted and ignored.** | Row groups are read sequentially. The s2 footprints estimate planned 838 requests for one query; parallelism is the main remaining performance lever. |
| **`indexUrl` must be a string.** | The designed multi-source array form is unimplemented and silently falls back to the (relative, development) `DEFAULT_INDEX_URL`. |
| **`DEFAULT_INDEX_URL` is `'./data/index.json'`,** a local development path. | Always pass `indexUrl` explicitly. |
| **GeoParquet output cannot write zstd.** | `hyparquet-compressors` is decompress-only. Refused with `FORMAT_CAPABILITY` rather than silently downgraded. Default is snappy. |
| **The provisional local index is gitignored.** | `.gitignore`'s `data/` rule excludes `examples/geocoder-demo/data/`. Every demo therefore defaults to the live catalog; `?index=local` needs a local rebuild via that directory's `build-data.sql`. |

---

## Licensing

**Code: MIT.** See [`LICENSE`](LICENSE); every package carries a copy.

> ⚠️ MIT is a **placeholder pending Chris's confirmation.** It is the obvious
> choice for a widget library meant to be embedded anywhere, including in
> commercial products, and it matches the permissive posture of the rest of the
> stack. If the intent is Apache-2.0 (patent grant, more common for
> foundation-adjacent geospatial work) or BSD-3-Clause, say so and this is a
> one-line change in seven files.

**Data: per catalog, and not ours to relicense.** The widgets never bundle
data; they read a published catalog whose manifest declares its own license and
attribution:

- **geoBoundaries CGAZ** — CC-BY-4.0. Attribution required, no share-alike.
  This is the default index for exactly that reason.
- **Overture divisions** — ODbL-1.0, **share-alike**, plus CC-BY-4.0
  components (geoBoundaries, Esri Community Maps, LINZ). Using it means
  inheriting share-alike on derived output.

The machinery for this is first-class rather than advisory: every manifest's
`attribution` array lands on `Area.provenance.attribution`, the adapters render
it under the search box by default (`showAttribution: false` to opt out),
`estimate()` raises a `share-alike` warning, and `DownloadResult.attribution`
carries it to whatever writes the file. A page that uses the Overture gazetteer
and hides the attribution line is out of compliance, and nothing here will stop
you — but everything here tells you.

**Third-party code** loaded at runtime from a CDN:
[hyparquet](https://github.com/hyparam/hyparquet) (MIT),
[hyparquet-compressors](https://github.com/hyparam/hyparquet-compressors) (MIT),
[hyparquet-writer](https://github.com/hyparam/hyparquet-writer) (MIT).
Peer dependencies: [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause),
[OpenLayers](https://openlayers.org/) (BSD-2-Clause).
