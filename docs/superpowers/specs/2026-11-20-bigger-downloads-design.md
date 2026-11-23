# Bigger downloads: raw GeoParquet passthrough + format-aware ceilings

**Date:** 2026-11-20
**Status:** design, awaiting approval. Builder check done 2026-11-20; the
two open questions it surfaced were answered by Chris and are recorded in
§7.1 and §7.5.
**Scope:** `@cngeo/extract-core`, `examples/download-demo`. A separate,
filed issue covers making `@cngeo/format-gpkg` streaming; it is a non-goal
here.

---

## 1. Intent, and why now

A tester tried to download complex country boundaries as GeoPackage and
could not get more than 2,000 rows. Two different things caused that, and
only one of them is a bug:

1. `examples/download-demo/index.html:402` hardcodes `limit: 2000` in
   every filter it builds. That is a demo leftover with no reason to
   exist.
2. GeoPackage genuinely cannot go much further than it did.
   `gpkg-writer.js` holds every row in JS arrays until `close()`, then
   builds the whole SQLite database in the sql.js wasm heap, then
   exports a third copy as a `Uint8Array`. **Measured** (Node 22,
   2026-11-20, `--expose-gc`, 20 ms RSS sampling, synthetic polygons):

   | rows | vertices/row | output | peak RSS | wall |
   |---|---|---|---|---|
   | 2,000 | 100 | 4 MB | 131 MB | 0.1 s |
   | 2,000 | 5,000 | 156 MB | 1,031 MB | 0.9 s |
   | 2,000 | 20,000 | 611 MB | 2,183 MB | 3.4 s |
   | 4,000 | 20,000 | 1,223 MB | 1,684 MB | 9.5 s |
   | 6,000 | 20,000 | 1,834 MB | 2,401 MB | 13.4 s |
   | 8,000 | 20,000 | 2,445 MB | 5,144 MB | 23.4 s |
   | 11,000 | 20,000 | 3,362 MB | 1,547 MB | 41.8 s |

   Peak RSS runs **roughly 3–4× the output size**, matching the three
   copies the code holds. (The RSS column is noisy above ~2 GB — macOS
   memory compression makes it read low; the multiplier from the small
   runs and from reading the code is the number to trust.) A browser tab
   has nothing like Node's headroom, so 2,000 complex boundaries at
   611 MB of output is already past what a tab should attempt, and the
   existing 256 MiB `blobBytes` ceiling correctly refused it.

The wider goal is the one Chris stated: this data can be huge, and it
would be good to just stream it out to people. For GeoParquet — which is
what the source data is in — the fastest possible download is the one
that does no decoding at all: copy the published bytes through to the
user's disk.

## 2. Goals

- Remove the demo's artificial row cap and give the demo a visible,
  user-controlled limit that defaults to *no limit*.
- Let a user download the complete partition(s) or the complete dataset
  as the original GeoParquet files — a single file when one is selected,
  a zip when more than one is.
- Make the ceilings depend on what the chosen format and sink actually
  cost, so a streaming format going to disk is bounded by the user's
  disk, not by a number picked for a buffering format.
- Warn, before anything is fetched, when a download is large enough to
  take a while, with a real byte count and a time estimate.

## 3. Non-goals

- Making GeoPackage *streaming*. That is issue #3 (the OPFS/SQLite-wasm
  work), and it stays out of scope. **Step 1 of that issue is now in
  scope** — see §7.7 — because it raises gpkg's ceiling for very little
  work; the OPFS step does not follow from it and is still deferred.
- Merging N partition files into one parquet file. That means decode and
  re-encode — exactly the cost passthrough exists to avoid. The zip is
  the answer.
- Any server-side component, build step, or new runtime dependency.
- Row-level filtering in the passthrough path. It is a passthrough.

## 4. Anti-goals

Things that would make this a failure even if it shipped:

- **Raising a ceiling so that a tab OOMs instead of showing a clean
  error.** A number that converts `CEILING_EXCEEDED` into a browser crash
  is strictly worse than the number it replaced.
- **Silently dropping a filter the user set.** If raw passthrough cannot
  honor `where`/`columns`/row-level spatial, the user must be told in
  words, on the estimate, before the download starts.
