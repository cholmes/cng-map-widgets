# E10 — Heavy download formats: GeoPackage, Shapefile, terrio, and the rest

**Date:** 2026-11-12
**Scope:** O5 (`docs/design/widgets-architecture.md` §4.5/§7) plus Chris's
direct question — "does the terrio one work?" — plus a scope addition:
FlatGeobuf, Esri formats (Esri JSON, File Geodatabase), CSV, and a lazy
format-loading registry amendment. Every claim below is marked
**[measured: how]** or **[not measured: why]**; nothing here is an
estimate carried over from the design doc without being re-checked.

Tooling: GDAL 3.10.3 (`ogrinfo`), DuckDB v1.4.1 with the `spatial`
extension, Node 22.23.2, `curl` + `gzip -9` for payload measurement
(matching the design doc §4.5's own methodology: "concatenated, gzip -9"
for hyparquet/hyparquet-compressors). Scratch downloads and probe scripts:
`/tmp/terrio-test/`, `/tmp/fgb-test/`,
`<scratchpad>/`.

---

## 1. The terrio verdict

**Does it work? Yes — it is real, it writes correct GeoPackage and
Shapefile output, and it validates clean against both `ogrinfo` and
DuckDB. It is also the heaviest candidate measured in this whole survey,
heavier than `gdal3.js`, which disqualifies it as O5's "light path" even
though it functionally works.**

- **What it is** [measured: GitHub API + README,
  `github.com/opengeos/terrio`]: a pure-Rust geospatial raster/vector/
  point-cloud I/O library (305 stars, 44 forks, actively developed —
  pushed within the hour of this check), with CLI, Python, Rust, and
  WebAssembly/JS (`terrio-js` on npm) bindings. It builds on
  `whitebox_next_gen`'s format libraries and ports GDAL/PROJ/PDAL
  algorithms; its own README is candid that it is "not independent of
  GDAL" and is pre-1.0 ("early development, the API may change"), first
  commit 2026-10-14 — one month old at the time of this check.
- **Formats:** reads and writes GeoTIFF/COG, GeoPackage, Shapefile (as
  `.shp.zip`), GeoParquet, FlatGeobuf, PMTiles/MBTiles, and more; point
  clouds (LAS/LAZ/COPC/PLY/E57); CRS transformations matching GDAL/PROJ to
  within a centimetre for WGS84 round-trips.
- **Install/try:** `npm install terrio-js@0.8.0` (the published npm
  package), ran directly in Node (its own documented usage: `init()`,
  `open()`/`fromGeoJSON()`, `.toBytes()`) — see
  `<scratchpad>/terrio-probe.mjs`.
- **Functional result** [measured: ran the probe script against a 2-point
  Liechtenstein-town GeoJSON, wrote `.gpkg` and `.shp.zip`, validated
  both]:

  ```
  === GPKG ===
  Layer name: test · Geometry: Point · Feature Count: 2
  Layer SRS WKT: ... ID["EPSG",4326]
  name: String (0.0) · pop: Integer (0.0)
  === shapefile (.shp.zip) ===
  Layer name: test · Geometry: Point · Feature Count: 2 · ID["EPSG",4326]
  === duckdb spatial read of gpkg ===
  name,pop,st_astext(geom)
  Vaduz,5696,POINT (9.5215 47.141)
  Schaan,6162,POINT (9.5064 47.1662)
  ```

  Both formats opened cleanly with `ogrinfo -al -so`, correct feature
  count, geometry type, CRS, and attributes; DuckDB's `ST_Read`/direct
  read agreed. **This is not "it opens" — it is a genuine, correct write
  path**, for both formats this task cares about.
