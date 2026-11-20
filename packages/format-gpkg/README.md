# @cng/format-gpkg

GeoPackage output for `@cng/download-core`: the O5 design-doc decision
(`docs/design/widgets-architecture.md` §4.5/O5), implemented and measured.

## What this costs your page

**~340 KB (min+gz), loaded once, only when a user actually picks GeoPackage.**

| piece | raw | min+gz | measured |
|---|---|---|---|
| sql.js wasm (`sql-wasm.wasm@1.13.0`) | 659,806 B | **321,893 B** | `curl` the CDN file, `gzip -9` |
| sql.js glue JS (`sql-wasm.js@1.13.0`) | 48,788 B | **17,352 B** | same |
| this package's own code (`src/*.js`) | ~9 KB | ~3 KB | concatenated, `gzip -9` |
| **total** | — | **~339 KB** | |

That is *lighter* than the design doc's original ~480 KB estimate for this
path (sql.js itself got smaller between the versions compared), and about
**27x lighter** than the `gdal3.js` alternative measured in
`experiments/e10-heavy-formats/RESULTS.md` (9.07 MB gzip for the full
driver set).

This weight is **not** paid by every page that imports
`@cng/download-core`, or even every page that imports this package. It is
paid exactly once, the first time a `download()` for `format: 'gpkg'`
actually runs:

```js
import { registerLazyFormat, download } from '@cng/download-core';
import { gpkgFormatDescriptor } from '@cng/format-gpkg';

registerLazyFormat(gpkgFormatDescriptor); // ~0 bytes: just registers the id, label, and this weight table
// ... later, only when the user picks "GeoPackage" in a format picker:
const handle = download(dataset, area, filter, { format: 'gpkg', filename: 'out.gpkg' });
// -> sql.js's wasm fetches now, cached by the registry for the rest of the page's life.
```

A format picker can read `gpkgFormatDescriptor.approxBytes` (`{ min:
330_000, max: 345_000, estimate: 339_000 }`) to show "GeoPackage (+~340KB)"
*before* the user commits to the fetch — the notice Chris's original
requirement asked for.

If you already have sql.js loaded for your own reasons, skip the lazy path
and register eagerly instead:

```js
import { registerFormat } from '@cng/download-core';
import { createGpkgFormat } from '@cng/format-gpkg';
import initSqlJs from 'sql.js';

registerFormat(createGpkgFormat(await initSqlJs()));
```

## Why sql.js, not gdal3.js (O5)

The design doc's O5 open item asked: hand-write the GeoPackage tables over
a minimal SQLite build (sql.js, ~480 KB estimated), or drive a real GDAL
wasm build (gdal3.js, 2–8 MB estimated)? `experiments/e10-heavy-formats/`
measured both:

- **sql.js path (this package): ~340 KB measured, and it works.** GeoPackage
  is a documented SQLite schema (the "vector features" profile needs only
  `gpkg_contents`, `gpkg_spatial_ref_sys`, `gpkg_geometry_columns`, and the
  feature table itself, with a small binary header in front of standard
  WKB for the geometry blob). Validated against real tooling, not just
  "it opens": `ogrinfo -al -so` reads every table this plugin writes
  cleanly (correct feature count, geometry type, CRS, attribute types),
  and DuckDB's `ST_Read` agrees on geometry and attribute values. A real,
  live download — FTW field boundaries for Liechtenstein, 100 rows,
  bbox-filtered — round-trips end to end and validates both ways (see
  `test/gpkg-integration.test.js`).
- **gdal3.js: 9.07 MB gzip, measured, not implemented.** Per O5's own
  framing ("gdal3.js becomes a second plugin for anyone who wants its
  other drivers and will pay for them"), this package exists because the
  light path worked; gdal3.js stays future work (`@cng/format-gdal`) for
  whoever needs a driver this package doesn't have (File Geodatabase
  write, for instance — see the research doc).

## What you give up versus a real GDAL build

