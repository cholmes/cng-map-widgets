// The `downloadRaster` handle: the state machine, the ceiling gate, cancel,
// and a full in-process round trip (fake COG -> clip -> GeoTIFF bytes in a
// memory sink -> read back with geotiff.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromArrayBuffer } from 'geotiff';
import { memorySink } from '@cng/download-core';
import { describeRasterDataset, planRasterClip } from '../src/plan.js';
import { downloadRaster } from '../src/download.js';

const AREA = { bbox: [-122.3, 37.84, -122.28, 37.85] }; // ~180 x 112 px at 10 m

const ITEM = {
  id: 'FAKE_10SEG',
  assets: {
    red: {
      href: 'https://example.test/B04.tif',
      type: 'image/tiff; application=geotiff',
      roles: ['data'],
      'eo:bands': [{ name: 'B04', common_name: 'red' }],
      'raster:bands': [{ nodata: 0, data_type: 'uint16' }],
    },
    nir: {
      href: 'https://example.test/B08.tif',
      type: 'image/tiff; application=geotiff',
      roles: ['data'],
      'eo:bands': [{ name: 'B08', common_name: 'nir' }],
      'raster:bands': [{ nodata: 0, data_type: 'uint16' }],
    },
  },
};

/** A fake source whose readRasters synthesizes a value from absolute pixel
 *  position, so the output can be checked against the exact window. */
function fakeSource(url, seed) {
  const levels = [0, 1].map((i) => {
    const factor = 2 ** i;
    const width = Math.ceil(10980 / factor);
    return {
      level: i,
      width,
      height: width,
      tileSize: [1024, 1024],
      tileCount: Math.ceil(width / 1024) ** 2,
      pixelSize: [10 * factor, 10 * factor],
      overviewFactor: factor,
    };
  });
  return {
    url,
    epsg: 32610,
    citation: 'WGS 84 / UTM zone 10N',
    origin: [499980, 4200000],
    pixelSize: [10, 10],
    bbox: [499980, 4090200, 609780, 4200000],
    dtype: 'uint16',
    samples: 1,
    nodata: 0,
    compression: 'deflate',
    tiled: true,
    levels,
    fileBytes: 230_706_785,
    _tiff: {
      async getImage(level) {
        return {
          getFileDirectory() {
            return { TileByteCounts: new Array(levels[level].tileCount).fill(1_000_000) };
          },
          async readRasters({ window }) {
            const [x0, y0, x1, y1] = window;
            const w = x1 - x0;
            const h = y1 - y0;
            const arr = new Uint16Array(w * h);
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) arr[y * w + x] = (seed * 1000 + ((y0 + y) * 31 + (x0 + x) * 7)) % 65536;
            }
            const out = [arr];
            out.width = w;
            out.height = h;
            return out;
          },
        };
      },
    },
  };
}

function sources() {
  return new Map([
    ['https://example.test/B04.tif', fakeSource('https://example.test/B04.tif', 1)],
    ['https://example.test/B08.tif', fakeSource('https://example.test/B08.tif', 2)],
  ]);
}

test('end-to-end: two bands clipped, written, and readable with the right pixels', async () => {
  const descriptor = describeRasterDataset(ITEM);
  const sink = memorySink();
  const states = [];
  const phases = [];
  const handle = downloadRaster(
    descriptor,
    AREA,
    { bands: ['red', 'nir'], compression: 'deflate' },
    {},
    { sink, sources: sources() },
  );
  handle.on('state', (s) => states.push(s.state));
  handle.on('progress', (p) => phases.push(p.phase));

  const est = await handle.estimate;
  const result = await handle.result;

  assert.equal(handle.state, 'done');
  assert.deepEqual(states, ['running', 'done']);
  assert.deepEqual([...new Set(phases)], ['planning', 'reading', 'writing', 'finalizing']);
  assert.equal(result.format, 'geotiff');
  assert.deepEqual(result.bands, ['B04', 'B08']);
  assert.equal(result.dtype, 'uint16');
  assert.equal(result.epsg, 32610);
  assert.match(result.filename, /FAKE_10SEG_B04-B08_\d+x\d+\.tif$/);
  assert.equal(result.sink.kind, 'memory');
  assert.ok(result.bytes > 0);
  // the modelled output size must bracket what was actually written
  assert.ok(result.bytes >= est.outputBytes.min && result.bytes <= est.outputBytes.max,
    `${result.bytes} outside [${est.outputBytes.min}, ${est.outputBytes.max}]`);

  const bytes = Buffer.concat(sink.chunks.map((c) => Buffer.from(c)));
  const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const image = await tiff.getImage(0);
  assert.equal(image.getWidth(), est.width);
  assert.equal(image.getHeight(), est.height);
  assert.equal(image.getSamplesPerPixel(), 2);
  assert.equal(image.getGeoKeys().ProjectedCSTypeGeoKey, 32610);

  // the exact window the plan chose, and the synthetic source values for it
  const plan = await planRasterClip(descriptor, AREA, { bands: ['red'] }, { sources: sources() });
  const [x0, y0] = plan.window;
  const out = await image.readRasters({ interleave: false });
  const w = est.width;
  for (const [px, py] of [[0, 0], [1, 2], [w - 1, est.height - 1]]) {
    assert.equal(out[0][py * w + px], (1000 + ((y0 + py) * 31 + (x0 + px) * 7)) % 65536, `band 1 at ${px},${py}`);
    assert.equal(out[1][py * w + px], (2000 + ((y0 + py) * 31 + (x0 + px) * 7)) % 65536, `band 2 at ${px},${py}`);
  }
  assert.deepEqual(image.getOrigin().slice(0, 2), plan.origin);
});

