# @cngeo/format-flatgeobuf

FlatGeobuf output for `@cngeo/extract-core`, wrapping the official
[`flatgeobuf`](https://www.npmjs.com/package/flatgeobuf) package's
GeoJSON serializer.

## What this costs your page

**~10 KB (min+gz), measured** — lighter than the design doc's original
~25 KB estimate for this format.

| piece | raw | min+gz | measured |
|---|---|---|---|
| `flatgeobuf@4.6.1`'s `geojson` submodule, jsdelivr `+esm` bundle | 37,603 B | **10,074 B** | `curl` the CDN file, `gzip -9` |

The full `flatgeobuf` package (its `.` export) also pulls in generic,
non-GeoJSON machinery (an Arrow-IO-adjacent reader/writer path this
plugin never touches); loading only the `geojson` submodule — confirmed
tree-shaken by jsdelivr's bundler, not just "the import path we asked
for" — is most of why this measured lighter than guessed.

Load it on demand, like the heavier formats:

```js
import { registerLazyFormat } from '@cngeo/extract-core';
import { flatGeobufFormatDescriptor } from '@cngeo/format-flatgeobuf';
registerLazyFormat(flatGeobufFormatDescriptor);
```

## What you give up

- **Not streaming.** `flatgeobuf`'s JS binding only exposes
  `serialize(featureCollection, crsCode)` — a whole-collection call, not
  an incremental encoder — even though FlatGeobuf's own file format
  (header + packed R-tree + features) is designed to stream. Writing a
  hand-rolled incremental FlatGeobuf encoder was out of scope for what
  was meant to be the cheapest format after GeoJSON/GeoParquet; this
  plugin buffers the batch as a GeoJSON `FeatureCollection` in memory and
  serializes once in `close()`.
- **No int/float distinction.** `flatgeobuf`'s GeoJSON serializer infers
  a column's schema type from sampled JS values, and GeoJSON itself makes
  no int/float distinction — an integer column (`pop: 5696`) round-trips
  as a double (`5696.0`). Confirmed in `test/flatgeobuf-write.test.js`;
  this is the wrapped package's own behavior, not something this plugin
  introduces or could silently "fix" without re-implementing the encoder.

## Output-size estimates: the geometry term

`estimateBytes(schema, rows, ctx)` takes an additive, optional third
argument (`ctx.avgGeometryBytes`: the dataset's own average geometry
bytes per row, derived from parquet footer statistics by `extract-core`).
`estimateFlatGeobufBytes` is exported and shared by the plugin and
`flatGeobufFormatDescriptor` — and is pure JS, so the descriptor can model
output bytes without loading the flatgeobuf module at all. Called with two
arguments it falls back to the old flat per-row constant.

FlatBuffers stores coordinates as the same raw float64 pairs WKB does,
with no general compression, so the geometry term is
`1.0 × avgGeometryBytes` — the closest fit of any format in this project.
Measured against the written file: 862 B/row for 795 FTW Liechtenstein
field boundaries whose WKB is 745 B/row, 11,018 against 10,895 for 400
geoBoundaries CGAZ ADM1 units, 37,277 against 37,052 for 218 CGAZ ADM0
boundaries — the model lands within 2.5%, 1.1% and 0.2% respectively.

Modelled estimate ÷ bytes actually written:

| dataset | before | after |
|---|---|---|
| 795 FTW Liechtenstein field boundaries | 75,525 / 684,920 = **0.11×** | 667,976 / 684,920 = **0.98×** |
| 218 geoBoundaries CGAZ ADM0 boundaries | 23,980 / 8,126,336 = **0.003×** | 8,110,502 / 8,126,336 = **1.00×** |

## Validated, not assumed

`test/flatgeobuf-write.test.js` writes Point and MultiPolygon batches and
validates the bytes with `ogrinfo -al -so` (feature count, geometry type,
CRS) and DuckDB's spatial `ST_Read` (attribute values, `ST_NumGeometries`
on the MultiPolygon case) — the same bar every format package in this
project uses.

## Running this package's tests

```
node --test packages/format-flatgeobuf/test/*.test.js
```
