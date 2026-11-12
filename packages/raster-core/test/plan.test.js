// Window math, overview choice, band resolution, the estimate and the
// ceiling -- all against a fake in-memory `RasterSource` shaped exactly like
// the real Sentinel-2 one measured in E11 (10980x10980, 10 m, UTM 10N,
// uint16, 1024x1024 tiles, 5 levels), so no network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRasterDataset,
  planRasterClip,
  windowForBbox,
  tilesForWindow,
  chooseLevel,
  defaultRasterCeiling,
} from '../src/plan.js';

const AREA = { bbox: [-122.3, 37.75, -122.2, 37.85] }; // Oakland, the E11 clip

function fakeSentinel2Source(url, { tileBytesEach = 1_500_000, samples = 1, dtype = 'uint16' } = {}) {
  const levels = [];
  for (let i = 0; i < 5; i++) {
    const factor = 2 ** i;
    const width = Math.ceil(10980 / factor);
    const tile = i === 0 ? 1024 : 512;
    levels.push({
      level: i,
      width,
      height: width,
      tileSize: [tile, tile],
      tileCount: Math.ceil(width / tile) ** 2,
      pixelSize: [10 * factor, 10 * factor],
      overviewFactor: factor,
    });
  }
  return {
    url,
    epsg: 32610,
    citation: 'WGS 84 / UTM zone 10N',
    origin: [499980, 4200000],
    pixelSize: [10, 10],
    bbox: [499980, 4090200, 609780, 4200000],
    dtype,
    samples,
    nodata: 0,
    compression: 'deflate',
    tiled: true,
    levels,
    fileBytes: 230_706_785,
    _tiff: {
      async getImage(level) {
        const lvl = levels[level];
        return {
          getFileDirectory() {
            return { TileByteCounts: new Array(lvl.tileCount).fill(tileBytesEach) };
          },
        };
      },
    },
  };
}

const S2_ITEM = {
  id: 'S2C_10SEG_20250617_0_L2A',
  collection: 'sentinel-2-l2a',
  properties: { license: 'proprietary' },
  assets: {
    red: {
      href: 'https://example.test/B04.tif',
      type: 'image/tiff; application=geotiff; profile=cloud-optimized',
      title: 'Red - 10m',
      roles: ['data', 'reflectance'],
      'eo:bands': [{ name: 'B04', common_name: 'red', center_wavelength: 0.665 }],
      'raster:bands': [{ nodata: 0, data_type: 'uint16', scale: 0.0001, offset: -0.1 }],
    },
    nir: {
      href: 'https://example.test/B08.tif',
      type: 'image/tiff; application=geotiff; profile=cloud-optimized',
      roles: ['data', 'reflectance'],
      'eo:bands': [{ name: 'B08', common_name: 'nir' }],
      'raster:bands': [{ nodata: 0, data_type: 'uint16', scale: 0.0001, offset: -0.1 }],
    },
    visual: {
      href: 'https://example.test/TCI.tif',
      type: 'image/tiff; application=geotiff; profile=cloud-optimized',
      roles: ['visual'],
      'eo:bands': [{ name: 'B04', common_name: 'red' }, { name: 'B03', common_name: 'green' }, { name: 'B02', common_name: 'blue' }],
    },
    thumbnail: { href: 'https://example.test/thumb.jpg', type: 'image/jpeg', roles: ['thumbnail'] },
  },
};

function sourcesFor(urls, opts) {
  return new Map(urls.map((u) => [u, fakeSentinel2Source(u, opts)]));
}

test('describeRasterDataset names bands from eo:bands and keeps raster:bands metadata', () => {
  const d = describeRasterDataset(S2_ITEM);
  assert.deepEqual(d.bands.map((b) => b.name), ['B04', 'B08'], 'only role=data assets, named from eo:bands');
  assert.equal(d.bands[0].commonName, 'red');
  assert.equal(d.bands[0].dataType, 'uint16');
  assert.equal(d.bands[0].nodata, 0);
  assert.equal(d.bands[0].scale, 0.0001);
  assert.ok(d.bands[0].aliases.includes('red'), 'the STAC asset key is an accepted alias');
  // a non-data asset only appears when asked for
  const visual = describeRasterDataset(S2_ITEM, { assetRoles: ['visual'] });
  assert.deepEqual(visual.bands.map((b) => b.name), ['B04', 'B03', 'B02']);
  assert.deepEqual(visual.bands.map((b) => b.sample), [0, 1, 2], 'samples inside one file');
  assert.ok(visual.bands.every((b) => b.url.endsWith('TCI.tif')));
  // no JPEG thumbnail ever
  assert.ok(!visual.bands.some((b) => b.url.endsWith('.jpg')));
});

