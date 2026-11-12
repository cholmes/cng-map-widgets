// Does our GeoTIFF writer produce files that a real TIFF reader accepts,
// with dtype, band count, georeferencing and nodata intact?
//
// geotiff.js (the npm devDependency) is the reader here, so this runs
// offline. The stronger check -- GDAL 3.10.3 reading the same files and
// matching every pixel against a /vsicurl read of the source COG -- lives in
// experiments/e11-raster-clip/04-validate.py, because it needs GDAL and the
// network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromArrayBuffer } from 'geotiff';
import { writeGeoTiff } from '../src/geotiff-writer.js';

const UTM = {
  origin: [561580, 4189480],
  pixelSize: [10, 10],
  epsg: 32610,
  citation: 'WGS 84 / UTM zone 10N',
};

async function readBack(bytes) {
  const copy = bytes.slice().buffer;
  const tiff = await fromArrayBuffer(copy);
  const image = await tiff.getImage(0);
  return { tiff, image, fd: image.getFileDirectory(), keys: image.getGeoKeys() };
}

test('uint16, single band, deflate: values, dtype, CRS and nodata survive', async () => {
  const width = 7;
  const height = 5;
  const band = Uint16Array.from({ length: width * height }, (_, i) => 1000 + i * 137);
  const bytes = await writeGeoTiff({ bands: [band], width, height, ...UTM, nodata: 0, compression: 'deflate' });
  const { image, fd, keys } = await readBack(bytes);

  assert.equal(image.getWidth(), width);
  assert.equal(image.getHeight(), height);
  assert.equal(image.getSamplesPerPixel(), 1);
  assert.deepEqual(Array.from(fd.BitsPerSample), [16]);
  assert.deepEqual(Array.from(fd.SampleFormat), [1]);
  assert.equal(fd.Compression, 8, 'deflate');
  assert.equal(keys.ProjectedCSTypeGeoKey, 32610);
  assert.equal(keys.GTModelTypeGeoKey, 1);
  assert.equal(keys.ProjLinearUnitsGeoKey, 9001);
  assert.equal(keys.GTCitationGeoKey, UTM.citation);
  assert.deepEqual(image.getOrigin().slice(0, 2), UTM.origin);
  assert.deepEqual(Array.from(fd.ModelPixelScale).slice(0, 2), UTM.pixelSize);
  assert.match(String(fd.GDAL_NODATA), /^0/);

  const [out] = await image.readRasters();
  assert.equal(out.constructor.name, 'Uint16Array', 'dtype preserved, not truncated to 8 bits');
  assert.deepEqual(Array.from(out), Array.from(band));
});

test('uint16 uncompressed round-trips identically (the geotiff.js writer cannot do this at all)', async () => {
  const band = Uint16Array.from([0, 1, 255, 256, 65535, 4096]);
  const bytes = await writeGeoTiff({ bands: [band], width: 3, height: 2, ...UTM, compression: 'none' });
  const { image, fd } = await readBack(bytes);
  assert.equal(fd.Compression, 1);
  const [out] = await image.readRasters();
  assert.deepEqual(Array.from(out), Array.from(band), 'values above 255 must not wrap');
});

test('three uint16 bands keep their order and stay separable', async () => {
  const width = 4;
  const height = 3;
  const n = width * height;
  const r = Uint16Array.from({ length: n }, (_, i) => 1000 + i);
  const g = Uint16Array.from({ length: n }, (_, i) => 2000 + i);
  const b = Uint16Array.from({ length: n }, (_, i) => 3000 + i);
  const bytes = await writeGeoTiff({ bands: [r, g, b], width, height, ...UTM, compression: 'deflate' });
  const { image } = await readBack(bytes);
  assert.equal(image.getSamplesPerPixel(), 3);
  const out = await image.readRasters({ interleave: false });
  assert.deepEqual(Array.from(out[0]), Array.from(r));
  assert.deepEqual(Array.from(out[1]), Array.from(g));
  assert.deepEqual(Array.from(out[2]), Array.from(b));
});

test('float32 and a geographic CRS', async () => {
  const band = Float32Array.from([0.25, -1.5, 3.125, 1e-8]);
  const bytes = await writeGeoTiff({
    bands: [band],
    width: 2,
    height: 2,
    origin: [-94.5, 42.5],
    pixelSize: [0.004166666666666667, 0.004166666666666667],
    epsg: 4326,
    citation: 'WGS 84',
    compression: 'deflate',
  });
  const { image, fd, keys } = await readBack(bytes);
  assert.equal(keys.GeographicTypeGeoKey, 4326);
  assert.equal(keys.GTModelTypeGeoKey, 2, 'geographic model type');
  assert.equal(keys.GeogAngularUnitsGeoKey, 9102);
  assert.equal(keys.ProjectedCSTypeGeoKey, undefined);
  assert.deepEqual(Array.from(fd.SampleFormat), [3]);
  const [out] = await image.readRasters();
  assert.equal(out.constructor.name, 'Float32Array');
  assert.deepEqual(Array.from(out), Array.from(band));
});

test('a window larger than one strip spans strips correctly', async () => {
  // rowsPerStrip is ~256 KB of payload; force several strips with a wide
  // multi-band image.
  const width = 2048;
  const height = 80;
  const n = width * height;
  const a = Uint16Array.from({ length: n }, (_, i) => i % 65536);
  const b = Uint16Array.from({ length: n }, (_, i) => (i * 7) % 65536);
  const bytes = await writeGeoTiff({ bands: [a, b], width, height, ...UTM, compression: 'deflate' });
  const { image, fd } = await readBack(bytes);
  assert.ok(fd.StripOffsets.length > 1, `expected several strips, got ${fd.StripOffsets.length}`);
  assert.equal(fd.StripOffsets.length, fd.StripByteCounts.length);
  const out = await image.readRasters({ interleave: false });
  assert.deepEqual(Array.from(out[0].slice(-5)), Array.from(a.slice(-5)));
  assert.deepEqual(Array.from(out[1].slice(-5)), Array.from(b.slice(-5)));
});

test('refuses mismatched bands rather than writing a corrupt file', async () => {
  await assert.rejects(
    () => writeGeoTiff({ bands: [new Uint16Array(4), new Float32Array(4)], width: 2, height: 2, ...UTM }),
    /share one dtype/,
  );
  await assert.rejects(
    () => writeGeoTiff({ bands: [new Uint16Array(3)], width: 2, height: 2, ...UTM }),
    /band length/,
  );
  await assert.rejects(() => writeGeoTiff({ bands: [], width: 2, height: 2, ...UTM }), /no bands/);
});