- **Payload, measured, not estimated:**

  | module | raw `.wasm` | gzip -9 | source |
  |---|---|---|---|
  | `terrio-js` (full) | 29,446,421 B (29.4 MB) | **10,623,358 B (10.6 MB)** | `curl` the npm-published `terrio_bg.wasm`, `gzip -9` |
  | `terrio-js/core` (GeoTIFF/COG, GeoJSON, FlatGeobuf, GeoPackage, Shapefile, PMTiles/MBTiles, CRS — no GeoParquet/Arrow, netCDF/HDF5, point clouds, JPEG2000, GRIB, Zarr, AVIF, OSM, CAD) | 15,876,817 B (15.9 MB) | **6,059,247 B (6.1 MB)** | same |

  The npm-published build's measured numbers are *larger* than terrio's
  own README-quoted CI snapshot (9.67 MB raw / 3.36 MB gzip for `core`,
  brotli-measured) — this survey measured the actual bytes a page would
  fetch from npm/jsdelivr today, with `gzip -9`, not the project's own
  best-case CI artifact with brotli; both are internally consistent, the
  discrepancy is measurement methodology (brotli vs gzip, and which build
  got published), not a correctness issue with either number.
- **Verdict:** **works, but not the light path.** Even the smallest
  module terrio-js offers (`core`, excluding GeoParquet and much else)
  is **6.1 MB gzip** — heavier than `gdal3.js`'s measured 9.07 MB only in
  the sense that it's in the *same weight class*, and both are an order
  of magnitude past the sql.js path that actually shipped (§3, ~340 KB).
  There is no "terrio-lite" module scoped to just GeoPackage+Shapefile
  the way this survey's hand-written sql.js path is. It is a genuinely
  impressive, fast-moving project — worth re-checking if it ever ships a
  format-scoped minimal build — but today it answers "does it work" with
  yes and "is it light" with no.