test('windowForBbox snaps outward to whole pixels and reproduces the measured E11 window', () => {
  const s = fakeSentinel2Source('u');
  const w = windowForBbox(s, 0, AREA.bbox);
  assert.deepEqual(w.window, [6160, 1052, 7050, 2170], 'matches the window GDAL validated');
  assert.equal(w.width, 890);
  assert.equal(w.height, 1118);
  assert.deepEqual(w.origin, [561580, 4189480]);
  assert.deepEqual(w.pixelSize, [10, 10]);
});

test('tilesForWindow counts the tiles actually touched and the read amplification', () => {
  const s = fakeSentinel2Source('u');
  const w = windowForBbox(s, 0, AREA.bbox);
  const t = tilesForWindow(s, 0, w.window);
  assert.equal(t.indices.length, 2, '890x1118 px in one tile column, two tile rows');
  assert.ok(t.amplification > 2 && t.amplification < 2.2, `amplification ${t.amplification}`);
});

test('chooseLevel: native by default, coarser only when asked', () => {
  const s = fakeSentinel2Source('u');
  assert.equal(chooseLevel(s, AREA.bbox, undefined), 0);
  assert.equal(chooseLevel(s, AREA.bbox, 'native'), 0);
  assert.equal(chooseLevel(s, AREA.bbox, { maxPixels: 1e9 }), 0, 'never upsamples past level 0');
  assert.equal(chooseLevel(s, AREA.bbox, { maxPixels: 250_000 }), 1, '890x1118 -> 445x559');
  assert.equal(chooseLevel(s, AREA.bbox, { maxPixels: 10_000 }), 4, '890x1118 -> 112x140 still too big, 56x70 fits');
  assert.equal(chooseLevel(s, AREA.bbox, { level: 2 }), 2);
});

test('estimate: pixels and bytes are exact, readBytes comes from TileByteCounts', async () => {
  const d = describeRasterDataset(S2_ITEM);
  const sources = sourcesFor(['https://example.test/B04.tif', 'https://example.test/B08.tif']);
  const plan = await planRasterClip(d, AREA, { bands: ['red', 'nir'] }, { sources });
  const e = plan.estimate;

  assert.equal(e.width, 890);
  assert.equal(e.height, 1118);
  assert.deepEqual(e.bands, ['B04', 'B08']);
  assert.equal(e.dtype, 'uint16');
  assert.equal(e.pixels.estimate, 890 * 1118 * 2);
  assert.equal(e.pixels.exact, true);
  assert.equal(e.decodedBytes.estimate, 890 * 1118 * 2 * 2);
  assert.equal(e.decodedBytes.exact, true);
  // 2 tiles per file x 2 files x 1.5 MB + the two header reads
  assert.equal(e.readBytes.estimate, 2 * 2 * 1_500_000 + 2 * 65_536);
  assert.equal(e.readBytes.exact, true, 'exact because TileByteCounts is in the IFD');
  assert.equal(e.outputBytes.exact, false, 'only the compression ratio is modelled');
  assert.ok(e.outputBytes.estimate < e.decodedBytes.estimate);
  assert.equal(e.files.selected, 2);
  assert.equal(e.tiles.selected, 4);
  assert.equal(e.resolution.native, true);
  assert.equal(e.resolution.level, 0);
  assert.equal(e.ceiling.exceeded, false);
  assert.deepEqual(e.prune.map((p) => p.stage), ['overview', 'window', 'tile', 'band']);
  assert.ok(e.naiveBytes > 400e6, 'the two whole source files, for the comparison');
});

test('estimate warnings are honest about what the clip is not', async () => {
  const d = describeRasterDataset(S2_ITEM);
  const sources = sourcesFor(['https://example.test/B04.tif']);
  const plan = await planRasterClip(d, AREA, { bands: ['red'] }, { sources });
  const codes = plan.estimate.warnings.map((w) => w.code);
  assert.ok(codes.includes('bbox-only-clip'), 'the polygon is not masked and the UI must say so');
  assert.ok(codes.includes('tile-amplification'));
  assert.ok(codes.includes('scale-offset-not-applied'), 'S2 DNs are not reflectance');
  assert.ok(!codes.includes('overview-downsample'));

  const coarse = await planRasterClip(d, AREA, { bands: ['red'], resolution: { maxPixels: 10_000 } }, { sources });
  assert.ok(coarse.estimate.warnings.some((w) => w.code === 'overview-downsample'));
  assert.equal(coarse.estimate.resolution.native, false);
});

