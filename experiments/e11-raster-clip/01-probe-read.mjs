// E11 step 1 -- what does a real COG look like through geotiff.js, and how
// many bytes does a windowed read actually cost?
//
// Usage: node 01-probe-read.mjs [url] [west,south,east,north]
import { fromUrl } from 'geotiff';
import { projectBbox } from '../../packages/raster-core/src/crs.js';
import { registerZstdDecoder } from './proto/zstd-decoder.js';

registerZstdDecoder();

const DEFAULT_URL =
  'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/EG/2025/9/S2B_10SEG_20250923_0_L2A/B04.tif';
// Oakland/Berkeley, inside MGRS tile 10SEG.
const DEFAULT_BBOX = [-122.3, 37.75, -122.2, 37.85];

const url = process.argv[2] || DEFAULT_URL;
const bbox = (process.argv[3] || '').split(',').map(Number).filter((n) => !Number.isNaN(n));
const area = bbox.length === 4 ? bbox : DEFAULT_BBOX;

// --- instrumented fetch -----------------------------------------------------
const net = { requests: 0, bytes: 0, ranges: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  const range = init?.headers?.Range ?? init?.headers?.range ?? null;
  const len = Number(res.headers.get('content-length') ?? 0);
  net.requests += 1;
  net.bytes += len;
  net.ranges.push({ range, len, status: res.status });
  return res;
};

function mark() {
  return { requests: net.requests, bytes: net.bytes, t: performance.now() };
}
function since(m) {
  return {
    requests: net.requests - m.requests,
    bytes: net.bytes - m.bytes,
    ms: Math.round(performance.now() - m.t),
  };
}

const t0 = mark();
const tiff = await fromUrl(url);
const count = await tiff.getImageCount();
const open = since(t0);
console.log(`\n# ${url}`);
console.log(`open+footer: ${open.requests} requests, ${open.bytes} bytes, ${open.ms} ms`);
console.log(`images (full-res + overviews): ${count}`);

const levels = [];
const baseForGeo = await tiff.getImage(0);
for (let i = 0; i < count; i++) {
  const img = await tiff.getImage(i);
  const fd = img.getFileDirectory();
  // FINDING: overview IFDs carry no ModelPixelScale/ModelTiepoint of their
  // own, so `img.getResolution()` throws "does not have an affine
  // transformation" -- the base image must be passed in.
  levels.push({
    level: i,
    width: img.getWidth(),
    height: img.getHeight(),
    tile: [img.getTileWidth(), img.getTileHeight()],
    samples: img.getSamplesPerPixel(),
    bits: fd.BitsPerSample,
    sampleFormat: fd.SampleFormat,
    compression: fd.Compression,
    predictor: fd.Predictor,
    planar: fd.PlanarConfiguration,
    resolution: img.getResolution(baseForGeo).map((r) => Math.abs(Math.round(r * 1000) / 1000)),
    nodata: fd.GDAL_NODATA,
    tiled: !!fd.TileOffsets,
    tileCount: fd.TileOffsets ? fd.TileOffsets.length : null,
  });
}
console.table(levels);

const base = await tiff.getImage(0);
const fd0 = base.getFileDirectory();
const gk = base.getGeoKeys();
console.log('geokeys:', JSON.stringify(gk));
console.log('origin:', base.getOrigin(), 'bbox(image crs):', base.getBoundingBox());
console.log('ModelPixelScale:', fd0.ModelPixelScale, 'ModelTiepoint:', fd0.ModelTiepoint);

// --- window math ------------------------------------------------------------
const epsg = gk.ProjectedCSTypeGeoKey ?? gk.GeographicTypeGeoKey;
const proj = projectBbox(area, epsg);
const [ox, oy] = base.getOrigin();
const [rx, ry] = base.getResolution();
const px = (x) => (x - ox) / rx;
const py = (y) => (y - oy) / ry;
const x0 = Math.max(0, Math.floor(px(proj[0])));
const x1 = Math.min(base.getWidth(), Math.ceil(px(proj[2])));
const yTop = Math.max(0, Math.floor(py(proj[3])));
const yBot = Math.min(base.getHeight(), Math.ceil(py(proj[1])));
const window = [x0, yTop, x1, yBot];
console.log(`\narea lon/lat: ${area.join(', ')}`);
console.log(`projected to EPSG:${epsg}: ${proj.map((v) => Math.round(v)).join(', ')}`);
console.log(`full-res window: [${window.join(', ')}]  (${x1 - x0} x ${yBot - yTop} px)`);

const t1 = mark();
const rasters = await base.readRasters({ window, samples: [0], interleave: false });
const read = since(t1);
const arr = rasters[0];
console.log(
  `windowed read: ${read.requests} requests, ${read.bytes} bytes (${(read.bytes / 1e6).toFixed(2)} MB), ${read.ms} ms`,
);
console.log(`returned: ${arr.constructor.name} length=${arr.length} (${rasters.width} x ${rasters.height})`);
let min = Infinity, max = -Infinity, sum = 0, zeros = 0;
for (const v of arr) {
  if (v === 0) zeros++;
  if (v < min) min = v;
  if (v > max) max = v;
  sum += v;
}
console.log(`values: min=${min} max=${max} mean=${(sum / arr.length).toFixed(1)} zeros=${zeros}`);

// naive baseline: what a "download the file and clip locally" flow costs
const head = await realFetch(url, { method: 'HEAD' });
const fileBytes = Number(head.headers.get('content-length'));
console.log(
  `\nnaive full-file download: ${fileBytes} bytes (${(fileBytes / 1e6).toFixed(2)} MB)` +
    ` -> windowed read is ${(fileBytes / (open.bytes + read.bytes)).toFixed(1)}x cheaper` +
    ` (${open.bytes + read.bytes} bytes incl. open)`,
);
console.log('\nrange trace:');
for (const r of net.ranges) console.log(`  ${r.status} ${r.range ?? '(no range)'} -> ${r.len} bytes`);
