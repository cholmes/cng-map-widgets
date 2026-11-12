// @cnmw/raster-core -- band resolution, window math, overview choice, and
// the pre-download estimate.
//
// The estimate contract is deliberately download-core's: `Bounded`
// (min/max/estimate/exact), a `prune` trace, `warnings`, and a `ceiling`
// block with `exceeded` + `breaches`, so one UI can render either. The
// raster numbers that matter are different, though:
//   * pixels/decodedBytes are *exact* -- they are window dims x bands x
//     dtype width, known before a pixel is read;
//   * readBytes is also exact, because a tiled TIFF's IFD carries
//     TileByteCounts, i.e. the compressed size of every tile the window
//     touches;
//   * outputBytes is the only modelled number (compression ratio).
// That is the opposite of the vector case, where rows are the uncertain
// quantity, and it makes the raster refusal path unusually trustworthy.

import { CnmwError } from '@cnmw/spec';
import { projectBbox } from './crs.js';
import { DTYPE_BYTES, openRaster, tileBytes } from './source.js';

/** @returns {{ pixels:number, decodedBytes:number, outputBytes:number, readBytes:number, files:number, blobBytes:number }} */
export function defaultRasterCeiling() {
  return {
    /** Window pixels x bands. 64 Mpx = e.g. 4000x4000x4 bands. */
    pixels: 64_000_000,
    /** The decisive one: the whole window must fit in RAM, decoded, at once.
     *  geotiff.js hands back one TypedArray per band and our writer then
     *  builds interleaved strips, so peak use is ~1.2x this number. 384 MiB
     *  keeps that near 460 MiB, which a browser tab survives; past it a tab
     *  is at real risk of an unrecoverable OOM, which is why this is a
     *  refusal and not a warning. */
    decodedBytes: 384 * 1024 ** 2,
    outputBytes: 2 * 1024 ** 3,
    readBytes: 4 * 1024 ** 3,
    /** One HTTP file handle per band in the multi-file (Sentinel-2) layout. */
    files: 32,
    blobBytes: 256 * 1024 ** 2,
  };
}

const bounded = (n) => ({ min: n, max: n, estimate: n, exact: true });
const range = (min, max, estimate) => ({ min, max, estimate, exact: false });

/**
 * Measured DEFLATE ratios (compressed/raw) on the E11 clips:
 *   S2 uint16 reflectance, 890x1118x3 -> 0.78
 *   S2 uint8 TCI subset,   890x1118x2 -> 0.66
 *   FTW float32 counts,    240x240x1  -> 0.61
 * Imagery is high-entropy, so the ratio never approaches text-like
 * compression; the bounds below are deliberately wide enough to hold an
 * all-nodata window (which compresses to almost nothing) and an
 * incompressible one (deflate can expand slightly).
 */
const DEFLATE_RATIO = { min: 0.02, max: 1.02, estimate: 0.8 };

/**
 * @typedef {object} RasterBandRef
 * @property {string} name          'red', 'B04', 'band:1' -- what the UI shows and the filter names
 * @property {string} url
 * @property {number} sample        0-based sample index inside that file
 * @property {string} [title]
 * @property {string} [commonName]
 * @property {number} [centerWavelength]
 * @property {string} [dataType]    from STAC raster:bands, advisory only
 * @property {number} [nodata]      from STAC raster:bands, advisory only
 * @property {number} [scale]
 * @property {number} [offset]
 */

/**
 * Build a raster dataset descriptor from a STAC Item.
 *
 * Band-naming contract (E11 decision): when the item has `eo:bands`, the
 * band's own `name` (B04) and `common_name` (red) are both offered and
 * either may be used in `filter.bands`; the asset key (`red`, `nir`) is a
 * third accepted alias, because that is what a STAC user sees first. With no
 * `eo:bands`, bands are named `<assetKey>:<n>` positionally -- never
 * silently guessed as RGB.
 *
 * `raster:bands` supplies dtype/nodata/scale/offset for the UI; the clip
 * itself reads dtype and nodata from the file's own tags, because the file
 * is the thing being copied and metadata can lie.
 *
 * @param {object} item a STAC Item (as JSON)
 * @param {{ assetRoles?: readonly string[] }} [options]
 */
