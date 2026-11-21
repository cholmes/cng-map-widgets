// @cngeo/raster-core -- opening a remote COG and describing it.
//
// A `RasterSource` is the raster analog of download-core's `DatasetTable`:
// everything a planner needs to size a clip without reading a pixel. All of
// it comes from the TIFF header + IFDs, which is one or two range reads.

import { CngError } from '@cngeo/spec';
import { loadGeoTiff, loadZstdDec } from './cdn.js';
import { describeCrs } from './crs.js';

/** TIFF SampleFormat + BitsPerSample -> our dtype names (and byte widths). */
function dtypeFrom(bits, format) {
  const f = format ?? 1;
  if (f === 3) return bits === 64 ? 'float64' : 'float32';
  if (f === 2) return bits === 8 ? 'int8' : bits === 16 ? 'int16' : 'int32';
  if (bits === 8) return 'uint8';
  if (bits === 16) return 'uint16';
  if (bits === 32) return 'uint32';
  return null;
}

export const DTYPE_BYTES = {
  uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8,
};

/** Compression ids geotiff.js can decode. 50000 (ZSTD) only after we register a decoder. */
const SUPPORTED_COMPRESSION = new Map([
  [1, 'none'], [5, 'lzw'], [7, 'jpeg'], [8, 'deflate'], [32773, 'packbits'],
  [32946, 'deflate'], [34887, 'lerc'], [50000, 'zstd'], [50001, 'webimage'],
]);

let zstdRegistered = false;

/**
 * geotiff.js 2.1.3 ships no decoder for TIFF compression 50000 (ZSTD) and
 * throws `Unknown compression method identifier: 50000` *at read time*,
 * after the tile bytes have been paid for. GDAL writes ZSTD COGs routinely
 * (the user's own ftw/global-data confidence rasters are ZSTD), so we
 * register the missing decoder through geotiff's public `addDecoder` seam.
 * Called automatically by `openRaster` when the file turns out to be ZSTD,
 * so the extra ~24 KB gz of zstddec is only fetched when it is needed.
 */
export async function ensureZstdDecoder() {
  if (zstdRegistered) return;
  const [gt, zd] = await Promise.all([loadGeoTiff(), loadZstdDec()]);
  const decoder = new zd.ZSTDDecoder();
  let ready = null;
  class ZstdDecoder extends gt.BaseDecoder {
    async decodeBlock(buffer) {
      if (!ready) ready = decoder.init();
      await ready;
      const input = new Uint8Array(buffer);
      // TIFF does not record the uncompressed tile size, and zstddec wants
      // an output-size hint, so grow geometrically until it fits.
      let guess = Math.max(1 << 16, input.length * 8);
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          return decoder.decode(input, guess).buffer;
        } catch (err) {
          if (attempt === 7) throw err;
          guess *= 4;
        }
      }
      throw new Error('unreachable');
    }
  }
  gt.addDecoder(50000, () => ZstdDecoder);
  zstdRegistered = true;
}

/**
 * @typedef {object} RasterLevel
 * @property {number} level 0 = full resolution, 1..n = overviews
 * @property {number} width
 * @property {number} height
 * @property {[number, number]} tileSize
 * @property {number} tileCount
 * @property {[number, number]} pixelSize in CRS units
 * @property {number} overviewFactor width(level 0) / width(level)
 */

/**
 * @typedef {object} RasterSource
 * @property {string} url
 * @property {number} epsg
 * @property {string} [citation]
 * @property {[number, number]} origin upper-left corner, CRS units
 * @property {[number, number]} pixelSize
 * @property {[number, number, number, number]} bbox in the image CRS
 * @property {string} dtype
 * @property {number} samples samples per pixel in the file
 * @property {number|null} nodata
 * @property {'none'|'deflate'|'lzw'|'zstd'|'jpeg'|'packbits'|'lerc'|'webimage'} compression
 * @property {boolean} tiled
 * @property {readonly RasterLevel[]} levels
 * @property {number} fileBytes -1 when the host did not expose Content-Length
 * @property {{ requests: number, bytes: number }} net live counters of what this file has cost
 * @property {object} _tiff geotiff.js handle (internal)
 */

