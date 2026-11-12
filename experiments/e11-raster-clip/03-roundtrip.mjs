// E11 step 3 -- the real thing: clip a window out of remote COGs, stack the
// chosen bands, write a GeoTIFF with our own writer, and leave the file for
// gdalinfo/gdallocationinfo to judge.
//
// Usage: node 03-roundtrip.mjs <outdir> [--compress deflate|none]
import { fromUrl } from 'geotiff';
import { writeFileSync } from 'node:fs';
import { projectBbox } from '../../packages/raster-core/src/crs.js';
import { registerZstdDecoder } from './proto/zstd-decoder.js';
import { writeGeoTiff } from '../../packages/raster-core/src/geotiff-writer.js';

registerZstdDecoder();

const OUT = process.argv[2] || '/tmp';
const compression = process.argv.includes('--compress')
  ? process.argv[process.argv.indexOf('--compress') + 1]
  : 'deflate';

const S2 = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/EG/2025/6/S2C_10SEG_20250617_0_L2A';
const AREA = [-122.3, 37.75, -122.2, 37.85]; // Oakland / Berkeley

const net = { requests: 0, bytes: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  net.requests += 1;
  net.bytes += Number(res.headers.get('content-length') ?? 0);
  return res;
};

/** Pixel window in the base image for a lon/lat bbox. */
function windowFor(image, epsg, bbox) {
  const proj = projectBbox(bbox, epsg);
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const x0 = Math.max(0, Math.floor((proj[0] - ox) / rx));
  const x1 = Math.min(image.getWidth(), Math.ceil((proj[2] - ox) / rx));
  const y0 = Math.max(0, Math.floor((proj[3] - oy) / ry));
  const y1 = Math.min(image.getHeight(), Math.ceil((proj[1] - oy) / ry));
  return { window: [x0, y0, x1, y1], originX: ox + x0 * rx, originY: oy + y0 * ry, rx, ry: Math.abs(ry) };
}

// --- case 1: three single-band uint16 assets -> one 3-band uint16 GeoTIFF ---
const picks = [
  { name: 'red', asset: 'B04.tif' },
  { name: 'green', asset: 'B03.tif' },
  { name: 'blue', asset: 'B02.tif' },
];
const t0 = performance.now();
let geom = null;
const bandArrays = [];
for (const p of picks) {
  const tiff = await fromUrl(`${S2}/${p.asset}`);
  const img = await tiff.getImage(0);
  const epsg = img.getGeoKeys().ProjectedCSTypeGeoKey;
  const w = windowFor(img, epsg, AREA);
  if (!geom) geom = { ...w, epsg, citation: img.getGeoKeys().GTCitationGeoKey };
  const r = await img.readRasters({ window: w.window, samples: [0], interleave: false });
  bandArrays.push(r[0]);
  geom.width = r.width;
  geom.height = r.height;
}
const readMs = Math.round(performance.now() - t0);
const width = geom.width;
const height = geom.height;
const buf = await writeGeoTiff({
  bands: bandArrays,
  width,
  height,
  origin: [geom.originX, geom.originY],
  pixelSize: [geom.rx, geom.ry],
  epsg: geom.epsg,
  citation: geom.citation,
  nodata: 0,
  compression,
});
const p1 = `${OUT}/clip-s2-rgb-uint16.tif`;
writeFileSync(p1, Buffer.from(buf));
console.log(
  `[1] S2 B04/B03/B02 ${width}x${height}x3 uint16 -> ${p1}\n` +
    `    read: ${net.requests} requests, ${(net.bytes / 1e6).toFixed(2)} MB, ${readMs} ms\n` +
    `    wrote ${buf.byteLength} bytes (${compression}); raw payload would be ${width * height * 3 * 2} bytes`,
);
// dump the first pixels so a GDAL check has something exact to match
const probePixels = [];
for (const [px, py] of [[0, 0], [1, 0], [0, 1], [width - 1, height - 1], [Math.floor(width / 2), Math.floor(height / 2)]]) {
  probePixels.push({
    px,
    py,
    x: geom.originX + (px + 0.5) * geom.rx,
    y: geom.originY - (py + 0.5) * geom.ry,
    values: bandArrays.map((b) => b[py * width + px]),
  });
}
console.log('    probe pixels (for gdallocationinfo):');
for (const p of probePixels) {
  console.log(`      px=${p.px},${p.py} utm=${p.x.toFixed(1)},${p.y.toFixed(1)} values=${p.values.join(',')}`);
}
writeFileSync(`${OUT}/clip-s2-rgb-uint16.probe.json`, JSON.stringify({ geom, probePixels }, null, 1));

