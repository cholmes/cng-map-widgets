# AGENTS.md — wiring up `@cngeo/*`

For AI agents and anyone who wants the facts without the prose. Every snippet
here is executed against live published data by
[`docs/verify-snippets.mjs`](docs/verify-snippets.mjs)
(`node docs/verify-snippets.mjs agents widgets`). If you change a snippet,
change it there too. The few lines that need a browser — a control on a map —
say which Playwright script covers them.

Prose version: [README.md](README.md). Normative API design:
[`docs/design/widgets-architecture.md`](docs/design/widgets-architecture.md).
When the two disagree, **the code is what the per-package READMEs describe**
and the design doc is what it should be.

---

## Mental model in five lines

**Scope note:** this is place-name/boundary lookup, not address geocoding.
Queries are place names; results are boundaries. No street addresses, ever.

1. A **cloud-native gazetteer** is published static data: a names-index parquet
   + an `index.json` manifest + per-level boundary parquets, on object storage.
2. `@cngeo/geocoder-core` reads it over HTTP range requests and emits an
   **`Area`**.
3. `@cngeo/upload-core` emits the same `Area` from a GeoJSON file.
4. `@cngeo/extract-core` consumes an `Area` + a `DatasetDescriptor` +
   a `FilterSpec` and writes a file.
5. There is **no server and no build step**. An import map is the setup.

And, since 0.4.0, for **showing** data rather than extracting it:

6. A **`LayerSpec`** (`cng-layer/1.0`) is plain JSON that says how to draw
   one thing. `@cngeo/stac` makes them from STAC — a collection, a scene
   found by an imagery search, a result of a catalog search — and
   `@cngeo/maplibre`'s `LayerManager` draws them, in one ordered stack.
7. A **timeline** is one such layer whose data is published as **chunks**,
   files that each cover a span of time. `@cngeo/timeline` decides which
   chunks a view needs; a chunk *format* reads them.

Live catalogs you can use right now:

```
GB  https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json
    52,398 names, ADM0/1/2, CC-BY-4.0, 3.9 MB index (full-load)
OV  https://data.source.coop/portolan-mirrors/cn-gazetteer-overture/names/index.json
    5,604,021 names, 5 levels, multilingual, ODbL-1.0 SHARE-ALIKE, 409 MB index
    (range path) + a 12.9 MB eager "prominent" subset
```

---

## Setup

### In a browser (the normal case)

```html
<script type="importmap">
{
  "imports": {
    "@cngeo/spec":            "/packages/spec/src/index.js",
    "@cngeo/geocoder-core":   "/packages/geocoder-core/src/index.js",
    "@cngeo/upload-core":     "/packages/upload-core/src/index.js",
    "@cngeo/extract-core":   "/packages/extract-core/src/index.js",
    "@cngeo/stac":            "/packages/stac/src/index.js",
    "@cngeo/timeline":        "/packages/timeline/src/index.js",
    "@cngeo/maplibre":        "/packages/maplibre/src/index.js"
  }
}
</script>
```

Which lines a page needs. `@cngeo/maplibre` imports only `@cngeo/spec` when
it loads: the search controls are *handed* a `@cngeo/stac` object you made,
so `stac` is a line only on a page that imports it — and it brings
`@cngeo/extract-core` with it. `@cngeo/timeline` is loaded by
`@cngeo/maplibre` itself, the first time a timeline layer is added: a page
with no timeline can leave its line out, and a page with one that leaves it
out fails then, not at load.

deck.gl, PMTiles, the layer panel and MiniSearch are **not** import-map
lines: like hyparquet, each loads from a pinned URL the first time it is
needed (deck.gl from a bundle shipped inside `@cngeo/maplibre`).

Do **not** add `hyparquet` to that map. The packages `import()` it themselves
from pinned absolute CDN URLs (`src/cdn.js` in each). Nothing is on npm yet;
when it is, each line becomes
`https://cdn.jsdelivr.net/npm/@cngeo/<name>@0.4.0/src/index.js` and no module
code changes.

**Without a clone**, swap the relative paths for the published site — the
packages are static files, so this works from any page anywhere:

```
https://cholmes.github.io/cng-map-widgets/packages/<name>/src/index.js
```

or, pinned to a tag,

```
https://cdn.jsdelivr.net/gh/cholmes/cng-map-widgets@v0.4.0/packages/<name>/src/index.js
```

Either way, **map every package you need transitively**, not just the ones
you `import` by name: these packages cross-import each other by bare
specifier (`@cngeo/spec` above all), and an unmapped specifier fails at
runtime with no build step to catch it. And note an import map is strict
JSON — a `//` comment inside the block stops it parsing and silently
disables every import in it.

Serve with real HTTP `Range` support. `python3 serve.py` (in this repo) or
`npx serve`. **`python3 -m http.server` returns 200 + the whole file for a
range request**, which degrades every range read into a full download with no
error.

### In Node, or inside a bundler

Node has no network imports, and inside a bundler `import(CDN.hyparquet)` is a
runtime-computed specifier no bundler can rewrite — so a host app that already
has hyparquet would run a second copy off the network. Inject instead, **once,
before the first `load()`/`estimate()`**:

```js
import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import * as writer from 'hyparquet-writer';
import { setHyparquetModules as setGeocoderModules } from '@cngeo/geocoder-core';
import { setHyparquetModules as setDownloadModules } from '@cngeo/extract-core';

setGeocoderModules({ hyparquet, compressors });
setDownloadModules({ hyparquet, compressors, writer });   // `writer` only for GeoParquet output
```

Pinned versions: `hyparquet@1.33.0`, `hyparquet-compressors@1.1.3`,
`hyparquet-writer@0.18.0`. Every snippet below runs in Node with those two
calls in place.

The widgets have the same seam for each thing they load lazily. A bundled
host injects its own copy, once, before first use:

```js
import MiniSearch from 'minisearch';                       // 7.2.0
import { setMinisearchModules } from '@cngeo/stac';
setMinisearchModules({ MiniSearch });                      // catalog search (recipe 8)

// In a browser bundle, from @cngeo/maplibre:
//   setDeckModules(deckStack)                 deck.gl 9.4.2 + deck.gl-raster, ONE copy on the page
//   setPmtilesModules(pmtiles)                pmtiles 4.5.0
//   setLayerControlModules(layerControl)      maplibre-gl-layer-control
//   setTimelineModules(await import('@cngeo/timeline'))
```

`@cngeo/stac` reads parquet through `@cngeo/extract-core`, so the
`setDownloadModules` call above covers it.

---

## Recipe 1 — an `Area` from a live gazetteer

```js
import { Geocoder } from '@cngeo/geocoder-core';

const geocoder = new Geocoder({
  indexUrl: 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json',
  limit: 5,
  // 'display' (default) = one read of the pre-simplified file.
  // 'full'              = one read of the full-resolution file.
  // 'both'              = return display now, upgrade filterGeometry in the background.
  // Use 'both' for anything interactive.
  geometry: { resolution: 'display' },
});

await geocoder.load();                   // call on search-box focus, not page load
const [best] = await geocoder.search('liechtenstein', { levels: [0] });
const area = await geocoder.select(best);
geocoder.close();                        // drops the in-memory index

area.type;                 // 'Area'
area.name;                 // 'Liechtenstein'
area.crs;                  // 'EPSG:4326'
area.vertexCount.filter;   // 44
area.filterGeometry;       // a Polygon -- or NULL, see pitfalls
```

