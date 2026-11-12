# @cnmw/format-shapefile

Shapefile output for `@cnmw/download-core`. Part of O5's research scope:
"evaluate a credible Shapefile writer, same validation bar as GeoPackage."
It was credible — zero dependencies, no wasm — so it shipped.

## What this costs your page

**Effectively nothing: ~3-5 KB of this package's own code, no wasm, no CDN
fetch.** There is no heavy dependency to lazy-load — `.shp`/`.shx`/`.dbf`
binary layout and a STORED-only ZIP container are both small enough to
hand-write (see `src/shp.js`, `src/dbf.js`, `src/zip.js`). Register it
eagerly:

```js
import { registerFormat } from '@cnmw/download-core';
import { createShapefileFormat } from '@cnmw/format-shapefile';
registerFormat(createShapefileFormat());
```

A `shapefileFormatDescriptor` is also exported for a page that lists every
format through the lazy-registration API uniformly — its `load()`
resolves immediately, so this costs nothing extra either way.

## Why a `.shp.zip`, not four separate files

A Shapefile is really five sibling files (`.shp`/`.shx`/`.dbf`/`.prj`/
`.cpg`), but `download-core`'s `Sink` writes exactly one file per
download. This package bundles them into one `.shp.zip` — the container
GDAL/`ogr2ogr`, QGIS, and ArcGIS all open directly, no manual unzip step
(`ogrinfo -al -so out.shp.zip` just works; confirmed in
`test/shapefile-write.test.js`). `terrio-js`'s own Shapefile writer
independently makes the same choice (see
`experiments/e10-heavy-formats/RESULTS.md`).

Pulling in `jszip` (measured: 37 KB gzip) to zip five tiny, already-in-
memory, uncompressed buffers would be the one dependency this package
otherwise has zero reason to carry, so `src/zip.js` hand-writes a
STORED-only ZIP instead (~80 lines, including a table-free CRC-32).

## Shapefile's real limits, surfaced as warnings — not silent mangling

This was the task's explicit bar, and it's a real format, not a
strawman: Shapefile predates Unicode-safe schemas and 64-bit file
offsets, and most JS shapefile writers just quietly truncate or drop
what doesn't fit. This package doesn't:

| limit | what happens | warning code |
|---|---|---|
| dBase field names are 10 bytes max | truncated and, on a collision, deduped with a numeric suffix | `shapefile-field-name-truncated` |
| One shape type per file | a result that mixes incompatible geometry families (e.g. `Point` rows with `Polygon` rows — `Polygon`/`MultiPolygon` *do* coexist fine, as do `LineString`/`MultiLineString`, both via Shapefile's own multi-part encoding) is **refused**, not silently coerced | `FORMAT_CAPABILITY` (a hard error, not a warning — there is no non-corrupting way to write it) |
| ~2 GiB practical size ceiling | warned once the written file exceeds it (many real-world readers, including older ArcGIS, misbehave well before the theoretical signed-word-offset limit) | `shapefile-size-ceiling` |
| dBase `DATE` has no time-of-day | a `timestamp` value's time component is dropped | `shapefile-date-truncated` |
| dBase `N`/`F` fields are fixed-width | a value too wide for its declared field is clamped to `*` (the classic dBase overflow marker GDAL itself recognizes), not corrupted | `shapefile-numeric-overflow` |

These come back on `FormatWriter.close()`'s result as `{ rows, bytes,
warnings }`; `download-core`'s `download()` re-emits each one through its
existing `'warning'` event and attaches them to the `DownloadResult` as
`formatWarnings` (an additive change to `download.js`, documented in the
design doc's lazy-loading amendment).

## Correctness detail: ring winding

Shapefile's polygon ring-winding convention is the *mirror image* of
GeoJSON's (RFC 7946: exterior counter-clockwise, holes clockwise;
Shapefile: exterior clockwise, holes counter-clockwise). `src/shp.js`
corrects this by computing each ring's actual signed area and flipping it
if needed — not by assuming the input already follows either convention.
`test/shapefile-write.test.js` proves this isn't cosmetic: a polygon with
a real hole round-trips through DuckDB's `ST_Area` at exactly the
hole-subtracted area (64.0 for a 10×10 square with a 6×6 hole punched
out); a winding bug would report 100 (hole ignored) or a self-intersecting
mess.

## Output-size estimates: the geometry term

`estimateBytes(schema, rows, ctx)` takes an additive, optional third
argument (`ctx.avgGeometryBytes`: the dataset's own average geometry
bytes per row, derived from parquet footer statistics by `download-core`).
`estimateShapefileBytes` is exported and shared by the plugin and
`shapefileFormatDescriptor`, so the two can never drift; called with two
arguments it falls back to the old flat per-row constant.

A shapefile shape record stores the same float64 coordinate pairs WKB
does, and the `.zip` this plugin writes is **stored, not deflated**, so
nothing is compressed away. The geometry term is therefore
`1.0 × avgGeometryBytes + 60` — the 60 being the 8-byte `.shp` record
header, the polygon record's own header (type, bbox, part counts) and the
8-byte `.shx` index entry — on top of the existing
`schema.length × 40 + 90` dBase/zip term.

Measured against the written archive: 942 B/row for 795 FTW Liechtenstein
field boundaries whose WKB is 745 B/row, 11,165 against 10,895 for 400
geoBoundaries CGAZ ADM1 units, 37,228 against 37,052 for 218 CGAZ ADM0
boundaries — 1.00–1.02× all-in once the dBase record is accounted for.

Modelled estimate ÷ bytes actually written:

| dataset | before | after |
|---|---|---|
| 795 FTW Liechtenstein field boundaries | 166,950 / 748,985 = **0.22×** | 807,101 / 748,985 = **1.08×** |
| 218 geoBoundaries CGAZ ADM0 boundaries | 54,500 / 8,115,740 = **0.007×** | 8,154,102 / 8,115,740 = **1.00×** |

## What you give up versus GeoPackage/GeoParquet

- No nested/struct columns — dBase III has no such concept (the design
  doc's `capabilities.nestedColumns: false`).
- Field names cost accuracy at 10 characters; a wide schema with similar
  prefixes will produce `FIELD_1`-style collisions.
- No native CRS — this plugin always writes a fixed WGS84 `.prj`
  (refusing non-4326 input with `FORMAT_CAPABILITY`, same as the other
  plugins in this project).

## Running this package's tests

```
node --test packages/format-shapefile/test/*.test.js
```

Validates with the local `ogrinfo`/`duckdb` CLIs (an environment-check
test fails loudly, rather than silently skipping, if either is missing).