test('ceiling: blocked until acceptCeiling(), and the estimate still resolves', async () => {
  const descriptor = describeRasterDataset(ITEM);
  const sink = memorySink();
  const handle = downloadRaster(
    descriptor,
    AREA,
    { bands: ['red'] },
    {},
    { sink, sources: sources(), ceiling: { decodedBytes: 1024 } },
  );
  const est = await handle.estimate;
  assert.equal(est.ceiling.exceeded, true);
  assert.ok(est.ceiling.breaches.includes('decodedBytes'));
  assert.equal(handle.state, 'blocked', 'a breach blocks instead of downloading');
  handle.acceptCeiling();
  const result = await handle.result;
  assert.equal(result.bytes > 0, true);
  assert.equal(handle.state, 'done');
});

test('ceiling: cancel while blocked rejects with CANCELLED and writes nothing', async () => {
  const descriptor = describeRasterDataset(ITEM);
  const sink = memorySink();
  const handle = downloadRaster(
    descriptor,
    AREA,
    { bands: ['red'] },
    {},
    { sink, sources: sources(), ceiling: { pixels: 1 } },
  );
  await handle.estimate;
  assert.equal(handle.state, 'blocked');
  await handle.cancel('changed my mind');
  assert.equal(handle.state, 'cancelled');
  await assert.rejects(() => handle.result, (err) => {
    assert.equal(err.code, 'CANCELLED');
    return true;
  });
  assert.equal(sink.chunks.length, 0);
});

test('acceptCeiling: true skips the gate', async () => {
  const descriptor = describeRasterDataset(ITEM);
  const sink = memorySink();
  const handle = downloadRaster(
    descriptor,
    AREA,
    { bands: ['red'] },
    {},
    { sink, sources: sources(), ceiling: { decodedBytes: 1024 }, acceptCeiling: true },
  );
  const result = await handle.result;
  assert.equal(result.estimate.ceiling.exceeded, true, 'the breach is still reported');
  assert.ok(result.bytes > 0, 'but the caller took responsibility up front');
});

test('a bad band name fails the handle, not the page', async () => {
  const descriptor = describeRasterDataset(ITEM);
  const handle = downloadRaster(descriptor, AREA, { bands: ['swir'] }, {}, { sink: memorySink(), sources: sources() });
  const errors = [];
  handle.on('error', (e) => errors.push(e.code));
  await assert.rejects(() => handle.result, (err) => {
    assert.equal(err.code, 'RASTER_BAND_UNKNOWN');
    return true;
  });
  await assert.rejects(() => handle.estimate);
  assert.equal(handle.state, 'failed');
  assert.deepEqual(errors, ['RASTER_BAND_UNKNOWN']);
});

test('no sink is a refusal, not a silent discard', async () => {
  const descriptor = describeRasterDataset(ITEM);
  const handle = downloadRaster(descriptor, AREA, { bands: ['red'] }, {}, { sources: sources() });
  await assert.rejects(() => handle.result, (err) => {
    assert.equal(err.code, 'SINK_UNSUPPORTED');
    return true;
  });
});