- **A zip that common tools cannot open.** Anything over 4 GiB must be
  readable by `unzip`, macOS Archive Utility, and Python `zipfile`.

## 5. Constraints

- No build step and no bundler: any new code is plain ESM, and any new
  third-party code would have to come from a pinned absolute CDN URL.
  The zip writer is therefore written in-repo (no dependency).
- A zip is a forward-only byte stream. Entries must be written in order,
  and the sinks (`sinks.js`) are `WritableStream`-based and non-seekable.
  That rules out fixed-up local headers and dictates data descriptors.
- `download()`'s existing contract is public API and must not change:
  synchronous return, `handle.estimate`, `handle.result`,
  `CEILING_EXCEEDED` + `acceptCeiling()`, the event names, the error
  codes. All of this is additive.
- Error **codes** are the API; messages are not (AGENTS.md).
- `blobSink` really is memory-bound; its 256 MiB cap stays. The
  File System Access path is not memory-bound and should not inherit it.

## 6. Approaches considered

### 6.1 Raw GeoParquet passthrough

| | Approach | Trade-off |
|---|---|---|
| **A** ✅ | A download mode inside `download()`: branch before the engine, stream bytes straight from object storage to the sink; zip when >1 file. | Reuses the handle, cancel, progress, estimate, sink, attribution. One more branch in `download()`. Estimate becomes *exact* (byte sizes are known, not modeled). |
| B | A separate `downloadRaw()` export. | Conceptually tidy — no filter semantics to explain. But duplicates handle/progress/sink/ceiling plumbing, and every consumer UI grows a second code path. |
| C | Show the user the file URLs to feed to `ogr2ogr`/duckdb. | Nearly free, but it is not "stream it out to people", and it abandons anyone without a CLI. |

**Chosen: A.** B's only advantage is avoiding an explanation we have to
give anyway (see `raw-passthrough-unfiltered` below), and it pays for
that with duplicated machinery. C is worth keeping as a *supplementary*
affordance in the demo (copyable URL list), not as the feature.

### 6.2 Ceilings

| | Approach | Trade-off |
|---|---|---|
| X | Raise all five numbers in `defaultCeiling()`. | One line. Wrong for GeoPackage: converts a clean refusal into a tab crash (§1). |
| **Y** ✅ | Derive the effective ceiling from the format's memory cost and the sink's nature. | More code, and one new optional capability field. But streaming-to-disk stops being capped by a buffering format's constraint, and the refusal message can name the format that *would* work. |
| Z | Make GeoPackage genuinely streaming (SQLite-wasm + an OPFS VFS). | The only real fix for gpkg, and a much larger job. Deferred to its own issue. |

**Chosen: Y now, Z filed separately.** Agreed with Chris 2026-11-20.

## 7. The design

### 7.1 Raw passthrough

**Selection.** A new output format id, `parquet-raw`, listed by
`formats()` so a picker can render it (label: "GeoParquet — original
files"). `download()` recognises it *before* calling `engine.plan()` and
takes the passthrough path.

**Applicability.** Supported when the resolved dataset's source kind is
one of `parquet`, `parquet-set`, `hive`, `stac-geoparquet` — i.e. the
source is itself parquet files with HTTPS hrefs. Anything else refuses
with `FORMAT_CAPABILITY` and a message naming the kind. An unresolved
`portolan-collection` must go through `resolveDataset()` first, as it
does today.

**Which files.** Reuse the existing whole-file stages of
`partitionPruneCascade` (`part-bbox`, `part-time`) and nothing below
them: no footer reads, no row-group pruning, no row scanning. So "Kenya,
September" selects the 1 partition that matters and downloads it whole.
The `prune` narration on the estimate shows exactly those stages, so the
UI can say "3 of 27 files".

**What is dropped, and saying so.** Raw passthrough cannot apply
`filter.where`, `filter.columns`, `filter.limit`, or row-level spatial
intersection. When the filter asks for any of them, the estimate carries
a new warning:

```
{ code: 'raw-passthrough-unfiltered',
  dropped: ['where', 'columns', 'spatial-row-level'] }
```

This is a warning, not an error: the user asked for the whole partition
on purpose. The demo renders it as "These files are complete and
unfiltered — your filter was used only to choose which files to fetch."

**Estimate.** `outputBytes` and `readBytes` are the summed part sizes
plus (for the zip) the exactly-computable container overhead, and are
marked `exact: true` when every selected part's size is known. Sizes come
from, in order: the part's own `bytes` (collection-mirror `file_size`,
STAC `file:size`), else one `HEAD` per part (counted in
`est.requests`). `rows` is the summed part `rowCount` when every part has
one, `exact: true`; otherwise it is left unknown rather than modeled.
`requests` = one GET per selected part, plus any HEADs.

