# @cnmw/download-core

Give it an `Area` and a dataset, get a file. In the browser, against object
storage, with **no server and no API** — it reads GeoParquet footers over HTTP
range requests, prunes everything it can from metadata alone, filters the
surviving rows, and streams the result to disk.

```js
const est = await estimate(dataset, area, filter);     // footers only -- 2 HTTP requests
const handle = download(dataset, area, filter, output, { sink });
const result = await handle.result;                    // 769 rows, 938 KB written
```

Three things make this more than a parquet reader:

- **The estimate is honest.** Every number is a `Bounded` with an `exact` flag,
  so a UI can say "between 2,000 and 400,000 rows" instead of pretending to
  know. Read bytes come from column-chunk sizes and *are* exact; row counts
  come from a selectivity model and say so.
- **The ceiling is a refusal, not a cap.** Over a limit, the download stops and
  waits for an explicit `acceptCeiling()`. Nothing is silently truncated.
- **Nothing heavy is implicit.** hyparquet is the only engine in core
  (DuckDB-WASM would be 3–9 MB, 15–45× the whole widget). Formats and engines
  are *registered*, never lazily imported.

- **Status:** experimental, pre-npm. See the [root README](../../README.md).
- **Normative design:** [`docs/design/widgets-architecture.md`](../../docs/design/widgets-architecture.md) §2 (descriptor + filter + worked examples), §3.4 (API), §3.5 (errors).
- **License:** MIT (code). **Downloaded data keeps its own license** — `estimate()` raises a `share-alike` warning and `DownloadResult.attribution` carries what you must pass on.

---

## Install / import

```html
<script type="importmap">
{
  "imports": {
    "@cnmw/spec": "/packages/spec/src/index.js",
    "@cnmw/download-core": "/packages/download-core/src/index.js"
  }
}
</script>
<script type="module">
  import { estimate, download, autoSink } from '@cnmw/download-core';
</script>
```

