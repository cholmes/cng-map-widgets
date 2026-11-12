// E11 step 2 -- what can geotiff.js's writeArrayBuffer actually write?
//
// Three cases, each validated with gdalinfo afterwards:
//   a) uint8, 1 band       -- the writer's happy path
//   b) uint16, 1 band      -- what Sentinel-2 actually is
//   c) uint8, 3 bands      -- multi-band, pixel-interleaved
// plus (d) float32, 1 band -- what the FTW confidence raster is.
import { writeArrayBuffer } from 'geotiff';
import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] || '/tmp/e11-write';

// A 4x4 ramp whose values are deliberately > 255 in the uint16 case, so
// truncation is visible rather than plausible.
const W = 4;
const H = 4;

const geo = {
  // UTM 10N, 10 m, origin somewhere in Oakland -- the real clip case.
  ModelPixelScale: [10, 10, 0],
  ModelTiepoint: [0, 0, 0, 561580, 4189480, 0],
  GTModelTypeGeoKey: 1,
  GTRasterTypeGeoKey: 1,
  ProjectedCSTypeGeoKey: 32610,
  ProjLinearUnitsGeoKey: 9001,
};

const cases = [
  {
    name: 'a-uint8-1band',
    values: Uint8Array.from({ length: W * H }, (_, i) => i * 16),
    metadata: { ...geo, width: W, height: H, BitsPerSample: [8], SampleFormat: [1], SamplesPerPixel: [1], PhotometricInterpretation: 1 },
    expect: [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240],
  },
  {
    name: 'b-uint16-1band',
    values: Uint16Array.from({ length: W * H }, (_, i) => 1000 + i * 500),
    metadata: { ...geo, width: W, height: H, BitsPerSample: [16], SampleFormat: [1], SamplesPerPixel: [1], PhotometricInterpretation: 1 },
    expect: Array.from({ length: 16 }, (_, i) => 1000 + i * 500),
  },
  {
    name: 'c-uint8-3band',
    // pixel-interleaved RGB
    values: Uint8Array.from({ length: W * H * 3 }, (_, i) => (i * 5) % 256),
    metadata: { ...geo, width: W, height: H, BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], SamplesPerPixel: [3], PhotometricInterpretation: 2 },
    expect: null,
  },
  {
    name: 'd-float32-1band',
    values: Float32Array.from({ length: W * H }, (_, i) => i * 0.25),
    metadata: { ...geo, width: W, height: H, BitsPerSample: [32], SampleFormat: [3], SamplesPerPixel: [1], PhotometricInterpretation: 1 },
    expect: Array.from({ length: 16 }, (_, i) => i * 0.25),
  },
];

for (const c of cases) {
  try {
    const buf = writeArrayBuffer(c.values, { ...c.metadata });
    const path = `${OUT}/geotiffjs-${c.name}.tif`;
    writeFileSync(path, Buffer.from(buf));
    const expectedPayload = c.values.byteLength;
    console.log(
      `${c.name}: wrote ${buf.byteLength} bytes; payload should be ${expectedPayload} bytes ` +
        `(${buf.byteLength - expectedPayload} bytes of header+IFD if the payload survived)`,
    );
    if (c.expect) console.log(`  expected pixel values: ${c.expect.slice(0, 6).join(', ')} ...`);
  } catch (err) {
    console.log(`${c.name}: THREW ${err.message}`);
  }
}
