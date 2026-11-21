# Bigger downloads — decisions made during implementation

Companion to [`2026-11-20-bigger-downloads-design.md`](2026-11-20-bigger-downloads-design.md)
and [`../plans/2026-11-20-bigger-downloads.md`](../plans/2026-11-20-bigger-downloads.md).

Seventeen decisions were taken while executing the plan, most of them
correcting defects in the design doc or the plan itself. They are recorded
here because several exist nowhere else in the tree, and because the next
person to touch this code needs the *why*, not just the result.

Branch: 28 commits, 43 files, +6651/−178. Tests at the end: 823 pass, 4 fail
(all four pre-existing in `packages/raster-core/test/geotiff-writer.test.js`,
verified stable across six runs). `docs/verify-snippets.mjs` 61/61.
`examples/download-demo/verify.mjs` 84/84 against live data.

---

## Decisions that corrected a defect in the design doc or plan

**R5 — the memory-sink exemption applies only at `memoryFactor === 0`.**
The plan's Global Constraints said "`memorySink` is exempt from `memoryBudget`
entirely", and that is what was built: the memory-sink branch short-circuited
ahead of the buffering branch, making GeoPackage **unbounded** on a
`memorySink`. Spec §7.3 rule 3 has no sink condition, and §7.8's note exists
to stop the *blobBytes* cap applying to `memorySink`, not to waive a format's
own buffering cost — gpkg's 3.5× is spent inside the writer and is identical
wherever the bytes land. A buffering format is `memoryBudget / memoryFactor`
regardless of sink.

**R8 — new warning payloads are flat, not nested under `context`.**
The design doc and plan invented a nested `context: {…}` payload, borrowed
from the `CngError` convention on a different type. All nine incumbent codes
in `estimate.js` use flat fields. `est.warnings` is a public array whose
consumers switch on `code` and read fields directly; a mixed convention would
force every consumer to special-case the new codes.

**R9 — an unknown part size must not manufacture a ceiling breach.**
`estimate.js` compares `outputBytes.max`/`readBytes.max` against the ceiling,
and the raw path sets `max: Infinity` when a size is unknown — so every raw
download whose sizes are unpublished would have rejected with
`CEILING_EXCEEDED`. STAC sources never publish sizes, so that was the common
case. The user was asked directly how protective this path should be and chose
"warn distinctly, always proceed" over requiring acceptance. Byte dimensions
are therefore judged on the sum of **known** sizes, while the reported
`Bounded` keeps `max: Infinity`/`exact: false` so nothing mistakes it for a
real bound. `files` is the hard backstop.

**R13 — declare gpkg's `memoryFactor` from the large case.**
The plan said "the measured maximum across all three cases". At 2,000 rows ×
100 vertices the output is ~4 MB while fixed Node+sql.js baseline RSS is
110–150 MB, so the ratio reads 29–38× — baseline overhead swamping a tiny
output, present and *larger* in the unchanged writer. Obeying that wording
would have forced a revert of a real improvement. The ceiling only binds large
downloads, where fixed baseline is negligible.

**R14 — the public `estimate()` routes `parquet-raw`.**
`finalizeEstimate` calls `format.estimateBytes(...)` unguarded, and the
registered raw descriptor deliberately has none. So `estimate()` with
`output.format: 'parquet-raw'` crashed — breaking the very pre-estimate
pattern R7 prescribes as the mitigation for the save-dialog trade-off. Routed
in `index.js` (which already imports both modules, keeping it cycle-free since
`raw.js` imports constants *from* `estimate.js`). A raw estimate reads no
parquet footers. Note `estimate` imported directly from `src/estimate.js` does
not route; `index.js` is the public surface.

**R6 — no cross-package imports in a `download-core` test.**
The plan told `ceiling.test.js` to `import('@cng/format-gpkg')`.
`download-core` does not depend on any format plugin, so that resolves only
via workspace hoisting. The "gpkg declares its factor" assertion lives in
`format-gpkg`'s own suite.

**R4 — the demo verifier asserts observable behavior.**
The plan invented a `buildFilterLimitFor` helper. Nothing may be exported from
the demo merely to make a test reachable. Application *state* on
`window.__cngDownloadDemo` (`map`, `geocoder`, the `area` getter) is fine — it
is observable the way UI text is. Functions added so a test can call them are
not.

**R1 / R10 — zip overhead and entry names come from one source of truth.**
The overhead prediction is computed by calling `zip.js`'s own record builders
with the names `rawZipEntryNames` produces, and the writer uses the same
function — so the predicted size cannot drift from the bytes written. Entry
names are the part path relative to the selected parts' common prefix,
preserving hive directories (`year=2022/detections.parquet`), not the full
URL path.

**R2 — gpkg declared its measured factor from the start.**
Left absent, the default of 3 would have applied, understating gpkg's real
cost and raising its ceiling above what memory can take.

---

## Decisions that accepted a cost or a known gap

**R7 — a save dialog can appear just before a `CEILING_EXCEEDED` refusal.**
The ceiling must know the sink kind, so `download()` resolves the sink before
the gate. Spec §7.8 decided this deliberately; `acceptCeiling()` continues on
the same handle, so it is recoverable. The mitigation for API consumers is to
call `estimate()` with `output`, confirm, then `download()` — which is what
the demo does.

**R11 — `suggestedFormats` never names `parquet-raw`.** That descriptor has no
`estimateBytes` (its size comes from part metadata, not a schema+rows model),
and `suggestedFormatsFor` skips any candidate lacking one. So "GeoPackage
won't fit, but raw streams to disk unbounded" — often the best answer — is
never offered. A proper fix needs dataset-source-kind knowledge inside
`suggestedFormatsFor`. **Worth a follow-up issue.**

