# AGENTS.md — wiring up `@cnmw/*`

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

1. A **cloud-native gazetteer** is published static data: a names-index parquet
   + an `index.json` manifest + per-level boundary parquets, on object storage.
2. `@cnmw/geocoder-core` reads it over HTTP range requests and emits an
   **`Area`**.
3. `@cnmw/upload-core` emits the same `Area` from a GeoJSON file.
4. `@cnmw/download-core` consumes an `Area` + a `DatasetDescriptor` +
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
    "@cnmw/spec":            "/packages/spec/src/index.js",
    "@cnmw/geocoder-core":   "/packages/geocoder-core/src/index.js",
    "@cnmw/upload-core":     "/packages/upload-core/src/index.js",
    "@cnmw/download-core":   "/packages/download-core/src/index.js",
    "@cnmw/maplibre":        "/packages/maplibre/src/index.js"
  }
}
</script>
```

Do **not** add `hyparquet` to that map. The packages `import()` it themselves
from pinned absolute CDN URLs (`src/cdn.js` in each). Nothing is on npm yet;
when it is, each line becomes
`https://cdn.jsdelivr.net/npm/@cnmw/<name>@0.1.0/src/index.js` and no module
code changes.

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
import { setHyparquetModules as setGeocoderModules } from '@cnmw/geocoder-core';
import { setHyparquetModules as setDownloadModules } from '@cnmw/download-core';

setGeocoderModules({ hyparquet, compressors });
setDownloadModules({ hyparquet, compressors, writer });   // `writer` only for GeoParquet output
```

Pinned versions: `hyparquet@1.33.0`, `hyparquet-compressors@1.1.3`,
`hyparquet-writer@0.18.0`. Every snippet below runs in Node with those two
calls in place.

---

## Recipe 1 — an `Area` from a live gazetteer

```js
import { Geocoder } from '@cnmw/geocoder-core';

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

Hard rules:

- `indexUrl` is the **manifest** (`index.json`), not the parquet, and must be a
  **string**. An array (the designed multi-source form) is unimplemented and
  silently falls back to `DEFAULT_INDEX_URL`, which is `'./data/index.json'` —
  a development path. Always pass it explicitly.
- `search()` is safe on every keystroke. A **superseded search resolves to
  `[]`, never rejects.**
- `searchSync()` is zero-await but throws `GEOCODER_NOT_LOADED` unless
  `state === 'ready'` **and** the index was fully loaded (not the range path).
- Pass `{ viewport: [w, s, e, n] }` to `search()` for the ranking boost. It
  genuinely reorders: `"contra"` → `Contralmirante Villar` without it,
  `Contra Costa` with a Bay Area viewport.

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
import { toAreaDocument, fromAreaDocument } from '@cnmw/spec';