- **Browser zero-build note:** not independently verified in a real
  browser this session (no browser harness was used for this survey) —
  Node's `import()` cannot load an absolute CDN URL, the same limitation
  every CDN-loaded dependency in this project works around via a
  test-injection seam (`cdn.js`'s `setXModule` pattern, used throughout
  this round's new packages). `terrio-js`'s own README documents the
  standard wasm-bindgen `init()`/`await init()` browser usage, which is
  the same shape sql.js's and flatgeobuf's own CDN-ESM loading uses here
  — **[not measured: no browser harness used]**, but there is no reason
  specific to terrio's packaging to expect it to fail where the same
  pattern (dynamic `import()` of a pinned absolute CDN URL, an `init()`
  call reading a co-located `.wasm`) worked for everything else in this
  survey.

---

## 2. Measured payload table — every candidate

All `gzip -9` unless noted; this is the same methodology §4.5 of the
design doc used ("concatenated, gzip -9").

| artifact | raw | min+gz | status | shipped? |
|---|---|---|---|---|
| sql.js 1.13.0 (`sql-wasm.wasm` + `sql-wasm.js`) | 708,594 B | **339,245 B** | **measured** | ✅ `@cngeo/format-gpkg` |
| `@cngeo/format-gpkg`'s own code | ~9 KB | ~3 KB | measured (concatenated, gzip -9) | ✅ |
| Hand-rolled Shapefile writer (`@cngeo/format-shapefile`, zero deps) | ~15 KB | ~5 KB | measured | ✅ |
| `flatgeobuf@4.6.1`'s `geojson` submodule (jsdelivr `+esm`) | 37,603 B | **10,074 B** | **measured** | ✅ `@cngeo/format-flatgeobuf` |
| `@cngeo/format-extras` (CSV + Esri JSON, zero deps) | ~6 KB | ~2 KB | measured | ✅ |
| `jszip@3.10.2` (`+esm`) | 121,334 B | 37,153 B | measured | ❌ not used (hand-rolled STORED zip instead, see format-shapefile's README) |
| `dbf@0.2.0` (`+esm`) | 2,431 B | 1,273 B | measured | ❌ not used (hand-rolled .dbf) |
| `@mapbox/shp-write@0.4.3` (`+esm`) | 5,825 B | 2,578 B | measured | ❌ not used |
| `sql.js` RTREE module | — | — | **measured absent**: `CREATE VIRTUAL TABLE ... USING rtree` throws `"no such module: rtree"` on the published wasm build | documented as a known gap, not implemented |
| `gdal3.js@2.8.1` (`gdal3WebAssembly.wasm`) | 28,219,835 B (28.2 MB) | **9,074,360 B (9.07 MB)** | **measured** | ❌ future work (`@cngeo/format-gdal`) |
| `terrio-js@0.8.0` full (`terrio_bg.wasm`) | 29,446,421 B | **10,623,358 B** | **measured** | ❌ (§1 verdict) |
| `terrio-js@0.8.0` `/core` (`core/terrio_bg.wasm`) | 15,876,817 B | **6,059,247 B** | **measured** | ❌ (§1 verdict) |

The design doc's own §4.5 estimates, for comparison:

| design-doc estimate | measured here | delta |
|---|---|---|
| `format-gpkg` sql.js path: ~480 KB *(est.)* | **339 KB** | lighter than estimated |
| `format-gpkg` gdal3.js path: 2-8 MB *(est., wide)* | **9.07 MB** | heavier than the estimate's upper bound |
| `format-flatgeobuf`: ~25 KB *(est.)* | **10 KB** | lighter than estimated |

---

## 3. sql.js hand-written GeoPackage — the path that shipped

**THE validation bar, met:** `ogrinfo -al -so out.gpkg` reads every table
this plugin writes cleanly (feature count, geometry type, CRS, attribute
types all correct); DuckDB's `ST_Read` agrees on both attributes and
geometry. A real, live download (FTW field boundaries, Liechtenstein, 100
rows, bbox + confidence-filtered) round-trips end to end through
`@cngeo/extract-core`'s real `download()` pipeline and validates both
ways — see `packages/format-gpkg/test/gpkg-integration.test.js`.

Implemented: `gpkg_contents`, `gpkg_spatial_ref_sys` (the three required
rows: -1 undefined-cartesian, 0 undefined-geographic, 4326 WGS84), `gpkg_
geometry_columns`, and the feature table itself (`fid INTEGER PRIMARY KEY
AUTOINCREMENT`, `geom BLOB` holding a GeoPackage Binary Header + standard
WKB, plus attribute columns mapped from this project's schema types to
SQLite/GeoPackage type affinities).

**R-tree: measured absent, documented, not implemented.** This isn't a
scope shortcut dressed up after the fact — `sql.js@1.13.0`'s published
wasm build throws `no such module: rtree` on `CREATE VIRTUAL TABLE ...
USING rtree(...)`; it simply isn't compiled with `SQLITE_ENABLE_RTREE`.
The GeoPackage spec's R-tree extension is RECOMMENDED, not REQUIRED, for
the base "vector features" profile, so every file this plugin writes is
still fully spec-valid without it (confirmed above). Cost: QGIS/GDAL fall
back to a full table scan for a spatial `WHERE` on the file, immaterial at
the row counts a bbox-pruned browser download produces.

**Non-streaming, memory ceiling stated honestly** (same category as
extract-core's own `geoparquet` plugin): peak memory is roughly three
copies of the data — buffered JS row arrays, sql.js's in-memory SQLite
database (comparable to the final file size), and the exported
`Uint8Array` copy. See `packages/format-gpkg/README.md` for the full
statement extract-core's `blobBytes` ceiling check is what actually
protects a page from this at scale.

---

## 4. Shapefile writers

**Credible path found: a zero-dependency, hand-rolled writer.** Assessed
and rejected `shp-write`/`@mapbox/shp-write` (measured above: tiny, but
still a `jszip` + `dbf` dependency chain for a format simple enough to
write directly) in favor of `@cngeo/format-shapefile`'s own
`.shp`/`.shx`/`.dbf` binary writer and a hand-rolled STORED-only ZIP (no
compression needed for five already-small files, so no need for
`jszip`'s 37 KB).

Limits surfaced as warnings, not silently mangled (the task's explicit
bar) — see `packages/format-shapefile/README.md`'s table: 10-character
dBase field names (truncated + deduped, warned), one shape type per file
(incompatible mixes **refused**, not coerced — `FORMAT_CAPABILITY`), the
~2 GiB practical size ceiling (warned), dBase `DATE`'s lack of a
time-of-day (warned when truncated), and numeric field overflow (clamped
to the classic `*` dBase marker, warned).

**Correctness detail verified, not assumed:** Shapefile's polygon ring
winding is the mirror image of GeoJSON's (RFC 7946: exterior CCW, holes
CW; Shapefile: exterior CW, holes CCW). The writer corrects by signed
area per ring rather than assuming input winding is already right.
Verified empirically: a 10×10 square with a 6×6 hole punched out
round-trips through DuckDB's `ST_Area` at exactly 64.0 — the
hole-subtracted area — not 100 (hole ignored, a classic winding bug) and
not a self-intersecting mess.

`ogrinfo -al -so out.shp.zip` opens the zipped container directly, no
manual unzip — confirmed both via the independent terrio-js probe (§1)
and this package's own writer.

---

## 5. FlatGeobuf

**Credible, shipped.** The official `flatgeobuf` npm package's `geojson`
submodule (`serialize(featureCollection, crsCode)`) is a real write path,
measured at 10 KB min+gz (lighter than the design doc's ~25 KB estimate),
validated with both `ogrinfo` and DuckDB. Not streaming — the JS binding
only exposes a whole-collection call, even though the FlatGeobuf file
format itself is designed to stream (header + packed R-tree + features);
writing an incremental encoder by hand was out of scope for what was
meant to be the cheapest format after GeoJSON/GeoParquet. One
schema-fidelity gap, not a bug in this project's wrapper: the GeoJSON
serializer infers a column's type from sampled values, and GeoJSON itself
has no int/float distinction, so an integer column round-trips as a
double.

---

## 6. Esri formats

| format | path | verdict |
|---|---|---|
| **Esri JSON (FeatureSet)** | hand-written, zero deps | **shipped** (`@cngeo/format-extras`). A trivial writer — `{ geometryType, spatialReference, fields, features }` — with the same ring-winding correctness as Shapefile (Esri's `rings` convention is identical: outer CW, holes CCW) and the same one-geometry-type-per-set restriction enforced as a refusal. Validated: GDAL's `ESRIJSON` driver reads it. |
| **File Geodatabase** | GDAL's `OpenFileGDB` driver (read+write since GDAL 3.6) [measured: `gdal3.js@2.8.1`'s README format table lists `OpenFileGDB` under "Read & Write"] | **not reachable without the full `gdal3.js` path** (9.07 MB gzip, §2). There is no lightweight FileGDB writer the way GeoPackage has sql.js or Shapefile has a flat-file format simple enough to hand-write — FileGDB is a proprietary, undocumented-by-Esri binary format; every open implementation (GDAL's own `OpenFileGDB` driver included) is a reverse-engineering effort, not something this survey could responsibly hand-roll in scope. Stays future work under the `gdal3.js`-backed `@cngeo/format-gdal` note. |

---

## 7. Cheap extras

**CSV (attributes + WKT): shipped**, zero deps, streaming, RFC 4180
escaping, matches the design doc's existing format-options entry exactly
(`{ geometry: 'wkt'|'drop', delimiter: ',' }`). Validated via DuckDB's
`read_csv` + `ST_GeomFromText`.

**KML: not shipped.** Explicitly in Chris's "if nearly free" scope and
genuinely would have been — a `Placemark`/`coordinates` XML writer is
the same shape as this round's CSV/EsriJSON writers — but it didn't make
this round under time pressure. Noted in `@cngeo/format-extras/README.md`
as the one explicitly-scoped format left undone, rather than silently
dropped from this report.

---

## 8. The lazy-loading registry amendment

Chris's mid-task addition: a heavy format should load "on the fly...
just when people select that format," with its weight shown *before*
that fetch happens. Implemented in `packages/extract-core/src/
registry.js`: `registerLazyFormat(descriptor)` takes `{ id, label,
extension, mediaType, approxBytes, capabilities, estimateBytes, load: ()
=> Promise<FormatPlugin> }`; `formats()` lists it (with `approxBytes` and
a `loadState`) without ever calling `load()`; `resolveFormat(id)` is the
one place that calls it, exactly once per id (concurrent callers share
one in-flight promise), with failures mapped to a new `FORMAT_LOAD_FAILED`
error code (`@cngeo/spec`). `download()` now resolves the format lazily
inside its internal `run()`, emitting a `'loading-format'` progress event
first — see `packages/extract-core/test/registry-lazy.test.js` and the
new tests appended to `download-handle.test.js` for coverage (load
exactly once, concurrent-resolve sharing, failure → `FORMAT_LOAD_FAILED`,
caching). Every package in this round (`format-gpkg`, `format-flatgeobuf`)
exports a ready-made `*FormatDescriptor` using this shape; the
zero-dependency ones (`format-shapefile`, `format-extras`) export one too,
whose `load()` just resolves immediately — demonstrating the registry
treats "lazy but free" and "lazy and heavy" uniformly.

This is a design doc amendment (§3.4/§4), not yet landed in the doc file
itself — see the final report for why (a concurrent agent is actively
editing that same file's §3.2/ranking section in this shared working
tree; the amendment content is written and ready, held back from a
same-file commit race rather than risking it).

---

## 9. What stays unsolved

- **No real browser smoke test** for any CDN-URL dynamic-import path in
  this round (sql.js, flatgeobuf, terrio) — every functional validation
  here ran in Node against the npm-installed equivalent package (the same
  test-injection pattern `extract-core/src/cdn.js` already established
  for hyparquet-writer), which is strong but not conclusive evidence for
  the actual `import('https://cdn.jsdelivr.net/...')` path a zero-build
  page would take.
- **gdal3.js and terrio: measured, not functionally exercised.** Their
  payload weight was enough to disqualify both from this round's "ship
  the light path" mandate (O5's own framing: "gdal3.js becomes a second
  plugin for anyone who wants its other drivers and will pay for them"),
  so neither was driven to actually convert a file in this session.
  `@cngeo/format-gdal` (gdal3.js-backed) remains the documented future-work
  path for File Geodatabase and anything else outside this round's four
  shipped formats.
- **KML.** See §7 — scoped in, not done.
- **Design doc amendment not committed** — written (§8), held out of a
  same-file commit race with a concurrent agent's in-flight edit to a
  different section of `docs/design/widgets-architecture.md`.
- **Numeric field width tuning in Shapefile/Esri JSON** is generous-but-
  arbitrary (e.g. dBase `N` fields at 18 digits for ints, `F` fields at
  32/10 for floats) rather than computed from the actual schema's known
  range; real data with extreme magnitudes could still overflow into the
  `*` marker. Flagged, not fixed, in this round.

---

## 10. Browser verification (2026-11-12, follow-up)

§9's "No real browser smoke test" gap is closed. `examples/download-demo`
now wires every format package from this round into a real **format
picker** (GeoJSON/GeoParquet eager, GeoPackage/Shapefile/FlatGeobuf/CSV/
Esri JSON all through `registerLazyFormat`), and
`examples/download-demo/verify.mjs` drives it end to end with Playwright
against a real Chromium page, the live geoBoundaries gazetteer (area
search: "liechtenstein"), and the live FTW Liechtenstein GeoParquet (the
same 218 KB / 795-field file this package's own tests already used) --
not Node's `setXModule()` injection seam, which cannot exercise an
absolute-URL dynamic `import()` at all.

**What this proved, measured, not assumed:**

- **The real `import('https://cdn.jsdelivr.net/...')` path works, in an
  actual browser, for both heavy/lazy formats.** sql.js
  (`@cngeo/format-gpkg`) and flatgeobuf's `geojson` submodule
  (`@cngeo/format-flatgeobuf`) both load via their exact pinned CDN URLs
  from `cdn.js` in each package -- `https://cdn.jsdelivr.net/npm/sql.js@1.13.0/+esm`
  (plus `dist/sql-wasm.wasm` via `locateFile`) and
  `https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/dist/esm/geojson.js/+esm`
  -- and the resulting plugin writes a correct file. **No descriptor fix
  was needed**: both URLs were already absolute, pinned CDN URLs (not a
  bare specifier or a Node-only path), and `curl`-ing each one ahead of
  the browser run confirmed `200`, `content-type:
  application/javascript`, and real bundled ESM content (jsdelivr's
  Rollup/esbuild header comment) before ever opening a page.
- **The lazy-loading proof, via real network capture (Playwright's
  Chromium request events, backed by the CDP `Network` domain):** across
  the whole happy-path run, zero requests to `cdn.jsdelivr.net` matching
  `sql-wasm`/`sql.js`/`flatgeobuf` occurred before that format was
  explicitly selected in the picker and "Download" was clicked. After
  selecting GeoPackage, exactly two sql.js requests fired (`+esm` glue,
  then `dist/sql-wasm.wasm`) and both are timestamped after the click;
  likewise FlatGeobuf's one `+esm` request. Every other registered lazy
  format (Shapefile, CSV, Esri JSON) loaded with **zero** network
  requests at all, confirmed the same way -- the registry's "lazy but
  free" and "lazy and heavy" paths really are one uniform code path, as
  RESULTS.md §8 claimed from the Node-only evidence available at the
  time.
- **Every format, downloaded for real and validated locally, per the
  task's own validation bar** (GDAL 3.10.3 `ogrinfo`, DuckDB v1.4.1 with
  the `spatial` extension) -- all 769 rows (Liechtenstein, FTW fields,
  `confidence >= 0.5`), all matching `result.rows` exactly:

  | format | bytes written | validated with | feature/row count |
  |---|---|---|---|
  | GeoJSON | 938,135 | (existing E5 coverage) | 769 |
  | GeoParquet | 193,541 | (existing E5 coverage) | 769 |
  | GeoPackage (`.gpkg`) | 798,720 | `ogrinfo -al -so` | 769 |
  | Shapefile (`.shp.zip`) | 728,799 | `ogrinfo -al -so` (opens the zip directly) | 769 |
  | FlatGeobuf (`.fgb`) | 667,256 | `duckdb` `ST_Read` (spatial ext.) | 769 |
  | CSV (WKT geometry) | 1,387,466 | `duckdb` `read_csv` | 769 |
  | Esri JSON (FeatureSet) | 1,461,432 | `ogrinfo -al -so` (`ESRIJSON` driver) | 769 |

- **`FORMAT_LOAD_FAILED` shows a clean, dedicated failure, not a garbled
  one.** A second page intercepted (`page.route`) sql.js's CDN request
  and aborted it -- a real network-level failure, not a mock of
  `resolveFormat()` -- and selecting GeoPackage + clicking Download
  produced the registry's real `FORMAT_LOAD_FAILED` error, which the demo
  renders in its own `#formatLoadError` box (distinct from the generic
  `#downloadInfo` error line every other failure uses) with a plain-
  language retry hint. The picker's GeoPackage row simultaneously
  reflects the registry's `loadState: 'failed'`.
- **A real UI bug found and fixed in the demo's own wiring** (not in any
  `@cngeo/format-*` package, and not a pre-existing bug -- it was
  introduced, and caught, in this same round of work): `download.js`'s
  `run()` emits the `'loading-format'` progress event **before** calling
  `resolveFormat()`, and `resolveFormat()` is what actually flips
  `registry.js`'s `lazyLoadState` to `'loading'` (its own first
  statement). A picker re-render driven synchronously from that progress
  event therefore reads `formats()` one statement too early and never
  observes `loadState: 'loading'` -- the loading row silently never
  appeared. Fixed in `examples/download-demo/index.html` with a page-
  owned `pendingLoadFormatId` flag, set the instant the event fires and
  cleared when the download settles, independent of the registry's own
  timing. This is a lesson for any other consumer of `'loading-format'`
  wanting to reflect `formatLoadState()` live, not just this demo: don't
  assume the registry's own state has already caught up to its own
  event.

**Evidence:** `examples/download-demo/verify.mjs` (extended to drive all
seven formats, the network-capture lazy-load proof, and the
`FORMAT_LOAD_FAILED` path), run against the live catalog with
`node examples/download-demo/verify.mjs <port>` (serve.py must be
running). Screenshots committed alongside the demo:
`examples/download-demo/screenshot.png` (the picker, every weight label
visible, nothing loaded yet), `screenshot-loading-gpkg.png` (GeoPackage's
"loading…" row mid-fetch), and `screenshot-format-load-failed.png` (the
dedicated `FORMAT_LOAD_FAILED` box).

**Still not covered:** terrio-js and gdal3.js remain Node-measured only
(§1/§2) -- this round's browser verification was scoped to the four
format packages this project actually ships (`format-gpkg`,
`format-shapefile`, `format-flatgeobuf`, `format-extras`), not the two
disqualified-on-weight candidates.