**Writing.** One selected part → the response body is piped to the sink
verbatim; default filename is the part's basename. Two or more → the zip
of §7.2; default filename `${dataset.id}.zip`. Files are fetched and
written **sequentially** — a zip is an ordered byte stream, and a
read-ahead would reintroduce the buffering this path exists to avoid.

**Progress.** A new phase, mirroring the existing shape:

```
{ phase: 'copying', fileIndex, fileCount, filename,
  bytesWritten, bytesTotal }
```

`bytesTotal` is present whenever the estimate was exact. Cancel aborts
the in-flight fetch via the existing `AbortController` and calls
`sink.abort()`, which keeps the existing partial-file cleanup.

**Attribution.** `DownloadResult.attribution` carries it on every path,
and the zip additionally carries an `ATTRIBUTION.txt` entry (§7.2). A
**single**-file raw download is *not* wrapped in a zip in order to add
that entry, not even for share-alike data — **decided by Chris,
2026-11-20**: "just get people the file. No clicking on a link to
download makes you include attribution." The verbatim bytes stay
verbatim; `result.attribution` plus the UI's own attribution display is
what discharges the obligation there, exactly as it does for a direct
link to the same file.

### 7.2 The zip writer

A new in-repo module, `packages/extract-core/src/zip.js`. No
dependency, no package of its own — it has exactly one caller.

- **STORE (method 0), never DEFLATE.** Parquet is already compressed;
  recompressing costs CPU and saves nothing.
- **Zip64 unconditionally.** Entries over 4 GiB and archives over 4 GiB
  are the expected case, not the edge case. Write the zip64 extra field
  on local and central headers, the zip64 end-of-central-directory record
  and its locator, and `version needed = 45`.
- **Data descriptors** (general-purpose flag bit 3), with 8-byte zip64
  sizes. This is what makes a non-seekable sink work: CRC-32 and sizes are
  written *after* each entry's bytes, so no local header ever needs
  rewriting. CRC-32 is computed streaming with a table-driven
  implementation (~40 lines).
- **Entry names preserve the partition layout**
  (`acq_date=2026-09-01/part-0.parquet`), so unzipping reproduces the
  dataset's directory structure. Name collisions get a numeric suffix.
- **One extra entry, `ATTRIBUTION.txt`**, holding the attribution text,
  licenses, URLs, and the source dataset id. For ODbL/share-alike data
  this is the only way the obligation travels with the bytes.

**Verification:** round-trip tests against Python `zipfile` and
`unzip -t` in `npm test`, plus an opt-in (not in `npm test`) >4 GiB
archive test, since it is slow and disk-hungry.

### 7.3 Format-aware ceilings

Replace the single `defaultCeiling()` with `effectiveCeiling({ format,
sink, overrides })`, which `estimate()`/`download()` call in place of
today's flat defaults. `options.ceiling` continues to override
field-by-field, unchanged.

**New optional capability field** on `FormatPlugin.capabilities` and
`LazyFormatDescriptor.capabilities`:

```js
memoryFactor: number   // peak bytes held in memory per output byte
```

Defaults when absent: `0` if `streaming === true`, `3` otherwise — so
every existing plugin keeps working. Declared values:

