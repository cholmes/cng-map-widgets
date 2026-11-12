// A minimal, dependency-free GeoTIFF writer.
//
// Why not geotiff.js's `writeArrayBuffer`: measured in 02-probe-write.mjs,
// it writes exactly one byte per sample regardless of `BitsPerSample`, so
// uint16 and float32 rasters come out with half/a quarter of their payload
// and GDAL refuses the strip ("got 16 bytes, expected 32"). It also corrupts
// the GeoKeyDirectory as soon as any ASCII geokey (GTCitationGeoKey) or
// ProjLinearUnitsGeoKey is present -- GDAL then reports "GeoTIFF tags
// apparently corrupt, they are being ignored" and the file has no CRS at
// all. 8-bit + exactly {GTModelType, GTRasterType, ProjectedCSType} is the
// only combination that round-trips. Sentinel-2 is uint16, so that is not
// enough, and the writer below is ~200 lines of tag layout.
//
// Scope: classic (32-bit) little-endian TIFF, single IFD, striped, chunky
// (PlanarConfiguration=1), uncompressed or Deflate. No overviews, no tiling:
// the output is a plain GeoTIFF of a small window, not a COG. Non-streaming
// by construction (the IFD offset must be known before the first byte), which
// is why the format plugin declares `streaming: false` and the blob-sink
// ceiling applies.

const TAGS = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  PlanarConfiguration: 284,
  Software: 305,
  SampleFormat: 339,
  ModelPixelScale: 33550,
  ModelTiepoint: 33922,
  GeoKeyDirectory: 34735,
  GeoDoubleParams: 34736,
  GeoAsciiParams: 34737,
  GDAL_NODATA: 42113,
};

const TYPE = { SHORT: 3, LONG: 4, ASCII: 2, DOUBLE: 12 };
const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 12: 8 };

/** @typedef {'uint8'|'int8'|'uint16'|'int16'|'uint32'|'int32'|'float32'|'float64'} Dtype */

/** TIFF SampleFormat + bit width per dtype. */
export const DTYPES = {
  uint8: { bits: 8, format: 1, array: Uint8Array },
  int8: { bits: 8, format: 2, array: Int8Array },
  uint16: { bits: 16, format: 1, array: Uint16Array },
  int16: { bits: 16, format: 2, array: Int16Array },
  uint32: { bits: 32, format: 1, array: Uint32Array },
  int32: { bits: 32, format: 2, array: Int32Array },
  float32: { bits: 32, format: 3, array: Float32Array },
  float64: { bits: 64, format: 3, array: Float64Array },
};

/** @param {ArrayBufferView} a */
export function dtypeOf(a) {
  for (const [name, d] of Object.entries(DTYPES)) if (a instanceof d.array) return name;
  return null;
}