**R12 — `raw-no-pruning` is silent on mixed-declaration datasets.** It fires
only when `selected.every(...)` lack the relevant field. On a dataset where
some parts declare a bbox and genuinely match while others pass only because
they declare none, **neither branch fires** and the user is told nothing —
silence reads as "your area narrowed this down". `basis` is never *wrong*,
only absent. A correct fix is a public-payload change (a third `basis` value
or a count). **Worth a follow-up issue.**

**R15 — no library-side filename rename for a multi-file zip.**
`output.filename` is an explicit caller instruction; overriding it silently is
worse than honoring it. The demo derives its extension from
`preflight.files.selected > 1`. A caller supplying `output.filename` should
consult `files.selected` — which is why spec §7.8 added `output`/`sink` to
`estimate()`.

**R16 — the blob-sink raw cap is documented, not coded around.**
Raw is `memoryFactor 0`, so a memory-backed sink caps it at `blobBytes`
(256 MiB). When part sizes are unpublished that ceiling cannot be *evaluated*,
so on a browser without the File System Access API (Firefox, Safari)
`autoSink` falls back to `blobSink` and the run dies at 256 MiB.
`SINK_QUOTA_EXCEEDED` names the lever. This is the trade-off chosen in R9.

**R17 — `download()`'s own `estimateBytes` call is guarded.**
The fix wave added a `FORMAT_CAPABILITY` guard in `finalizeEstimate`, but
`download()`'s `run()` builds `outputBytesOverride` by calling
`format.estimateBytes(...)` directly, one line earlier. A misregistered format
surfaced as `INTERNAL` rather than a capability error — and the new comment
claimed that surface was safe. Guarding made the claim true. Registration-time
validation was rejected: `rawFormatDescriptor` is registered deliberately
without `estimateBytes`.

**R3 — suppress size warnings when the size is unknown.** `large-download` and
`slow-download` are suppressed rather than computed from a partial sum, which
would imply "small" when the truth is "unknown". The suppression is local to
`rawEstimate`; `finalizeEstimate` is untouched, so the normal decode path —
where a non-exact `outputBytes` is the ordinary case — cannot regress.

---

## Measurements, and a corrected projection

GeoPackage's `memoryFactor` is **2.9, measured**, not the ~2.5 §7.7 first
projected. Method: synthetic WKB polygons, one row-count per process so the
emscripten heap does not carry over, RSS sampled at ~20 ms, derived from
2,000 rows × 20,000 vertices (~611 MB output).

| | peak RSS / output |
|---|---|
| before step 1 | 3.07× (max of 6 runs) |
| after step 1 | 2.82× (max of 10 runs) |

So ~8% better, against ~33% projected; ceiling ~293 MiB → **~353 MiB**, a 20%
lift rather than 40%. Two caveats, both pointing the same way: the run counts
were uneven, so the *margin* is less rigorous than it reads (the declared 2.9
comes from the new writer's own ten runs, not the delta); and peak RSS
probably **understates** the saving, because sql.js's wasm memory can only
grow within a `Database`'s lifetime — so the new writer's sampled peak is near
its true peak, while the old writer's required catching the instant both the
V8-heap row array and the growing wasm heap were large, and V8 can collect
that array.

**Step 1.5 (chunked export) is impossible, not merely risky.** sql.js 1.13.0
exposes no MEMFS: `SQL.FS` is `undefined`, the Module carries no
`FS`/`MEMFS`/`NODEFS` key, and `Database.prototype` is exactly `close,
constructor, create_aggregate, create_function, each, exec, export,
getRowsModified, handleError, iterateStatements, prepare, run, updateHook`.
The two remaining copies cannot be reduced within sql.js at all, so
**issue #3 (OPFS-backed SQLite) is the only path to large GeoPackage.**

## Verification that is not reproducible from the test suite

- **A real 4.4 GiB zip64 archive**, CRC-verified by both Python
  `zipfile.testzip()` and `unzip -t`. Run by hand via
  `packages/download-core/test/zip-large.verify.mjs` (opt-in, not in
  `npm test`).
- **The multi-file zip path against a live catalog** — FIRMS detections, 3
  hive partitions, 2.74 GiB, entry names `year=2022/detections.parquet`,
  `year=2023/…`, `year=2024/…` plus `ATTRIBUTION.txt`; both readers clean; the
  `year=2022` entry (685,630,403 bytes) byte-for-byte identical to an
  independent fetch. Every other zip test uses synthetic ASCII fixtures and
  all three demo datasets are single-file, so this was the branch's largest
  untested surface.
- **The row cap is gone end-to-end**, not merely deleted from source: a real
  uncapped download of 49,349 rows / 97 MB, and the same download with
  Max Rows = 10 returning exactly 10 with `truncated: true`.

## Process notes worth carrying forward

Two gating mistakes, both caught late:

- Tasks were gated on `npm test`, which deliberately excludes the live-data
  verifiers — so a `verify-snippets.mjs` regression introduced by registering
  `parquet-raw` sat on the branch for five tasks and was caught only because
  the docs task's brief required the verifier. **Any task touching
  `download-core`'s public surface or the format registry should be gated on
  `node docs/verify-snippets.mjs` too.**
- Three spec defects (R5, R8, and the `blobBytes`-on-a-buffering-format gap
  found by the whole-branch review) share one shape: a derived rule was
  specified for one branch of a case split and silently assumed for the other.