export function describeRasterDataset(item, options = {}) {
  const roles = options.assetRoles ?? ['data'];
  /** @type {RasterBandRef[]} */
  const bands = [];
  const assets = item?.assets ?? {};
  for (const [key, asset] of Object.entries(assets)) {
    const type = String(asset.type ?? '');
    if (!/tiff/i.test(type)) continue;
    if (asset.roles && roles.length && !asset.roles.some((r) => roles.includes(r))) continue;
    const eo = asset['eo:bands'] ?? [];
    const rb = asset['raster:bands'] ?? [];
    const n = Math.max(eo.length, rb.length, 1);
    for (let i = 0; i < n; i++) {
      const e = eo[i] ?? {};
      const r = rb[i] ?? {};
      bands.push({
        name: e.name ?? (n === 1 ? key : `${key}:${i + 1}`),
        aliases: [key, e.common_name, e.name, n === 1 ? null : `${key}:${i + 1}`].filter(Boolean),
        url: asset.href,
        sample: i,
        title: asset.title,
        commonName: e.common_name,
        // Ground resolution is part of a band's identity, not decoration:
        // Sentinel-2 publishes 10/20/60 m bands side by side in one item,
        // and mixing them in one clip is a refusal (RASTER_GRID_MISMATCH),
        // so a band picker has to show it.
        resolution: r.spatial_resolution ?? asset.gsd ?? item?.properties?.gsd,
        centerWavelength: e.center_wavelength,
        dataType: r.data_type,
        nodata: r.nodata,
        scale: r.scale,
        offset: r.offset,
      });
    }
  }
  return {
    spec: 'cnmw-raster-dataset/1.0',
    id: item?.id,
    title: item?.properties?.title ?? item?.id,
    bands,
    attribution: item?.properties?.license ? [{ text: String(item.properties.license) }] : [],
    extra: { collection: item?.collection },
  };
}

/** A hand-written descriptor for a bare COG URL: one band per sample, discovered on open. */
export async function describeRasterUrl(url, options = {}) {
  const source = await openRaster(url, options);
  const bands = [];
  for (let i = 0; i < source.samples; i++) {
    bands.push({
      name: source.samples === 1 ? 'band:1' : `band:${i + 1}`,
      aliases: [`band:${i + 1}`],
      url,
      sample: i,
      dataType: source.dtype,
      nodata: source.nodata,
    });
  }
  return {
    spec: 'cnmw-raster-dataset/1.0',
    id: url,
    title: url.split('/').pop(),
    bands,
    attribution: [],
    _sources: new Map([[url, source]]),
  };
}

function matchBand(descriptor, wanted) {
  const w = String(wanted).toLowerCase();
  return descriptor.bands.find(
    (b) => b.name?.toLowerCase() === w || (b.aliases ?? []).some((a) => String(a).toLowerCase() === w),
  );
}

/**
 * Pixel window in a given level for a lon/lat bbox. Half-open in pixel
 * space: [x0, y0) .. [x1, y1), snapped outward to whole pixels so the
 * requested area is always fully covered, never cropped.
 */
export function windowForBbox(source, level, bbox4326) {
  const lvl = source.levels[level];
  const proj = projectBbox(bbox4326, source.epsg);
  const [ox, oy] = source.origin;
  const [sx, sy] = lvl.pixelSize;
  const x0 = Math.max(0, Math.floor((proj[0] - ox) / sx));
  const x1 = Math.min(lvl.width, Math.ceil((proj[2] - ox) / sx));
  const y0 = Math.max(0, Math.floor((oy - proj[3]) / sy));
  const y1 = Math.min(lvl.height, Math.ceil((oy - proj[1]) / sy));
  return {
    window: [x0, y0, x1, y1],
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
    origin: [ox + x0 * sx, oy - y0 * sy],
    pixelSize: [sx, sy],
    projected: proj,
  };
}