async function deflateChunk(bytes) {
  // TIFF Compression=8 is zlib-wrapped DEFLATE, which is exactly what
  // CompressionStream('deflate') emits (as opposed to 'deflate-raw').
  const cs = new CompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * @param {{
 *   bands: ArrayBufferView[],       // one array per band, row-major, length width*height
 *   width: number,
 *   height: number,
 *   origin: [number, number],       // CRS coords of the UPPER-LEFT corner of the upper-left pixel
 *   pixelSize: [number, number],    // [sx, sy], both positive; sy is applied downward
 *   epsg: number,                   // CRS of origin/pixelSize
 *   citation?: string,
 *   nodata?: number|string|null,
 *   compression?: 'none'|'deflate',
 *   software?: string,
 *   bandNames?: string[],           // written as a GDAL metadata-free TIFFTAG? no: see note
 * }} opts
 * @returns {Promise<Uint8Array>}
 */
export async function writeGeoTiff(opts) {
  const { bands, width, height, origin, pixelSize, epsg } = opts;
  if (!bands.length) throw new Error('writeGeoTiff: no bands');
  const dtype = dtypeOf(bands[0]);
  if (!dtype) throw new Error('writeGeoTiff: unsupported array type');
  for (const b of bands) {
    if (dtypeOf(b) !== dtype) throw new Error('writeGeoTiff: all bands must share one dtype');
    if (b.length !== width * height) throw new Error('writeGeoTiff: band length != width*height');
  }
  const spec = DTYPES[dtype];
  const samples = bands.length;
  const bytesPerSample = spec.bits / 8;
  const compression = opts.compression === 'deflate' ? 8 : 1;

  // --- interleave into chunky strips -----------------------------------
  // ~256 KB of uncompressed payload per strip, at least one row.
  const rowBytes = width * samples * bytesPerSample;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor((256 * 1024) / Math.max(1, rowBytes))));
  const stripCount = Math.ceil(height / rowsPerStrip);
  /** @type {Uint8Array[]} */
  const strips = [];
  for (let s = 0; s < stripCount; s++) {
    const y0 = s * rowsPerStrip;
    const rows = Math.min(rowsPerStrip, height - y0);
    const raw = new spec.array(rows * width * samples);
    if (samples === 1) {
      raw.set(bands[0].subarray(y0 * width, (y0 + rows) * width));
    } else {
      let w = 0;
      for (let y = 0; y < rows; y++) {
        const base = (y0 + y) * width;
        for (let x = 0; x < width; x++) {
          for (let b = 0; b < samples; b++) raw[w++] = bands[b][base + x];
        }
      }
    }
    const asBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    strips.push(compression === 8 ? await deflateChunk(asBytes) : asBytes);
  }

  // --- geokeys ----------------------------------------------------------
  const geographic = isGeographic(epsg);
  /** @type {[number, number, number, number][]} */
  const geoKeys = [];
  const asciiParts = [];
  let asciiLen = 0;
  const pushAscii = (keyId, value) => {
    const text = `${value}|`; // GeoTIFF ASCII params are '|'-terminated
    geoKeys.push([keyId, TAGS.GeoAsciiParams, text.length, asciiLen]);
    asciiParts.push(text);
    asciiLen += text.length;
  };
  geoKeys.push([1024, 0, 1, geographic ? 2 : 1]); // GTModelTypeGeoKey
  geoKeys.push([1025, 0, 1, 1]); // GTRasterTypeGeoKey = PixelIsArea
  if (opts.citation) pushAscii(1026, opts.citation); // GTCitationGeoKey
  if (geographic) {
    geoKeys.push([2048, 0, 1, epsg]); // GeographicTypeGeoKey
    geoKeys.push([2054, 0, 1, 9102]); // GeogAngularUnitsGeoKey = degree
  } else {
    geoKeys.push([3072, 0, 1, epsg]); // ProjectedCSTypeGeoKey
    geoKeys.push([3076, 0, 1, 9001]); // ProjLinearUnitsGeoKey = metre
  }
  geoKeys.sort((a, b) => a[0] - b[0]);
  const geoKeyDirectory = [1, 1, 0, geoKeys.length];
  for (const k of geoKeys) geoKeyDirectory.push(...k);

  // --- entries ----------------------------------------------------------
  /** @type {{tag:number,type:number,values:number[]|string}[]} */
  const entries = [
    { tag: TAGS.ImageWidth, type: TYPE.LONG, values: [width] },
    { tag: TAGS.ImageLength, type: TYPE.LONG, values: [height] },
    { tag: TAGS.BitsPerSample, type: TYPE.SHORT, values: Array(samples).fill(spec.bits) },
    { tag: TAGS.Compression, type: TYPE.SHORT, values: [compression] },
    {
      tag: TAGS.PhotometricInterpretation,
      type: TYPE.SHORT,
      values: [samples >= 3 && dtype === 'uint8' ? 2 : 1],
    },
    { tag: TAGS.StripOffsets, type: TYPE.LONG, values: Array(stripCount).fill(0) }, // patched below
    { tag: TAGS.SamplesPerPixel, type: TYPE.SHORT, values: [samples] },
    { tag: TAGS.RowsPerStrip, type: TYPE.LONG, values: [rowsPerStrip] },
    { tag: TAGS.StripByteCounts, type: TYPE.LONG, values: strips.map((s) => s.byteLength) },
    { tag: TAGS.PlanarConfiguration, type: TYPE.SHORT, values: [1] },
    { tag: TAGS.Software, type: TYPE.ASCII, values: `${opts.software ?? '@cnmw/raster-core'}\0` },
    { tag: TAGS.SampleFormat, type: TYPE.SHORT, values: Array(samples).fill(spec.format) },
    { tag: TAGS.ModelPixelScale, type: TYPE.DOUBLE, values: [pixelSize[0], pixelSize[1], 0] },
    { tag: TAGS.ModelTiepoint, type: TYPE.DOUBLE, values: [0, 0, 0, origin[0], origin[1], 0] },
    { tag: TAGS.GeoKeyDirectory, type: TYPE.SHORT, values: geoKeyDirectory },
  ];
  if (samples > 1 && !(samples >= 3 && dtype === 'uint8')) {
    // Without ExtraSamples, libtiff warns "Sum of Photometric type-related
    // color channels and ExtraSamples doesn't match SamplesPerPixel" on every
    // multi-band MINISBLACK file. 0 = EXTRASAMPLE_UNSPECIFIED, which is what
    // GDAL itself writes for a plain band stack.
    entries.push({ tag: 338, type: TYPE.SHORT, values: Array(samples - 1).fill(0) });
  }
  if (asciiParts.length) {
    entries.push({ tag: TAGS.GeoAsciiParams, type: TYPE.ASCII, values: asciiParts.join('') });
  }
  if (opts.nodata !== undefined && opts.nodata !== null) {
    entries.push({ tag: TAGS.GDAL_NODATA, type: TYPE.ASCII, values: `${opts.nodata}\0` });
  }
  entries.sort((a, b) => a.tag - b.tag); // TIFF requires ascending tag order

  // --- layout -----------------------------------------------------------
  const valueBytes = (e) =>
    typeof e.values === 'string' ? e.values.length : e.values.length * TYPE_SIZE[e.type];
  const ifdSize = 2 + entries.length * 12 + 4;
  let cursor = 8 + ifdSize; // header + IFD
  const overflow = [];
  for (const e of entries) {
    const n = valueBytes(e);
    if (n > 4) {
      if (e.type === TYPE.DOUBLE && cursor % 8 !== 0) cursor += 8 - (cursor % 8); // keep doubles aligned
      e.offset = cursor;
      overflow.push(e);
      cursor += n;
    }
  }
  if (cursor % 2) cursor += 1;
  const stripOffsets = [];
  for (const s of strips) {
    stripOffsets.push(cursor);
    cursor += s.byteLength;
  }
  const total = cursor;
  const stripEntry = entries.find((e) => e.tag === TAGS.StripOffsets);
  stripEntry.values = stripOffsets;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  // header
  out[0] = 0x49;
  out[1] = 0x49; // 'II' little-endian
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true); // first IFD at byte 8
  view.setUint16(8, entries.length, true);
  let p = 10;
  for (const e of entries) {
    const count = typeof e.values === 'string' ? e.values.length : e.values.length;
    view.setUint16(p, e.tag, true);
    view.setUint16(p + 2, e.type, true);
    view.setUint32(p + 4, count, true);
    const n = valueBytes(e);
    if (n > 4) view.setUint32(p + 8, e.offset, true);
    else writeValues(view, out, p + 8, e);
    p += 12;
  }
  view.setUint32(p, 0, true); // no next IFD
  for (const e of overflow) writeValues(view, out, e.offset, e);
  for (let i = 0; i < strips.length; i++) out.set(strips[i], stripOffsets[i]);
  return out;
}

function writeValues(view, out, at, e) {
  if (typeof e.values === 'string') {
    for (let i = 0; i < e.values.length; i++) out[at + i] = e.values.charCodeAt(i) & 0xff;
    return;
  }
  for (let i = 0; i < e.values.length; i++) {
    const v = e.values[i];
    if (e.type === TYPE.SHORT) view.setUint16(at + i * 2, v, true);
    else if (e.type === TYPE.LONG) view.setUint32(at + i * 4, v, true);
    else if (e.type === TYPE.DOUBLE) view.setFloat64(at + i * 8, v, true);
  }
}

function isGeographic(epsg) {
  return epsg === 4326 || epsg === 4269 || epsg === 4979;
}