/**
 * Open a remote COG and describe it. Costs 1-2 range reads (header + IFDs).
 * @param {string} url
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal, probeSize?: boolean }} [options]
 * @returns {Promise<RasterSource>}
 */
export async function openRaster(url, options = {}) {
  const gt = await loadGeoTiff();
  const baseFetch = options.fetch ?? globalThis.fetch;
  // FINDING: geotiff.js's `fromUrl` has no `fetch` option -- its FetchClient
  // closes over the *global* fetch, so neither an injected fetch nor the
  // `cache: 'no-store'` that §4.4 rule 7 requires can reach it that way.
  // `fromCustomClient` + the exported BaseClient/BaseResponse is the
  // supported seam, and it costs ~20 lines. It buys three things:
  //   1. `options.fetch` actually works (hosts, tests, proxies);
  //   2. every range read carries `cache: 'no-store'`, the measured
  //      sentinel-2 fix for Chrome serializing concurrent reads of one URL
  //      behind its cache lock;
  //   3. honest byte accounting -- counted from the decoded ArrayBuffer,
  //      not from a Content-Length header that a cross-origin response may
  //      not expose.
  const net = { requests: 0, bytes: 0 };
  /** Total file size, learned for free from the first 206's Content-Range. */
  let totalBytes = -1;
  class CountingResponse extends gt.BaseResponse {
    constructor(response) {
      super();
      this.response = response;
    }
    get status() {
      return this.response.status;
    }
    getHeader(name) {
      return this.response.headers.get(name);
    }
    async getData() {
      const data = await this.response.arrayBuffer();
      net.bytes += data.byteLength;
      return data;
    }
  }
  class CountingClient extends gt.BaseClient {
    async request({ headers, signal } = {}) {
      net.requests += 1;
      const response = await baseFetch(this.url, { headers, signal, cache: 'no-store' });
      if (totalBytes < 0) {
        // "Content-Range: bytes 0-65536/228720054" carries the total file
        // size, so on a host that exposes the header the "vs a naive full
        // download" figure is free. FINDING: `Content-Range` is NOT a
        // CORS-safelisted response header, and sentinel-cogs sends no
        // `Access-Control-Expose-Headers`, so in a browser this reads as
        // null there (it works on source.coop, which exposes `*`). Hence
        // the HEAD fallback below -- Content-Length *is* safelisted.
        const m = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '');
        if (m) totalBytes = Number(m[1]);
      }
      return new CountingResponse(response);
    }
  }
  let tiff;
  try {
    tiff = await gt.fromCustomClient(new CountingClient(url), {}, options.signal);
  } catch (err) {
    throw new CngError(`Could not open ${url}: ${err?.message ?? err}`, 'NETWORK', { cause: err, retryable: true });
  }
  const count = await tiff.getImageCount();
  const base = await tiff.getImage(0);
  const fd = base.getFileDirectory();
  const keys = base.getGeoKeys() ?? {};
  const epsg = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey ?? null;
  if (!epsg) {
    throw new CngError(`${url} has no CRS GeoKey; it is not georeferenced.`, 'RASTER_NOT_GEOREFERENCED');
  }
  if (!describeCrs(epsg)) {
    throw new CngError(
      `EPSG:${epsg} is not one of the CRSs raster-core can transform an area into (4326, 3857, WGS84 UTM zones).`,
      'RASTER_CRS_UNSUPPORTED',
      { context: { epsg } },
    );
  }
  if (!fd.ModelPixelScale || !fd.ModelTiepoint) {
    throw new CngError(`${url} has no affine transform (ModelPixelScale/ModelTiepoint).`, 'RASTER_NOT_GEOREFERENCED');
  }

  const compression = SUPPORTED_COMPRESSION.get(fd.Compression ?? 1);
  if (!compression) {
    // Refuse in `openRaster`, i.e. before any pixel bytes are paid for.
    // geotiff.js's own failure mode is a throw from inside readRasters,
    // after the tiles have been fetched.
    throw new CngError(
      `${url} uses TIFF compression ${fd.Compression}, which cannot be decoded in the browser.`,
      'RASTER_COMPRESSION_UNSUPPORTED',
      { context: { compression: fd.Compression } },
    );
  }
  if (compression === 'zstd') await ensureZstdDecoder();

  const bits = Array.from(fd.BitsPerSample ?? [8]);
  const formats = Array.from(fd.SampleFormat ?? bits.map(() => 1));
  if (new Set(bits).size > 1 || new Set(formats).size > 1) {
    throw new CngError(`${url} mixes sample types across bands, which is not supported.`, 'RASTER_MIXED_DTYPE');
  }
  const dtype = dtypeFrom(bits[0], formats[0]);
  if (!dtype) {
    throw new CngError(`${url} has an unsupported sample type (${bits[0]} bits, format ${formats[0]}).`, 'RASTER_DTYPE_UNSUPPORTED');
  }

  const [ox, oy] = base.getOrigin();
  const res = base.getResolution();
  /** @type {RasterLevel[]} */
  const levels = [];
  for (let i = 0; i < count; i++) {
    const img = i === 0 ? base : await tiff.getImage(i);
    const ifd = img.getFileDirectory();
    const factor = base.getWidth() / img.getWidth();
    levels.push({
      level: i,
      width: img.getWidth(),
      height: img.getHeight(),
      tileSize: [img.getTileWidth(), img.getTileHeight()],
      tileCount: ifd.TileOffsets ? ifd.TileOffsets.length : 0,
      // NOTE: overview IFDs carry no ModelPixelScale of their own, so
      // `img.getResolution()` throws "does not have an affine
      // transformation"; the base image must be passed in. Measured on
      // every Sentinel-2 COG.
      pixelSize: [Math.abs(res[0]) * factor, Math.abs(res[1]) * factor],
      overviewFactor: factor,
    });
  }

  let fileBytes = totalBytes;
  if (fileBytes < 0 && options.probeSize !== false) {
    try {
      const head = await baseFetch(url, { method: 'HEAD', signal: options.signal });
      fileBytes = Number(head.headers.get('content-length') ?? -1);
    } catch {
      /* advisory only: it feeds the "vs a naive full download" comparison */
    }
  }

  const nodataRaw = fd.GDAL_NODATA;
  const nodata = nodataRaw == null ? null : Number(String(nodataRaw).replace(/\0/g, '').trim());

  return {
    url,
    epsg,
    citation: keys.GTCitationGeoKey ?? keys.GeogCitationGeoKey,
    origin: [ox, oy],
    pixelSize: [Math.abs(res[0]), Math.abs(res[1])],
    bbox: base.getBoundingBox(),
    dtype,
    samples: base.getSamplesPerPixel(),
    nodata: Number.isFinite(nodata) ? nodata : null,
    compression,
    tiled: !!fd.TileOffsets,
    levels,
    fileBytes,
    /** Live byte/request counters for this file (see `doFetch` above). */
    net,
    _tiff: tiff,
  };
}

/**
 * Exact compressed byte counts for a set of tiles, straight from the IFD's
 * TileByteCounts -- which is what makes a raster read-bytes estimate
 * `exact: true` rather than a model. The tag is already in memory after
 * `openRaster`, so this costs no requests.
 * @param {RasterSource} source
 * @param {number} level
 * @param {readonly number[]} tileIndices
 */
export async function tileBytes(source, level, tileIndices) {
  const img = await source._tiff.getImage(level);
  const counts = img.getFileDirectory().TileByteCounts;
  if (!counts) return null;
  let total = 0;
  for (const i of tileIndices) total += Number(counts[i] ?? 0);
  return total;
}
