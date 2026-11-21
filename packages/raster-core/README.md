# @cngeo/raster-core

Clip a window out of a remote Cloud-Optimized GeoTIFF **in the browser**, pick
the bands you want, and save a valid GeoTIFF — no server, no bundler, no full
download.

```js
import { describeRasterDataset, estimateRasterClip, downloadRaster } from '@cngeo/raster-core';
import { autoSink } from '@cngeo/download-core';

const item = await (await fetch(stacItemUrl)).json();      // a STAC Item
const dataset = describeRasterDataset(item);               // bands from eo:bands / raster:bands

const est = await estimateRasterClip(dataset, area, { bands: ['red', 'green', 'blue'] });
// est.decodedBytes.exact === true -- window px x bands x dtype, known before a pixel is read
// est.readBytes.exact   === true -- summed TileByteCounts of the tiles the window touches

const sink = await autoSink({ suggestedName: 'clip.tif' }); // user gesture first
const handle = downloadRaster(dataset, area, { bands: ['red', 'green', 'blue'] }, {}, { sink });
handle.on('ceiling', () => handle.acceptCeiling());         // or let the user decide
const result = await handle.result;
```

Measured on a real Sentinel-2 L2A scene (`sentinel-cogs`, AWS Open Data):
a 1544 × 1086 px, 3-band uint16 clip fetched **32.7 MB in 12 range requests**
instead of the **689 MB** the three source assets weigh — and the resulting
file matched GDAL's own read of the same window on every one of 5 030 352
pixels.

## What it does, and what it deliberately does not

| | |
|---|---|
| Windowed read over HTTP ranges | yes — geotiff.js, tile-granular, overviews available |
| Band subset | yes — separate per-band files (Sentinel-2) or samples inside one file (TCI) |
| Output | a plain, striped GeoTIFF: dtype preserved, CRS + transform + nodata written, DEFLATE or uncompressed |
| Size/cost estimate before downloading | yes, and `decodedBytes`/`readBytes` are **exact**, not modelled |
| Memory ceiling with an explicit refusal | yes — the window must fit in RAM (default 384 MiB decoded) |
| Reprojection | **no** — `RASTER_CRS_UNSUPPORTED` outside EPSG:4326 / 3857 / WGS84 UTM |
| Resampling to an arbitrary resolution | **no** — native, or an overview level, nothing in between |
| Masking to the area's polygon | **no** — the clip is the area's **bounding box** (`bbox-only-clip` warning on every estimate) |
| Applying STAC `scale`/`offset` | **no** — raw digital numbers are copied verbatim (warned about) |
| Cloud-optimizing the output | **no** — no overviews, no tiling; it is a window, not an archive |
| Mixing grids or dtypes in one output | **no** — `RASTER_GRID_MISMATCH` / `RASTER_MIXED_DTYPE` |

Every "no" is an explicit error or warning. None of them fails silently.

## Why it does not use geotiff.js's writer

`writeArrayBuffer` writes **one byte per sample regardless of
`BitsPerSample`**, so a uint16 or float32 raster comes out with a quarter to a
half of its payload and GDAL refuses the strip
(`TIFFReadEncodedStrip: got 16 bytes, expected 32`). It also corrupts the
GeoKeyDirectory as soon as an ASCII geokey (`GTCitationGeoKey`) or
`ProjLinearUnitsGeoKey` is present — GDAL then reports *"GeoTIFF tags
apparently corrupt, they are being ignored"* and the file has **no CRS at
all**. 8-bit data plus exactly
`{GTModelTypeGeoKey, GTRasterTypeGeoKey, ProjectedCSTypeGeoKey}` is the only
combination that round-trips. Sentinel-2 is uint16, so `src/geotiff-writer.js`
is ~230 lines of tag layout instead. Evidence:
`experiments/e11-raster-clip/RESULTS.md`.

## Packaging

Plain ESM + JSDoc, no build step, like the other `@cngeo` packages. geotiff.js
is loaded lazily from an **exact pinned CDN URL** the first time a raster is
opened (`src/cdn.js`), never as a bare specifier:

* `https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm` — 22.6 KB gz (+ 4.8 KB gz
  for its float16 dependency, pinned by the same bundle)
* `https://cdn.jsdelivr.net/npm/zstddec@0.1.0/+esm` — 23.8 KB gz, fetched
  **only** when a source turns out to be ZSTD-compressed (geotiff.js 2.1.3
  ships no ZSTD decoder; `ensureZstdDecoder()` registers one through its
  public `addDecoder` seam)

`setGeoTiffModules({ geotiff })` hands in a host's own copy instead — the same
host-injection seam `@cngeo/download-core`'s `setHyparquetModules` provides, and
what makes `node --test` possible.

`rasterClipPlugin` exports the `{ name, approxBytes, load }` descriptor shape
that download-core's `registerLazyFormat` amendment established, so a format
picker can show "GeoTIFF clip (+~28 KB)" before anything is fetched.

## Errors

`RASTER_NOT_GEOREFERENCED`, `RASTER_CRS_UNSUPPORTED`,
`RASTER_COMPRESSION_UNSUPPORTED` (raised at open time, before any pixel bytes
are paid for), `RASTER_MIXED_DTYPE`, `RASTER_GRID_MISMATCH`,
`RASTER_BAND_UNKNOWN`, `RASTER_NO_BANDS`, `RASTER_AREA_DISJOINT`,
`RASTER_AREA_ANTIMERIDIAN`, plus `@cngeo/spec`'s `CANCELLED`, `AREA_EMPTY`,
`SINK_*` and `NETWORK`.

## Tests

```
node --test packages/raster-core/test/*.test.js
```

26 tests, all offline: the CRS transforms are pinned against GDAL/PROJ
reference values, the writer round-trips through geotiff.js, and the planner
and download handle run against a fake Sentinel-2-shaped source. The networked
evidence (GDAL reading real browser output) lives in
`experiments/e11-raster-clip/`.