const doc = toAreaDocument(area);       // extras under `area:*`, snake_case
const restored = fromAreaDocument(JSON.parse(JSON.stringify(doc)));  // validates on the way in
```

```js
// Attribution: read BOTH key styles. A geocoder Area's entries come
// straight off the manifest (snake_case); download-core's derived ones are
// camelCase. Checking only `shareAlike` silently misses ODbL obligations.
for (const a of area.provenance.attribution) {
  const shareAlike = a.shareAlike ?? a.share_alike;
  display(a.text, a.license, a.url, shareAlike);
}
```

---

## Recipe 3 — a `DownloadRequest` for each dataset kind

A `DownloadRequest` is `{ spec: 'cnmw-request/1.0', dataset, filter, output,
generator? }`. All plain JSON. `filter.area` is either an inline `AreaDocument`
or `{ ref: 'area' }` to defer to the runtime argument.

### 3a. One GeoParquet file (`kind: 'parquet'`)

```js
const request = {
  spec: 'cnmw-request/1.0',
  dataset: {
    spec: 'cnmw-dataset/1.0',
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
    spec: 'cnmw-filter/1.0',
    area: { ref: 'area' },
    spatial: { mode: 'intersects' },          // 'bbox' | 'intersects' (default) | 'clip' (unimplemented)
    where: [{ col: 'confidence', op: '>=', value: 0.9 }],
    columns: { include: ['id', 'confidence'] },
    limit: 50,
  },
  output: { spec: 'cnmw-output/1.0', format: 'geojson', filename: 'ftw-liechtenstein.geojson' },
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
import { resolveDataset, estimate } from '@cnmw/download-core';

const dataset = await resolveDataset({
  spec: 'cnmw-dataset/1.0',
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
dataset.table.bbox;           // { kind: 'none' } -- FIRMS publishes no covering
dataset.table.rowCount;       // 632471436

const filter = {
  spec: 'cnmw-filter/1.0',
  area: { ref: 'area' },
  spatial: { mode: 'intersects' },
  time: { column: 'acq_datetime', start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z', closed: '[)' },
  columns: { exclude: ['instrument', 'satellite'] },
  limit: 100,
};

const est = await estimate(dataset, area, filter);
est.files;        // { total: 27, selected: 1 }  <- the time filter alone, zero data requests
est.prune;        // [{ stage: 'part-time', before: 27, after: 1, basis: '…' }, …]
est.warnings;     // includes { code: 'no-covering' }
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
  spec: 'cnmw-dataset/1.0',
  id: 'sentinel-2-c1-l2a',
  source: {
    kind: 'portolan-collection',
    url: 'https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json',
  },
});
dataset.source.kind;              // 'stac-geoparquet'
dataset.attribution[0].shareAlike;  // true -- CC-BY-SA-3.0-IGO

const filter = {
  spec: 'cnmw-filter/1.0',
  area: { ref: 'area' },
  spatial: { mode: 'intersects' },
  time: { start: '2025-06-01T00:00:00Z', end: '2025-06-08T00:00:00Z', closed: '[)' },
  where: [{ col: 'eo:cloud_cover', op: '<=', value: 20 }],
  columns: { include: ['id', 'datetime', 'eo:cloud_cover'], includeBbox: true },
  limit: 100,
};

const est = await estimate(dataset, area, filter);
est.files;        // { total: 12, selected: 1 }
est.rowGroups;    // { total: 825, selected: 824 } -- no covering, so almost nothing prunes
est.requests;     // 838  <- plan for this; reads are sequential today
est.columns;      // ['id', 'datetime', 'eo:cloud_cover', 'geometry']
est.warnings;     // includes 'no-covering' and 'share-alike'
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

### Checking a collection before building anything

```js
import { collectionDownloadSupport } from '@cnmw/download-core';

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
import { download, memorySink, autoSink } from '@cnmw/download-core';

// In a browser, from a user gesture (showSaveFilePicker needs one):
//   const sink = await autoSink({ suggestedName: 'fields.geojson' });
// Headless / tests:
const sink = memorySink();

const handle = download(dataset, area, filter, output, { sink });
// `download()` returns SYNCHRONOUSLY so you can cancel during planning.
handle.state;   // 'planning'

// 1. Always inspect the estimate before awaiting the result.
const est = await handle.estimate;        // resolves even when the ceiling trips

if (est.ceiling.exceeded) {
  // A blocked handle's `result` NEVER settles on its own. Pick one:
  if (est.rows.max <= 10_000) handle.acceptCeiling();
  else await handle.cancel('over budget');
}

// 2. Progress, if you want it.
handle.on('progress', (p) => {
  if (p.phase === 'reading') report(p.rowGroupsDone, p.rowGroupsTotal, p.rowsMatched);
});

// 3. The result.
const result = await handle.result;
result.rows;        // 795
result.bytes;       // bytes written
result.readBytes;   // bytes pulled from object storage
result.truncated;   // true iff `filter.limit` bound
result.attribution; // pass this on to whatever consumes the file
sink.chunks;        // the bytes, for memorySink
```

**The rule for an automated caller: never `await handle.result` without first
awaiting `handle.estimate` and handling `ceiling.exceeded`.** Otherwise a
breach hangs you forever.

Defaults you are overriding when you pass `ceiling`: 5,000,000 rows, 2 GiB
output, 4 GiB read, 500 files, 256 MiB blob.

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
inherits a share-alike license).

Output formats: `geojson` (streaming; options `precision`, `newlineDelimited`,
`featureIdColumn`) and `geoparquet` (**buffers everything in memory**; options
`compression` — `'snappy'` default, `'none'` ok, `'zstd'` **refused** with
`FORMAT_CAPABILITY`; `rowGroupSize`, `writeCovering`). Anything else must be
registered first; `formats()` lists what is available without loading any of
it.

---

## Recipe 5 — an uploaded `Area` is interchangeable

```js
import { areaFromFile, areaFromGeoJson, attachDropTarget } from '@cnmw/upload-core';

const { area, warnings } = await areaFromFile(file);
// ...or from a value you already have:
const r = await areaFromGeoJson(geojsonValue, { name: 'box.geojson' });

// The SAME estimate() call works on it. No branching anywhere downstream.
const est = await estimate(dataset, area, { spec: 'cnmw-filter/1.0', spatial: { mode: 'intersects' } });
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
the file. `normalizeName` from `@cnmw/spec` is the function that produces it:
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
`@cnmw/download-core`, which normalizes bytes-or-object.

### 2. `area.filterGeometry` can be `null`

It is a real state, not an error: the filter geometry could not be produced
within the 5% `areaDeltaMaxRatio`. Filtering falls back to `bboxes` alone and
`estimate()` raises `degraded-to-bbox`. If you dereference
`area.filterGeometry.coordinates`, you crash on exactly the big countries users
search for first.

### 3. Attribution keys are inconsistent, and it matters for ODbL

A geocoder `Area` carries the manifest's `snake_case` (`share_alike`);
`download-core`'s collection-derived attribution uses `shareAlike`. Read
`a.shareAlike ?? a.share_alike`. Checking only one silently reports no
share-alike obligation on Overture-sourced data.

### 4. A `blocked` download handle hangs forever

Covered in recipe 4. `await handle.estimate` first, then `acceptCeiling()` or
`cancel()`. The design doc says `result` rejects with `CeilingExceededError`;
it does not.

### 5. `geometryRef.row` is a `BigInt`

Parquet `INT64`. `JSON.stringify(searchResult)` **throws** `TypeError: Do not
know how to serialize a BigInt`:

```js
JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? String(v) : v));
```

### 6. `bbox` can have `west > east`

Anything doing `east - west` on `Area.bbox` is wrong for Fiji and Russia.
Use `bboxes`.

### 7. Synchronous simplification is O(m²)

`@cnmw/spec`'s `simplifyToVertexCeiling` measured 38 ms at 1,000 vertices,
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

### 9. Reads are sequential; plan for request count, not bytes

`maxConcurrentRequests` is accepted and ignored. The s2 footprints estimate
planned **838 requests** for a one-week, one-country query. `est.requests` is
the number to show a user and the number to budget against.

### 10. `includeBbox: true` is a no-op without a covering

The covering columns come from `table.bbox`. On `{ kind: 'none' }` there is
nothing to include. (The `geoparquet` *writer* always computes its own from the
geometry when `writeCovering` is on — that is a different thing.)

### 11. `clip` is not implemented

`spatial.mode: 'clip'` fails with `FILTER_REQUIRES_ENGINE` before any fetch.
Use `'intersects'`. Same for `whereSql` (needs `'sql'`) and an `Area` with
`combine: 'dissolve'` (needs `'dissolve'`).

### 12. Version-skew checking is currently inert

The live catalogs publish no `cnmw:catalog_version` footer key, so
`onVersionSkew: 'error'` neither errors nor warns. Identity is still safe —
resolution always re-locates rows by key, never by a cached offset — but do not
rely on the check catching a rebuilt catalog.

---

## Error handling

```js
import { isCnmwError } from '@cnmw/spec';   // or from @cnmw/download-core

try {
  await handle.result;
} catch (err) {
  if (!isCnmwError(err)) throw err;
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
[download-core](packages/download-core/README.md#error-codes),
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
```

If you add a widget to a page, copy the shape of one of the
[`examples/*/verify.mjs`](examples/) scripts: navigate, wait on a visible
status string, assert on the actual map source data
(`map.getSource('cnmw-area-display')._data`) rather than a screenshot, and fail
on any console error. That pattern caught every real bug in this repo's
history.
