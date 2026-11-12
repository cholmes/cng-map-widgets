#!/usr/bin/env python3
"""E11 step 4 -- does the browser-written GeoTIFF agree with GDAL's own read
of the same window of the same remote COG, pixel for pixel?

Run with `python3 -I 04-validate.py <outdir>` after 03-roundtrip.mjs.
Compares: CRS, geotransform, dtype, band count, nodata, and every pixel
against /vsicurl reads of the sources.
"""
import json
import sys

from osgeo import gdal, osr

gdal.UseExceptions()
gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
S2 = ("https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/"
      "10/S/EG/2025/6/S2C_10SEG_20250617_0_L2A")
FTW = ("https://data.source.coop/ftw/global-data/predictions/confidence/"
       "crop-consensus/prue_v1_crop_count_mean_500m.tif")

failures = []


def check(label, got, want):
    ok = got == want
    print(f"  {'OK ' if ok else 'FAIL'} {label}: {got!r}" + ("" if ok else f" != {want!r}"))
    if not ok:
        failures.append(f"{label}: {got!r} != {want!r}")


def source_window(ds, gt_clip, w, h):
    """Pixel offset of the clip's origin inside the source, from geotransforms."""
    gt = ds.GetGeoTransform()
    px = round((gt_clip[0] - gt[0]) / gt[1])
    py = round((gt_clip[3] - gt[3]) / gt[5])
    return px, py


def compare(name, clip_path, sources, bands_in_source):
    print(f"\n== {name}")
    clip = gdal.Open(clip_path)
    gt = clip.GetGeoTransform()
    srs = osr.SpatialReference(wkt=clip.GetProjection())
    print(f"  clip: {clip.RasterXSize}x{clip.RasterYSize}x{clip.RasterCount}"
          f" dtype={gdal.GetDataTypeName(clip.GetRasterBand(1).DataType)}"
          f" epsg={srs.GetAuthorityCode(None)} gt={tuple(round(v, 6) for v in gt)}")
    total_diff = 0
    for i, (src_url, sample) in enumerate(zip(sources, bands_in_source), start=1):
        src = gdal.Open(f"/vsicurl/{src_url}")
        px, py = source_window(src, gt, clip.RasterXSize, clip.RasterYSize)
        src_arr = src.GetRasterBand(sample).ReadAsArray(px, py, clip.RasterXSize, clip.RasterYSize)
        clip_arr = clip.GetRasterBand(i).ReadAsArray()
        same_dtype = src_arr.dtype == clip_arr.dtype
        diff = (src_arr != clip_arr).sum()
        total_diff += diff
        print(f"  band {i} <- {src_url.rsplit('/', 1)[-1]}[{sample}] at ({px},{py}):"
              f" dtype {src_arr.dtype}{'==' if same_dtype else '!='}{clip_arr.dtype},"
              f" mismatching pixels: {diff} / {src_arr.size}")
        if diff:
            failures.append(f"{name} band {i}: {diff} pixel mismatches")
        if not same_dtype:
            failures.append(f"{name} band {i}: dtype {src_arr.dtype} != {clip_arr.dtype}")
    return clip, total_diff


# --- case 1: three single-band uint16 S2 assets stacked ---------------------
probe = json.load(open(f"{OUT}/clip-s2-rgb-uint16.probe.json"))
clip, _ = compare(
    "S2 B04/B03/B02 -> 3-band uint16",
    f"{OUT}/clip-s2-rgb-uint16.tif",
    [f"{S2}/B04.tif", f"{S2}/B03.tif", f"{S2}/B02.tif"],
    [1, 1, 1],
)
srs = osr.SpatialReference(wkt=clip.GetProjection())
check("epsg", srs.GetAuthorityCode(None), "32610")
check("band count", clip.RasterCount, 3)
check("dtype", gdal.GetDataTypeName(clip.GetRasterBand(1).DataType), "UInt16")
check("nodata", clip.GetRasterBand(1).GetNoDataValue(), 0.0)
check("pixel size", (clip.GetGeoTransform()[1], clip.GetGeoTransform()[5]), (10.0, -10.0))
# the exact values geotiff.js produced in the browser-side read
for p in probe["probePixels"]:
    vals = [int(clip.GetRasterBand(b + 1).ReadAsArray(p["px"], p["py"], 1, 1)[0][0]) for b in range(3)]
    check(f"probe px {p['px']},{p['py']}", vals, [int(v) for v in p["values"]])

# --- case 2: FTW float32, EPSG:4326, ZSTD source ---------------------------
clip2, _ = compare("FTW crop-consensus -> 1-band float32", f"{OUT}/clip-ftw-float32.tif", [FTW], [1])
srs2 = osr.SpatialReference(wkt=clip2.GetProjection())
check("epsg", srs2.GetAuthorityCode(None), "4326")
check("dtype", gdal.GetDataTypeName(clip2.GetRasterBand(1).DataType), "Float32")

# --- case 3: band subset inside one interleaved uint8 file -----------------
clip3, _ = compare(
    "S2 TCI samples [R,B] -> 2-band uint8",
    f"{OUT}/clip-s2-tci-sub.tif",
    [f"{S2}/TCI.tif", f"{S2}/TCI.tif"],
    [1, 3],
)
check("band count", clip3.RasterCount, 2)
check("dtype", gdal.GetDataTypeName(clip3.GetRasterBand(1).DataType), "Byte")

print("\n" + ("ALL CHECKS PASSED" if not failures else f"{len(failures)} FAILURES:\n  " + "\n  ".join(failures)))
sys.exit(1 if failures else 0)