**`resolution: 'both'` also takes `upgradeDisplay: true`** (default `false`):
`geometry: { resolution: 'both', upgradeDisplay: true }` additionally swaps
`area.geometry` itself to the full-resolution fetch once the background
upgrade lands (not just `filterGeometry`), keeping the pre-upgrade geometry
on `area.displayGeometry`. Listen for `'area:upgrading'` (fires right after
`'select'`, carries a cheap `{ bytes?, vertices? }` estimate) to show a
"loading full detail…" notice, and call `geocoder.cancelUpgrade()` any time
before `'area:upgraded'` fires to abort it and keep the simplified
`geometry` — that emits `'area:upgrade-cancelled'` instead. See
[`@cngeo/geocoder-core`'s README](packages/geocoder-core/README.md#upgradedisplay-true--swap-the-outline-too-with-a-cancel-handle).

Hard rules:

- `indexUrl` is the **manifest** (`index.json`), not the parquet, and takes
  **one** URL. The designed multi-source array form is unimplemented (design
  doc §8); a one-element array works, two or more throw
  `INDEX_MULTI_SOURCE_UNSUPPORTED`. Omitting it entirely is now fine —
  `DEFAULT_INDEX_URL` is the published geoBoundaries manifest as of
  2026-11-12 (it used to be the relative dev path `'./data/index.json'`) —
  but pass it explicitly whenever you care *which* gazetteer you get.
- `search()` is safe on every keystroke. A **superseded search resolves to
  `[]`, never rejects.**
- `searchSync()` is zero-await but throws `GEOCODER_NOT_LOADED` unless
  `state === 'ready'` **and** the index was fully loaded (not the range path).
- Pass `{ viewport: [w, s, e, n] }` to `search()` for the ranking boost. It
  genuinely reorders: `"contra"` → `Contralmirante Villar` without it,
  `Contra Costa` with a Bay Area viewport.
- **Typos still resolve.** When the prefix search matches *nothing* and the
  query is ≥ 3 chars, a Jaro-Winkler fuzzy fallback (adapted from
  [Development Seed's gazet](https://github.com/developmentseed/gazet), MIT)
  scans the in-memory index: `"liechtenstien"` → Liechtenstein,
  `"brookln"` → Brooklyn. Those results carry `rank.matchClass: 'fuzzy'`
  and `rank.similarity` (0..1); a non-empty prefix result is never
  reordered or augmented. In range mode it scans the prominent index only
  — **never range reads** — so an index without `prominent_index` gets no
  fallback. Disable with `fuzzy: false`, tune with
  `fuzzy: { minSimilarity: 0.9 }` (the measured default).

`SearchResult` fields worth using: `featureId`, `name`, `level`, `country`,
`parentName` ?? `countryName` (dropdown context), `areaKm2`, `moreCount`
(render as "(+N more)"), `bbox`, `rank.matchClass`, `rank.viewportRank`,
`score` (display only — the sort never reads it).

---

## Recipe 2 — consume an `Area`

Everything a consumer needs is already on the object. Compute nothing.

```js
// Spatial arithmetic uses `bboxes`, NEVER `bbox`.
area.bboxes;                  // 1 or 2 boxes, each [w, s, e, n] with w <= e
area.bbox;                    // SIGNED; w > e means it wraps the antimeridian
area.crossesAntimeridian;     // === (area.bboxes.length > 1)

area.geometry;                // what to draw
area.filterGeometry;          // what to filter with -- may be null
area.vertexCount;             // { display, filter }

area.provenance.source;       // 'geocoder' | 'upload' | 'draw'
area.provenance.combine;      // 'single' | 'collect' | 'dissolve'
area.provenance.geometryVariant;   // 'full' | 'display-simplified' | 'unknown'
area.provenance.attribution;  // what your UI MUST display
```

Serialize it as a GeoJSON `Feature` — it opens in geojson.io, QGIS and
`ogr2ogr` unchanged:

```js
import { toAreaDocument, fromAreaDocument } from '@cngeo/spec';

const doc = toAreaDocument(area);       // extras under `area:*`, snake_case
const restored = fromAreaDocument(JSON.parse(JSON.stringify(doc)));  // validates on the way in
```

```js
// Attribution: read BOTH key styles. A geocoder Area's entries come
// straight off the manifest (snake_case); extract-core's derived ones are
// camelCase. Checking only `shareAlike` silently misses ODbL obligations.
for (const a of area.provenance.attribution) {
  const shareAlike = a.shareAlike ?? a.share_alike;
  display(a.text, a.license, a.url, shareAlike);
}
```

---

## Recipe 3 — a `DownloadRequest` for each dataset kind

A `DownloadRequest` is `{ spec: 'cng-request/1.0', dataset, filter, output,
generator? }`. All plain JSON. `filter.area` is either an inline `AreaDocument`
or `{ ref: 'area' }` to defer to the runtime argument.

### 3a. One GeoParquet file (`kind: 'parquet'`)

```js
const request = {
  spec: 'cng-request/1.0',
  dataset: {
    spec: 'cng-dataset/1.0',
    id: 'ftw-fields-li',
    title: 'Fields of The World — field boundaries (Liechtenstein)',
    source: {
      kind: 'parquet',
      url: 'https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=LI/Liechtenstein.parquet',
    },
    table: {
      geometryColumn: 'geometry',
      geometryEncoding: 'WKB',
      crs: 'OGC:CRS84',
      // THE most valuable field here: it is what lets row groups be pruned
      // without decoding geometry. { kind: 'none' } means full scan.
      bbox: { kind: 'struct', column: 'bbox' },
      columns: [
        { name: 'id', type: 'string' },
        { name: 'geometry', type: 'geometry' },
        { name: 'confidence', type: 'float32' },
        { name: 'bbox', type: 'struct' },
      ],
    },
    attribution: [{ text: 'Fields of The World', license: 'CC-BY-4.0', shareAlike: false }],
  },
  filter: {
    spec: 'cng-filter/1.0',
    area: { ref: 'area' },
    spatial: { mode: 'intersects' },          // 'bbox' | 'intersects' (default) | 'clip' (unimplemented)
    where: [{ col: 'confidence', op: '>=', value: 0.9 }],
    columns: { include: ['id', 'confidence'] },
    limit: 50,
  },
  output: { spec: 'cng-output/1.0', format: 'geojson', filename: 'ftw-liechtenstein.geojson' },
};

const est = await estimate(request.dataset, area, request.filter);
est.files.selected;   // 1
est.requests;         // 2
```

`table` can be omitted entirely and inferred from the parquet schema, but then
you get `bbox: { kind: 'none' }` unless the file happens to have a column
literally named `bbox` — i.e. a full scan. Declare it when you know it.

### 3b. Hive-partitioned (`kind: 'hive'`) — derive it, don't write it

```js
import { resolveDataset, estimate } from '@cngeo/extract-core';

const dataset = await resolveDataset({
  spec: 'cng-dataset/1.0',
  id: 'firms-detections',
  source: {
    kind: 'portolan-collection',
    url: 'https://data.source.coop/portolan-mirrors/firms-catalog/detections/collection.json',
  },
});

dataset.source.kind;          // 'hive'
dataset.source.strategy;      // 'temporal'
dataset.source.fileCount;     // 27
dataset.source.enumeration;   // { kind: 'stac-items', collectionUrl: '…' }
dataset.table.timeColumn;     // 'acq_datetime'
dataset.table.bbox;           // { kind: 'none' } -- no covering COLUMN, but see below:
                              // the geometry carries native GeospatialStatistics
dataset.table.rowCount;       // 632471436

const filter = {
  spec: 'cng-filter/1.0',
  area: { ref: 'area' },
  spatial: { mode: 'intersects' },
  time: { column: 'acq_datetime', start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z', closed: '[)' },
  columns: { exclude: ['instrument', 'satellite'] },
  limit: 100,
};

const est = await estimate(dataset, area, filter);
est.files;        // { total: 27, selected: 1 }  <- the time filter alone, zero data requests
est.prune;        // [{ stage: 'part-time', before: 27, after: 1, basis: '…' },
                  //  { stage: 'row-group-bbox', before: 582, after: 6,
                  //    basis: 'native geometry statistics' }, …]
est.warnings;     // NO 'no-covering': the GeoParquet 2.0 geometry column
                  // carries per-row-group bboxes in the footer. ~4 MB read.
```

**Never hand-write a hive descriptor from a glob.** Both live catalogs publish
`partition:glob` as an `s3://` URI, which a browser cannot fetch.
`enumeration` (`collection-mirror` → 1 request, or `stac-items` → N) is what
yields real HTTPS hrefs.

### 3c. STAC-GeoParquet footprints (`kind: 'stac-geoparquet'`)

Same derivation; the kind is detected from `table:columns` containing
`stac_version` + `assets`.

```js
const dataset = await resolveDataset({
  spec: 'cng-dataset/1.0',
  id: 'sentinel-2-c1-l2a',
  source: {
    kind: 'portolan-collection',
    url: 'https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json',
  },
});
dataset.source.kind;              // 'stac-geoparquet'
dataset.attribution[0].shareAlike;  // true -- CC-BY-SA-3.0-IGO

const filter = {
  spec: 'cng-filter/1.0',
  area: { ref: 'area' },
  spatial: { mode: 'intersects' },
  time: { start: '2025-06-01T00:00:00Z', end: '2025-06-08T00:00:00Z', closed: '[)' },
  where: [{ col: 'eo:cloud_cover', op: '<=', value: 20 }],
  columns: { include: ['id', 'datetime', 'eo:cloud_cover'], includeBbox: true },
  limit: 100,
};

const est = await estimate(dataset, area, filter);
est.files;        // { total: 12, selected: 1 }
est.rowGroups;    // { total: 825, selected: 27 } -- pruned by the geometry's
                  //    native GeospatialStatistics (see pitfall 10)
est.requests;     // 28  <- was 838 before native statistics were read
est.columns;      // ['id', 'datetime', 'eo:cloud_cover', 'geometry']
est.warnings;     // includes 'share-alike' (no longer 'no-covering')
```

The fat `assets` column is excluded unless explicitly included — a footprint
download almost never wants it.

### 3d. An explicit list of files (`kind: 'parquet-set'`)

```js
source: {
  kind: 'parquet-set',
  urls: ['https://…/a.parquet', 'https://…/b.parquet'],
  // Optional per-file metadata. Supply it and whole files prune with ZERO
  // HTTP requests.
  parts: [
    { url: 'https://…/a.parquet', bbox: [-10, 40, 10, 60], rowCount: 1000, interval: ['2025-01-01T00:00:00Z', null] },
  ],
}
```

### 3e. Raw GeoParquet passthrough (`output.format: 'parquet-raw'`) — the published files themselves

Every recipe above decodes rows through hyparquet and re-encodes them into a
new file. This path does neither: it streams the **original published
parquet bytes** straight through — one file verbatim, or several zipped
together with a generated `ATTRIBUTION.txt` — with no footer read, no
row-group pruning and no row-level filtering. Supported source kinds:
`parquet`, `parquet-set`, `hive`, `stac-geoparquet` (resolve a
`portolan-collection` first; this path does not take one directly).

```js
const output = { spec: 'cng-output/1.0', format: 'parquet-raw' };
const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'intersects' } };

const est = await estimate(request.dataset, area, filter, { output });
est.rowGroups;      // { total: 0, selected: 0 } -- none is ever examined
est.columns;        // [] -- no projection; every column of every file passes through
est.rows;           // null when any selected file has no declared rowCount -- an honest
                    // "don't know", not a model (most STAC-sourced datasets, always)

const handle = download(request.dataset, area, filter, output, { sink: memorySink() });
const result = await handle.result;
result.bytes;       // the ORIGINAL file's byte count when one file is selected --
                    // nothing decoded, nothing re-encoded
```

Zero matching files throws `FILTER_NO_MATCH` (`context.files` is how many
existed before the filter) — there is no "0 rows, still a valid file" state
on this path the way there is on the decoded one. See pitfall 13 for
`rows: null`, how an unknown file size interacts with the ceiling, and the
`raw-no-pruning` warning's blind spot on a mixed dataset.

### Checking a collection before building anything

```js
import { collectionDownloadSupport } from '@cngeo/extract-core';

const collection = await fetch(collectionUrl).then((r) => r.json());
const support = collectionDownloadSupport(collection, { baseUrl: collectionUrl });

support.supported;   // boolean -- synchronous, no extra fetch
support.descriptor;  // the concrete descriptor, when supported
support.code;        // 'DATASET_UNSUPPORTED' for raster/zarr/pmtiles
support.message;     // names the asset types found
```

Render "unsupported" as the *absence* of a download widget, not an error
dialog. That is what this function is for.

---

## Recipe 4 — run a download, handling the estimate and the ceiling

```js
import { download, memorySink, autoSink } from '@cngeo/extract-core';

// In a browser, from a user gesture (showSaveFilePicker needs one):
//   const sink = await autoSink({ suggestedName: 'fields.geojson' });
// Headless / tests:
const sink = memorySink();

const handle = download(dataset, area, filter, output, { sink });
// `download()` returns SYNCHRONOUSLY so you can cancel during planning.
handle.state;   // 'planning'

// 1. Progress, if you want it.
handle.on('progress', (p) => {
  if (p.phase === 'reading') report(p.rowGroupsDone, p.rowGroupsTotal, p.rowsMatched);
});

// 2. The result. A ceiling breach REJECTS with CeilingExceededError
//    (`code: 'CEILING_EXCEEDED'`) and carries the estimate on the error,
//    so you no longer have to inspect `handle.estimate` first to be safe.
let result;
try {
  result = await handle.result;
} catch (err) {
  if (err.code !== 'CEILING_EXCEEDED') throw err;
  const est = err.context.estimate;
  if (est.rows.max > 10_000) {
    await handle.cancel('over budget');
    throw err;
  }
  // The auditable override. `acceptCeiling()` returns the CONTINUED run's
  // promise, because the one you were awaiting has already rejected.
  result = await handle.acceptCeiling();
}

result.rows;        // 795
result.bytes;       // bytes written
result.readBytes;   // bytes pulled from object storage
result.truncated;   // true iff `filter.limit` bound
result.attribution; // pass this on to whatever consumes the file
sink.chunks;        // the bytes, for memorySink
```

**`handle.estimate` is still there** and resolves even when the ceiling
trips, if you would rather branch before starting than catch a rejection.
Either shape is safe now: before 2026-11-12 a blocked handle's `result`
never settled at all, and this document carried a rule telling you to work
around that.

**A save dialog can now appear moments before a refusal.** The ceiling needs
the real sink kind (`blob` vs `filesystem` vs `memory` change the number —
see below), so `download()` resolves/opens the sink — including `autoSink`'s
`showSaveFilePicker` — **before** the ceiling gate, not after. A user can see
the picker, choose a file, and immediately get `CEILING_EXCEEDED`. The
mitigation: call `estimate()` with the same `output` first and confirm
*before* calling `download()` at all, so `download()`'s own gate is only
ever reached on a plan you already approved.

**Ceilings are derived per format and sink, not one flat number.**
`download()`/`estimate()` compute them with `effectiveCeiling({ format, sink,
overrides: options.ceiling })`:

- **Raw passthrough (recipe 3e) is never refused on `rows`** — nothing is
  decoded, so only `outputBytes`, `readBytes` and `files` can breach there.
  `est.rows` is still reported when every part declares a row count.
- `rows: 50,000,000`, `readBytes: 64 GiB`, `files: 10,000`, `blobBytes: 256
  MiB` are flat — the same for every format.
- `outputBytes` depends on the format's declared `capabilities.memoryFactor`
  (bytes of peak memory held per output byte it writes) and, only for a
  streaming format, the sink:
  - **streaming** (`memoryFactor: 0` — `geojson`, `geoparquet`, `parquet-raw`): unbounded
    (a 1 TiB sentinel, `UNBOUNDED_BYTES`) on a disk-backed sink or a `memory`
    sink — the format holds nothing of its own, so the real limit is the
    sink's, not this package's — but capped at `blobBytes` on a `blob` sink
    or when no sink exists yet (`sink: null`, e.g. before a picker has
    resolved one), the conservative choice. **`blobBytes` is the default
    for a blob sink, not a cap on one you configured:** a
    `blobSink({ maxBytes })` states its real limit on `sink.maxBytes`, and
    that is what both this cap and the buffering clamp below use (an
    explicit `ceiling.blobBytes` override still wins).
  - **buffering** (`memoryFactor` absent on a `streaming: false` format
    defaults to `3`; `gpkg` declares `2.9`. `geoparquet` used to be here at
    `2` and has streamed since issue #4):
    `outputBytes = memoryBudget / memoryFactor` — `memoryBudget` defaults to
    **1 GiB** — because the cost is spent inside the writer (row arrays, a
    wasm heap, an export copy), not in where the bytes land, this derivation
    itself does not vary by sink *kind*. But a `blob` sink (or `sink: null`,
    the same conservative treatment as the streaming case above)
    additionally clamps the result to `blobBytes`
    (`Math.min(derived, blobBytes)`): `blobSink` genuinely refuses above 256
    MiB at write time regardless of what a format's memory factor would
    otherwise allow, so `gpkg` (~353 MiB derived) would otherwise pass this
    gate only to die at the sink's own
    limit later, with no `suggestedFormats` on that late failure. A `memory`
    sink is exempt from BOTH the budget (when `memoryFactor === 0`) AND the
    `blobBytes` clamp (always) — it is not a loophole for a buffering
    format's own derivation, which still applies in full on a `memorySink`
    (an earlier draft of this had the budget exemption wrong, which left
    `gpkg` through a `memorySink` unbounded).

Import `effectiveCeiling`, `memoryFactorOf`, `UNBOUNDED_BYTES`,
`MEMORY_BUDGET_DEFAULT` from `@cngeo/extract-core` to compute the same numbers
a UI would show before calling `download()`.

`CeilingExceededError.context.suggestedFormats` lists OTHER registered
formats whose own `effectiveCeiling` would fit this exact plan. It never
names `parquet-raw`: that format has no `estimateBytes` (its size comes from
file metadata, not a schema+rows model), so it cannot be compared the same
way every other candidate is, and a raw-path breach reports
`suggestedFormats: []` outright — no candidate loop runs there at all. Don't
read either list as exhaustive; call `formats()` yourself if an unusual
format might actually serve the request.

Reading the estimate:

```js
est.rows;        // { min, max, estimate, exact } -- exact:false means it is a MODEL
est.readBytes;   // exact:true -- summed column-chunk sizes from the footers
est.requests;    // request DEPTH is the latency on this path, not bytes
est.prune;       // the narration: [{ stage, before, after, basis }, …]
est.columns;     // the output projection
est.warnings;    // see below
```

Warning codes and what they mean for you: `no-covering` (no bbox column →
full scan), `single-row-group` (a file that cannot be pruned at all),
`no-statistics`, `degraded-to-bbox` (the `Area` has no usable
`filterGeometry`), `antimeridian-split`, `estimate-wide` (`max/estimate > 10`
— say "between X and Y", do not pretend to know), `share-alike` (the output
inherits a share-alike license), `large-download` (`{ bytes, estimatedSeconds
}`, fires over 1 GiB), `slow-download` (`{ estimatedSeconds }`, fires over
120 s at an assumed 10 MB/s) — nine codes so far.

The raw path (recipe 3e) raises `share-alike` exactly as the decoded path
does — it matters most there, since a single file is handed over verbatim
with no `ATTRIBUTION.txt` beside it — and adds three codes of its own.
Raw-passthrough only: `raw-passthrough-unfiltered`
(`{ dropped }` — which of `where` / `columns` / `spatial-row-level` / `limit`
this path did NOT apply, because nothing is decoded to apply them to —
`spatial-row-level` fires whenever any `Area` was passed, regardless of
`filter.spatial.mode`; `limit` fires whenever `filter.limit` was set, since
a whole file is always returned verbatim, never truncated),
`raw-size-unknown` (`{ partsWithoutSize, partsTotal }` — at least one
selected file's size couldn't be resolved; `large-download`/`slow-download`
are suppressed on that same estimate, since presenting a partial byte sum as
"the size" would imply small when the truth is unknown), `raw-no-pruning`
(`{ basis }` — the filter narrowed by area or time but every surviving file
declares no bbox/interval to prune by, so nothing was actually pruned by
metadata, it just happened to all pass). **`raw-no-pruning` checks
`selected.every(...)`**: on a dataset where some files genuinely matched a
declared bbox/interval and others passed only because they declare none,
neither this warning nor any other signal fires for the second group — a
known gap, not a correctness bug (`basis` itself is never wrong; there is
just no way yet to say "some of these").

**All twelve codes above — the nine first, plus these three raw-only ones —
are FLAT on the warning object** (`w.bytes`, never `w.context.bytes`), so a
consumer can switch on `w.code` without special-casing any of them.

Output formats: `geojson` (`memoryFactor: 0` — streams; options `precision`,
`newlineDelimited`, `featureIdColumn`), `geoparquet` (`memoryFactor: 0` — **streams**: one row group is buffered,
encoded and handed to the sink at a time, so it is bounded like `geojson`,
not by `memoryBudget`; a group closes at `rowGroupSize` rows or
`rowGroupBytes` of geometry, whichever first; nested columns (struct,
list, map) are written as native Parquet groups from the source footer
schema, not JSON strings — except a column whose shape differs between the
selected files, or that `hyparquet-writer` cannot re-encode (a legacy
two-level list, a top-level `REPEATED` group, a non-string-keyed map),
which stays JSON text rather than failing; the dataset's **declared**
`bbox` covering struct becomes the covering instead of four added `bbox_*`
columns; options `compression` — `'snappy'` default, `'none'` ok, `'zstd'`
**refused** with `FORMAT_CAPABILITY` at `open()`; `rowGroupSize` (50,000),
`rowGroupBytes` (64 MiB), `writeCovering`), and `parquet-raw` (`memoryFactor: 0`, no
decode at all — recipe 3e). Anything else must be registered first;
`formats()` lists what is available without loading any of it.

---

## Recipe 5 — an uploaded `Area` is interchangeable

```js
import { areaFromFile, areaFromGeoJson, attachDropTarget } from '@cngeo/upload-core';

const { area, warnings } = await areaFromFile(file);
// ...or from a value you already have:
const r = await areaFromGeoJson(geojsonValue, { name: 'box.geojson' });

// The SAME estimate() call works on it. No branching anywhere downstream.
const est = await estimate(dataset, area, { spec: 'cng-filter/1.0', spatial: { mode: 'intersects' } });
```

Report `warnings` to the user. Codes: `repaired` (with the list of fixes),
`overlapping-features`, `simplified`, `degraded-to-bbox`, `assumed-4326`.

`attachDropTarget(el, onResult, { onError })` wires drag/drop/paste. **Always
pass `onError`** — without it, a bad file silently does nothing. Also wire a
hidden `<input type="file">` to the same handler: it is the only path browser
automation can drive.

Refusals: `AREA_UNSUPPORTED_GEOMETRY` (points/lines only),
`AREA_EMPTY` (nothing survived repair), `AREA_INVALID_CRS` (a declared
non-4326 CRS — pass `{ onForeignCrs: 'assume-4326' }` to override, which
records the assumption), `UPLOAD_TOO_LARGE`, `UPLOAD_UNSUPPORTED_FORMAT`,
`UPLOAD_PARSE_ERROR`.

---

## The map widgets (recipes 6–9)

Four widgets, each a headless half you can run anywhere and a MapLibre
control that drives it. The headless halves below are executed by
`node docs/verify-snippets.mjs widgets`; a control needs a browser, and is
verified by the `examples/*/verify.mjs` named beside it.

**Add every control after the map's `load` event**, and give them all the
**same `LayerManager`**: it is the one list of what is on the map.

## Recipe 6 — a layer stack, from STAC or by hand

A `LayerSpec` is plain JSON: `{ spec: 'cng-layer/1.0', id, title, kind,
source, style?, bbox?, attribution[], group? }`. `kind` is one of
`pmtiles-vector`, `cog`, `geojson`, `timeline` (drawable), `scenes` (a
collection of imagery: not one picture, so it is *searched* — recipe 7 — and
each scene found becomes a `cog`), `table` and `unsupported` (nothing to
draw). `add()` rejects the last three with `LAYER_UNSUPPORTED`.

```js
import { layersFromCollection } from '@cngeo/stac';
import { validateLayerSpec } from '@cngeo/spec';

const url = 'https://storage.googleapis.com/carto-open-catalogs/ocha-cod-jamaica/main/parishes/collection.json';
const collection = await fetch(url).then((r) => r.json());
const layers = layersFromCollection(collection, { baseUrl: url });   // synchronous, no fetch of its own

const [layer] = layers;
layer.kind;              // 'pmtiles-vector'
layer.source.url;        // absolute: made so against `baseUrl`
layer.source.style?.url; // the collection's own style, when it publishes one
layer.attribution;       // what your UI MUST display

validateLayerSpec(layer);   // throws a CngError (`LAYER_INVALID`) for a spec that is not one
```

In a browser (`examples/layers-demo/verify.mjs`, 15 checks):

```js
import { LayerManager, LayerControl, urlAddProvider } from '@cngeo/maplibre';

const manager = new LayerManager(map);                    // bottom-first; sits under the basemap's labels
map.addControl(new LayerControl({ manager, addProviders: [urlAddProvider({ layersFromCollection })] }), 'top-right');

await manager.add(layer);                                 // drawn with the collection's own style
await manager.add({ spec: 'cng-layer/1.0', id: 'image', kind: 'cog', source: { url: 'https://example.org/scene.tif' } });
manager.move('image', 0);                                 // to the bottom; the map follows
manager.setOpacity('image', 0.6);
manager.list();          // [{ id, title, kind, visible, opacity, status, error?, note?, attribution, spec }]
manager.attribution();   // every credit owed for what is shown
```

Hard rules:

- **`baseUrl` is not optional in practice.** Without it relative asset hrefs
  stay relative and nothing loads.
- `add()` rejects with a coded error and, for a load failure
  (`LAYER_LOAD_FAILED`), **leaves the layer in the list** with
  `status: 'error'`. Read `list()`, do not assume.
- A COG is read by range request and reprojected in the browser from its own
  CRS (UTM included). It does not need to be in Web Mercator.
- `source` is data. A function anywhere in it fails validation.

## Recipe 7 — imagery search over STAC-GeoParquet

One search for any collection whose items are published as GeoParquet:
Sentinel-2, NAIP, OpenAerialMap. `imageryProfile()` absorbs how they differ
(where the items file is, which asset is the picture, whether `assets` is a
struct or a JSON string, a `datetime` or a start/end interval).

```js
import { imageryProfile, ImagerySearch } from '@cngeo/stac';

const collectionUrl = 'https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json';
const collection = await fetch(collectionUrl).then((r) => r.json());
const profile = imageryProfile(collection, { baseUrl: collectionUrl });
const search = new ImagerySearch(profile);

profile.filters;   // what a panel can offer: [{ column: 'eo:cloud_cover', label, kind: 'max', type }, …]

const { scenes, truncated, plan } = await search.search({
  area,                                            // an Area (recipes 1, 5), or omit for everywhere
  time: { start: '2025-06-01T00:00:00Z', end: '2025-06-08T00:00:00Z' },
  where: [{ col: 'eo:cloud_cover', op: '<=', value: 60 }],
  limit: 20,                                       // default 200
  onScenes: (batch) => draw(batch),                // as each row group is read
});

scenes[0];   // { id, datetime, start, end, bbox: [w, s, e, n], geometry, properties, thumbnail, self, assets? }
             // newest first, unless `sort` says otherwise

const layer = await search.layerSpecFor(scenes[0]);   // a 'cog' LayerSpec for the scene's picture
```

In a browser (`examples/imagery-search/verify.mjs`, per collection):

```js
import { LayerManager, ImagerySearchControl } from '@cngeo/maplibre';
map.addControl(new ImagerySearchControl({ search, manager }), 'top-left');
// area (the map view, or a drawn one), dates, the profile's filters, cards with
// thumbnails, footprints on the map, and "Add to map" -> manager.add(layerSpecFor(scene))
```

Hard rules:

- `search()` is safe to call again before the last one finishes: **the
  superseded one resolves `{ scenes: [], superseded: true }`, never
  rejects.** Check the flag before you clear a list.
- **A time filter means "overlaps the window"**, per row, as
  `start_datetime ?? datetime` … `end_datetime ?? datetime`. OpenAerialMap
  items have no `datetime` at all, and are found.
- The first search of a collection pays for its footers (Sentinel-2: about
  8 MB, several seconds, more on a slow day — the snippet above measured
  between 9 and 36 s cold). They are cached for the life of the
  `ImagerySearch`; call `search.warm()` when the panel opens.
- **Do not ask for `assets` in a search of Sentinel-2.** It is a JSON string
  of about 18 KB a row. `layerSpecFor(scene)` finds the one asset it needs.
- `truncated: true` means `limit` cut the list, not that the search failed.

## Recipe 8 — catalog search over a `collections.parquet`

A STAC-GeoParquet index of collections — the Portolan registry's has 6,941 —
searched in the browser: text, area, time, licence, and what each can be
drawn as.

```js
import { CatalogIndex } from '@cngeo/stac';

const index = new CatalogIndex('https://registry.portolan-sdi.org/v0.1/collections.parquet');
await index.load();                // or let the first search do it
index.entries.length;              // 6,941 (2026-11-25)

const { results, total, facets } = await index.search({ text: 'buildings', limit: 10 });
results[0];        // { key, id, title, description, href, license, keywords, catalog, catalogs,
                   //   bbox, start, end, kinds, thumbnail, score, fit }
facets.license;    // [{ value: 'CC-BY-4.0', count }, …]  -- also facets.catalog, facets.kinds

const { drawable, undrawable, source } = await index.resolve(results[0]);
drawable;          // LayerSpec[]: hand each to manager.add()
undrawable;        // [{ title, kind: 'table', reason }] -- say why, do not hide it
source;            // 'render' (read from the index) or 'collection' (its JSON was fetched)
```

`search()` also takes `area` (an `Area`), `time: { start?, end? }`,
`license`, `kinds` and `within` (a catalog). Results whose extent *fits* the
area rank above global ones.

In a browser (`examples/catalog-search/verify.mjs`, 42 checks):

```js
import { LayerManager, LayerControl, CatalogSearchControl, catalogAddProvider } from '@cngeo/maplibre';

const catalog = new CatalogSearchControl({ index, manager });
map.addControl(catalog, 'top-left');
// The layer panel's "Add" button leads to it:
map.addControl(new LayerControl({ manager, addProviders: [catalogAddProvider(catalog)] }), 'top-right');
```

Hard rules:

- The index is loaded once, light columns only (never `original`, 56.7 MB of
  text in a 19 MB file). **A file's size is found with a ranged GET, not
  HEAD**: GitHub Pages, which hosts the registry, answers HEAD with the
  length of the file's gzip encoding, and the footer is then looked for in
  the wrong place. `remoteByteLength()` in `@cngeo/extract-core` is the
  function; use it if you open a parquet file yourself.
- A superseded `search()` resolves `{ results: [], total: 0, superseded:
  true }`. Safe on every keystroke.
- Typos resolve: `"buildngs"` finds buildings (one edit, on words of six
  letters or more).
- `resolve()` needs one fetch of the collection's JSON unless the index
  carries a `render` column. The live registry does not yet
  (`experiments/e13-render-column/` measures what it would cost: 454 KB).
- Two results can share an `id` across catalogs. `key` is unique; layer ids
  are disambiguated when both are added.

## Recipe 9 — a timeline over chunks of any size

A histogram of time under the map, a selection that decides what the map
draws, and play / pause — over files that each cover a span of time. A
chunk's **span** is whatever it says (a year, a month, a week); the
**bucket unit** inside it is `day` or `month`.

```js
import { chunksFromTemplate, forView, forSelection } from '@cngeo/timeline';

const BASE = 'https://data.source.coop/portolan-mirrors/firms-catalog/detections';
const years = chunksFromTemplate({
  template: `${BASE}/year={YYYY}/fire-{YYYY}.pmtiles`,
  period: 'year',                      // 'year' | 'month' | 'week' | 'day' | { days: n }
  start: '20001101',                   // day keys: YYYYMMDD, always UTC
  end: '20261125',                     // default: today
});
years.length;   // 27
years[0];       // { id: '2000', start: '20001101', end: '20001231', unit: 'day', format: 'pmtiles', url, priority: 0 }

// Monthly files are the same thing with another period.
const months = chunksFromTemplate({ template: 'https://example.org/{YYYY}/{MM}.pmtiles', period: 'month', start: '20240101', end: '20241231' });
forSelection(months, { from: '20240120', to: '20240310' }, 'day').length;   // 3: a selection draws from every chunk it touches

// With a monthly overview beside the years, a narrow view is days and a wide one months.
const overview = { id: 'alltime', start: '20001101', end: '20261130', unit: 'month', format: 'pmtiles', url: `${BASE}/alltime.pmtiles` };
forView([...years, overview], { from: '20260818', to: '20261125' });   // { unit: 'day',   load: [2026] }
forView([...years, overview], { from: '20150101', to: '20261125' });   // { unit: 'month', load: [alltime] }
```

From a STAC collection whose items have dates and a tiles asset:

```js
import { chunksFromStac } from '@cngeo/stac';

const url = 'https://data.source.coop/portolan-mirrors/firms-catalog/detections/collection.json';
const { chunks, skipped } = await chunksFromStac(await fetch(url).then((r) => r.json()), { baseUrl: url });
chunks.length;   // 27 -- one request per item
skipped;         // [{ href, reason }] for an item that is gone or has no tiles
```

In a browser (`examples/timeline-firms/verify.mjs`, 24 checks):

```js
import { LayerManager, LayerControl, TimelineControl, describePmtilesChunk } from '@cngeo/maplibre';

const fires = {
  spec: 'cng-layer/1.0', id: 'fires', title: 'Active fires', kind: 'timeline',
  source: {
    chunks: [...years, { ...(await describePmtilesChunk(`${BASE}/alltime.pmtiles`)), id: 'alltime' }],
    aggregate: { layer: 'aggregate', idProperty: 'a5_cell' },   // cells with a count_YYYYMMDD column per day
    points: { layer: 'features', property: 'day' },             // features that each carry their own day
  },
  attribution: [{ text: 'NASA FIRMS' }],
};
map.addControl(new TimelineControl({ manager, layer: fires, metricLabel: 'detections' }), 'bottom-left');
manager.handle('fires');   // the session: state, on('change'), setView(), setSelection(), retry()
```

PMTiles is one chunk **format**. Anything that can answer "counts per bucket
for this view" and "draw this window" is another, and the orchestrator does
not know the difference:

```js
import { createChunkSet } from '@cngeo/timeline';

const counts = { 20240105: 3, 20240106: 5, 20240210: 2 };
const memoryFormat = {
  async open(chunk) {
    return { unit: chunk.unit };                 // whatever mount() needs
  },
  mount({ chunk, settled }) {
    const mine = Object.fromEntries(Object.entries(counts).filter(([day]) => day >= chunk.start && day <= chunk.end));
    settled(true);                               // "what I have for this view is complete"
    return {
      setWindow(window) {},                      // { unit, ranges: [[from, to], …] } to draw; null = nothing
      histogram(viewport) { return mine; },      // { bucketKey: count } for what is in view
      freeze() {},                               // keep showing what you show: a successor is loading
      destroy() {},
    };
  },
};

const set = createChunkSet({
  chunks: chunksFromTemplate({ template: 'https://example.org/{YYYY}-{MM}.bin', period: 'month', start: '20240101', end: '20240229', format: 'memory' }),
  formats: { memory: memoryFormat },
});
set.setViewport({ bbox: [-180, -85, 180, 85], zoom: 2 });
set.setView({ from: '20240101', to: '20240229' });
set.setSelection({ from: '20240105', to: '20240210' });
// ...a moment later:
set.state.drawing.length;   // 2 -- the selection spans both chunks, so both draw
set.state.histogram;        // { 20240105: 3, 20240106: 5, 20240210: 2 }
set.destroy();
```

On a map, `registerChunkFormat(name, factory)` from `@cngeo/maplibre` adds
such a format to the timeline layer; its mounts also return deck.gl layers.
**No GeoParquet format is built.** The interface is the place for one.

Hard rules:

- **A descriptor must say what its file really holds.** One that claims more
  shows the difference as loaded-and-empty: false zeros, indistinguishable
  from "no fires". For a file whose span is not in its name (a rolling
  "latest", an overview rebuilt monthly) ask the file:
  `describePmtilesChunk(url)`. A catalog's item dates can lag its file too.
- The **axis** is the whole chunk set; what is **loaded** follows the view
  (`cap`, default 3 big chunks); what **draws** follows the selection. What is
  not loaded is hatched, never drawn as zero: `state.gaps`.
- Where chunks overlap, each bucket has **one owner**: higher `priority`,
  then the narrower span.
- A chunk that will not open is in `state.failed`, with a `retry(id)`. It
  does not fail the layer unless the layer has never shown anything.
- Day keys are **UTC calendar days**. A date-time with no zone is read as
  UTC, not in the viewer's zone.
- A page with a timeline needs `@cngeo/timeline` in its import map (see
  Setup). It fails when the layer is added, not at load, without it.

---

## The manifest contract

`indexUrl` points at ~10 KB of JSON that describes the whole gazetteer. You can
read it directly; `geocoder-core` does nothing you cannot.

```js
const manifest = await fetch(indexUrl).then((r) => r.json());
manifest.spec;             // 'cnmw-index/1.0'  <- anything else is refused
manifest.source;           // 'geoboundaries-cgaz'
manifest.catalog_version;  // 'geoboundaries-cgaz-2026-11-12'
manifest.rows;             // 52398
manifest.levels;           // [0, 1, 2]
manifest.attribution;      // [{ text, license, url, share_alike }]  <- snake_case
```

| field | required | notes |
|---|---|---|
| `spec` | yes | `'cnmw-index/1.0'`. A mismatch throws `INDEX_SCHEMA_MISMATCH`. |
| `source`, `index_version`, `catalog_version`, `rows`, `levels` | yes | `source` also defaults the index's per-row `source` when the column is absent. |
| `index.url`, `.size`, `.row_groups` | yes | `size` drives the `auto` full-vs-range choice (`<= 5 MiB` → full). |
| `index.feature_id_column` | no | Defaults `'feature_id'`. geoBoundaries publishes `'shape_id'`. |
| `index.footer_metadata_bytes` | no | **The thrift footer alone — this is what a hyparquet client should ask for.** |
| `index.footer_bytes` | no | Footer **+ page index**. Larger; hyparquet never reads page-index bodies, so asking for this over-fetches. Used only as a fallback. |
| `prominent_index` | no | A small eager-loaded strict row subset, same schema and sort. Enables two-wave search. Absence is a complete no-op. |
| `boundaries[].level`, `.geometry_column`, `.full.url` | yes | |
| `boundaries[].display.url` | no | The pre-simplified variant. A level without one falls back to `'full'` for every resolution mode. |
| `boundaries[].feature_id_column` | no | The boundary file's join column. **`null` is legal** — CGAZ ADM0 has no `shapeID` column at all. |
| `boundaries[].index_key_column` | no | Which *index* column is the join key. `'country'` for CGAZ ADM0, matched against `country_column`. |
| `boundaries[].country_column` | no | e.g. `'shapeGroup'`. Narrows candidate row groups. |
| `boundaries[].row_group_rows` | no | Required for the `geometry_ref` fast path: the ref's `row_group` is checked against `floor(row / row_group_rows)`. |
| `stats_truncated`, `dropped_unnamed` | no | Honesty fields. geoBoundaries drops 37 unnamed ADM2 rows and says so. |

Index columns — required: `name`, `name_norm`, `level`, `country`,
`feature_id` (renamable), `source` (defaultable), `bbox`. Read when present:
`parent_name`, `parent_id`, `country_name`, `area_km2`, `geometry_ref`,
`name_lang`, `alt_of`, `class`, `population`. A missing required column throws
`INDEX_SCHEMA_MISMATCH` naming it. No silent coercion.

**The sort guarantee:** rows ascend by `name_norm` compared **byte-wise on its
UTF-8 encoding** — not locale collation — so a JavaScript `a < b` agrees with
the file. `normalizeName` from `@cngeo/spec` is the function that produces it:
NFD → strip `\p{M}` → lowercase → keep only `[\p{L}\p{N} '-]` → collapse
whitespace → trim. Override `GeocoderOptions.normalize` and you break the
binary search unless you also rebuilt the index.

Full contract: [design doc §6](docs/design/widgets-architecture.md#6-index-file-interface).

---

## Pitfalls

Ordered by how badly they bite. The first three cause **silently wrong
answers**; the rest cause hangs, crashes or slowness.

### 1. hyparquet needs `geoparquet: false` AND `utf8: false` for raw WKB

Two flags, both required, in two different places. Getting one right is worse
than getting both wrong, because it fails silently.

```js
// geoparquet:false goes on the METADATA call (it lives on the schema).
const metadata = await hyparquet.parquetMetadataAsync(file, {
  initialFetchSize: 65_536,
  geoparquet: false,
});
// utf8:false goes on EVERY READ call.
const [row] = await hyparquet.parquetReadObjects({
  file, metadata, columns: ['geometry'], rowStart: 0, rowEnd: 1,
  utf8: false, compressors,
});
row.geometry instanceof Uint8Array;   // true
row.geometry[0];                      // 1 -- the little-endian WKB marker
```

Without `geoparquet: false`: hyparquet replaces the WKB with its own decoded
GeoJSON object. Without `utf8: false`: the untyped BYTE_ARRAY column falls back
to hyparquet's `utf8: true` default and the binary is **mangled into a JS
string**, one UTF-16 unit per byte. A real string column is unaffected by
`utf8: false`, so always pass it.

Also: **`parquetMetadataAsync(file, 65536)` silently ignores the number.** The
second argument is always an options object; destructuring off a `Number`
yields `undefined` for everything and you quietly get the defaults. This
dormant-bug shape existed in two packages here.

And separately again: a GeoParquet **2.0** file (native Parquet `GEOMETRY`
logical type — FIRMS, s2-stac-geoparquet) is auto-decoded *unconditionally*,
independent of the `geoparquet` flag, which only ever governed the older
sidecar-metadata convention. Use `decodeWkbGeometry` from
`@cngeo/extract-core`, which normalizes bytes-or-object.

### 2. `area.filterGeometry` can be `null`

It is a real state, not an error: the filter geometry could not be produced
within the 5% `areaDeltaMaxRatio`. Filtering falls back to `bboxes` alone and
`estimate()` raises `degraded-to-bbox`. If you dereference
`area.filterGeometry.coordinates`, you crash on exactly the big countries users
search for first.

### 3. Attribution casing: normalized now, but normalize yours too

The manifest declares `share_alike` (snake_case); the documented
`AreaAttribution` shape names it `shareAlike`. `geocoder-core` now
normalizes on ingestion and keeps the raw key alongside it, so an `Area`
carries **both**, in agreement — reading either is correct, and
`a.shareAlike ?? a.share_alike` still works. Worth knowing because the
hazard it replaced was silent: before the normalization, checking only
`shareAlike` reported *no* share-alike obligation on ODbL (Overture)
data. If you ingest a manifest yourself, normalize it the same way.

### 4. A ceiling breach rejects — catch it, don't mistake it for a failure

Covered in recipe 4. `handle.result` rejects with `CeilingExceededError`
(`code: 'CEILING_EXCEEDED'`, the estimate on `err.context.estimate`), and
`handle.acceptCeiling()` returns the **continued** run's promise, because
the one you were awaiting has already settled. A promise captured before
the breach stays rejected; re-read `handle.result` after accepting.
*(Until 2026-11-12 this entry said the opposite — `result` never settled at
all, which hung any caller that awaited it. If you are working from an
older copy of this file, that is the change.)*

### 5. Parquet `INT64` columns decode as `BigInt`

hyparquet decodes `INT64` as `BigInt`, and one `BigInt` anywhere in an
object graph makes `JSON.stringify` **throw** `TypeError: Do not know how to
serialize a BigInt`. `SearchResult` is coerced at its boundary, so
`geometryRef.row` and `population` are plain numbers and a result
serializes. **If you decode index or dataset rows yourself, coerce
`number|bigint` rather than testing for `number`** — that exact mistake
dropped the Who's On First `population` column on every row and silently
disabled a whole ranking component until it was measured.

```js
const n = typeof v === 'bigint' ? Number(v) : v;   // then range-check it
```

### 6. `bbox` can have `west > east`

Anything doing `east - west` on `Area.bbox` is wrong for Fiji and Russia.
Use `bboxes`.

### 7. Synchronous simplification is O(m²)

`@cngeo/spec`'s `simplifyToVertexCeiling` measured 38 ms at 1,000 vertices,
921 ms at 5,000, 3,852 ms at 10,000 — and a little over the ceiling is not
cheap, because one binary-search trial always strips the ring to nothing.
Canada's ADM0 ring is ~195,000 points and hung a browser for ~24 s before the
guard existed. Pass `maxSyncInputVertices: MAX_SYNC_SIMPLIFY_VERTICES` (1500)
and accept a bbox degradation, or use `simplifyToVertexCeilingAsync`.
`geocoder-core`'s `select()` already does the former, plus a background upgrade.

### 8. Range reads need `cache: 'no-store'`

Which these packages do internally. Chrome serializes concurrent reads of one
URL behind its cache lock: 2.1 s → 0.4 s for the same eight reads, measured. If
you write your own reader, pass it.

### 9. Reads are parallel (12 by default); still plan for request count

`maxConcurrentRequests` defaults to **12**: row groups are fetched in
parallel, and `onBatch` still delivers them in row-group order, so output
order is unchanged. Request *depth* is still the latency on this path, so
`est.requests` is still the number to show a user and to budget against.
That number also got far smaller: the s2 footprints query planned **838
requests** before native geometry statistics were read and plans **28**
after (measured, live, 2026-11-17). Lower the option for a
file with very large row groups: peak memory is one decoded row group per
concurrent read.

### 10. `includeBbox: true` is a no-op without a covering — but `{ kind: 'none' }` no longer means "full scan"

The covering *columns* come from `table.bbox`. On `{ kind: 'none' }` there is
nothing to include. (The `geoparquet` *writer* always computes its own from the
geometry when `writeCovering` is on — that is a different thing.)

**Pruning is now separate from that.** A GeoParquet 2.0 file (native Parquet
`GEOMETRY` logical type) carries a per-row-group bbox in the footer as
`GeospatialStatistics`, with no covering column anywhere. `estimate()` falls
back to those automatically, and the `row-group-bbox` stage then reports
`basis: 'native geometry statistics'` and no `no-covering` warning. Measured
live on 2026-11-17, against a Kenya bbox:

| dataset | row groups before | after |
|---|---|---|
| s2-stac-geoparquet (2025) | 825 | **27** |
| FIRMS detections (2025) | 582 | **6** |
| fieldmaps subnational ADM2 | 68 | **5** |

The fallback also fires when a declared covering turns out to be *unusable* —
which is not hypothetical: a STAC-GeoParquet `bbox` column is a LIST
(`[xmin, ymin, xmax, ymax]`), not a struct, so a `struct` covering inferred
from its name reads `bbox.xmin`, gets nothing, and used to report
`basis: 'covering bbox'` while pruning nothing *and* suppressing the
`no-covering` warning.

There is still no per-ROW bbox in a native-stats file, so a row-level test
decodes geometry exactly as `{ kind: 'none' }` does.

### 11. Raw passthrough (recipe 3e) is complete and unfiltered, and its `rows` can be `null`

Moved above pitfalls 12/13 (whole-branch review, final fix wave): this list
is explicitly "ordered by how badly they bite", and silently-unfiltered
output bites harder than an unimplemented `clip` mode or an inert
version-skew check — the gap this pitfall describes was a CRITICAL finding
in review, reachable in two clicks through the demo's "Max rows" input.

`output.format: 'parquet-raw'` applies `where`, `columns`, `filter.limit`,
and row-level spatial filtering to **nothing** — only whole-file pruning
runs (partition/time/bbox against a file's own declared metadata), because
nothing is ever decoded. Row-level spatial filtering is dropped whenever
**any `Area` is passed at all**, regardless of `filter.spatial.mode` —
`'bbox'` filters rows by their own bbox on the decoded path just as
`'intersects'`/`'clip'` do, and an omitted `spatial` block defaults to
`'intersects'` downstream, so there is no mode that makes row-level
filtering a no-op once an area exists. `est.warnings`'
`raw-passthrough-unfiltered` names which of `where`/`columns`/
`spatial-row-level`/`limit` your filter asked for and got silently skipped;
read it, or a user gets every row of a file bigger than the request implied,
with no explanation why. `DownloadResult.truncated` stays `false` on this
path regardless — the warning is disclosure, not a change to that field.

`est.rows` is `null`, not a `Bounded`, whenever any selected file has no
declared `rowCount` — most STAC-sourced datasets, always. This is honesty,
not a bug: a modeled guess has no place on the one path whose entire point
is exactness. Don't call `.max`/`.estimate` on it unconditionally the way you
would on every other recipe's `est.rows`.

An unknown file **size** is handled differently and does NOT block the
download: the ceiling's `outputBytes`/`readBytes` checks compare against the
sum of KNOWN sizes only, while the `Bounded` reported back still carries
`max: Infinity` and `exact: false` so nothing mistakes that partial sum for
a real bound. `files` (the file count) is the one ceiling dimension an
unknown size can never evade — it is always known. This is a deliberate
choice ("warn distinctly, always proceed", not "warn, then require explicit
acceptance"): the common case — every STAC-sourced file — publishes no size
at all, and refusing by default there would make the feature unusable for
exactly the datasets it targets.

One consequence of "warn distinctly, always proceed" worth stating plainly:
in a browser with no File System Access API (Firefox, Safari as of this
writing), `autoSink` falls back to `blobSink`, which caps **any** download
at 256 MiB and refuses above it with `SINK_QUOTA_EXCEEDED`. On the raw path
that cap cannot be predicted up front whenever part sizes are unpublished
(the STAC-sourced case above) — the run starts, streams, and only then dies
at 256 MiB, because there was nothing to evaluate the ceiling against
before the first byte moved. This is the accepted trade-off of proceeding
on an unknown size, not a bug to work around; `SINK_QUOTA_EXCEEDED` already
names the lever (a filesystem-backed sink has no such cap).

The public `estimate()` (from `@cngeo/extract-core`'s `index.js`) routes
`output.format === 'parquet-raw'` to `planRaw`/`rawEstimate` — both
exported — and reads **no parquet footers at all**, which is the point of
the path. `estimate` imported directly from `extract-core/src/estimate.js`
(as that module's own unit tests do) does **not** route; only the package's
public entry point does, so always import `estimate` from
`@cngeo/extract-core` itself, never a deeper path.

`suggestedFormats` (on a `CEILING_EXCEEDED` error's context, recipe 4) never
names `parquet-raw`: it works by running each registered format's
synchronous `estimateBytes` and comparing against that format's own
ceiling, and `parquet-raw` has no `estimateBytes` — its size comes from part
metadata, not a schema+rows model. So a gpkg ceiling breach can suggest
`geojson`/`geoparquet` but will never suggest the raw path, even when raw
would be the best answer ("gpkg won't fit, but raw streams to disk
unbounded"). Discovery doesn't depend on the suggestion list: offer
`parquet-raw` directly in your own format picker, the way the demo does.

Also worth knowing: `raw-no-pruning`'s `basis` field can go silent on a
**mixed** dataset — some selected parts declare a `bbox`/`interval` and
genuinely match, others declare neither and pass trivially — because the
check is `selected.every(...)`. Neither branch fires in that case, so a
user sees no pruning warning at all on a selection that partly "matched"
only by having nothing to check against. Not a correctness bug (the
`basis` string, when present, is never wrong) — just a gap this single
string can't yet express.

### 12. `clip` is not implemented

`spatial.mode: 'clip'` fails with `FILTER_REQUIRES_ENGINE` before any fetch.
Use `'intersects'`. Same for `whereSql` (needs `'sql'`) and an `Area` with
`combine: 'dissolve'` (needs `'dissolve'`).

### 13. Version-skew checking is currently inert

The live catalogs publish no `cng:catalog_version` footer key, so
`onVersionSkew: 'error'` neither errors nor warns. Identity is still safe —
resolution always re-locates rows by key, never by a cached offset — but do not
rely on the check catching a rebuilt catalog.

---

## Error handling

```js
import { isCngError } from '@cngeo/spec';   // or from @cngeo/extract-core

try {
  await handle.result;
} catch (err) {
  if (!isCngError(err)) throw err;
  switch (err.code) {
    case 'CEILING_EXCEEDED': /* show the estimate + a "download anyway" */ break;
    case 'CANCELLED':        /* never surface this */ break;
    case 'FORMAT_UNAVAILABLE': /* name the plugin needed */ break;
    default:
      if (err.retryable) retry();
      else report(err.code, err.message, err.context);
  }
}
```

**The `code` is the API. Messages are for humans and may be reworded; codes may
not.** `retryable` is `true` by default for `INDEX_FETCH_FAILED`,
`DATASET_UNRESOLVED`, `SINK_PERMISSION_DENIED`, `NETWORK`. Full tables:
[extract-core](packages/extract-core/README.md#error-codes),
[upload-core](packages/upload-core/README.md#error-codes),
[spec](packages/spec/README.md#errors).

Codes reserved in the taxonomy but **not raised by this build**:
`DATASET_NO_GEOMETRY_COLUMN`, `DATASET_CRS_UNSUPPORTED`,
`FILTER_UNKNOWN_COLUMN`, `CORS`, `HTTP_STATUS`, `AREA_ANTIMERIDIAN_CLIP`. Match
on them anyway; they will not change meaning.

---

## Verifying your work

```bash
npm test                              # 1,400+ unit tests. Offline, but for two integration tests
                                      # (extract-core, format-gpkg) that read source.coop and
                                      # fail when that host does: re-run before believing them.
npm run check:deck                    # the committed deck.gl bundle equals a fresh build
node docs/verify-snippets.mjs         # every snippet in every doc, against live data
node docs/verify-snippets.mjs agents  # just this file's recipes 1-5
node docs/verify-snippets.mjs widgets # recipes 6-9, the widgets' headless halves

python3 serve.py 8000 &               # real Range support; -m http.server will not do
node examples/quickstart/verify.mjs 8000
node examples/download-demo/verify.mjs 8000
node examples/layers-demo/verify.mjs 8000        # recipe 6
node examples/imagery-search/verify.mjs 8000     # recipe 7: Sentinel-2, NAIP and OpenAerialMap (add `naip` for one)
node examples/catalog-search/verify.mjs 8000     # recipe 8
node examples/timeline-firms/verify.mjs 8000     # recipe 9

# Starts its own server; needs no running serve.py. The File System Access
# path -- the one `npm test` cannot reach, because no Node runtime has a
# `FileSystemWritableFileStream` and no headless browser can open a save
# dialog. Drives the real `download()` into a real OPFS writable, which has
# the same swap-file commit semantics a picker handle does.
node packages/extract-core/test/browser/filesystem-sink.verify.mjs
```

If you add a widget to a page, copy the shape of one of the
[`examples/*/verify.mjs`](examples/) scripts: navigate, wait on a visible
status string, assert on the actual map source data
(`map.getSource('cng-area-display')._data`) rather than a screenshot, and fail
on any console error. That pattern caught every real bug in this repo's
history.
