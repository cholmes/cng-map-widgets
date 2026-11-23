# @cngeo/extract-core

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
    "@cngeo/spec": "/packages/spec/src/index.js",
    "@cngeo/extract-core": "/packages/extract-core/src/index.js"
  }
}
</script>
<script type="module">
  import { estimate, download, autoSink } from '@cngeo/extract-core';
</script>
```

`hyparquet`, `hyparquet-compressors` and `hyparquet-writer` are **not** in that
map: this package `import()`s them from pinned, exact CDN URLs (`src/cdn.js`),
lazily — `hyparquet-writer` is only fetched if you actually write GeoParquet.
In Node or a bundler, inject your own: see [Node and bundlers](#node-and-bundlers).

**Coming:** `npm i @cngeo/extract-core`.

## Size

| | files | raw | gzip | gzip, comments stripped | design-doc budget (§4.5) |
|---|---|---|---|---|---|
| `@cngeo/extract-core` src | 21 | 125.3 KiB | 37.6 KiB | **19.8 KiB** | ≤ 30 KB min+gz |
| `+ @cngeo/spec` | | | | 6.2 KiB | ≤ 10 KB |
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
import { estimate, download, memorySink } from '@cngeo/extract-core';
import { areaFromGeoJson } from '@cngeo/upload-core';

const dataset = {
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
  spec: 'cng-filter/1.0',
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
est.prune.map((s) => s.stage);   // ['row-group-bbox', 'row-group-stats', 'row-group-where']

// --- download ------------------------------------------------------------
const sink = memorySink();
const handle = download(dataset, area, filter,
  { spec: 'cng-output/1.0', format: 'geojson', filename: 'fields.geojson' },
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
  spec: 'cng-filter/1.0',
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
double-counting. The window is tested **per row** on the table's declared
`timeColumn`, with the same bounds the row-group statistics prune uses —
pruning alone only discards row groups wholly outside the window, and
before 0.3.0 that was all that ran, so a download carried every row of any
group that merely overlapped it. A row whose time is null is in no window.
With no declared `timeColumn` there is nothing to test per row; the
estimate says so with `no-statistics`.

### `OutputRequest` + `DownloadRequest`

```js
{ spec: 'cng-output/1.0', format: 'geojson', filename: 'fields.geojson', options: { precision: 6 } }
```

A `DownloadRequest` is `{ spec: 'cng-request/1.0', dataset, filter, output,
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
| `outputBytes` | `Bounded` | A bytes-per-row model, **never exact**. Standalone `estimate()` uses a generic, format-agnostic one (it has no `OutputRequest`, so it cannot know the format — treat it as order-of-magnitude only); `download()` recomputes it from the real format's `estimateBytes`, including the geometry term below, and *that* is the number its ceiling checks. |
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
`share-alike`, `large-download` (`{ bytes, estimatedSeconds }`, fires over
`largeDownloadBytes`, 1 GiB by default), `slow-download` (`{ estimatedSeconds
}`, fires over `SLOW_DOWNLOAD_SECONDS`, 120 s, at an assumed
`DEFAULT_THROUGHPUT_BYTES_PER_SECOND`, 10 MB/s) — nine codes so far.

Raw passthrough (`output.format: 'parquet-raw'`, below) adds three more:
`raw-passthrough-unfiltered` (`{ dropped }` — which
of `where` / `columns` / `spatial-row-level` / `limit` this path did NOT
apply, since nothing is decoded to apply them to; `spatial-row-level` fires
whenever any `Area` was passed, regardless of `filter.spatial.mode` — every
mode filters rows on the decoded path once an area exists; `limit` fires
whenever `filter.limit` was set, since a whole file is always returned
verbatim, never truncated), `raw-size-unknown` (`{
partsWithoutSize, partsTotal }` — at least one selected file's size could not
be resolved; `large-download`/`slow-download` are suppressed on that same
estimate rather than computed from a partial sum), `raw-no-pruning` (`{ basis
}` — the filter narrowed by area or time but every surviving file declares
no bbox/interval to prune by). `raw-no-pruning` checks `selected.every(...)`:
on a dataset where some files genuinely matched a declared bbox/interval and
others passed only because they declare none, neither this warning nor any
other signal fires for the second group — a known gap, not a correctness
bug.

**All twelve codes above — the nine first, plus these three raw-only ones —
are FLAT on the warning object**: `w.bytes`, never `w.context.bytes`.

Prune stages, in order: `partition` (explicit `filter.partitions`), `part-time`,
`part-bbox`, `row-group-bbox`, `row-group-stats` (the time column),
`row-group-where` (`filter.where` predicate pushdown, below). Every stage is
reported even when it pruned nothing, so the cascade's shape does not depend on
the query. Row-level filtering still happens during the download, not the
estimate.

#### Predicate pushdown: which `where[]` operators prune

A `where[]` predicate on a column with min/max footer statistics can drop whole
row groups *before* they are fetched, using the same machinery as the bbox and
time stages. Pruning is sound-only: a row group is dropped only when the
statistics **prove** no row in it can match. Anything unprovable keeps the row
group, and says so in the stage's `basis`.

| operator | prunes? |
|---|---|
| `=`, `!=`, `<`, `<=`, `>`, `>=` | yes |
| `in`, `not_in`, `between` | yes |
| `is_null`, `is_not_null` | yes |
| `like`, `ilike` | **no** — a prefix pattern is prunable in principle, but a leading `%` is not, and getting that wrong drops user data |
| `intersects` and any spatial op | no — that is the `row-group-bbox` stage's job |
| anything inside a negated `not` | no — the negation inverts what the statistics prove |
| a path with `[`, i.e. into a list/struct element | no — chunk statistics describe the leaf, not the element |

Always unprunable, whatever the operator: a column with no statistics in the
footer, statistics of a non-comparable or mixed type, and a comparison between
a string and a number. Each falls back to "keep the row group".

**Measured, live** (`estimate()` only — footers, no row data), reading the
`row-group-where` stage's own before/after:

| dataset + predicate | row groups | requests | read bytes |
|---|---|---|---|
| FIRMS 2024 Africa, `brightness >= 500` | 649 → **147** | 678 → 176 | **−77.4%** (1.13 GB → 254 MB) |
| s2 2025 Kenya, `_month = 7` | 825 → 808 | 839 → 822 | −2.0% |
| FIRMS 2024 Africa, `confidence_pct >= 95` | 649 → 649 | — | 0% (stats exist; every group's range spans 95) |
| FIRMS 2024 Africa, `satellite = "N"` | 649 → 649 | — | 0% |
| s2 2025 Kenya, `eo:cloud_cover <= 1` | 825 → 825 | — | 0% |
| s2 2025 Kenya, `s2:tile_id like 'S2B%'` | 825 → 825 | — | 0%, and the basis says `no statistics-prunable operator` |

So: when it works it is dramatic (a 77% smaller read), and on five of six real
predicates it does nothing at all. That is the honest shape of statistics
pruning on files that were not sorted for your predicate — the same lesson the
bbox stage already teaches on a dataset with no covering.

### `download(dataset, area, filter, output, options?) => DownloadHandle`

**Returns synchronously.** A handle that only existed after an `await` could not
be cancelled during planning, which is exactly when a user changes their mind.

| `options` | default | notes |
|---|---|---|
| `sink` | `await autoSink({ suggestedName: output.filename })` | |
| `acceptCeiling` | `false` | `true` pre-authorizes a breach. |
| `ceiling` | `effectiveCeiling({ format, sink })` | Partial override, merged in via `overrides`; see below. **Not** `defaultCeiling()` — that flat-`outputBytes` helper is unchanged but no longer what `estimate()`/`download()` use. |
| `engine` | the built-in hyparquet engine | |
| `fetch` | `globalThis.fetch` | |
| `signal` | — | Aborts reads; see the cancel gotcha below. |
| `maxConcurrentRequests` | `12` | Parallel row-group reads, with ordered delivery. Lower it for a file with very large row groups (up to this many decoded groups are live at once); `1` is the old sequential behaviour. |

`DownloadHandle`:

| member | notes |
|---|---|
| `id`, `state` | `'planning' \| 'blocked' \| 'running' \| 'paused' \| 'done' \| 'cancelled' \| 'failed'`. |
| `estimate` | `Promise<Estimate>` — resolves even when the ceiling trips. |
| `result` | `Promise<DownloadResult>`. A **getter** over the live run's promise: it **rejects with `CeilingExceededError`** the moment the handle goes `blocked`, and `acceptCeiling()` installs a fresh one — see below. |
| `progress` | `AsyncIterable<Progress>`, latest-wins (a progress bar wants the newest number, not every number). |
| `on(event, handler)` | `=> unsubscribe`. |
| `acceptCeiling()` | The refusal override. **Returns the continued run's `Promise<DownloadResult>`**, because the one you were holding has already rejected. Idempotent when not `blocked`. |
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

### The ceiling: refuse, then decide

A breach **rejects**; it does not wait. The rejection carries the estimate,
so awaiting `result` alone is a safe way to drive a download.

```js
// (1) Blocked: `result` rejects with CeilingExceededError.
const blocked = download(dataset, area, filter, output, { sink: memorySink(), ceiling: { rows: 10 } });
try {
  await blocked.result;
} catch (err) {
  err.code;                           // 'CEILING_EXCEEDED'
  err.context.breaches;               // ['rows']
  err.context.estimate.rows.max;      // 795 -- the whole Estimate is here
  blocked.state;                      // 'blocked' -- still decidable
}
await blocked.estimate;               // also still resolves, if you prefer that shape
await blocked.cancel('too big');
blocked.state;                        // 'cancelled'

// (2) Accepted from the event -- the auditable override. `acceptCeiling()`
//     returns the CONTINUED run's promise, because the one above is settled.
const accepted = download(dataset, area, filter, output, { sink: memorySink(), ceiling: { rows: 10 } });
const continued = await new Promise((r) => accepted.on('ceiling', () => r(accepted.acceptCeiling())));
continued.rows;                       // 769
(await accepted.result).rows;         // 769 -- `result` now returns that same promise

// (3) Pre-accepted, when the caller already decided: never blocks.
const pre = download(dataset, area, filter, output, { sink: memorySink(), ceiling: { rows: 10 }, acceptCeiling: true });
(await pre.result).rows;              // 769
```

Two consequences worth knowing:

- **A promise captured before the breach stays rejected.** Promises settle
  once, and the run does not end at a breach — so `result` is a getter over
  a per-run deferred, and you re-read it (or use `acceptCeiling()`'s return
  value) after accepting.
- **Declining does not re-settle it.** `cancel()` while `blocked` moves
  `state` to `'cancelled'` but leaves the promise rejected with the
  `CEILING_EXCEEDED` it was already given, rather than switching error codes
  underneath a caller who is holding it. Read `state`, or the `state` event,
  for the decision.

*Until 2026-11-12 this section documented the opposite — a blocked handle's
`result` never settled at all, and this README told automated callers to
inspect `handle.estimate` first to avoid deadlocking. That rule is gone.*

**A save dialog can appear moments before a refusal.** `effectiveCeiling`
needs the real sink kind (`blob` vs `filesystem` vs `memory` change the
number — see below), so `download()` now resolves/opens the sink —
including `autoSink`'s `showSaveFilePicker` — *before* the ceiling gate, not
after. A caller can see the picker, choose a file, and immediately get
`CEILING_EXCEEDED`. Mitigation: call `estimate()` with the same `output`
first and confirm before calling `download()` at all, so `download()`'s own
gate is only ever reached on a plan already approved.

`CeilingExceededError.context.suggestedFormats` lists other registered
formats whose own `effectiveCeiling` would fit this exact plan (`[]` when
none do). It is computed by running each candidate's synchronous
`estimateBytes` against the breaching plan and comparing it to *that*
candidate's own ceiling — never the breaching format's bytes against
another format's limit. It never names `parquet-raw`: that descriptor has
no `estimateBytes` (its size comes from file metadata, not a schema+rows
model), so the comparison loop skips it; a breach on the raw path itself
reports `suggestedFormats: []` outright, since no candidate loop runs there
at all. Don't read either list as exhaustive — call `formats()` directly if
an unusual format might actually serve the request.

### The ceiling: derived from the format and the sink, not one flat number

Since 2026-11-20, `estimate()`/`download()` compute the ceiling with
`effectiveCeiling({ format, sink, overrides: options.ceiling })` — a format's
own memory cost and the sink it is writing into, not one flat
`outputBytes` for every format. `defaultCeiling()` is **unchanged** (kept for
any existing caller that built on its flat shape directly) but is no longer
what the public functions use.

Flat limits, the same for every format (raised from `defaultCeiling()`'s
values now that `outputBytes` carries its own weight):

| limit | default |
|---|---|
| `rows` | 50,000,000 |
| `readBytes` | 64 GiB |
| `files` | 10,000 |
| `blobBytes` | 256 MiB — the budget for a streaming format's `outputBytes` on a `blob` sink, or when `sink` is not yet known, AND the clamp on a buffering format's `memoryBudget / memoryFactor` derivation on that same sink kind (never on `memory` or `filesystem`). |

`outputBytes` is derived from `memoryFactorOf(format)` — `format.capabilities.memoryFactor`,
read without needing the format's `load()` to have run, defaulting to `0` for
a `streaming` format and `3` otherwise:

- **`memoryFactor === 0`** (streaming — `geojson`, `geoparquet`, `parquet-raw`): the format
  holds nothing of its own, so `outputBytes` is the 1 TiB sentinel
  `UNBOUNDED_BYTES` on a disk-backed (`filesystem`) sink or a `memory` sink,
  and `blobBytes` on a `blob` sink or `sink: null` (not yet created — the
  conservative choice when the real sink isn't known).
- **`memoryFactor > 0`** (buffering — `@cngeo/format-gpkg`'s `gpkg` declares
  `2.9`; `geoparquet` declared `2` until it began streaming): `outputBytes = Math.floor(memoryBudget / memoryFactor)`,
  where `memoryBudget` defaults to **1 GiB** (`MEMORY_BUDGET_DEFAULT`) —
  because the cost (row arrays, a wasm heap, an export copy) is spent
  inside the writer itself, not wherever the bytes land, this derivation
  itself does not vary by sink kind. **But a `blob` sink (or `sink: null`,
  the same conservative treatment as the streaming case above) additionally
  clamps that number to `blobBytes`** (`Math.min(derived, blobBytes)`):
  `blobSink` genuinely refuses to write above 256 MiB regardless of what a
  format's memory factor would otherwise allow (`SINK_QUOTA_EXCEEDED` in
  `sinks.js`), so `gpkg` (~353 MiB derived) would otherwise pass the gate
  only to die at the sink's own
  write-time limit, with no `suggestedFormats` on that late failure. A
  `filesystem` sink is not clamped — it has no 256 MiB limit to predict.

**The `memory`-sink exemption applies only when `memoryFactor === 0`, and
only to `blobBytes` — never to a buffering format's own derivation.** A
buffering format is `memoryBudget / memoryFactor` on a `memorySink` exactly
as on any other sink, with **no** `blobBytes` clamp there either — it is not
a loophole, because the format's own buffering cost doesn't care where the
output ends up, and `memorySink` is this package's own test/advanced sink
with no real write-time cap to predict. (An earlier draft of this
derivation waived the budget for *any* format on a memory sink, which left
`gpkg` unbounded there; fixed before release.)

An explicit `overrides.outputBytes` (i.e. `options.ceiling.outputBytes`)
always wins over either derivation. Import `effectiveCeiling`,
`memoryFactorOf`, `UNBOUNDED_BYTES`, `MEMORY_BUDGET_DEFAULT` to compute the
same numbers a UI would show before calling `download()`.

### `downloadRequest(request, area, options?) => DownloadHandle`

Runs a serialized `DownloadRequest`. An inline `filter.area` (an
`AreaDocument`) is used; `{ ref: 'area' }` defers to the `area` argument.

```js
import { toAreaDocument } from '@cngeo/spec';

const request = {
  spec: 'cng-request/1.0',
  dataset,
  filter: { ...filter, area: toAreaDocument(area), limit: 25 },
  output: { spec: 'cng-output/1.0', format: 'geojson', filename: 'fields.geojson' },
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
  spec: 'cng-dataset/1.0',
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
| built in | `geoparquet` | `.parquet` | `application/vnd.apache.parquet` | yes | `compression` (`'snappy'`), `rowGroupSize` (50,000), `rowGroupBytes` (64 MiB), `writeCovering` (true) |
| built in | `parquet-raw` | `.parquet` (or `.zip`, multi-file) | `application/vnd.apache.parquet` (`application/zip` for the multi-file case) | **yes** | none — see "Raw GeoParquet passthrough" below |

#### `estimateBytes(schema, rows, ctx?)` — the output-size model

```ts
estimateBytes(
  schema: readonly ColumnDescriptor[],
  rows: Bounded,
  ctx?: { avgGeometryBytes: number | null; geometryColumn: string },
): Bounded;
```

The third argument is **additive**: a plugin that ignores it, or a caller
invoking `estimateBytes(schema, rows)` with two arguments, keeps working and
falls back to that format's old constant-geometry model. `avgGeometryBytes` is
the average **uncompressed** bytes per row of the geometry column, derived from
footer statistics alone at estimate time, so the estimate stays metadata-only.
Uncompressed on purpose: what an output format expands from is the decoded WKB,
not whatever codec the source file used — zstd-19 WKB and raw WKB produce
identical GeoJSON. Each format then applies its own measured expansion factor
(GeoJSON ~1.55x WKB, CSV's WKT ~2.4x, GeoParquet's recompressed WKB well under
1x).

**Why it exists.** Every model counted attribute columns only and assumed a
small fixed constant for geometry. On boundary data that is wrong by orders of
magnitude, because geometry *is* the row. Modelled ÷ actual, measured against
three real datasets (ratios: 1.00 is perfect, below 1 under-estimates):

| dataset | format | actual written | before | after |
|---|---|---|---|---|
| CGAZ ADM0 display, 218 rows | geojson | 12,379,597 | 0.006 | **1.01** |
| | csv | 19,217,657 | 0.001 | **1.01** |
| | geoparquet | 8,044,920 | 0.003 | **1.01** |
| | esrijson | 19,728,426 | 0.003 | **1.01** |
| | shapefile | 8,115,740 | 0.007 | **1.00** |
| FTW Liechtenstein, 795 rows | geojson | 963,287 | 0.24 | **1.05** |
| | csv | 1,423,923 | 0.06 | **1.03** |
| | geoparquet | 199,790 | 0.36 | 3.08 |
| | esrijson | 1,500,215 | 0.14 | **1.02** |
| | shapefile | 748,985 | 0.22 | **1.08** |
| CGAZ ADM1 display, 400 rows | geojson | 6,860,896 | 0.019 | 0.41 |
| | csv | 10,465,804 | 0.005 | 0.41 |
| | geoparquet | 4,356,586 | 0.009 | 0.41 |
| | esrijson | 10,762,831 | 0.011 | 0.41 |
| | shapefile | 4,465,938 | 0.022 | 0.43 |

**Two honest residuals**, both visible above and neither hidden:

- **CGAZ ADM1 under-estimates by ~2.4x for every format.** The expansion factor
  is not actually constant — it depends on how many decimal digits each
  coordinate needs, and ADM1's display geometries measure 3.8x WKB as GeoJSON
  where ADM0's measure 1.5x. A single per-format multiplier cannot be right for
  both. Under-estimating is the dangerous direction for a ceiling, so this is a
  known gap, not a rounding quibble.
- **GeoParquet over-estimates by ~3x on FTW.** The model expands from
  *uncompressed* source WKB, but GeoParquet output is recompressed; when the
  source happens to be denser than the output's codec achieves, the model is
  high. Over-estimating only costs a spurious ceiling prompt.

Both are a large improvement on "geometry contributes 220 bytes a row". Before,
a 19 MB CSV modelled as 26 kB could never trip an `outputBytes` ceiling at all,
which made the ceiling decorative on exactly the datasets it exists for.

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
| `onFormatState(handler)` | `=> unsubscribe`. **Push, not poll.** Fires `{ id, state }` on every registration and every lazy-load transition, so a picker can re-read `formats()` when something actually changes. |

`formats()` and `formatLoadState()` are pull-only, and a lazy format's state
moves asynchronously underneath a UI that has already rendered — so without
`onFormatState` a format picker has to poll (the portolan-browser
integration was bumping a reactivity counter to force a re-read, which is
what prompted adding this). Handlers run synchronously in registration
order; one that throws is swallowed, so a broken subscriber cannot fail the
registration or `load()` that triggered it:

```js
import { onFormatState, formats } from '@cngeo/extract-core';

const off = onFormatState(({ id, state }) => {
  render(formats());                  // 'idle' | 'loading' | 'loaded' | 'failed'
});
// ... later
off();
```

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
  { spec: 'cng-output/1.0', format: 'geoparquet', filename: 'fields.parquet' },
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
  { spec: 'cng-output/1.0', format: 'geoparquet', options: { compression: 'zstd' } },
  { sink: memorySink() }).result;
// rejects CngError { code: 'FORMAT_CAPABILITY' }
```

`hyparquet-compressors` is decompress-only; there is no pure-JS zstd
*compressor* among this package's dependencies. Use `'snappy'` (the default) or
`'none'`. The design doc defaults to zstd; that is not achievable today, and
guessing would produce a file that claims a codec it did not use.

### Raw GeoParquet passthrough (`parquet-raw`)

`output.format: 'parquet-raw'` is not a decode-and-re-encode format like the
two above — it streams the **original published parquet bytes** straight
through: one selected file verbatim, never zipped even for a share-alike
license ("just get people the file"), or several files plus a generated
`ATTRIBUTION.txt` streamed into a zip64 archive when more than one survives
pruning. Nothing is read beyond the HTTP response bodies themselves: no
footer, no row group, no row-level filter.

Supported `dataset.source.kind`: `parquet`, `parquet-set`, `hive`,
`stac-geoparquet`. Not `portolan-collection` directly — call `resolveDataset()`
first, same as every other recipe. Only whole-file pruning runs (the
existing partition/time/bbox stages against a file's own declared metadata),
and `area.bboxes` is what gets compared, never the signed, antimeridian-
wrapping `area.bbox`.

```js
import { estimate, download, memorySink } from '@cngeo/extract-core';

const output = { spec: 'cng-output/1.0', format: 'parquet-raw' };
const est = await estimate(dataset, area, filter, { output });
est.rowGroups;   // { total: 0, selected: 0 } -- none is ever examined
est.columns;     // [] -- no projection; every column of every file passes through
est.rows;        // null when any selected file has no declared rowCount (the common
                // case for STAC-sourced parts) -- an honest unknown, not a model

const handle = download(dataset, area, filter, output, { sink: memorySink() });
const result = await handle.result;
result.bytes;    // the ORIGINAL file's byte count, for a single selected file
```

Zero matching files throws `FILTER_NO_MATCH`, not an empty result — there is
no "0 rows, still a valid file" state on this path.

Because nothing is decoded, `outputBytes`/`readBytes` can be **exact**
instead of modeled — the reason this path exists — but only when every
selected file's size is resolvable (its own declared `bytes`, else one
`HEAD` per sizeless file, never allowed to throw). When at least one size is
unknown: the reported `Bounded` keeps `max: Infinity` and `exact: false` (an
honest upper bound, never a guess), but the ceiling's `outputBytes`/
`readBytes` breach checks are judged against the sum of **known** sizes
only, so an unknown size alone can never manufacture a breach — a deliberate
choice (warn, then always proceed) over the alternative (warn, then require
explicit acceptance), because every STAC-sourced file publishes no size at
all and that is the common case this path serves, not an edge case. `files`
(the file count) is the one ceiling dimension that stays a hard backstop
regardless of size knowledge. See the warning codes above
(`raw-size-unknown`, `raw-no-pruning`, `raw-passthrough-unfiltered`).

`estimate()` (the public one, from this package's `index.js`) routes
`output.format === 'parquet-raw'` to `planRaw`/`rawEstimate` (both exported)
instead of the normal decode-path `estimate()`, and reads **no parquet
footers at all** — routing matters because the normal path would otherwise
both throw (`rawFormatDescriptor` deliberately has no `estimateBytes`) and,
even without the throw, do exactly the footer reads this path exists to
avoid. `estimate` imported directly from `src/estimate.js` (as that module's
own unit tests do) does **not** route; only this package's public entry
point does.

`parquet-raw` is registered (so `formats()` lists it) but never resolved
into the normal decode pipeline — `download()` branches to the raw path on
`output.format === RAW_FORMAT_ID` before any `getFormat()`/`resolveFormat()`
call. It is also never a `CeilingExceededError.context.suggestedFormats`
candidate for a *different* format's breach, because it has no
`estimateBytes` to compare; a breach on the raw path's own ceiling reports
`suggestedFormats: []` outright.

**The `blobSink` fallback caps a raw download at 256 MiB, and this cannot
always be predicted up front.** `parquet-raw` has `memoryFactor: 0`
(streaming), so `effectiveCeiling` already derives the right number — see
"Format-aware ceilings" above: unbounded on a disk-backed sink, `blobBytes`
(256 MiB) on a memory-backed one. In a browser without the File System
Access API (Firefox, Safari as of this writing), `autoSink` silently falls
back to `blobSink`, so a raw download there is capped at 256 MiB and
refuses above it with `SINK_QUOTA_EXCEEDED`. The one wrinkle is *when* that
refusal arrives: the ceiling can only be evaluated against **known** part
sizes (see above), and the common STAC-sourced case publishes none at all —
so the run starts, streams, and only then dies at 256 MiB, with no up-front
`CEILING_EXCEEDED` to catch first. This is not a bug to route around; it is
the accepted cost of "warn distinctly, always proceed" on an unknown size.
`SINK_QUOTA_EXCEEDED`'s message already names the lever (a filesystem-backed
sink has no such cap).

### Sinks

| export | notes |
|---|---|
| `autoSink({ suggestedName? })` | **The default.** `fileSystemSink` where available, else `blobSink`. Opens the save picker, so **call it from a user gesture**. A dismissed dialog throws `SINK_PERMISSION_DENIED`. |
| `fileSystemSink({ handle, suggestedName?, keepPartial? })` | Streams to disk. Requires a `FileSystemFileHandle` you obtained from `showSaveFilePicker` yourself — this function never opens the picker. Removes the partial file on abort unless `keepPartial`. |
| `blobSink({ maxBytes? })` | Buffers, exposes `.blob`. Over `maxBytes` (256 MiB) → `SINK_QUOTA_EXCEEDED`. |
| `streamSink(stream)` | Wraps a `WritableStream<Uint8Array>` you own. |
| `memorySink()` | Collects `.chunks`. For tests, and for headless automation (no native dialog). |

**The sink lifecycle, if you write your own:** one writable per run —
`open()` once, then exactly one of `close()` or `abort()`. **`close()` is
what commits.** A format plugin writes to the writer `open()` returned and
never closes it; closing is the sink's job, and for `fileSystemSink` it is
the atomic swap-file replace that makes the bytes appear in the user's
file. A sink whose `close()` does nothing produces a zero-byte file while
`DownloadResult.bytes` reports the full size — the format writer really did
hand the bytes over. `open()` twice on one sink throws `SINK_UNSUPPORTED`;
create a sink per download.
(`test/browser/filesystem-sink.verify.mjs` holds this against a real
`FileSystemWritableFileStream`.)

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
// rejects CngError { code: 'FILTER_REQUIRES_ENGINE' }
```

### Predicates and spatial tests, standalone

```js
import { evaluateWhere, evaluatePredicate, getPath, rowMatchesArea } from '@cngeo/extract-core';

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
`resolveFormat`, `formatLoadState`, `onFormatState`, `registerEngine`, `engines`,
`createGeoJsonFormat`, `createGeoParquetFormat`, `createHyparquetEngine`,
`HYPARQUET_ENGINE_ID`, `defaultCeiling`, `requirementsOf`,
`decodeWkbGeometry`, `bboxOfAnyGeometry`, `bboxIntersectsAny`,
`pointInGeometry`, `geometriesIntersect`, `geometryIntersectsArea`,
`boundedExact`, `boundedRange`, `addBounded`, `sumBounded`, `scaleBounded`,
`capBounded`, `isEstimateWide`, `enumeratePartitions`,
`partitionPruneCascade`, `pruneRowGroupsByBBox`, `pruneRowGroupsByTime`,
`CDN`, `loadHyparquet`, `loadHyparquetWriter`, `setHyparquetModules`,
`clearHyparquetModules`, `CngError`, `CancelledError`,
`CeilingExceededError`, `isCngError`, `VERSION`.

`decodeWkbGeometry` is `@cngeo/spec`'s `wkbToGeoJson` extended with Point and
MultiPoint (which FIRMS needs), and passing an already-decoded GeoJSON object
through unchanged (which GeoParquet 2.0's native `GEOMETRY` logical type
produces). Folding that back into `@cngeo/spec` is a known follow-up.

---

## Error codes

Thrown as `CngError` with a stable `code`. **The code is the API; messages may
be reworded.**

| code | retryable | what the UI should say / do |
|---|---|---|
| `DATASET_UNRESOLVED` | yes | Collection JSON unreachable or malformed. Also: unreadable parquet metadata or row data — **except** when the read was aborted, which reports `CANCELLED` instead. |
| `DATASET_UNSUPPORTED` | no | Design call #8's graceful refusal. "Downloads aren't supported for raster/zarr data." Names what was found. |
| `DATASET_NO_GEOMETRY_COLUMN` | no | "This table has no geometry column." |
| `DATASET_CRS_UNSUPPORTED` | no | Name the CRS found and the `ogr2ogr` command that fixes it. 4326/CRS84 only. |
| `FILTER_UNKNOWN_COLUMN` | no | Name the column and the nearest match. |
| `FILTER_UNSUPPORTED_PREDICATE` | no | The engine cannot express the predicate. |
| `FILTER_REQUIRES_ENGINE` | no | "This filter needs the DuckDB engine plugin." Names the requirement (`sql`, `exact-clip`, `dissolve`). |
| `FILTER_NO_MATCH` | no | Raw passthrough only (`output.format: 'parquet-raw'`): no file in the dataset matches the area/time/partition filter. `context.files` is how many files existed before the filter — there is no "0 rows, still a valid file" state on this path. |
| `AREA_ANTIMERIDIAN_CLIP` | no | "Exact clip is not available across the antimeridian. Use intersects." |
| `CEILING_EXCEEDED` | no | **The refusal path.** Show the estimate, the limit, and a "download anyway" that calls `acceptCeiling()`. |
| `FORMAT_UNAVAILABLE` | no | No plugin registered for that format id. "GeoPackage output needs the @cngeo/format-gpkg plugin." |
| `FORMAT_LOAD_FAILED` | no | A lazy format's `load()` threw -- usually its CDN fetch. Carries `context.approxBytes`; the id stays re-attemptable. |
| `FORMAT_CAPABILITY` | no | e.g. zstd, or nested columns into GeoPackage. Offer GeoParquet. |
| `SINK_PERMISSION_DENIED` | yes | The user dismissed the save picker. Not worth a dialog. |
| `SINK_QUOTA_EXCEEDED` | no | "Too large to buffer in memory; use a browser that supports direct-to-disk saving." |
| `SINK_UNSUPPORTED` | no | Internal fallback from FS to Blob; surfaced only if both fail. |
| `NETWORK` | yes | Generic fetch failure. **Also what an abort during planning currently surfaces** — see the gotcha. |
| `CORS` | no | Distinguished from `NETWORK` because the fix is the publisher's. Names the host. |
| `HTTP_STATUS` | depends | `context.status`; retryable for 5xx/429. |
| `CANCELLED` | no | Never surfaced to the user. Reported for an abort at any stage — planning footer read, row-group read, or between batches. |
| `INTERNAL` | no | A bug. Include the package version. |

Plus everything `@cngeo/spec` can throw on an `Area` (`AREA_INVALID_CRS`,
`AREA_UNSUPPORTED_GEOMETRY`, `AREA_EMPTY`, `AREA_VERTEX_CEILING`).

Codes in the table that this build does not yet raise:
`DATASET_NO_GEOMETRY_COLUMN`, `DATASET_CRS_UNSUPPORTED`,
`FILTER_UNKNOWN_COLUMN`, `FILTER_UNSUPPORTED_PREDICATE` (raised only for an
unknown operator), `CORS`, `HTTP_STATUS`, `AREA_ANTIMERIDIAN_CLIP` (reachable
only once `clip` exists). They are reserved so a consumer can match on them
without a later breaking change.

```js
const handle = download(
  { spec: 'cng-dataset/1.0', source: { kind: 'parquet', url: 'https://data.source.coop/does-not-exist-404.parquet' } },
  null, { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } },
  { spec: 'cng-output/1.0', format: 'geojson' }, { sink: memorySink() });

await handle.result;   // rejects; isCngError(err) === true, err.code is NETWORK / HTTP_STATUS / DATASET_UNRESOLVED
handle.state;          // 'failed'
```

---

## Node and bundlers

```js
import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import * as writer from 'hyparquet-writer';
import { setHyparquetModules } from '@cngeo/extract-core';

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
`@cngeo/geocoder-core`.

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

### Cancelling reports `CANCELLED` — including mid-read

Both halves of this used to be wrong, and both are fixed: cancelling during
planning surfaced `NETWORK` with `state: 'failed'` (the abort hit the
in-flight footer fetch and was wrapped as a network error), and cancelling
inside a row-group read surfaced `DATASET_UNRESOLVED` — a lie about a file
the user stopped reading on purpose. `parquet-io.js` now checks
`signal.aborted` whenever a footer or row read throws and reports
`CancelledError` (`code: 'CANCELLED'`, `state: 'cancelled'`), per design doc
§3.5 rule 1.

It tests the **signal**, not the error's name or type, because the abort
rejection's shape is not yours to predict: through the `fetch` option a host
can supply any implementation, and it may reject with something other than
an `AbortError` `DOMException`. If you write your own reader against this
package, do the same.

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

### `geoparquet` output streams, and keeps nested columns nested

`streaming: true`, `capabilities.memoryFactor: 0`, `nestedColumns: true`.

**Streaming.** Rows are buffered up to one row group. A group is full at
`rowGroupSize` rows (default 50,000) **or** `rowGroupBytes` of buffered
geometry (default 64 MiB), whichever comes first; the byte bound is what
keeps a download of large geometries (full-resolution admin boundaries at
tens of KB each) from holding gigabytes under the row bound alone. Each
full group is encoded by `hyparquet-writer`'s incremental `ParquetWriter`
and its bytes are handed to the sink before the next group is read;
`close()` writes the last group and the footer. Both options must be
positive numbers; anything else is refused with `FORMAT_CAPABILITY` at
`open()`. Peak memory is one row group, so `effectiveCeiling` treats it exactly like
`geojson`: unbounded on a disk-backed sink, the sink's own limit on a blob
sink. Before this (through 0.3.0) the writer used the buffer-only
`parquetWriteBuffer`, held the whole result until `close()`, and was capped
at `memoryBudget / 2`.

**Nested columns.** `download()` passes the source files' own Parquet
schema to the writer as `FormatContext.sourceSchema` (the columns the
selected parts' footers **agree** on), and every struct, list and map
column is written with that schema verbatim. A
STAC-GeoParquet `links` (`list<struct>`), `bbox` and `stac_extensions`
therefore read back as native nested types in hyparquet, DuckDB and
pyarrow. Without a source schema `hyparquet-writer` can only infer, and
what it infers for an object or array is a JSON string — still the
fallback when a format is driven without one. The details:

- The column's own element is relaxed to `OPTIONAL` (this writer nulls
  freely); everything beneath it is left as the source declared it.
- **A column falls back to JSON text, rather than failing the download,**
  in two cases. When the selected files disagree about its shape (one
  part's `assets` has a field another's lacks): one part's schema would
  drop the other's fields or throw mid-stream, and JSON holds them all.
  And when its shape is one `hyparquet-writer` cannot re-encode from the
  values hyparquet reads back: a legacy two-level list (a `REPEATED` leaf,
  the parquet-avro and old Spark default), a top-level `REPEATED` group,
  or a map whose keys are not strings.
- Flat columns go through the declared `table.columns` type, so a column
  that is a *string* at the source stays a string even when its content is
  JSON — the s2 catalog's `assets` is one. A flat column with no declared
  type takes the source footer's physical type when it is a plain one
  (string, boolean, float, double, bare INT32/INT64); only then is it
  inferred from the first row group, and an inferred column is always
  written nullable.

**Covering.** In order: (1) when the dataset's **declared** covering
struct (`table.bbox`, passed as `FormatContext.covering`) is in the output
and written natively, the `geo` metadata's `covering` points at it
(`["bbox", "xmin"]`, …) and no `bbox_*` columns are added. Only the
declared one: a struct that merely has `xmin`/`ymin`/`xmax`/`ymax` fields
is not the geometry's bbox. (2) When the output already has all four
`bbox_xmin` … `bbox_ymax` columns — a file this writer produced, extracted
again — they are reused, not duplicated. (3) Otherwise `writeCovering`
(default `true`) computes the four columns from the written geometry.

The schema is fixed when the first row group is written.

`node packages/extract-core/test/stac-roundtrip.verify.mjs` checks all of
this against the live Sentinel-2 catalog.

### Parallel reads are ordered, and the win depends on the query

Row groups are fetched by `maxConcurrentRequests` workers (default 12) pulling
from one shared cursor, and `onBatch` is still invoked in strict row-group
order by a single delivery loop — so the output is byte-for-byte what the
sequential implementation produced. Read-ahead is bounded (a worker will not
start slot `i` while `i - delivered >= maxConcurrentRequests`), so one slow
group cannot pull the rest of the plan into memory.

On this path request *depth* is the latency, not bytes: measured against the
real `sentinel-2-c1-l2a` STAC-GeoParquet footprints, 8 row-group reads in
series take 10.07 s and the same 8 concurrently take 1.59 s, while the
engine's own per-row filter loop (WKB decode, bbox test, polygon
intersection, `where[]`) costs 14 ms per 6,144-row group.

End to end, on design doc §2.8's worked-example query (Kenya ∩
2025-06-01/2025-09-01 ∩ `eo:cloud_cover <= 20`). That collection publishes no
bbox covering, so nothing prunes and the plan is 825 row-group reads:

| | requests | bytes read | rows | elapsed |
|---|---|---|---|---|
| `maxConcurrentRequests: 1` | 825 | 208,463,067 | 6,822 | **737 s** (1 sample) |
| default `12` | 825 | 208,463,067 | 6,822 | **65 / 67 / 74 s** (3 samples) |

**11x at the median, with identical requests, bytes and rows** — pruning
nothing and changing no answer, just not waiting. A sweep over disjoint cold
96-row-group windows of the same plan: 1 → 106 s, 4 → 23 s, 12 → 9.5 s,
24 → 5.0 s. 24 was still scaling; 12 is the conservative default because peak
memory scales with it. `maxConcurrentRequests: 1` through the new code matches
the old sequential engine on the same window (106.1 s vs 106.5 s mean), so the
pool costs nothing when you turn it off.

Counters (`requests`, `bytesRead`, `rowGroupsDone`, `rowsScanned`) are
incremented by the ordered delivery loop, so they report the row groups that
contributed to the output and end on exactly the sequential totals. One
consequence: when `filter.limit` stops the run, the at-most
`maxConcurrentRequests - 1` reads already in flight finish, are discarded, and
are **not** counted — so a limit-bound download's `requests` under-reports
actual network use by up to that many.

### Timestamps and BigInts in output

GeoJSON output converts `BigInt` to `Number` and `Date` to an ISO string.
GeoParquet output must *widen* unsigned types — `uint32` → INT64, because
hyparquet-writer has no unsigned physical type and inferring INT32 from early
small values throws the moment a later value exceeds the signed range (found
writing s2's `_hilbert` column). A column whose declared type this package does
not recognize gets no explicit type and is inferred, which is the same trap.

## Tests

```
node --test packages/extract-core/test/*.test.js
```

11 files: `Bounded` arithmetic, collection→descriptor derivation, the
`DownloadHandle` state machine (ceiling/accept/cancel/pause, via a fake engine
so the math is tested without a network), GeoParquet decode and write,
partition enumeration and pruning, predicates, row-group pruning, spatial
tests, WKB geometry, the streaming zip64 writer (round-tripped through
Python's `zipfile` and, when present, `unzip -t`), and a real-network
integration test.

End-to-end against live catalogs:
[`examples/download-demo/verify.mjs`](../../examples/download-demo/verify.mjs),
[`examples/firms-explorer/verify.mjs`](../../examples/firms-explorer/verify.mjs),
[`examples/s2-footprints/verify.mjs`](../../examples/s2-footprints/verify.mjs),
and `docs/verify-snippets.mjs`.

Opt-in, not run by `npm test` (writes a >4 GiB file to a temp directory and
is slow): `node packages/extract-core/test/zip-large.verify.mjs` checks
the zip writer's zip64 path past the 32-bit size/offset limits, asserting
both entries' sizes through Python's `zipfile`.
