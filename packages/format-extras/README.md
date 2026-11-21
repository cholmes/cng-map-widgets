# @cngeo/format-extras

The "nearly free" `@cngeo/download-core` output formats: **CSV** (attributes
+ WKT geometry) and **Esri JSON** (a REST `FeatureSet` document). Both
zero-dependency, zero-wasm, and cheap enough to register eagerly.

## What this costs your page

**~0 KB beyond this package's own code (a few KB).** No CDN fetch, no
wasm, nothing to lazy-load. `csvFormatDescriptor`/`esriJsonFormatDescriptor`
are exported anyway, for a page that lists every format uniformly through
`registerLazyFormat` — their `load()` resolves immediately.

```js
import { registerFormat } from '@cngeo/download-core';
import { createCsvFormat, createEsriJsonFormat } from '@cngeo/format-extras';
registerFormat(createCsvFormat());
registerFormat(createEsriJsonFormat());
```

## CSV

Options match the design doc's format-options table exactly: `{
geometry?: 'wkt'|'drop' ('wkt'), delimiter?: string (',') }`. Streaming —
the header is written the moment `open()` runs (schema is known up
front; no need to wait for the first batch), and each row is text the
instant it arrives. RFC 4180 escaping (quote a field containing the
delimiter, a quote, or a newline; double embedded quotes) — not a naive
`join(',')` that breaks on the first comma in a name field.

Validated: `test/csv.test.js` round-trips a written file through DuckDB's
`read_csv` + `ST_GeomFromText(wkt)` and confirms the parsed geometry
matches.

## Esri JSON (FeatureSet)

The format ArcGIS Online, the ArcGIS REST API, and ArcGIS Pro/Field Maps'
"Add Data" accept directly — `{ geometryType, spatialReference: { wkid:
4326 }, fields, features: [{ attributes, geometry }] }`. Not streaming (a
FeatureSet is one JSON document; ArcGIS's own REST API never returns it
newline-delimited).

Two things this writer gets right that a naive GeoJSON-to-Esri
transliteration would not:

- **Ring winding.** Esri's `rings` convention is the same as Shapefile's
  (outer clockwise, holes counter-clockwise — the mirror of GeoJSON's RFC
  7946 convention), corrected by signed area rather than assumed from
  input order. `test/esrijson.test.js` validates a polygon-with-hole's
  shape with `ogrinfo`.
- **One `geometryType` per FeatureSet.** Esri FeatureSets, like
  Shapefiles, allow exactly one geometry type for the whole set. Mixing
  incompatible types (Point rows with Polygon rows) is refused with
  `FORMAT_CAPABILITY`, not silently coerced.

Validated: `test/esrijson.test.js` confirms GDAL's `ESRIJSON` driver
(`ogrinfo -al -so`) reads the written document — feature count, geometry
type, and the mixed-type refusal.

## Output-size estimates: the geometry term

`estimateBytes(schema, rows, ctx)` takes an additive, optional third
argument (`ctx.avgGeometryBytes`: the dataset's own average geometry
bytes per row, derived from parquet footer statistics by `download-core`).
Both plugins here, and both of their `LazyFormatDescriptor`s, share one
implementation each — `estimateCsvBytes` / `estimateEsriJsonBytes`, both
exported — so a descriptor's estimate and its loaded plugin's can never
disagree. Called with two arguments, they fall back to the old flat
per-row constant.

The geometry factors are measured, not guessed: the WKT (or Esri ring)
text of every written row was summed and divided by the source's WKB
bytes per row.

| | geometry term | measured | why |
|---|---|---|---|
| `csv` | `2.4 × avgGeometryBytes + 16` | 2.37× (FTW Liechtenstein), 2.38× (CGAZ ADM0), 2.40× (CGAZ ADM1) | `geometryToWkt` writes full JS double precision — `-9.521234567890123 47.123456789012345`, ~37 bytes a coordinate pair, against 16 bytes of WKB. The 16 covers `POLYGON ((` … `))` and the two quotes RFC 4180 forces (WKT contains commas). |
| `esrijson` | `2.45 × avgGeometryBytes + 20` | ~2.39× (FTW), ~2.44× (CGAZ ADM0) | Esri rings are the same full-precision coordinate text, nested one level deeper. |

What that changed, on live data (modelled estimate ÷ bytes actually
written):

| dataset | format | before | after |
|---|---|---|---|
| 795 FTW Liechtenstein field boundaries | `csv` | 84,270 / 1,423,923 = **0.06×** | 1,463,222 / 1,423,923 = **1.03×** |
| 218 geoBoundaries CGAZ ADM0 boundaries | `csv` | 25,724 / 19,217,657 = **0.001×** | 19,421,605 / 19,217,657 = **1.01×** |
| 795 FTW Liechtenstein field boundaries | `esrijson` | 209,880 / 1,500,215 = **0.14×** | 1,534,185 / 1,500,215 = **1.02×** |
| 218 geoBoundaries CGAZ ADM0 boundaries | `esrijson` | 63,656 / 19,728,426 = **0.003×** | 19,840,755 / 19,728,426 = **1.01×** |

The one case this still gets wrong: `avgGeometryBytes` is a *per-file*
average, so a query whose `limit` or filter takes a non-representative
slice of a file with wildly varying geometry sizes inherits that error.
Reading the first 400 of geoBoundaries ADM1's 3,224 rows — the largest
ones, because that file's row groups run biggest-first — models 0.41× of
what is written, because those rows' real WKB is 10,895 B/row against the
file's 4,470 B/row average.

## What was left out, and why

- **File Geodatabase.** GDAL's `OpenFileGDB` driver has had write support
  since GDAL 3.6, but that write support is only reachable through a real
  GDAL build — `gdal3.js`, measured at 9.07 MB gzip in
  `experiments/e10-heavy-formats/RESULTS.md`. There is no lightweight,
  zero-wasm path to File Geodatabase the way there is to GeoPackage (a
  documented SQLite schema) or Shapefile (a documented flat-file format);
  it stays future work under the `gdal3.js`-backed `@cngeo/format-gdal`
  package note in the design doc, not something this package could do
  cheaply.
- **KML.** Dropped from this round's scope under time pressure, not
  because it's hard — it's a straightforward XML `Placemark` writer, a
  near-identical shape to this package's CSV/EsriJSON writers. Noted as
  the one explicitly-scoped-in format this package didn't get to.

## Running this package's tests

```
node --test packages/format-extras/test/*.test.js
```