- **No R-tree spatial index.** Measured: sql.js@1.13.0's published wasm
  build throws `no such module: rtree` on `CREATE VIRTUAL TABLE ... USING
  rtree(...)` — it isn't compiled with `SQLITE_ENABLE_RTREE`. The
  GeoPackage spec's R-tree extension is RECOMMENDED, not REQUIRED, for the
  base feature profile, so every file this package writes is still fully
  spec-valid without it (confirmed by `ogrinfo`/DuckDB above). The
  practical cost: QGIS/GDAL fall back to a full table scan for a spatial
  `WHERE` on the file, which doesn't matter at the row counts a
  bbox-pruned browser download produces.
- **No raster support.** Vector only — this plugin's whole job is the
  `gpkg` entry in download-core's format registry, which only ever writes
  feature tables.
- **2D geometry only** (no Z/M). Every source this project reads (CGAZ,
  FTW, FIRMS) is 2D; the WKB encoder (`src/wkb.js`) throws a clear error
  rather than silently dropping a Z coordinate if that ever changes.
- **No `gpkg_extensions` metadata table.** Not needed for the base
  profile; added if a future feature needs it (e.g. an actual tiles
  extension, out of scope here).

## Memory ceiling (honest, not streaming)

`FormatPlugin.streaming` is `false`, same category as download-core's own
`geoparquet` plugin, for the same structural reason: `gpkg_contents`'
bbox and `gpkg_geometry_columns`' `geometry_type_name` are only knowable
once every row has been seen, and sql.js's `Database.export()` serializes
the *entire* in-memory database every time — there's no "append to a file
on disk" mode to stream into.

Rows ARE inserted into the open sql.js database as each `writeBatch`
arrives (bigger-downloads task 9 — GitHub issue #3's step 1), inside a
transaction, with no row data retained afterwards. Only the two values
not knowable until the last row — `gpkg_geometry_columns`'
`geometry_type_name` and `gpkg_contents`' bbox — are buffered (as a small
`Set` and four numbers, not per-row), and corrected at `close()` with two
single-row `UPDATE`s.

Peak memory while writing is still two copies of the data alive at once,
not one:

1. sql.js's in-memory SQLite database (built incrementally across
   `writeBatch` calls, comparable in size to the final `.gpkg` file, held
   in the wasm heap), and
2. the exported `Uint8Array` copy `close()` hands to the sink.

(Before task 9 there was a third copy — every row buffered in JS arrays
from `writeBatch` until `close()` — which is what `memoryFactor` dropped
from 3.5 to **2.9** for. sql.js has no incremental-export mode, so this
is not yet a flat-memory writer; GitHub issue #3's OPFS-backed-SQLite
step is what gets there.)

**A chunked/incremental `export()` was investigated as a follow-up
(bigger-downloads task 10) and is not possible on this sql.js build.**
`sql.js@1.13.0` exposes no `FS`/`MEMFS`/`NODEFS` surface at all: `SQL.FS`
is `undefined`, and `Database.prototype` has exactly `close`,
`constructor`, `create_aggregate`, `create_function`, `each`, `exec`,
`export`, `getRowsModified`, `handleError`, `iterateStatements`,
`prepare`, `run`, `updateHook` — `export` and nothing chunked to depend
on. So **GitHub issue #3 (OPFS-backed SQLite) is the only path to a
GeoPackage writer whose peak memory doesn't scale with the output, not
one option among several** for getting there.

**`memoryFactor: 2.9` is measured, not estimated**, by
`test/memory-factor.verify.mjs`: synthetic WKB polygons at 2,000 rows ×
{100, 5,000, 20,000} vertices/row, one row-count/vertex-count case per
Node **process** (so one case's sql.js wasm heap can never carry into the
next), `process.memoryUsage().rss` sampled on a ~20 ms interval and kept
at its peak. The declared `2.9` comes from the 20,000-vertices/row case
**alone**, not the maximum across all three cases: at the 100-vertex case
the output is only ~4 MB while the fixed Node + sql.js-wasm baseline RSS
is ~110–150 MB, so that case's ratio (28–38×, before and after this
change alike — confirmed by re-running against the pre-task-9 writer)
is baseline overhead swamping a tiny output, not a per-byte buffering
cost, which is what `memoryFactor` is meant to measure. Rounded up from a
measured max of 2.82× over 10 runs at the 20,000-vertex case; rounding up
is the safe direction, since a higher factor means a *lower*, more
conservative ceiling.

