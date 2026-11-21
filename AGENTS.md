# AGENTS.md — wiring up `@cngeo/*`

For AI agents and anyone who wants the facts without the prose. Every snippet
here is executed against live published data by
[`docs/verify-snippets.mjs`](docs/verify-snippets.mjs)
(`node docs/verify-snippets.mjs agents`). If you change a snippet, change it
there too.

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

Live catalogs you can use right now:

```
GB  https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json
    52,398 names, ADM0/1/2, CC-BY-4.0, 3.9 MB index (full-load)
OV  https://data.source.coop/portolan-mirrors/cn-gazetteer-overture/names/index.json
    5,604,413 names, 5 levels, multilingual, ODbL-1.0 SHARE-ALIKE, 409 MB index
    (range path) + an 8.6 MB eager "prominent" subset
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
    "@cngeo/maplibre":        "/packages/maplibre/src/index.js"
  }
}
</script>
```

Do **not** add `hyparquet` to that map. The packages `import()` it themselves
from pinned absolute CDN URLs (`src/cdn.js` in each). Nothing is on npm yet;
when it is, each line becomes
`https://cdn.jsdelivr.net/npm/@cngeo/<name>@0.3.0/src/index.js` and no module
code changes.

**Without a clone**, swap the relative paths for the published site — the
packages are static files, so this works from any page anywhere:

```
https://cholmes.github.io/cng-map-widgets/packages/<name>/src/index.js
```

or, pinned to a tag,

```
https://cdn.jsdelivr.net/gh/cholmes/cng-map-widgets@v0.3.0/packages/<name>/src/index.js
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
  - **streaming** (`memoryFactor: 0` — `geojson`, `parquet-raw`): unbounded
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
    defaults to `3`; `geoparquet` declares `2`, `gpkg` declares `2.9`):
    `outputBytes = memoryBudget / memoryFactor` — `memoryBudget` defaults to
    **1 GiB** — because the cost is spent inside the writer (row arrays, a
    wasm heap, an export copy), not in where the bytes land, this derivation
    itself does not vary by sink *kind*. But a `blob` sink (or `sink: null`,
    the same conservative treatment as the streaming case above)
    additionally clamps the result to `blobBytes`
    (`Math.min(derived, blobBytes)`): `blobSink` genuinely refuses above 256
    MiB at write time regardless of what a format's memory factor would
    otherwise allow, so `geoparquet` (512 MiB derived) and `gpkg` (~353 MiB
    derived) would otherwise pass this gate only to die at the sink's own
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
`newlineDelimited`, `featureIdColumn`), `geoparquet` (`memoryFactor: 2` —
**buffers its whole output in memory**, so its ceiling's `outputBytes` is
`memoryBudget / 2` (512 MiB) on a `filesystem` sink, but clamped down to the
flat `blobBytes` (256 MiB) on a `blob` sink or `sink: null` — see "Ceilings
are derived per format and sink" above; options `compression` — `'snappy'`
default, `'none'` ok, `'zstd'` **refused** with `FORMAT_CAPABILITY`;
`rowGroupSize`, `writeCovering`), and `parquet-raw` (`memoryFactor: 0`, no
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
npm test                              # 400+ unit tests, no network
node docs/verify-snippets.mjs         # every snippet in every doc, against live data
node docs/verify-snippets.mjs agents  # just this file's recipes

python3 serve.py 8000 &               # real Range support; -m http.server will not do
node examples/quickstart/verify.mjs 8000
node examples/download-demo/verify.mjs 8000

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