// --- case 2: the ftw float32 zstd global COG, EPSG:4326 ---------------------
const FTW = 'https://data.source.coop/ftw/global-data/predictions/confidence/crop-consensus/prue_v1_crop_count_mean_500m.tif';
const t2 = performance.now();
const before = { ...net };
const ftiff = await fromUrl(FTW);
const fimg = await ftiff.getImage(0);
const fepsg = fimg.getGeoKeys().GeographicTypeGeoKey;
const fw = windowFor(fimg, fepsg, [-94.5, 41.5, -93.5, 42.5]);
const fr = await fimg.readRasters({ window: fw.window, samples: [0], interleave: false });
const fms = Math.round(performance.now() - t2);
const fbuf = await writeGeoTiff({
  bands: [fr[0]],
  width: fr.width,
  height: fr.height,
  origin: [fw.originX, fw.originY],
  pixelSize: [fw.rx, fw.ry],
  epsg: fepsg,
  citation: 'WGS 84',
  nodata: null,
  compression,
});
const p2 = `${OUT}/clip-ftw-float32.tif`;
writeFileSync(p2, Buffer.from(fbuf));
console.log(
  `\n[2] FTW crop-consensus ${fr.width}x${fr.height}x1 float32 -> ${p2}\n` +
    `    read: ${net.requests - before.requests} requests, ${((net.bytes - before.bytes) / 1e6).toFixed(2)} MB, ${fms} ms\n` +
    `    wrote ${fbuf.byteLength} bytes (${compression}); raw payload would be ${fr.width * fr.height * 4} bytes`,
);
const fprobe = [];
for (const [px, py] of [[0, 0], [10, 10], [fr.width - 1, fr.height - 1]]) {
  fprobe.push({
    px,
    py,
    x: fw.originX + (px + 0.5) * fw.rx,
    y: fw.originY - (py + 0.5) * fw.ry,
    value: fr[0][py * fr.width + px],
  });
}
for (const p of fprobe) console.log(`      px=${p.px},${p.py} lonlat=${p.x.toFixed(5)},${p.y.toFixed(5)} value=${p.value}`);
writeFileSync(`${OUT}/clip-ftw-float32.probe.json`, JSON.stringify({ geom: fw, fepsg, fprobe }, null, 1));

// --- case 3: band subset inside one pixel-interleaved file (TCI, uint8) -----
const t3 = performance.now();
const before3 = { ...net };
const ttiff = await fromUrl(`${S2}/TCI.tif`);
const timg = await ttiff.getImage(0);
const tepsg = timg.getGeoKeys().ProjectedCSTypeGeoKey;
const tw = windowFor(timg, tepsg, AREA);
const tr = await timg.readRasters({ window: tw.window, samples: [0, 2], interleave: false }); // R and B only
const t3ms = Math.round(performance.now() - t3);
const tbuf = await writeGeoTiff({
  bands: [tr[0], tr[1]],
  width: tr.width,
  height: tr.height,
  origin: [tw.originX, tw.originY],
  pixelSize: [tw.rx, tw.ry],
  epsg: tepsg,
  citation: timg.getGeoKeys().GTCitationGeoKey,
  nodata: 0,
  compression,
});
const p3 = `${OUT}/clip-s2-tci-sub.tif`;
writeFileSync(p3, Buffer.from(tbuf));
console.log(
  `\n[3] S2 TCI samples [0,2] ${tr.width}x${tr.height}x2 uint8 -> ${p3}\n` +
    `    read: ${net.requests - before3.requests} requests, ${((net.bytes - before3.bytes) / 1e6).toFixed(2)} MB, ${t3ms} ms`,
);
console.log(`\ntotal network: ${net.requests} requests, ${(net.bytes / 1e6).toFixed(2)} MB`);
