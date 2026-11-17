# E11 — In-browser raster clip & download

**Date:** 2026-11-12
**Question (Chris):** *"interested if there's raster possibilities, to clip into
a geotiff and download a subset of bands."*
**Verdict: yes — and it shipped.** `@cng/raster-core` + `examples/raster-demo`.

Short version:

* **Read: geotiff.js works, with three caveats worth knowing.** Windowed reads
  over HTTP ranges against real COGs cost **21–1324× less** than downloading
  the files, and the numbers are tile-granular and predictable.
* **Write: geotiff.js's `writeArrayBuffer` is unusable for this.** It is 8-bit
  only (it writes one byte per sample whatever `BitsPerSample` says) and
  corrupts the GeoKeyDirectory for most geokey sets. A ~230-line writer
  replaces it, and GDAL 3.10.3 validates its output.
* **Validation: zero mismatching pixels**, over 8.4 M compared pixels across
  uint8/uint16/float32, UTM and geographic, DEFLATE and ZSTD sources —
  including the file the **browser** produced (5 030 352 pixels, Chromium →
  `gdal.Open` → compared against `/vsicurl` reads of the sources).

---

## 1. What was measured against

Two real, public COG sources — one third-party, one from the user's own
catalogs — both verified for CORS and range behaviour before anything else:

| source | what it is | size | CORS | ranges |
|---|---|---|---|---|
| `sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/EG/2025/6/S2C_10SEG_20250617_0_L2A/` (B02/B03/B04/B08/TCI…) | Sentinel-2 L2A, MGRS 10SEG (San Francisco Bay), 2025-06-17, cloud 0.02 %, nodata 0 % | 228–231 MB per 10 m band; TCI 356 MB | `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: HEAD, GET`. **No `Access-Control-Expose-Headers`** | `Accept-Ranges: bytes`, 206 confirmed |
| `data.source.coop/ftw/global-data/predictions/confidence/crop-consensus/prue_v1_crop_count_mean_500m.tif` | FTW crop-consensus, global 500 m, float32, **ZSTD**, EPSG:4326 (from `~/repos/ftw-portolan`) | **1 040 896 487 B (1.04 GB)** | `access-control-allow-origin: *`, `access-control-expose-headers: *` | `accept-ranges: bytes`, 206 confirmed |

Discovery notes worth keeping:

* The first Sentinel-2 item Earth Search returned for the demo bbox
  (`S2B_10SEG_20250923`) is a **partial swath — only 22 % of the granule has
  data**, and the first windowed read came back all zeros. A granule's STAC
  footprint is not its valid-data extent; the item picked for everything below
  was re-selected with `s2:nodata_pixel_percentage < 1`. A raster widget that
  shows "0 everywhere" will usually be looking at this, not at a bug.
* `~/repos/italy-aerial-catalog` is **Zarr, not COG** (`application/vnd.zarr`,
  multiscales, EPSG:3857), so it is out of scope for geotiff.js and is the
  natural next target if raster support grows (see §8).
* `Content-Range` is **not a CORS-safelisted response header**. On
  sentinel-cogs (which exposes nothing extra) a browser cannot read the total
  file size from a range response, so `openRaster` falls back to one `HEAD`
  (`Content-Length` *is* safelisted). On source.coop (`expose-headers: *`) the
  size comes free with the first read and the HEAD is skipped.

---

## 2. Read side — geotiff.js verdict

**Works.** `fromUrl` + `readRasters({ window, samples })` issues coalesced
range reads and decodes only the tiles the window touches.

### Measured (Node, `01-probe-read.mjs` / `03-roundtrip.mjs`)

| source | window | bands | requests | bytes fetched | vs naive full download | time |
|---|---|---|---|---|---|---|
| S2 B04 (uint16, 10 m) | 890 × 1118 px | 1 | 3 | 3.15 MB | 230.7 MB → **73×** | 2.3 s |
| S2 B04+B03+B02 | 890 × 1118 px | 3 files | 9 | 9.44 MB | 689 MB → **73×** | 5.1 s |
| S2 TCI (uint8, 3 samples in one file) | 890 × 1118 px | 2 of 3 samples | 3 | 4.78 MB | 356 MB → **74×** | 3.2 s |
| FTW crop-consensus (float32, ZSTD, 1.04 GB) | 240 × 240 px | 1 | 4 | 0.79 MB | 1040.9 MB → **1324×** | 3.6 s |