| format | streaming | memoryFactor | basis |
|---|---|---|---|
| `geojson` | true | 0 | writes through |
| `parquet-raw` | true | 0 | copies bytes through |
| `geoparquet` | true | 0 | streams a row group at a time (was `false`/`2`, buffering, until GitHub issue #4) |
| `gpkg` | false | 3.5 | **measured**, §1 |
| `shapefile`, `flatgeobuf` | per package | declare, or take the default | builder to measure |

**Effective limits.** One new knob, `memoryBudget`, default **1 GiB**,
overridable via `options.ceiling.memoryBudget`.

- `memoryFactor === 0` **and** the sink is not memory-backed
  (`kind === 'filesystem'` or `'stream'`): `outputBytes` is effectively
  unbounded (1 TiB sentinel, so a runaway still trips something).
- `memoryFactor === 0` and the sink *is* memory-backed (`blob`,
  `memory`): bounded by `blobBytes`, 256 MiB, unchanged — this is a real
  constraint of holding a `Blob` in a tab.
- `memoryFactor > 0`: `outputBytes = memoryBudget / memoryFactor`.
  GeoPackage therefore lands at ~292 MiB — close to today's 256 MiB, but
  now a number with a reason behind it and one knob to raise.

**Flat defaults that simply go up** (they were conservative, not
derived): `rows` 5,000,000 → 50,000,000; `readBytes` 4 GiB → 64 GiB;
`files` 500 → 10,000. `blobBytes` stays at 256 MiB.

**The refusal must name the lever.** `CeilingExceededError`'s context
gains `suggestedFormats: string[]` — the registered formats whose
effective ceiling *would* accommodate this download — and the message
says why, e.g.:

> GeoPackage buffers the whole file in memory (about 3.5× the output
> size); this download would need roughly 4.2 GB. GeoParquet and GeoJSON
> stream straight to disk and have no such limit.

`code` stays `CEILING_EXCEEDED`. No existing code changes meaning.

### 7.4 The "this is big" warning

Two new estimate warning codes, emitted through the existing `warning`
event and `est.warnings`:

- `large-download` — `outputBytes.estimate` exceeds `largeDownloadBytes`
  (default **1 GiB**, overridable). Carries flat fields
  `{ bytes, estimatedSeconds }`.
- `slow-download` — `estimatedSeconds` exceeds **120**, flat
  `{ estimatedSeconds }`.

**Warning payload shape** (corrected 2026-11-20, ruling R8): every new
warning code here uses FLAT fields, not a nested `context` object, because
all nine incumbent codes in `estimate.js` are flat
(`single-row-group{files}`, `antimeridian-split{boxes}`,
`estimate-wide{ratio}`, `share-alike{attribution}`). `est.warnings` is a
public array whose consumers switch on `code` and read fields directly; a
mixed convention would force every consumer to special-case the new codes.

The time estimate uses a documented, conservative default throughput of
**10 MB/s**, overridable as `options.throughputBytesPerSecond`. It is a
rough number and must be presented as one ("roughly 7 minutes"), never as
a countdown. During a run, the `copying`/`reading` progress events carry
enough to compute a live rate; refining the displayed ETA from measured
throughput is left to the UI.

### 7.5 Guard-rails on the raw path

Two cases make "warn before anything is fetched, with a real byte count"
(§2) unreliable, and both **warn distinctly and always proceed** —
decided by Chris, 2026-11-20. Neither is a ceiling breach and neither
refuses.

- **Sizes unobtainable.** `enumerateStacItems` in `partitions.js` records
  no size, and a cross-origin `HEAD` may be blocked or may not expose
  `content-length`. Then `outputBytes.exact` is `false`, `bytesTotal` is
  absent from `copying` progress, and a new warning
  `raw-size-unknown` fires, with flat
  `{ partsWithoutSize, partsTotal }`. `large-download` and
  `slow-download` cannot fire; the UI must say "size unknown" rather
  than imply small.
- **Pruning kept everything.** `partitionPruneCascade` keeps any part
  that declares no `bbox` (`if (!p.bbox) return true`) or no `interval`,
  so an area selection against a dataset whose parts carry no declared
  bbox selects *every* file. A new warning `raw-no-pruning` fires
  whenever `files.selected === files.total` **and** the filter asked for
  a narrowing (an area, or a time range), with flat
  `{ basis: 'parts declare no bbox' | 'parts declare no interval' }`.
  The demo renders it as "Your area did not narrow this down — this is
  the whole dataset."

The hard backstop on this path is therefore `readBytes` (64 GiB) and
`files` (10,000), which is deliberate: those two are what stand between
a user and a 500 GB accident once `outputBytes` is unbounded for a
streaming format on a disk-backed sink.

### 7.6 The demo

- Delete `limit: 2000`. Add a "Max rows" input that defaults to empty
  (= no limit) and is passed through only when set.
- Add `parquet-raw` to the format picker, labelled "GeoParquet — original
  files (complete, unfiltered)".
- Render `raw-passthrough-unfiltered`, `large-download` and
  `slow-download` prominently, and require an explicit confirm click
  before starting any download that carries `large-download`.
- Show the copyable list of source file URLs alongside the raw option
  (approach C, as a supplement).
- Extend `examples/download-demo/verify.mjs` in the house style:
  navigate, wait on a visible status string, assert on real output, fail
  on any console error.

### 7.7 GeoPackage step 1: stop buffering rows in JS

Added to scope by Chris, 2026-11-20, after confirming it raises the
GeoPackage ceiling. This is step 1 of issue #3 only; the OPFS/SQLite-wasm
step of that issue remains out of scope.

**Why it is in scope.** gpkg's ceiling is `memoryBudget / memoryFactor`
(§7.3), so the factor is the lever. Of the three copies §1 describes,
one is avoidable with a small change.

**Measured outcome (2026-11-20), which fell short of this section's
original projection.** The projection was 3.5 → ~2.5, lifting the ceiling
from ~293 MiB to ~410 MiB. Matched old-vs-new measurement on one machine
gave **3.07 → 2.82**, about an 8% improvement rather than the ~33%
predicted. Declared factor **3.5 → 2.9**, so the ceiling moves
**~293 MiB → ~353 MiB** — a 20% lift, not 40%.

The measured gap is best read as a conservative floor rather than the
whole saving, for a mechanical reason: sql.js's wasm linear memory can
only *grow*, never shrink, within a `Database`'s lifetime, so the new
writer's sampled peak is close to its true peak. The old writer's peak
required catching the instant when both the V8-heap row array and the
growing wasm heap were large at once — and V8, unlike wasm, can collect
that array — so a 20 ms sampler is likelier to miss the old peak than
the new one. The real saving is therefore probably larger than 8%, by an
amount this method cannot establish.

Either way, step 1 is a modest win, which is itself the useful finding:
it is §7.7's step 1.5 and issue #3, not this change, that decide whether
GeoPackage can handle large data.

**The change.** `bufferedRows` exists only because two values are not
known until the final batch: the geometry type name written to
`gpkg_geometry_columns`, and the overall bbox written to `gpkg_contents`.
Both are single-row `UPDATE`s on metadata tables. So:

- `open()` creates the `SQL.Database`, writes the `gpkg_*` tables, and
  creates the feature table, inserting `gpkg_geometry_columns` with
  `geometry_type_name = 'GEOMETRY'` and `gpkg_contents` with null bounds.
- `writeBatch()` inserts that batch inside a transaction, keeping the
  running `geometryTypeCodes` set and `overallBbox` it already keeps, and
  retains no row data afterwards.
- `close()` issues `UPDATE gpkg_geometry_columns SET geometry_type_name
  = ?` and `UPDATE gpkg_contents SET min_x = ?, min_y = ?, max_x = ?,
  max_y = ?`, then exports as it does today.
- `abort()` must now `db.close()`, since a database exists from `open()`
  onward.

**Step 1.5 — investigated, and NOT feasible. Dropped.** `db.export()` is
the third copy, and the idea was to stream the database out of sql.js's
emscripten MEMFS in chunks instead. Measured against sql.js **1.13.0**:
there is no MEMFS surface to use. `SQL.FS` is `undefined`, the Module
carries no `FS`/`MEMFS`/`NODEFS` key at all, and `Database.prototype`
exposes only `close, create_aggregate, create_function, each, exec,
export, getRowsModified, handleError, iterateStatements, prepare, run,
updateHook` — `export` and nothing chunked. This is a harder "no" than
anticipated: the concern was depending on undocumented internals, but
nothing is exposed to depend on. `memoryFactor` therefore stays at the
step-1 measured value.

**Consequence:** the two remaining copies (the database in the wasm heap
plus `export()`'s `Uint8Array`) cannot be reduced within sql.js at all.
Issue #3 — replacing sql.js with `@sqlite.org/sqlite-wasm` on the
`opfs-sahpool` VFS — is therefore the *only* path to large GeoPackage,
not one option among several.

**Verification is the gate on the declared factor.** `memoryFactor` for
gpkg must be *re-measured* after this change, with the same method as
§1 (one row-count per process, RSS sampled at 20 ms, synthetic polygons
at a fixed vertex count), and the measured value is what goes in the
plugin. If it does not improve, the change is reverted rather than
declared.

**Correctness must not regress.** The existing
`packages/format-gpkg/test/` suite (including the GDAL/DuckDB-validated
integration tests) must pass unchanged — the output file has to be
byte-equivalent in structure, not merely openable.

### 7.8 Calls made after the builder check

Settled by the author, 2026-11-20, in response to the builder check.
Listed here because each is visible in the public surface.

- **The sink is created before the ceiling gate.** `download()` builds
  the sink after the gate today, so `effectiveCeiling` would have had to
  guess the sink kind — and guessing `'filesystem'` while `autoSink`
  silently falls back to `blobSink` is anti-goal §4.1 exactly. Moving
  sink creation earlier means the ceiling sees the real sink. The cost
  is that a save dialog can appear just before a refusal; that is
  recoverable, since `acceptCeiling()` continues on the same handle.
- **`memorySink` is not subject to `memoryBudget`.** It is an explicit
  test/advanced sink, and capping it would leave the demo and
  `verify.mjs` unable to exercise the feature at all. `blobSink` stays
  capped at 256 MiB. The demo keeps `memorySink` for headless
  verification, and gains an OPFS-backed browser verify script modelled
  on `packages/extract-core/test/browser/filesystem-sink.verify.mjs`.
- **`estimate()` gains optional `output` and `sink`** in its options —
  additive, so §5's no-break constraint holds. It is what lets a UI get
  a format-aware estimate before any bytes move, and it is how the demo
  learns `files.selected` in time to pick the save-picker filename
  (§7.1's one-file-vs-zip naming).
- **`large-download` stays a warning, not a second blocking gate.** The
  demo pre-estimates and confirms before calling `download()`. Adding a
  non-ceiling gate to the handle would be a public-API change for no
  gain over that.
- **`DownloadResult.rows` on the raw path** is the summed part
  `rowCount` when every selected part declares one, otherwise `null`,
  documented as "not counted on the raw path". `truncated` is always
  `false` there; `readBytes` is the bytes copied.
- **`suggestedFormats` runs each registered format's synchronous
  `estimateBytes`** against the plan and compares it with *that*
  format's own effective ceiling. Comparing the current format's
  `outputBytes` against other ceilings gives wrong suggestions whenever
  formats differ in size by more than their memory factors, which is the
  normal case. Lazy descriptors already expose `estimateBytes` without
  `load()`, so this needs no wasm.
- **`est.ceiling.limits` reports the derived numbers**, not the flat
  defaults — a UI needs the number it was actually judged against.
  `defaultCeiling()` stays exported as a compat shim.
- **`download.js`'s hardcoded `!format.streaming && outputBytes.max >
  blobBytes` check is removed**, subsumed by `effectiveCeiling`.

## 8. What is left to the builder

- Whether `parquet-raw` is implemented as a registered pseudo-format or
  as a plain branch keyed on the id string. The id is the contract; the
  internal shape is the builder's call.
- The exact CRC-32 implementation and zip64 field layout, within the
  constraints of §7.2.
- `memoryFactor` values for `shapefile` and `flatgeobuf` — measure them
  with the probe used in §1 rather than guessing, or leave them on the
  default of 3 and say so in the package README.
- Whether `memoryBudget` should additionally take `navigator.deviceMemory`
  into account. Worth doing only if it can be done without making the
  limit unpredictable across machines; a flat, documented 1 GiB default is
  acceptable.
- Test layout, beyond the two verification requirements already named
  (zip round-trip in `npm test`; >4 GiB zip opt-in).
- Doc updates to `AGENTS.md`, `packages/extract-core/README.md` and
  `docs/verify-snippets.mjs` — required, shape is the builder's.