For the row counts this system's download ceiling targets that's tens of
MB in practice, not hundreds — but it is real, and it is what
`download-core`'s own `effectiveCeiling({ format, sink })` actually
protects a page against: because this plugin declares
`capabilities.memoryFactor: 2.9` on a `streaming: false` format, its
`outputBytes` ceiling is `memoryBudget / 2.9` — **≈353 MiB** at the 1 GiB
default `memoryBudget` — regardless of which sink the download writes to,
including a `memorySink` (the sink-exemption applies only to a format
whose `memoryFactor` is `0`; see `@cng/download-core`'s README/AGENTS.md
for the full derivation). See `test/memory-factor.verify.mjs` for the
measurement script itself (run by hand, not part of `npm test`) and its
own in-script notes on why the smallest measured case is excluded from
the declared factor.

## Output-size estimates: the geometry term

`estimateBytes(schema, rows, ctx)` takes an additive, optional third
argument (`ctx.avgGeometryBytes`: the dataset's own average geometry
bytes per row, derived from parquet footer statistics by `download-core`).
`estimateGpkgBytes` is exported and shared by the plugin and
`gpkgFormatDescriptor` — and is pure JS, so the descriptor models output
bytes without loading sql.js, which is what
`LazyFormatDescriptor.estimateBytes` requires. Called with two arguments
it falls back to the old flat per-row constant.

A GeoPackage geometry BLOB is the same WKB the source held plus an 8-byte
GP header (this writer writes no envelope), so the geometry term is
`1.05 × avgGeometryBytes + 8` — the 1.05 covering SQLite's record and
overflow-page overhead around a large BLOB — plus
`schema.length × 12 + 120` for the attribute columns and SQLite's
per-row fixed cost (record header, page padding, the rtree row).

Measured against the written file: 1,020 B/row for 795 FTW Liechtenstein
field boundaries whose WKB is 745 B/row (that's where SQLite's fixed
per-row cost shows, hence the 120), 11,725 against 10,895 for 400
geoBoundaries CGAZ ADM1 units, 37,897 against 37,052 for 218 CGAZ ADM0
boundaries.

Modelled estimate ÷ bytes actually written:

| dataset | before | after |
|---|---|---|
| 795 FTW Liechtenstein field boundaries | 84,270 / 811,008 = **0.10×** | 752,454 / 811,008 = **0.93×** |
| 218 geoBoundaries CGAZ ADM0 boundaries | 25,724 / 8,261,632 = **0.003×** | 8,529,216 / 8,261,632 = **1.03×** |

This matters here more than for a streaming format: the `blobBytes`
ceiling check above reads `est.outputBytes.max`, and before this the
number it checked modelled no geometry at all — so a GeoPackage download
could sail under a 256 MiB blob ceiling and then try to build a
multi-gigabyte database in the wasm heap.

## Running this package's tests

```
npm test -w @cng/format-gpkg
```

`gpkg-write.test.js` builds files in memory and validates them with the
local `ogrinfo`/`duckdb` CLIs (skips those assertions, not the whole
suite, if either is missing — see the environment-check test at the
bottom of that file, which fails loudly if validation was silently
skipped). `gpkg-integration.test.js` additionally touches the network
(the real FTW Liechtenstein file) and skips cleanly offline.
`gpkg-streaming.test.js` covers the per-batch-insert behavior itself
(rows land in the open database before `close()`, the two metadata
`UPDATE`s, `abort()` closing the database). `memory-factor.verify.mjs` is
a slow, hand-run script (deliberately **not** part of `npm test`) that
re-measures `memoryFactor` — see "Memory ceiling" above.
