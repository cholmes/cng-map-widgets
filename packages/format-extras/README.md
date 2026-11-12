# @cnmw/format-extras

The "nearly free" `@cnmw/download-core` output formats: **CSV** (attributes
+ WKT geometry) and **Esri JSON** (a REST `FeatureSet` document). Both
zero-dependency, zero-wasm, and cheap enough to register eagerly.

## What this costs your page

**~0 KB beyond this package's own code (a few KB).** No CDN fetch, no
wasm, nothing to lazy-load. `csvFormatDescriptor`/`esriJsonFormatDescriptor`
are exported anyway, for a page that lists every format uniformly through
`registerLazyFormat` — their `load()` resolves immediately.

```js
import { registerFormat } from '@cnmw/download-core';
import { createCsvFormat, createEsriJsonFormat } from '@cnmw/format-extras';
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

## What was left out, and why

- **File Geodatabase.** GDAL's `OpenFileGDB` driver has had write support
  since GDAL 3.6, but that write support is only reachable through a real
  GDAL build — `gdal3.js`, measured at 9.07 MB gzip in
  `experiments/e10-heavy-formats/RESULTS.md`. There is no lightweight,
  zero-wasm path to File Geodatabase the way there is to GeoPackage (a
  documented SQLite schema) or Shapefile (a documented flat-file format);
  it stays future work under the `gdal3.js`-backed `@cnmw/format-gdal`
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