### Measured (Chromium, `examples/raster-demo/verify.mjs`, live)

1544 × 1086 px × 3 bands uint16 from three separate 10 m assets:

* **12 GET requests, 32.70 MB fetched** (counted as decoded `ArrayBuffer`
  bytes inside the page), all **206 Partial Content** — verified independently
  by Playwright on the response stream.
* vs **689.23 MB** for the three whole assets → **21× less**.
* 5.0–6.4 s wall clock, cold, including loading geotiff.js from the CDN.
* Output: 7.83 MB GeoTIFF, written, re-read by the same page, and drawn.

### The three caveats

1. **Tile granularity is the real unit, not the window.** The 890 × 1118
   window touches two 1024 × 1024 tiles, so 2.1× more pixels are fetched and
   decoded than are kept; the browser window above touched 18 tiles for 3.8×
   amplification. `planRasterClip` computes this and warns above 2×. It is
   also why the estimate says "26.50 MB from 18 tiles" while the measured
   figure is 32.70 MB: geotiff.js's `BlockedSource` fetches 64 KB-aligned
   blocks that overhang tile boundaries, ≈ 23 % over the exact tile bytes.
2. **ZSTD is not supported out of the box.** geotiff.js 2.1.3 has no decoder
   for TIFF compression 50000 and throws
   `Unknown compression method identifier: 50000` **from inside `readRasters`,
   after the tile bytes have been paid for**. `zstddec` is already a
   transitive dependency (the LERC path uses it), so ~20 lines through the
   public `addDecoder` seam fix it — `ensureZstdDecoder()` in
   `packages/raster-core/src/source.js`. raster-core additionally refuses
   unknown compression in `openRaster`, i.e. **before** any pixel bytes are
   fetched.
3. **Two API edges that cost time.**
   * `image.getResolution()` throws *"The image does not have an affine
     transformation"* on every overview IFD — overviews carry no
     `ModelPixelScale`, so the base image must be passed:
     `img.getResolution(baseImage)`.
   * `fromUrl(url, { fetch })` **has no fetch option**: `FetchClient` closes
     over the global `fetch`. So neither an injected fetch, nor
     `cache: 'no-store'` (design doc §4.4 rule 7 — the measured sentinel-2
     fix for Chrome serializing concurrent reads behind its cache lock), nor
     honest byte accounting can get in that way. `fromCustomClient` plus the
     exported `BaseClient`/`BaseResponse` is the supported seam and costs ~20
     lines; raster-core uses it for all three.

*(Upstream-feedback candidates for geotiff.js: the ZSTD gap, the overview
`getResolution` ergonomics, a `fetch` option on `fromUrl`, and the writer —
see §3.)*

---

## 3. Write side — geotiff.js `writeArrayBuffer` verdict

**Unusable for this job.** Evidence, `02-probe-write.mjs` + `gdalinfo`:

| case | result |
|---|---|
| uint8, 1 band | pixels OK |
| uint8, 3 bands | pixels OK, RGB interpretation OK |
| **uint16, 1 band** | **broken** — `TIFFReadEncodedStrip: Read error at scanline 4294967295; got 16 bytes, expected 32`, `Bogus "StripByteCounts"`; GDAL cannot read the band at all |
| **float32, 1 band** | **broken** — same, `got 16 bytes, expected 64` |

The cause is in `encodeImage`: it allocates `width * height * samplesPerPixel`
**bytes** and copies through `new Uint8Array(values)`, which converts a
`Uint16Array` element-wise (truncating mod 256) rather than reinterpreting its
bytes. `BitsPerSample: [16]` is written into the IFD regardless, so the file
*claims* uint16 and carries half the data.