/** Tile indices (into TileOffsets/TileByteCounts) a window touches at a level. */
export function tilesForWindow(source, level, window) {
  const lvl = source.levels[level];
  if (!lvl.tileCount) return { indices: [], tilesAcross: 0, amplification: 1 };
  const [tw, th] = lvl.tileSize;
  const across = Math.ceil(lvl.width / tw);
  const [x0, y0, x1, y1] = window;
  const indices = [];
  for (let ty = Math.floor(y0 / th); ty <= Math.floor((y1 - 1) / th); ty++) {
    for (let tx = Math.floor(x0 / tw); tx <= Math.floor((x1 - 1) / tw); tx++) {
      indices.push(ty * across + tx);
    }
  }
  const windowPixels = Math.max(1, (x1 - x0) * (y1 - y0));
  return { indices, tilesAcross: across, amplification: (indices.length * tw * th) / windowPixels };
}

/**
 * Choose the level to clip from.
 *
 * E11 decision: **native resolution of the window is the default**, because
 * the stated user intent is "full res of the window" -- a clip that silently
 * handed back a decimated raster would be a different product wearing the
 * same filename. `resolution: {maxPixels}` is the opt-in that picks the
 * finest overview level whose window fits the budget (and it never
 * upsamples: if even level 0 is under the budget, level 0 wins).
 */
export function chooseLevel(source, bbox4326, resolution) {
  if (resolution === undefined || resolution === 'native') return 0;
  if (typeof resolution === 'object' && resolution.level !== undefined) return resolution.level;
  if (typeof resolution === 'object' && resolution.maxPixels) {
    for (let i = 0; i < source.levels.length; i++) {
      const w = windowForBbox(source, i, bbox4326);
      if (w.width * w.height <= resolution.maxPixels) return i;
    }
    return source.levels.length - 1;
  }
  return 0;
}

/**
 * Plan a clip and estimate it. Reads only headers (one or two range reads
 * per distinct file), never pixels.
 *
 * @param {object} descriptor from describeRasterDataset/describeRasterUrl
 * @param {import('@cnmw/spec').Area|null} area
 * @param {{ bands?: readonly string[], resolution?: 'native'|{maxPixels?:number, level?:number}, compression?: 'none'|'deflate', bbox?: readonly number[] }} filter
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal, ceiling?: object, sources?: Map<string, object> }} [options]
 */
