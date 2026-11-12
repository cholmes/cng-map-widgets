#!/usr/bin/env python3
"""E11 step 5 -- validate the GeoTIFF the BROWSER produced.

examples/raster-demo/verify.mjs --keep-tif saves the file the page built
(geotiff.js windowed reads + raster-core's writer, all in Chromium) to
examples/raster-demo/clip.tif. This checks it against GDAL's own /vsicurl
read of the same window of the same Sentinel-2 assets.

    python3 -I 05-validate-browser-clip.py [path-to-clip.tif]
"""
import os
import sys

from osgeo import gdal, osr

gdal.UseExceptions()
gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")

HERE = os.path.dirname(os.path.abspath(__file__))
CLIP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "examples", "raster-demo", "clip.tif")
S2 = ("https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/"
      "10/S/EG/2025/6/S2C_10SEG_20250617_0_L2A")
# The demo checks B04/B03/B02 and lists them sorted by name, so the written
# band order is B02, B03, B04.
SOURCES = [f"{S2}/B02.tif", f"{S2}/B03.tif", f"{S2}/B04.tif"]

clip = gdal.Open(CLIP)
gt = clip.GetGeoTransform()
srs = osr.SpatialReference(wkt=clip.GetProjection())
print(f"browser clip: {CLIP}")
print(f"  {clip.RasterXSize}x{clip.RasterYSize}x{clip.RasterCount} "
      f"{gdal.GetDataTypeName(clip.GetRasterBand(1).DataType)} EPSG:{srs.GetAuthorityCode(None)}")
print(f"  geotransform {tuple(round(v, 4) for v in gt)}")
print(f"  compression {clip.GetMetadata('IMAGE_STRUCTURE').get('COMPRESSION')}, "
      f"nodata {clip.GetRasterBand(1).GetNoDataValue()}")

failures = []
for i, url in enumerate(SOURCES, start=1):
    src = gdal.Open(f"/vsicurl/{url}")
    sgt = src.GetGeoTransform()
    px = round((gt[0] - sgt[0]) / sgt[1])
    py = round((gt[3] - sgt[3]) / sgt[5])
    want = src.GetRasterBand(1).ReadAsArray(px, py, clip.RasterXSize, clip.RasterYSize)
    got = clip.GetRasterBand(i).ReadAsArray()
    diff = int((want != got).sum())
    print(f"  band {i} vs {url.rsplit('/', 1)[-1]} at ({px},{py}): dtype {want.dtype}/{got.dtype}, "
          f"mismatching pixels {diff} / {want.size}")
    if diff:
        failures.append(f"band {i}: {diff} mismatches")
    if want.dtype != got.dtype:
        failures.append(f"band {i}: dtype {want.dtype} != {got.dtype}")

if srs.GetAuthorityCode(None) != "32610":
    failures.append(f"CRS is {srs.GetAuthorityCode(None)}")
if (gt[1], gt[5]) != (10.0, -10.0):
    failures.append(f"pixel size {(gt[1], gt[5])}")

print("\n" + ("BROWSER CLIP VALIDATED" if not failures else "FAILURES: " + "; ".join(failures)))
sys.exit(1 if failures else 0)