test('the memory ceiling refuses a window that would not fit in RAM', async () => {
  const d = describeRasterDataset(S2_ITEM);
  const sources = sourcesFor(['https://example.test/B04.tif', 'https://example.test/B08.tif']);
  // The whole Sentinel-2 tile, two bands: 10980^2 x 2 x 2 B = 482 MB
  // decoded, which no browser tab should be asked to hold.
  const wholeTile = { bbox: [-123.5, 36.5, -120.5, 38.5] };
  const plan = await planRasterClip(d, wholeTile, { bands: ['red', 'nir'] }, { sources });
  const e = plan.estimate;
  assert.equal(e.ceiling.exceeded, true);
  assert.ok(e.ceiling.breaches.includes('decodedBytes'), `breaches: ${e.ceiling.breaches}`);
  assert.ok(e.ceiling.breaches.includes('pixels'), `breaches: ${e.ceiling.breaches}`);
  assert.equal(e.width, 10980, 'the window clamps to the image, it does not run off the edge');
  assert.ok(e.decodedBytes.estimate > defaultRasterCeiling().decodedBytes);
  // and the same request under a raised ceiling is allowed, explicitly
  const raised = await planRasterClip(d, wholeTile, { bands: ['red', 'nir'] }, { sources, ceiling: { decodedBytes: 2 * 1024 ** 3, pixels: 1e9 } });
  assert.equal(raised.estimate.ceiling.exceeded, false);
});

test('refusals: unknown band, no bands, disjoint area, antimeridian, mixed grids', async () => {
  const d = describeRasterDataset(S2_ITEM);
  const sources = sourcesFor(['https://example.test/B04.tif', 'https://example.test/B08.tif']);

  await assert.rejects(() => planRasterClip(d, AREA, { bands: ['swir16'] }, { sources }), (err) => {
    assert.equal(err.code, 'RASTER_BAND_UNKNOWN');
    assert.match(err.message, /Available: B04, B08/);
    return true;
  });
  await assert.rejects(() => planRasterClip(d, { bbox: [10, 10, 11, 11] }, { bands: ['red'] }, { sources }), (err) => {
    assert.equal(err.code, 'RASTER_AREA_DISJOINT');
    return true;
  });
  await assert.rejects(
    () => planRasterClip(d, { bbox: [179, 37, -179, 38], bboxes: [[179, 37, 180, 38], [-180, 37, -179, 38]] }, { bands: ['red'] }, { sources }),
    (err) => {
      assert.equal(err.code, 'RASTER_AREA_ANTIMERIDIAN');
      return true;
    },
  );
  await assert.rejects(() => planRasterClip(d, null, { bands: ['red'] }, { sources }), (err) => {
    assert.equal(err.code, 'AREA_EMPTY');
    return true;
  });

  // 20 m band mixed with a 10 m band: one GeoTIFF has one grid.
  const mixed = new Map(sources);
  const coarse = fakeSentinel2Source('https://example.test/B08.tif');
  coarse.pixelSize = [20, 20];
  mixed.set('https://example.test/B08.tif', coarse);
  await assert.rejects(() => planRasterClip(d, AREA, { bands: ['red', 'nir'] }, { sources: mixed }), (err) => {
    assert.equal(err.code, 'RASTER_GRID_MISMATCH');
    return true;
  });

  const mixedType = new Map(sources);
  const f32 = fakeSentinel2Source('https://example.test/B08.tif', { dtype: 'float32' });
  mixedType.set('https://example.test/B08.tif', f32);
  await assert.rejects(() => planRasterClip(d, AREA, { bands: ['red', 'nir'] }, { sources: mixedType }), (err) => {
    assert.equal(err.code, 'RASTER_MIXED_DTYPE');
    return true;
  });
});

test('band order in the output follows the order asked for', async () => {
  const d = describeRasterDataset(S2_ITEM);
  const sources = sourcesFor(['https://example.test/B04.tif', 'https://example.test/B08.tif']);
  const plan = await planRasterClip(d, AREA, { bands: ['nir', 'B04'] }, { sources });
  assert.deepEqual(plan.estimate.bands, ['B08', 'B04']);
  assert.deepEqual(plan.bands.map((b) => b.url.split('/').pop()), ['B08.tif', 'B04.tif']);
});
