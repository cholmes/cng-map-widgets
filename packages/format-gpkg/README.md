# @cngeo/format-gpkg

GeoPackage output for `@cngeo/extract-core`: the O5 design-doc decision
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
`@cngeo/extract-core`, or even every page that imports this package. It is
paid exactly once, the first time a `download()` for `format: 'gpkg'`
actually runs:

```js
import { registerLazyFormat, download } from '@cngeo/extract-core';
import { gpkgFormatDescriptor } from '@cngeo/format-gpkg';

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
import { registerFormat } from '@cngeo/extract-core';
import { createGpkgFormat } from '@cngeo/format-gpkg';
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
  light path worked; gdal3.js stays future work (`@cngeo/format-gdal`) for
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
  `gpkg` entry in extract-core's format registry, which only ever writes
  feature tables.
- **2D geometry only** (no Z/M). Every source this project reads (CGAZ,
  FTW, FIRMS) is 2D; the WKB encoder (`src/wkb.js`) throws a clear error
  rather than silently dropping a Z coordinate if that ever changes.
- **No `gpkg_extensions` metadata table.** Not needed for the base
  profile; added if a future feature needs it (e.g. an actual tiles
  extension, out of scope here).

## Memory ceiling (honest, not streaming)

`FormatPlugin.streaming` is `false`, same category as extract-core's own
`geoparquet` plugin, for the same structural reason: `gpkg_contents`'
bbox and `gpkg_geometry_columns`' `geometry_type_name` are only knowable
once every row has been seen, and sql.js's `Database.export()` serializes
the *entire* in-memory database every time — there's no "append to a file
on disk" mode to stream into.

Peak memory while writing is roughly three copies of the data alive at
once:

1. buffered JS row arrays (built incrementally in `writeBatch`),
2. sql.js's in-memory SQLite database (built in `close()`, comparable in
   size to the final `.gpkg` file, held in the wasm heap), and
3. the exported `Uint8Array` copy handed to the sink.

For the row counts this system's download ceiling targets (see the main
design doc's `Ceiling.outputBytes` default, 2 GiB) that's tens of MB in
practice, not hundreds — but it is real, and `extract-core`'s own
ceiling check (`est.outputBytes.max > ceiling.blobBytes` for a
non-streaming format) is what actually protects a page from a GeoPackage
download large enough for this to matter.

## Output-size estimates: the geometry term

`estimateBytes(schema, rows, ctx)` takes an additive, optional third
argument (`ctx.avgGeometryBytes`: the dataset's own average geometry
bytes per row, derived from parquet footer statistics by `extract-core`).
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
npm test -w @cngeo/format-gpkg
```

`gpkg-write.test.js` builds files in memory and validates them with the
local `ogrinfo`/`duckdb` CLIs (skips those assertions, not the whole
suite, if either is missing — see the environment-check test at the
bottom of that file, which fails loudly if validation was silently
skipped). `gpkg-integration.test.js` additionally touches the network
(the real FTW Liechtenstein file) and skips cleanly offline.