Independently, **georeferencing is lost for most geokey sets**: any ASCII
geokey (`GTCitationGeoKey`) or `ProjLinearUnitsGeoKey` produces
`TIFFTagLocation=0, count=0`, and GDAL responds with
`Key … has count=0, whereas only 1 is legal` →
*"GeoTIFF tags apparently corrupt, they are being ignored"* — **no CRS at
all**, silently. Only the exact set
`{GTModelTypeGeoKey, GTRasterTypeGeoKey, ProjectedCSTypeGeoKey}` survives.

Sentinel-2 is uint16 and the FTW raster is float32, so this was a dead end,
not a workaround. **`packages/raster-core/src/geotiff-writer.js`** replaces it:
classic little-endian TIFF, one IFD, striped (~256 KB payload per strip),
chunky interleave, uncompressed or DEFLATE via `CompressionStream('deflate')`
(the browser's own zlib — no dependency), dtypes uint8/int8/uint16/int16/
uint32/int32/float32/float64, `ModelPixelScale` + `ModelTiepoint`, a correct
GeoKeyDirectory with `GeoAsciiParams`, `ExtraSamples` for multi-band
MINISBLACK (without it libtiff warns on every file), and `GDAL_NODATA`.

Measured DEFLATE ratios (compressed/raw), now wired into the estimate's
bounds: **0.78** (S2 uint16 RGB), **0.78** (browser clip), **0.66** (uint8 TCI
subset), **0.61** (FTW float32).

---

## 4. Validation evidence

### 4.1 Node-produced clips (`04-validate.py`, GDAL 3.10.3 + `/vsicurl`)

```
== S2 B04/B03/B02 -> 3-band uint16
  clip: 890x1118x3 dtype=UInt16 epsg=32610 gt=(561580.0, 10.0, 0.0, 4189480.0, 0.0, -10.0)
  band 1 <- B04.tif[1] at (6160,1052): dtype uint16==uint16, mismatching pixels: 0 / 995020
  band 2 <- B03.tif[1] at (6160,1052): dtype uint16==uint16, mismatching pixels: 0 / 995020
  band 3 <- B02.tif[1] at (6160,1052): dtype uint16==uint16, mismatching pixels: 0 / 995020
  OK  epsg: '32610'      OK  band count: 3     OK  dtype: 'UInt16'
  OK  nodata: 0.0        OK  pixel size: (10.0, -10.0)
  OK  probe px 0,0: [720, 741, 490]        (values geotiff.js returned in JS)
  OK  probe px 889,1117: [947, 822, 704]

== FTW crop-consensus -> 1-band float32      (ZSTD source, EPSG:4326)
  clip: 240x240x1 dtype=Float32 epsg=4326 gt=(-94.5, 0.004167, 0.0, 42.5, 0.0, -0.004167)
  band 1 <- prue_v1_crop_count_mean_500m.tif[1] at (20520,9960): 0 / 57600 mismatches

== S2 TCI samples [R,B] -> 2-band uint8      (band subset *within* one file)
  band 1 <- TCI.tif[1] at (6160,1052): 0 / 995020
  band 2 <- TCI.tif[3] at (6160,1052): 0 / 995020

ALL CHECKS PASSED
```

### 4.2 The file the browser wrote (`05-validate-browser-clip.py`)

```
browser clip: examples/raster-demo/clip.tif
  1544x1086x3 UInt16 EPSG:32610
  geotransform (558310.0, 10.0, 0.0, 4189320.0, 0.0, -10.0)
  compression DEFLATE, nodata 0.0
  band 1 vs B02.tif at (5833,1068): 0 / 1676784 mismatches
  band 2 vs B03.tif at (5833,1068): 0 / 1676784 mismatches
  band 3 vs B04.tif at (5833,1068): 0 / 1676784 mismatches

BROWSER CLIP VALIDATED
```

`gdalinfo` on the same file reports `PROJCRS["WGS 84 / UTM zone 10N" … ID["EPSG",32610]]`,
`Pixel Size = (10, -10)`, three `Type=UInt16` bands, `NoData Value=0`,
`COMPRESSION=DEFLATE`, `TIFFTAG_SOFTWARE=@cng/raster-core`, and statistics
identical to those computed from the arrays in JS (band 1 mean 922.4576 both
sides).

Regenerate with: `node examples/raster-demo/verify.mjs 8123 --keep-tif`
(the 7.8 MB `clip.tif` is intentionally not committed), then
`python3 -I experiments/e11-raster-clip/05-validate-browser-clip.py`.

### 4.3 Offline unit tests

`node --test packages/raster-core/test/*.test.js` — 26 tests: CRS transforms
pinned against GDAL/PROJ reference values to **< 1 cm**, writer round-trips
through geotiff.js (dtype, geokeys, multi-strip, refusals), and the planner /
download handle against a fake Sentinel-2-shaped source (window math, tile
counts, overview choice, estimate exactness, ceiling, cancel).

---

## 5. Semantics — the decisions, and why

### 5.1 Clip = the area's **bounding box**, at the **native resolution of the window**

Native (level 0) is the default because the stated intent is "full res of the
window", and a clip that silently handed back a decimated raster would be a
different product wearing the same filename. Overviews are opt-in and explicit:
`resolution: { maxPixels }` picks the **finest** overview level whose window
fits the budget and **never upsamples**; `resolution: { level }` names one
outright. Any level > 0 raises an `overview-downsample` warning carrying the
actual ground resolution.

The window is snapped **outward** to whole pixels, so the requested area is
always fully covered, never cropped.

Reprojection is refused, not faked. An `Area` is EPSG:4326 (design doc §1); a
COG usually is not. raster-core transforms the area's bbox *into* the image CRS
— EPSG:4326/4269, 3857, and all WGS84 UTM zones (which covers Sentinel-2,
Landsat, and most COG archives), with everything else refused as
`RASTER_CRS_UNSUPPORTED` rather than mis-located. The bbox is **densified**
(16 steps per edge) before projecting, because a lon/lat rectangle is not a
rectangle in UTM: a zone-wide box's corner-only envelope under-covers the
bowed edge by **1.9 km — 186 Sentinel-2 pixels** of missing data. There is a
test for exactly that.

### 5.2 Band subset: named bands, from STAC, in the order asked for

`describeRasterDataset(item)` reads `eo:bands` and `raster:bands` from each
asset with `role: data`:

* a band's `name` (`B04`), its `common_name` (`red`) and the **asset key**
  (`red`, `visual`) are all accepted aliases in `filter.bands`;
* with no `eo:bands`, bands are named `<assetKey>:<n>` positionally — never
  guessed as RGB;
* `raster:bands` supplies `data_type`, `nodata`, `scale`, `offset` and
  `spatial_resolution` for the UI, but the **clip reads dtype and nodata from
  the file's own tags**, because the file is what is being copied and metadata
  can lie;
* output band order follows the request, not the file order.

Two physical layouts, one contract: **a band per file** (Sentinel-2's B02/B03/
B04 assets — a band subset saves bytes proportionally) and **a sample inside
one file** (TCI's 3 interleaved uint8 samples — a subset saves output size but
*no* bytes, because the tile carries all samples). Both are just entries in the
band list; the estimate reports what each actually costs.

Ground resolution is part of a band's identity, not decoration: Sentinel-2
publishes 10/20/60 m bands in one item, and one GeoTIFF has one grid, so mixing
them is `RASTER_GRID_MISMATCH` (the demo's band picker shows "B11 (swir16)
20m"). This fired for real the first time the demo ran with naive defaults —
the refusal worked exactly as intended.

### 5.3 nodata / masking outside the polygon: **bbox-only is the honest v1**

The clip is the area's bounding box. Pixels inside the box but outside the
polygon are **kept as-is, not masked**, and **every estimate carries a
`bbox-only-clip` warning saying so** (shown verbatim in the demo). This is the
raster analog of the vector clip plugin (design call #1: clipping never mutates
features silently), and the same reasoning applies: a mask is an opt-in
post-process, never implicit.

Exact polygon masking is a future addition, and the shape of it is known:
rasterize the area's rings into a per-pixel mask (scanline fill, ~80 lines),
then write `nodata` outside it — which **requires a nodata value to exist**.
When the source declares none (a `nodata-absent` warning is already emitted),
the options are to add an alpha/mask band (changes the band count), pick a
sentinel value (changes the data), or refuse. That choice is a product
decision, which is why v1 does not make it silently. The antimeridian is
refused outright (`RASTER_AREA_ANTIMERIDIAN`): one GeoTIFF has one transform
and cannot span the seam.

STAC `scale`/`offset` are **not** applied — raw digital numbers are copied, and
a `scale-offset-not-applied` warning names the bands and the formula. Applying
them would mean promoting uint16 to float32 and quadrupling the download.

### 5.4 Size estimate before the download — and it is *exact*

`estimateRasterClip()` reads headers only (one or two range reads per file) and
returns the same `Bounded`/ceiling/warning vocabulary as download-core's
`Estimate`, so one UI renders either. The raster numbers invert the vector
case's uncertainty:

| quantity | exact? | from |
|---|---|---|
| `pixels`, `width`, `height` | **yes** | window dims × bands |
| `decodedBytes` | **yes** | pixels × dtype width |
| `readBytes` | **yes** | summed `TileByteCounts` of the tiles the window touches — the compressed size of every tile, already in the IFD |
| `outputBytes` | no | the only modelled number: DEFLATE ratio 0.80 (bounds 0.02–1.02, from the measurements in §3) |

Plus a `prune` trace (`overview → window → tile → band`), `files`/`tiles`
counts, `requests`, and `naiveBytes` for the "vs downloading the whole file"
line. In the demo: *"bytes to fetch: 26.50 MB from 18 tile(s) in 3 file(s)
(exact, from TileByteCounts) / naive full download: 689.23 MB → 26× less"*,
before a single pixel is fetched. (Measured after: 32.70 MB — the 64 KB block
alignment overhead of §2, which is why the honest line to show a user is the
tile-exact figure plus that caveat, not a false precision.)

### 5.5 Memory ceiling: the window must fit in RAM

`defaultRasterCeiling()` = `pixels: 64 M`, **`decodedBytes: 384 MiB`**,
`outputBytes: 2 GiB`, `readBytes: 4 GiB`, `files: 32`, `blobBytes: 256 MiB`
(the existing blob-sink limit). `decodedBytes` is the decisive one: geotiff.js
returns one TypedArray per band and the writer then builds interleaved strips,
so peak use is ~1.2× that number — 384 MiB keeps the peak near 460 MiB, which a
tab survives, while past it an unrecoverable OOM is a real risk. That is why it
is a **refusal**, not a warning.

It uses the existing refusal path verbatim: the handle resolves `estimate`,
emits `ceiling`, goes to state `blocked`, and waits for `acceptCeiling()` or
`cancel()`. The demo exercises it live — an **Alameda County** area at 10 m
native resolution with 3 bands is 5180 × 5219 × 3 = **81 Mpx / 162 MB decoded**,
which breaches `pixels` and is refused with the estimate, the limit and a
"download anyway" button. (A whole Sentinel-2 tile, 2 bands = 482 MB, breaches
`decodedBytes` as well; there is a unit test for both.)

Output is **non-streaming** (`streaming: false`), like the sql.js GeoPackage
path: a classic TIFF's IFD must know its strip offsets before the first byte,
and the window has to be in RAM anyway. The blob-sink ceiling therefore
applies, and the design-doc contract already covers this case.

---

## 6. What shipped

```
packages/raster-core/              (new)
  src/cdn.js            pinned CDN URLs + host-injection seam (mirrors download-core/src/cdn.js)
  src/crs.js            lon/lat -> 4326 / 3857 / WGS84 UTM, densified bbox projection
  src/source.js         openRaster(): levels, tiles, dtype, nodata, CRS, compression; ZSTD decoder registration; counting client
  src/plan.js           STAC band model, window math, overview choice, exact estimate, ceiling
  src/download.js       downloadRaster(): download-core's handle/state machine over sinks
  src/geotiff-writer.js the writer geotiff.js does not have
  src/index.js          public API + rasterClipPlugin ({name, approxBytes, load})
  test/*.test.js        26 offline tests
  README.md
examples/raster-demo/              (new)
  index.html            geocoder -> area (or map view) -> COG/STAC source -> band checkboxes -> estimate -> download -> preview
  verify.mjs            Playwright, live data, committed screenshot
  screenshot.png
experiments/e11-raster-clip/       (this experiment)
  01-probe-read.mjs 02-probe-write.mjs 03-roundtrip.mjs
  04-validate.py 05-validate-browser-clip.py proto/zstd-decoder.js RESULTS.md
```

**Weight** (gzip -9 of the served bundles): geotiff 22.6 KB + float16 4.8 KB =
**~27 KB gz** for the read path, +23.8 KB gz for zstddec **only when a source
is ZSTD**. raster-core's own source is ~1 100 lines of plain ESM. That is
roughly one-fifth of hyparquet+compressors, and ~1 % of what a GDAL-wasm path
would cost — the reason this is worth having as a first-class pipeline rather
than a gdal3.js plugin.

**How it fits the existing architecture.** Raster is deliberately *not* a
download-core `FormatPlugin`: a `FormatPlugin` consumes `FeatureBatch`es (rows
+ WKB) from a parquet engine, and a clip has no rows. It is a second pipeline
that reuses the *contracts* — `Bounded`, the ceiling/refusal gate, the `Sink`
interface (`memorySink`/`blobSink`/`fileSystemSink` verbatim), the handle state
machine, the `CnmwError` taxonomy, the pinned-CDN + host-injection packaging —
and publishes the `{ name, approxBytes, load }` deferred-plugin descriptor the
registry amendment established, so a picker can show "GeoTIFF clip (+~28 KB)"
before fetching anything. The descriptor model (§2) gains a sibling kind
(`cnmw-raster-dataset/1.0`: a band list with URLs, samples and STAC metadata)
rather than a new `DatasetSource`, because the filter vocabulary is different
too — bands and resolution, not predicates and columns.

---

## 7. Implication for portolan-browser (noted, not implemented)

Design call #8 currently says raster/zarr → graceful *"not supported"*. For
**COG** collections that can now change: a collection whose assets are
`image/tiff; application=geotiff` can offer the same area widget, with the
format picker replaced by a band picker and a resolution choice, and the same
estimate → ceiling → sink flow the vector path uses. The glue is thin —
`describeRasterDataset(item)` already consumes a STAC Item as-is, which is
exactly what portolan-browser holds — so the honest architectural sentence is:
*raster collections move from "no widget" to "the same widget with a band
picker", with the collection's own STAC metadata as the descriptor, and the
"unsupported" path narrowing to Zarr and to non-UTM/non-3857 projected COGs.*

---

## 8. What raster work remains

1. **Exact polygon masking** (§5.3) — scanline rasterization of the area rings
   plus a nodata/alpha decision. The warning text that promises bbox-only
   today is the contract to change.
2. **Zarr.** `italy-aerial-catalog` is Zarr-multiscales, and portolan-browser
   already has a Zarr review branch. geotiff.js cannot touch it;
   zarrita/zarr.js would be a separate reader behind the same plan/estimate/
   write path — the writer and the ceiling would be reused as-is.
3. **Reprojection** beyond 4326/3857/UTM (a pinned proj4js plugin behind the
   same `RASTER_CRS_UNSUPPORTED` refusal), and resampling to an arbitrary
   resolution rather than only overview levels.
4. **COG output** — the current output is a plain striped GeoTIFF. Tiling +
   overviews + the leading IFD layout would make a clip re-servable; it is
   perhaps another 150 lines in the writer.
5. **Parallel tile reads.** geotiff.js coalesces blocks but reads bands
   sequentially; 12 requests at ~0.5 s each is most of the 5 s wall clock.
   `maxConcurrentRequests` (download-core's default is 12) wants an equivalent
   here, via `Pool`/`maxRanges` or our own client.
6. **Upstream geotiff.js reports** (§2/§3): ZSTD decoder, `fetch` option on
   `fromUrl`, overview `getResolution`, and the writer's 8-bit truncation +
   GeoKeyDirectory corruption — the last one is a silent data-corruption bug
   and is worth filing with the repro in `02-probe-write.mjs`.
7. **`scale`/`offset`** as an opt-in float32 output, for people who want
   reflectance rather than DNs.