export async function planRasterClip(descriptor, area, filter = {}, options = {}) {
  const started = Date.now();
  const ceiling = { ...defaultRasterCeiling(), ...(options.ceiling ?? {}) };
  const bbox = filter.bbox ?? area?.bbox;
  if (!bbox || bbox.length !== 4) {
    throw new CnmwError('A raster clip needs an area with a bbox.', 'AREA_EMPTY');
  }
  if (area?.bboxes && area.bboxes.length > 1) {
    // An antimeridian-split area is two bboxes in lon/lat; in a projected
    // CRS they are not one rectangle, and a GeoTIFF has exactly one
    // transform. Refusing is honest; the user can clip each side.
    throw new CnmwError(
      'This area crosses the antimeridian. Clip each side separately -- one GeoTIFF cannot span the seam.',
      'RASTER_AREA_ANTIMERIDIAN',
      { context: { boxes: area.bboxes.length } },
    );
  }

  const wantedNames = filter.bands?.length ? filter.bands : descriptor.bands.map((b) => b.name);
  /** @type {RasterBandRef[]} */
  const bands = [];
  for (const name of wantedNames) {
    const band = matchBand(descriptor, name);
    if (!band) {
      throw new CnmwError(
        `No band named "${name}". Available: ${descriptor.bands.map((b) => b.name).join(', ')}.`,
        'RASTER_BAND_UNKNOWN',
        { context: { band: name, available: descriptor.bands.map((b) => b.name) } },
      );
    }
    bands.push(band);
  }
  if (!bands.length) throw new CnmwError('Select at least one band.', 'RASTER_NO_BANDS');

  // Open each distinct file once.
  const sources = options.sources ?? descriptor._sources ?? new Map();
  const urls = [...new Set(bands.map((b) => b.url))];
  let requests = 0;
  for (const url of urls) {
    if (!sources.has(url)) {
      sources.set(url, await openRaster(url, options));
      requests += 2; // header/IFD read + the advisory HEAD
    }
  }
  const primary = sources.get(bands[0].url);

  // Every band must share one grid, or they cannot go into one GeoTIFF.
  for (const b of bands) {
    const s = sources.get(b.url);
    if (s.epsg !== primary.epsg || s.pixelSize[0] !== primary.pixelSize[0] || s.pixelSize[1] !== primary.pixelSize[1]) {
      throw new CnmwError(
        `Band "${b.name}" is on a different grid (EPSG:${s.epsg}, ${s.pixelSize.join('x')}) than "${bands[0].name}" ` +
          `(EPSG:${primary.epsg}, ${primary.pixelSize.join('x')}). Resampling is out of scope; pick bands of one resolution.`,
        'RASTER_GRID_MISMATCH',
        { context: { band: b.name } },
      );
    }
    if (s.dtype !== primary.dtype) {
      throw new CnmwError(
        `Band "${b.name}" is ${s.dtype} but "${bands[0].name}" is ${primary.dtype}; one GeoTIFF has one sample type.`,
        'RASTER_MIXED_DTYPE',
        { context: { band: b.name } },
      );
    }
  }

  const level = chooseLevel(primary, bbox, filter.resolution);
  const win = windowForBbox(primary, level, bbox);
  if (win.width === 0 || win.height === 0) {
    throw new CnmwError(
      'The area does not overlap this raster.',
      'RASTER_AREA_DISJOINT',
      { context: { areaBbox: bbox, rasterBbox: primary.bbox, epsg: primary.epsg } },
    );
  }

  const bytesPer = DTYPE_BYTES[primary.dtype];
  const pixels = win.width * win.height * bands.length;
  const decodedBytes = pixels * bytesPer;

  // readBytes: exact, from TileByteCounts, per file.
  /** @type {import('./plan.js').PruneStage[]} */
  const prune = [];
  let readBytes = 0;
  let readExact = true;
  let tilesSelected = 0;
  let tilesTotal = 0;
  let amplification = 1;
  for (const url of urls) {
    const s = sources.get(url);
    const t = tilesForWindow(s, level, win.window);
    amplification = Math.max(amplification, t.amplification);
    tilesSelected += t.indices.length;
    tilesTotal += s.levels[level].tileCount;
    const exact = await tileBytes(s, level, t.indices);
    if (exact == null) {
      readExact = false;
      readBytes += decodedBytes / bands.length; // striped file: assume we read it all
    } else {
      readBytes += exact;
    }
  }
  readBytes += urls.length * 65_536; // the header read geotiff.js always does
  prune.push({
    stage: 'overview',
    before: primary.levels[0].width * primary.levels[0].height,
    after: primary.levels[level].width * primary.levels[level].height,
    basis: level === 0 ? 'native resolution (level 0)' : `overview level ${level} (1/${primary.levels[level].overviewFactor})`,
  });
  prune.push({
    stage: 'window',
    before: primary.levels[level].width * primary.levels[level].height,
    after: win.width * win.height,
    basis: `bbox window ${win.width}x${win.height} px`,
  });
  prune.push({
    stage: 'tile',
    before: tilesTotal,
    after: tilesSelected,
    basis: primary.tiled ? `tiles touching the window (read amplification ${amplification.toFixed(2)}x)` : 'untiled: whole strips',
  });
  prune.push({
    stage: 'band',
    before: [...urls].reduce((n, u) => n + sources.get(u).samples, 0),
    after: bands.length,
    basis: urls.length === bands.length ? 'one file per band' : 'samples within a file',
  });

  const compression = filter.compression ?? 'deflate';
  const outputBytes =
    compression === 'none'
      ? bounded(decodedBytes + 2048)
      : range(
          Math.round(decodedBytes * DEFLATE_RATIO.min),
          Math.round(decodedBytes * DEFLATE_RATIO.max) + 2048,
          Math.round(decodedBytes * DEFLATE_RATIO.estimate),
        );

  /** @type {{code:string, message:string}[]} */
  const warnings = [];
  warnings.push({
    code: 'bbox-only-clip',
    message:
      'The clip is the bounding box of the area, at full resolution. Pixels inside the box but outside the ' +
      'polygon are kept as-is, not masked.',
  });
  if (amplification > 2) {
    warnings.push({
      code: 'tile-amplification',
      message: `The window covers part of ${tilesSelected} tile(s); ${amplification.toFixed(1)}x more pixels are fetched and decoded than are kept.`,
    });
  }
  if (level > 0) {
    warnings.push({
      code: 'overview-downsample',
      message: `Reading overview level ${level} (${primary.levels[level].pixelSize[0]} CRS units/px instead of ${primary.levels[0].pixelSize[0]}).`,
    });
  }
  if (primary.nodata == null) {
    warnings.push({
      code: 'nodata-absent',
      message: 'The source declares no nodata value, so the output cannot mark missing pixels.',
    });
  }
  const scaled = bands.filter((b) => b.scale !== undefined || b.offset !== undefined);
  if (scaled.length) {
    warnings.push({
      code: 'scale-offset-not-applied',
      message:
        `Raw digital numbers are copied verbatim; ${scaled.length} band(s) declare scale/offset in STAC ` +
        '(apply them yourself, e.g. reflectance = DN * scale + offset).',
    });
  }

  const breaches = [];
  if (pixels > ceiling.pixels) breaches.push('pixels');
  if (decodedBytes > ceiling.decodedBytes) breaches.push('decodedBytes');
  if (outputBytes.max > ceiling.outputBytes) breaches.push('outputBytes');
  if (readBytes > ceiling.readBytes) breaches.push('readBytes');
  if (urls.length > ceiling.files) breaches.push('files');

  const estimate = {
    pixels: bounded(pixels),
    width: win.width,
    height: win.height,
    bands: bands.map((b) => b.name),
    dtype: primary.dtype,
    decodedBytes: bounded(decodedBytes),
    readBytes: readExact ? bounded(readBytes) : range(readBytes, readBytes * 1.2, readBytes),
    outputBytes,
    files: { total: urls.length, selected: urls.length },
    tiles: { total: tilesTotal, selected: tilesSelected },
    requests: requests + urls.length, // header reads already done + one coalesced range per file (measured: 1-2)
    naiveBytes: urls.reduce((n, u) => n + Math.max(0, sources.get(u).fileBytes), 0),
    resolution: {
      level,
      pixelSize: primary.levels[level].pixelSize,
      native: level === 0,
      epsg: primary.epsg,
    },
    prune,
    warnings,
    ceiling: { exceeded: breaches.length > 0, limits: ceiling, breaches },
    elapsedMs: Date.now() - started,
  };

  return {
    descriptor,
    bands,
    sources,
    level,
    window: win.window,
    width: win.width,
    height: win.height,
    origin: win.origin,
    pixelSize: win.pixelSize,
    epsg: primary.epsg,
    citation: primary.citation,
    dtype: primary.dtype,
    nodata: primary.nodata,
    compression,
    estimate,
  };
}

/** Header-only estimate, for a UI that wants a number before any commitment. */
export async function estimateRasterClip(descriptor, area, filter = {}, options = {}) {
  const plan = await planRasterClip(descriptor, area, filter, options);
  return plan.estimate;
}