`hyparquet`, `hyparquet-compressors` and `hyparquet-writer` are **not** in that
map: this package `import()`s them from pinned, exact CDN URLs (`src/cdn.js`),
lazily — `hyparquet-writer` is only fetched if you actually write GeoParquet.
In Node or a bundler, inject your own: see [Node and bundlers](#node-and-bundlers).

**Coming:** `npm i @cnmw/download-core`.

## Size

| | files | raw | gzip | gzip, comments stripped | design-doc budget (§4.5) |
|---|---|---|---|---|---|
| `@cnmw/download-core` src | 21 | 125.3 KiB | 37.6 KiB | **19.8 KiB** | ≤ 30 KB min+gz |
| `+ @cnmw/spec` | | | | 6.2 KiB | ≤ 10 KB |
| `+ hyparquet@1.33.0` | | 199.9 KiB | 46.9 KiB | — | 35 KB (at 1.26.0) |
| `+ hyparquet-compressors@1.1.3` | | | 69.1 KiB *(jsdelivr `+esm`, as fetched)* | — | 79 KB |
| `+ hyparquet-writer@0.18.0` | | | 19.5 KiB *(jsdelivr `+esm`, as fetched)* | — | ~20 KB *(est.)* |

`hyparquet-writer` is loaded **only** by the `geoparquet` format plugin, on
first use. A GeoJSON-only page never pays for it.

---

## Minimal example

Everything below is real: a published GeoParquet file (Fields of The World's
Liechtenstein tile, 218 KB / 795 fields / 1 row group) and an `Area` from a
GeoJSON box. No fixtures.

```js
import { estimate, download, memorySink } from '@cnmw/download-core';
import { areaFromGeoJson } from '@cnmw/upload-core';

const dataset = {
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
    bbox: { kind: 'struct', column: 'bbox' },     // the single most valuable field here
    columns: [
      { name: 'id', type: 'string' },
      { name: 'geometry', type: 'geometry' },
      { name: 'confidence', type: 'float32' },
      { name: 'bbox', type: 'struct' },
    ],
  },
  attribution: [{ text: 'Fields of The World', license: 'CC-BY-4.0', shareAlike: false }],
};

const filter = {
  spec: 'cnmw-filter/1.0',
  spatial: { mode: 'intersects' },
  where: [{ col: 'confidence', op: '>=', value: 0.5 }],
  columns: { include: ['id', 'confidence'] },
};

const { area } = await areaFromGeoJson(
  { type: 'Polygon', coordinates: [[[9.47, 47.05], [9.47, 47.28], [9.64, 47.28], [9.64, 47.05], [9.47, 47.05]]] },
  { name: 'liechtenstein-box' },
);

// --- estimate: parquet footers only, no row data -------------------------
const est = await estimate(dataset, area, filter);
est.readBytes;      // { min: 204945, max: 204945, estimate: 204945, exact: true }
est.rows;           // { min: 0, max: 795, estimate: …, exact: false }
est.files;          // { total: 1, selected: 1 }
est.rowGroups;      // { total: 1, selected: 1 }
est.requests;       // 2
est.columns;        // ['id', 'confidence', 'geometry']
est.warnings;       // [{ code: 'single-row-group', … }]
est.ceiling.exceeded;  // false
est.prune.map((s) => s.stage);   // ['row-group-bbox', 'row-group-stats']

// --- download ------------------------------------------------------------
const sink = memorySink();
const handle = download(dataset, area, filter,
  { spec: 'cnmw-output/1.0', format: 'geojson', filename: 'fields.geojson' },
  { sink });

handle.state;       // 'planning'  -- the handle exists before any await

const result = await handle.result;
result.rows;        // 769
result.bytes;       // 938135
result.requests;    // 1   -- one coalesced range read for the surviving row group
result.readBytes;   // 204945
result.truncated;   // false
result.attribution[0].license;   // 'CC-BY-4.0'
```

In a browser, replace `memorySink()` with `await autoSink({ suggestedName:
'fields.geojson' })` to stream straight to disk — but call it from a user
gesture, because `showSaveFilePicker` requires one.

---

## The three documents

A download is described by plain, serializable JSON — no code. That is
deliberate: the same document can be pasted into a web app, a notebook, or the
QGIS plugin and produce the same rows.

### `DatasetDescriptor` — where the data is, what shape it has

`source.kind` is one of:

| kind | shape |
|---|---|
| `parquet` | `{ url }` — one GeoParquet file. |
| `parquet-set` | `{ urls[], parts? }` — an explicit list making one logical table. |
| `hive` | `{ scheme: 'hive', glob, keys[], strategy?, fileCount?, enumeration, parts? }` |
| `stac-geoparquet` | the same, plus `stac: { datetimeColumn, idColumn, collectionColumn }` defaults. |
| `portolan-collection` | `{ url, asset? }` — name a collection JSON and let `resolveDataset()` derive the rest. |

`table` is `{ geometryColumn, geometryEncoding, crs, bbox, timeColumn?,
rowCount?, columns? }`. **`table.bbox` is the single most valuable field in the
whole descriptor** — it is what makes row-group pruning possible without
decoding geometry:

| `bbox` | meaning |
|---|---|
| `{ kind: 'struct', column: 'bbox', fields? }` | A struct column, as CGAZ/FTW publish and GeoParquet 1.1 specifies. |
| `{ kind: 'columns', xmin, ymin, xmax, ymax }` | Four top-level columns. |
| `{ kind: 'none' }` | No covering. Pruning cannot narrow the read, and the estimate says so (`no-covering`). |

Omit `table` entirely and it is inferred from the first file's parquet schema —
`geometry` if present, a `bbox` struct if present, otherwise nothing.

### `FilterSpec` — which rows and columns

```js
{
  spec: 'cnmw-filter/1.0',
  area: { ref: 'area' },        // or an inline AreaDocument; see downloadRequest()
  spatial: { mode: 'intersects', includeBboxTouch: false },
  time: { column: 'acq_datetime', start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z', closed: '[)' },
  where: [ /* ANDed Predicates */ ],
  whereSql: { dialect: 'duckdb', fragment: '…' },   // needs an engine that can run it
  columns: { include: [...] } /* or */ { exclude: [...] },
  limit: 5000,
  partitions: { year: { op: 'in', values: [2026] } },
  requires: [],
}
```

`spatial.mode`:

| mode | behaviour |
|---|---|
| `bbox` | bbox prune only. Fastest, over-selects at the edges. |
| `intersects` | **the default** — bbox prune, then a real point-in-polygon / edge test against `Area.filterGeometry`. |
| `clip` | designed, **not implemented in core**: refused with `FILTER_REQUIRES_ENGINE`. Clipping mutates features, so it will never be implicit. |

`time.closed` defaults to `'[)'` so adjacent windows tile without
double-counting.

### `OutputRequest` + `DownloadRequest`

```js
{ spec: 'cnmw-output/1.0', format: 'geojson', filename: 'fields.geojson', options: { precision: 6 } }
```

A `DownloadRequest` is `{ spec: 'cnmw-request/1.0', dataset, filter, output,
generator? }` — the copy-pasteable unit, runnable with `downloadRequest()`.

---

## API reference

Verified by [`docs/verify-snippets.mjs`](../../docs/verify-snippets.mjs)
(`node docs/verify-snippets.mjs download`) against live published data.

### `estimate(dataset, area, filter, options?) => Promise<Estimate>`

Metadata only: resolves the descriptor, enumerates and prunes partitions, reads
one footer per surviving file, prunes row groups by bbox-covering and time
statistics. **It never reads a data page.**

`Estimate`:

| field | type | notes |
|---|---|---|
| `requestDigest` | `string` | SHA-256 hex of the canonicalized dataset + area id + filter. Pairs an estimate with its download. |
| `rows` | `Bounded` | `exact: true` only when nothing filters at all. Otherwise a bbox-overlap-weighted selectivity model. |
| `readBytes` | `Bounded` | **Exact** — summed `total_compressed_size` of the columns actually read in the selected row groups. |
| `outputBytes` | `Bounded` | A bytes-per-row model. Standalone `estimate()` uses a generic one; `download()` recomputes it with the real format's `estimateBytes`. |
| `files` | `{ total, selected }` | |
| `rowGroups` | `{ total, selected } \| null` | |
| `requests` | `number` | HTTP requests the download will issue. Surfaced because on this path request *depth* is the latency, not bytes. |
| `prune` | `PruneStage[]` | `{ stage, before, after, basis }` per stage, in order. This is the narration a UI should show. |
| `columns` | `string[]` | The output projection. |
| `warnings` | `EstimateWarning[]` | |
| `ceiling` | `{ exceeded, limits, breaches }` | |
| `elapsedMs` | `number` | |

`Bounded` is `{ min, max, estimate, exact }`. **`exact: true` means the number
came from metadata, not a model.**

Warning codes: `no-covering`, `no-statistics`, `single-row-group`,
`degraded-to-bbox`, `antimeridian-split`, `estimate-wide` (`max/estimate > 10`),
`share-alike`.

Prune stages, in order: `partition` (explicit `filter.partitions`), `part-time`,
`part-bbox`, `row-group-bbox`, `row-group-stats`. Row-level filtering happens
during the download, not the estimate.

### `download(dataset, area, filter, output, options?) => DownloadHandle`

**Returns synchronously.** A handle that only existed after an `await` could not
be cancelled during planning, which is exactly when a user changes their mind.

| `options` | default | notes |
|---|---|---|
| `sink` | `await autoSink({ suggestedName: output.filename })` | |
| `acceptCeiling` | `false` | `true` pre-authorizes a breach. |
| `ceiling` | `defaultCeiling()` | Partial override. |
| `engine` | the built-in hyparquet engine | |
| `fetch` | `globalThis.fetch` | |
| `signal` | — | Aborts reads; see the cancel gotcha below. |
| `maxConcurrentRequests` | — | **Accepted but not implemented**: this build reads one row group at a time, sequentially. |

`DownloadHandle`:

| member | notes |
|---|---|
| `id`, `state` | `'planning' \| 'blocked' \| 'running' \| 'paused' \| 'done' \| 'cancelled' \| 'failed'`. |
| `estimate` | `Promise<Estimate>` — resolves even when the ceiling trips. |
| `result` | `Promise<DownloadResult>`. **Stays pending while `blocked`** — see below. |
| `progress` | `AsyncIterable<Progress>`, latest-wins (a progress bar wants the newest number, not every number). |
| `on(event, handler)` | `=> unsubscribe`. |
| `acceptCeiling()` | The refusal override. Only meaningful while `blocked`. |
| `pause()` / `resume()` | Cooperative, at row-group boundaries. |
| `cancel(reason?)` | Aborts reads, aborts the writer and sink, removes the partial file for a filesystem sink we created, and resolves once settled. |

Events: `state`, `estimate`, `ceiling` (once, before `blocked`), `progress`,
`warning`, `done`, `error`.

`Progress` phases: `planning`, `pruning`, `reading` (with `rowGroupsDone`,
`rowGroupsTotal`, `bytesRead`, `rowsScanned`, `rowsMatched`, `requests`),
`writing`, `finalizing`.

`DownloadResult`: `{ rows, bytes, format, filename, elapsedMs, requests,
readBytes, sink, estimate, truncated, attribution }`. `sink` is
`{ kind: 'memory', chunks }`, `{ kind: 'blob', blob }`,
`{ kind: 'filesystem', handle }` or `{ kind: 'stream' }`.

### The ceiling: block, then decide

```js
// (1) Blocked and left alone -- `result` NEVER settles on its own.
const blocked = download(dataset, area, filter, output, { sink: memorySink(), ceiling: { rows: 10 } });
const est = await blocked.estimate;   // resolves anyway
est.ceiling.exceeded;                 // true
est.ceiling.breaches;                 // ['rows']
blocked.state;                        // 'blocked'
// ... await blocked.result here and you wait forever.
await blocked.cancel('too big');
await blocked.result;                 // rejects CnmwError { code: 'CANCELLED' }, state 'cancelled'

// (2) Accepted from the event -- the auditable override.
const accepted = download(dataset, area, filter, output, { sink: memorySink(), ceiling: { rows: 10 } });
accepted.on('ceiling', () => accepted.acceptCeiling());
(await accepted.result).rows;         // 769

// (3) Pre-accepted, when the caller already decided.
const pre = download(dataset, area, filter, output, { sink: memorySink(), ceiling: { rows: 10 }, acceptCeiling: true });
(await pre.result).rows;              // 769
```

**This diverges from the design doc**, which says `result` rejects with
`CeilingExceededError` when a blocked handle is not accepted. It does not; it
waits. Treat a `blocked` handle as requiring one of two calls. The practical
rule for any automated caller: **never `await handle.result` without first
inspecting `handle.estimate`.**

`defaultCeiling()`:

| limit | default |
|---|---|
| `rows` | 5,000,000 |
| `outputBytes` | 2 GiB |
| `readBytes` | 4 GiB |
| `files` | 500 |
| `blobBytes` | 256 MiB — Blob-sink only, because a Blob is held in memory. |

A non-streaming format (`geoparquet`) whose `outputBytes.max` exceeds
`blobBytes` also breaches `blobBytes`, regardless of sink, because it buffers
in memory.

### `downloadRequest(request, area, options?) => DownloadHandle`

Runs a serialized `DownloadRequest`. An inline `filter.area` (an
`AreaDocument`) is used; `{ ref: 'area' }` defers to the `area` argument.

```js
import { toAreaDocument } from '@cnmw/spec';

const request = {
  spec: 'cnmw-request/1.0',
  dataset,
  filter: { ...filter, area: toAreaDocument(area), limit: 25 },
  output: { spec: 'cnmw-output/1.0', format: 'geojson', filename: 'fields.geojson' },
  generator: { name: 'my-app', version: '1.0.0', at: new Date().toISOString() },
};

const result = await downloadRequest(request, null, { sink: memorySink() }).result;
result.rows;        // 25
result.truncated;   // true -- `limit` bound
```

### `resolveDataset(descriptor, options?) => Promise<DatasetDescriptor>`

Turns a `portolan-collection` source into a concrete one. Every other kind is
returned unchanged. The derivation is the design doc's §2.4 table, so the
Python side can implement the same mapping.

```js
const dataset = await resolveDataset({
  spec: 'cnmw-dataset/1.0',
  id: 'firms-detections',
  source: { kind: 'portolan-collection', url: 'https://data.source.coop/portolan-mirrors/firms-catalog/detections/collection.json' },
});

dataset.source.kind;              // 'hive'
dataset.source.strategy;          // 'temporal'
dataset.source.fileCount;         // 27
dataset.source.keys;              // [{ name: 'year', type: 'int32', description: '…' }]
dataset.source.enumeration;       // { kind: 'stac-items', collectionUrl: '…' }
dataset.table.timeColumn;         // 'acq_datetime'
dataset.table.bbox;               // { kind: 'none' }  -- FIRMS publishes no covering
dataset.table.rowCount;           // 632471436
dataset.attribution[0].license;   // 'CC0-1.0'
dataset.source.glob;              // 's3://portolan-mirrors/…'  <-- see the gotcha
```

### `descriptorFromCollection(collection, options?)` / `collectionDownloadSupport(collection, options?)`

The same derivation, **synchronous**, on a collection JSON you already have.
`options.baseUrl` is the collection's own URL — relative asset hrefs
(`./cgaz_adm0.parquet`, the Portolan norm) resolve against it.

`collectionDownloadSupport` is the non-throwing form, for a UI that renders
"unsupported" as the *absence* of a widget rather than an error dialog:

```js
collectionDownloadSupport(collection, { baseUrl });
// { supported: true, descriptor: { … } }

collectionDownloadSupport({
  id: 'some-cogs', license: 'CC-BY-4.0',
  assets: { data: { href: './scene.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] } },
}, { baseUrl: 'https://example.org/c/collection.json' });
// { supported: false, code: 'DATASET_UNSUPPORTED',
//   message: "Downloads aren't supported for raster/zarr data. Found: image/tiff; …" }
```

### Partition enumeration

A browser cannot list an object-storage prefix, so `enumeration` says how to
learn the partition values:

| kind | cost |
|---|---|
| `collection-mirror` | **Preferred** — one small STAC-GeoParquet fetch gives every partition's url, bbox, row count and interval. 1 request. |
| `stac-items` | N requests (concurrency 8, hard cap 200 items), one per `item` link. Hrefs are resolved relative to the collection, and asset hrefs relative to the item. |
| `values` | One JSON array of partition-value tuples. 1 request. |
| `declared` | `PartitionKey.values` inline; the glob is filled by cross product. 0 requests. |
| `bucket-listing` | `?list-type=2&prefix=` against an S3-compatible endpoint. Opt-in; many hosts refuse. |

`enumeratePartitions(source, options?)` and
`partitionPruneCascade(parts, areaBBoxes, time, explicitPartitions)` are
exported for direct use.

### Formats

| | id | ext | media type | streaming | options |
|---|---|---|---|---|---|
| built in | `geojson` | `.geojson` | `application/geo+json` | **yes** | `precision` (7), `newlineDelimited` (false → RFC 8142 sequences), `featureIdColumn` |
| built in | `geoparquet` | `.parquet` | `application/vnd.apache.parquet` | **no** | `compression` (`'snappy'`), `rowGroupSize` (50,000), `writeCovering` (true) |

Two registration shapes:

- **`registerFormat(plugin)`** — eager. You hand over a ready `FormatPlugin`.
  This is what the two built-ins use.
- **`registerLazyFormat(descriptor)`** — deferred. You hand over a small static
  descriptor (`id`, `label`, `extension`, `mediaType`, `streaming`,
  `capabilities`, `approxBytes`, a pure `estimateBytes`) plus
  `load() => Promise<FormatPlugin>`. The heavy part is fetched on first use,
  **but its weight is listed before that happens** — so a format picker can
  render "GeoPackage (+~480 KB)" and only pay for it if the user picks it.

`formats()` lists both kinds and **never triggers a `load()`**. It returns
descriptor-shaped objects, not plugins: `{ id, label, extension, mediaType,
streaming, capabilities, lazy, loadState }`, where a lazy entry also carries
`approxBytes` and a `loadState` of `'idle' | 'loading' | 'loaded' | 'failed'`.

| export | notes |
|---|---|
| `formats()` | List everything registered, for a picker. No side effects. |
| `getFormat(id)` | Synchronous. An eager plugin, or a lazy one already loaded; `undefined` for a lazy format not yet loaded — it deliberately never triggers `load()`. |
| `resolveFormat(id)` | `Promise<FormatPlugin \| undefined>`. The one place `load()` is called, at most once per id per page; concurrent calls share the in-flight promise. `download()` awaits this. |
| `formatLoadState(id)` | `'idle' \| 'loading' \| 'loaded' \| 'failed' \| 'unknown'`. |

A `load()` may resolve to the plugin, an ESM module whose `default` is the
plugin or a zero-arg factory, or a factory directly — all are normalized.
A failing `load()` throws `FORMAT_LOAD_FAILED` (carrying `context.approxBytes`
and the original error as `cause`) and leaves the id re-attemptable rather than
caching a permanent rejection.

An id that was never registered at all fails with `FORMAT_UNAVAILABLE` naming
it. **Deferred loading does not relax the zero-build rule:** a plugin's
`load()` is documented to `import()` an *exact pinned absolute CDN URL*, never
a bare specifier — the rule was always "no bare specifiers" (which need a
bundler or a host-maintained import map), not "no dynamic imports".

The GeoParquet writer hand-builds GeoParquet 1.1 `geo` metadata and, by
default, a bbox covering — so the output is itself prunable:

```js
const sink = memorySink();
await download(dataset, area, filter,
  { spec: 'cnmw-output/1.0', format: 'geoparquet', filename: 'fields.parquet' },
  { sink }).result;

const bytes = Buffer.concat(sink.chunks.map(Buffer.from));
const meta = hyparquet.parquetMetadata(bytes.buffer);
Number(meta.num_rows);                               // 769
meta.schema.slice(1).map((s) => s.name);
// ['id', 'confidence', 'geometry', 'bbox_xmin', 'bbox_ymin', 'bbox_xmax', 'bbox_ymax']
const geo = JSON.parse(meta.key_value_metadata.find((kv) => kv.key === 'geo').value);
geo.version;                                         // '1.1.0'
geo.columns.geometry.covering.bbox.xmin;             // ['bbox_xmin']
```

**zstd is refused, not silently downgraded:**

```js
download(dataset, area, filter,
  { spec: 'cnmw-output/1.0', format: 'geoparquet', options: { compression: 'zstd' } },
  { sink: memorySink() }).result;
// rejects CnmwError { code: 'FORMAT_CAPABILITY' }
```

`hyparquet-compressors` is decompress-only; there is no pure-JS zstd
*compressor* among this package's dependencies. Use `'snappy'` (the default) or
`'none'`. The design doc defaults to zstd; that is not achievable today, and
guessing would produce a file that claims a codec it did not use.

### Sinks

| export | notes |
|---|---|
| `autoSink({ suggestedName? })` | **The default.** `fileSystemSink` where available, else `blobSink`. Opens the save picker, so **call it from a user gesture**. A dismissed dialog throws `SINK_PERMISSION_DENIED`. |
| `fileSystemSink({ handle, suggestedName?, keepPartial? })` | Streams to disk. Requires a `FileSystemFileHandle` you obtained from `showSaveFilePicker` yourself — this function never opens the picker. Removes the partial file on abort unless `keepPartial`. |
| `blobSink({ maxBytes? })` | Buffers, exposes `.blob`. Over `maxBytes` (256 MiB) → `SINK_QUOTA_EXCEEDED`. |
| `streamSink(stream)` | Wraps a `WritableStream<Uint8Array>` you own. |
| `memorySink()` | Collects `.chunks`. For tests, and for headless automation (no native dialog). |

### Engines

`createHyparquetEngine()` is the only one in core: `id: 'hyparquet'`,
`capabilities: ['bbox', 'intersects']`. `registerEngine(engine)` / `engines()`
add and list. A filter needing a capability the engine lacks fails with
`FILTER_REQUIRES_ENGINE` **before a byte is fetched**:

```js
requirementsOf({ spatial: { mode: 'intersects' } });                    // []
requirementsOf({ spatial: { mode: 'clip' } });                          // ['exact-clip']
requirementsOf({ spatial: { mode: 'intersects' }, whereSql: { dialect: 'duckdb', fragment: 'x > 1' } });  // ['sql']

await estimate(dataset, area, { ...filter, spatial: { mode: 'clip' } });
// rejects CnmwError { code: 'FILTER_REQUIRES_ENGINE' }
```

### Predicates and spatial tests, standalone

```js
import { evaluateWhere, evaluatePredicate, getPath, rowMatchesArea } from '@cnmw/download-core';

const row = { confidence: 0.95, kind: 'field', names: { primary: 'Westfield' }, tags: ['a', 'b'], retired: null };
evaluateWhere([{ col: 'confidence', op: '>=', value: 0.9 }], row);          // true
evaluateWhere([{ col: 'kind', op: 'in', values: ['field', 'orchard'] }], row); // true
evaluateWhere([{ col: 'names.primary', op: 'ilike', value: 'west%' }], row);   // true
evaluateWhere([{ col: 'retired', op: 'is_null' }], row);                       // true
evaluateWhere([{ col: 'confidence', op: 'between', low: 0.9, high: 1 }], row); // true
evaluatePredicate({ op: 'or', args: [
  { col: 'kind', op: '=', value: 'nope' },
  { col: 'confidence', op: '>', value: 0.5 },
] }, row);                                                                      // true

getPath(row, 'names.primary');   // 'Westfield'
getPath(row, 'tags[1]');         // 'b'
getPath(row, 'nothing.here');    // undefined

// The row-level spatial test: bbox prune first, then the exact geometry test.
const triangle = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [0, 10], [0, 0]]] };
const areaLike = { bboxes: [[0, 0, 10, 10]], filterGeometry: triangle };
rowMatchesArea({ featureBBox: [9, 9, 9.5, 9.5], featureGeometry: { type: 'Point', coordinates: [9.2, 9.2] } },
  areaLike, { mode: 'intersects' });      // false -- in the bbox, outside the triangle
rowMatchesArea({ featureBBox: [9, 9, 9.5, 9.5] }, areaLike, { mode: 'bbox' });   // true
rowMatchesArea({ featureBBox: [50, 50, 51, 51] }, areaLike, { mode: 'intersects' }); // false
```

Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not_in`, `between`,
`is_null`, `is_not_null`, `like`, `ilike`, `not_like`, plus `and` / `or` /
`not` nodes. `where[]` entries are ANDed. `col` may be a dotted path into a
struct with `[n]` list subscripts; a path through a MAP is unvalidatable and is
passed through unchecked.

### Also exported

`registerFormat`, `registerLazyFormat`, `formats`, `getFormat`,
`resolveFormat`, `formatLoadState`, `registerEngine`, `engines`,
`createGeoJsonFormat`, `createGeoParquetFormat`, `createHyparquetEngine`,
`HYPARQUET_ENGINE_ID`, `defaultCeiling`, `requirementsOf`,
`decodeWkbGeometry`, `bboxOfAnyGeometry`, `bboxIntersectsAny`,
`pointInGeometry`, `geometriesIntersect`, `geometryIntersectsArea`,
`boundedExact`, `boundedRange`, `addBounded`, `sumBounded`, `scaleBounded`,
`capBounded`, `isEstimateWide`, `enumeratePartitions`,
`partitionPruneCascade`, `pruneRowGroupsByBBox`, `pruneRowGroupsByTime`,
`CDN`, `loadHyparquet`, `loadHyparquetWriter`, `setHyparquetModules`,
`clearHyparquetModules`, `CnmwError`, `CancelledError`,
`CeilingExceededError`, `isCnmwError`, `VERSION`.

`decodeWkbGeometry` is `@cnmw/spec`'s `wkbToGeoJson` extended with Point and
MultiPoint (which FIRMS needs), and passing an already-decoded GeoJSON object
through unchanged (which GeoParquet 2.0's native `GEOMETRY` logical type
produces). Folding that back into `@cnmw/spec` is a known follow-up.

---

## Error codes

Thrown as `CnmwError` with a stable `code`. **The code is the API; messages may
be reworded.**

| code | retryable | what the UI should say / do |
|---|---|---|
| `DATASET_UNRESOLVED` | yes | Collection JSON unreachable or malformed. Also: unreadable parquet metadata. |
| `DATASET_UNSUPPORTED` | no | Design call #8's graceful refusal. "Downloads aren't supported for raster/zarr data." Names what was found. |
| `DATASET_NO_GEOMETRY_COLUMN` | no | "This table has no geometry column." |
| `DATASET_CRS_UNSUPPORTED` | no | Name the CRS found and the `ogr2ogr` command that fixes it. 4326/CRS84 only. |
| `FILTER_UNKNOWN_COLUMN` | no | Name the column and the nearest match. |
| `FILTER_UNSUPPORTED_PREDICATE` | no | The engine cannot express the predicate. |
| `FILTER_REQUIRES_ENGINE` | no | "This filter needs the DuckDB engine plugin." Names the requirement (`sql`, `exact-clip`, `dissolve`). |
| `AREA_ANTIMERIDIAN_CLIP` | no | "Exact clip is not available across the antimeridian. Use intersects." |
| `CEILING_EXCEEDED` | no | **The refusal path.** Show the estimate, the limit, and a "download anyway" that calls `acceptCeiling()`. |
| `FORMAT_UNAVAILABLE` | no | No plugin registered for that format id. "GeoPackage output needs the @cnmw/format-gpkg plugin." |
| `FORMAT_LOAD_FAILED` | no | A lazy format's `load()` threw -- usually its CDN fetch. Carries `context.approxBytes`; the id stays re-attemptable. |
| `FORMAT_CAPABILITY` | no | e.g. zstd, or nested columns into GeoPackage. Offer GeoParquet. |
| `SINK_PERMISSION_DENIED` | yes | The user dismissed the save picker. Not worth a dialog. |
| `SINK_QUOTA_EXCEEDED` | no | "Too large to buffer in memory; use a browser that supports direct-to-disk saving." |
| `SINK_UNSUPPORTED` | no | Internal fallback from FS to Blob; surfaced only if both fail. |
| `NETWORK` | yes | Generic fetch failure. **Also what an abort during planning currently surfaces** — see the gotcha. |
| `CORS` | no | Distinguished from `NETWORK` because the fix is the publisher's. Names the host. |
| `HTTP_STATUS` | depends | `context.status`; retryable for 5xx/429. |
| `CANCELLED` | no | Never surfaced to the user. |
| `INTERNAL` | no | A bug. Include the package version. |

Plus everything `@cnmw/spec` can throw on an `Area` (`AREA_INVALID_CRS`,
`AREA_UNSUPPORTED_GEOMETRY`, `AREA_EMPTY`, `AREA_VERTEX_CEILING`).

Codes in the table that this build does not yet raise:
`DATASET_NO_GEOMETRY_COLUMN`, `DATASET_CRS_UNSUPPORTED`,
`FILTER_UNKNOWN_COLUMN`, `FILTER_UNSUPPORTED_PREDICATE` (raised only for an
unknown operator), `CORS`, `HTTP_STATUS`, `AREA_ANTIMERIDIAN_CLIP` (reachable
only once `clip` exists). They are reserved so a consumer can match on them
without a later breaking change.

```js
const handle = download(
  { spec: 'cnmw-dataset/1.0', source: { kind: 'parquet', url: 'https://data.source.coop/does-not-exist-404.parquet' } },
  null, { spec: 'cnmw-filter/1.0', spatial: { mode: 'bbox' } },
  { spec: 'cnmw-output/1.0', format: 'geojson' }, { sink: memorySink() });

await handle.result;   // rejects; isCnmwError(err) === true, err.code is NETWORK / HTTP_STATUS / DATASET_UNRESOLVED
handle.state;          // 'failed'
```

---

## Node and bundlers

```js
import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import * as writer from 'hyparquet-writer';
import { setHyparquetModules } from '@cnmw/download-core';

setHyparquetModules({ hyparquet, compressors, writer });   // once, before the first estimate()
```

`writer` is only needed for GeoParquet output. `clearHyparquetModules()`
restores the CDN path. Pinned versions in `src/cdn.js`: `hyparquet@1.33.0`,
`hyparquet-compressors@1.1.3`, `hyparquet-writer@0.18.0`.

Inside a bundler this is not optional hygiene: `import(CDN.hyparquet)` is a
runtime-computed specifier no bundler can rewrite, so without injection a
bundled app that already has hyparquet runs a second copy off the network.

---

## Gotchas

### hyparquet needs `geoparquet: false` **and** `utf8: false` for raw WKB

The single most consequential finding in this codebase, and the cause of three
separate silent-corruption bugs:

```js
// WRONG -- GeoParquet auto-decode replaces the WKB with hyparquet's own GeoJSON.
const meta = await hyparquet.parquetMetadataAsync(file, { initialFetchSize: 65_536 });
const [row] = await hyparquet.parquetReadObjects({ file, metadata: meta, columns: ['geometry'], rowStart: 0, rowEnd: 1, compressors });
typeof row.geometry;   // 'object' -- already decoded, not bytes

// STILL WRONG -- geoparquet:false removes the GEOMETRY logical type, and
// hyparquet's fallback for an untyped BYTE_ARRAY column is utf8:true, which
// mangles binary WKB into a JS string (one UTF-16 unit per byte).
const rawMeta = await hyparquet.parquetMetadataAsync(file, { initialFetchSize: 65_536, geoparquet: false });
const [m] = await hyparquet.parquetReadObjects({ file, metadata: rawMeta, columns: ['geometry'], rowStart: 0, rowEnd: 1, compressors });
typeof m.geometry;     // 'string'  (!)

// RIGHT -- both flags, every time.
const [ok] = await hyparquet.parquetReadObjects({ file, metadata: rawMeta, columns: ['geometry'], rowStart: 0, rowEnd: 1, utf8: false, compressors });
ok.geometry instanceof Uint8Array;   // true
ok.geometry[0];                      // 1 -- the little-endian WKB byte-order marker
```

`geoparquet: false` goes on the **metadata** call (it lives on the returned
schema); `utf8: false` goes on every **read** call. A real string column
(`converted_type: 'UTF8'`) is unaffected by `utf8: false`, so there is no
downside to always passing it.

And separately: **`parquetMetadataAsync(file, 65536)` silently ignores the
number.** The second argument is always an options *object*
(`{ parsers, initialFetchSize, geoparquet }`); destructuring those off a
`Number` yields `undefined` for all of them and you quietly get hyparquet's own
defaults. This dormant-bug shape existed in both this package and
`@cnmw/geocoder-core`.

### GeoParquet 2.0 is a different mechanism

FIRMS and s2-stac-geoparquet use the **native** Parquet `GEOMETRY` logical
type, not the older "BYTE_ARRAY + `geo` kv-metadata sidecar" convention.
hyparquet auto-decodes a native-logical-type column *unconditionally*,
independent of the `geoparquet` flag — which only ever governed the sidecar
heuristic. So `row[geometryColumn]` is already a GeoJSON object for those
datasets. `decodeWkbGeometry` normalizes either input; without that check,
every row crashed trying to read WKB type bytes out of
`new Uint8Array({type:'Point',…})`, which silently produces a zero-length
buffer rather than throwing something legible.

### Range reads must be `cache: 'no-store'`

Which this package does internally. Chrome serializes concurrent reads of one
URL behind its cache lock: **2.1 s → 0.4 s for the same eight reads**, measured.

### A Portolan `partition:glob` is an `s3://` URI

Both live catalogs publish `glob: 's3://…'`. A browser cannot fetch that, and
glob expansion is useless to it anyway. **Rely on `enumeration`** —
`collection-mirror` or `stac-items` — which yields real HTTPS asset hrefs.
`enumeratePartitions` does this for you; it only falls back to filling the glob
for the `declared` and `values` kinds.

### Cancelling during planning reports `NETWORK`, not `CANCELLED`

`handle.cancel()` called before reading starts aborts the in-flight footer
fetch, and that abort is wrapped as a `NETWORK` error on the way out — so
`state` lands on `'failed'` rather than `'cancelled'`. Cancelling a *running*
download behaves correctly. Match on both until this is fixed.

### `includeBbox: true` adds nothing without a covering

The covering columns are the output's `bbox` columns, derived from
`table.bbox`. On a dataset with `{ kind: 'none' }` (FIRMS, s2) there is nothing
to include, so the option is a silent no-op. It is not a way to *compute* a
bbox column on a dataset that lacks one — except in the `geoparquet` writer,
which always computes its own from the geometry when `writeCovering` is on.

### A single-row-group file cannot be pruned

`estimate()` raises `single-row-group` for exactly this. The tge-labs CGAZ
mirror is the canonical example: 97 MB in one row group, so every download
reads the whole bbox + geometry columns regardless of how small the area is.
This is why the project built an optimized mirror instead.

### `geoparquet` output buffers everything in memory

`streaming: false`. `hyparquet-writer`'s `parquetWriteBuffer` wants the whole
column-oriented dataset up front, so the whole result is held before a byte is
written. The `blobBytes` ceiling check applies regardless of sink. Use
`geojson` with `newlineDelimited: true` for anything genuinely large.

### `maxConcurrentRequests` is accepted and ignored

Row groups are read one at a time, sequentially. The design doc's parallel-read
story (12 concurrent, which is where the `no-store` finding came from) is not
implemented here. On a many-row-group read this is the main performance gap:
the s2 footprints estimate planned **838 requests** for one query.

### Timestamps and BigInts in output

GeoJSON output converts `BigInt` to `Number` and `Date` to an ISO string.
GeoParquet output must *widen* unsigned types — `uint32` → INT64, because
hyparquet-writer has no unsigned physical type and inferring INT32 from early
small values throws the moment a later value exceeds the signed range (found
writing s2's `_hilbert` column). A column whose declared type this package does
not recognize gets no explicit type and is inferred, which is the same trap.

## Tests

```
node --test packages/download-core/test/*.test.js
```

10 files: `Bounded` arithmetic, collection→descriptor derivation, the
`DownloadHandle` state machine (ceiling/accept/cancel/pause, via a fake engine
so the math is tested without a network), GeoParquet decode and write,
partition enumeration and pruning, predicates, row-group pruning, spatial
tests, WKB geometry, and a real-network integration test.

End-to-end against live catalogs:
[`examples/download-demo/verify.mjs`](../../examples/download-demo/verify.mjs),
[`examples/firms-explorer/verify.mjs`](../../examples/firms-explorer/verify.mjs),
[`examples/s2-footprints/verify.mjs`](../../examples/s2-footprints/verify.mjs),
and `docs/verify-snippets.mjs`.
