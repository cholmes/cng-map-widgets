// NOTE: this graduated into packages/raster-core/src/source.js
// (`ensureZstdDecoder`). The copy here keeps the experiment scripts runnable
// against the npm `geotiff` package without the CDN loader.
//
// geotiff.js 2.1.3 has no decoder for TIFF compression 50000 (ZSTD) -- it
// throws `Unknown compression method identifier: 50000` *at read time*, after
// bytes have already been fetched. Several real COGs use it, including the
// user's own ftw/global-data confidence rasters (GDAL's COMPRESS=ZSTD).
//
// zstddec is already a transitive dependency of geotiff (its LERC decoder
// uses it), so registering the missing decoder costs ~20 lines. `addDecoder`
// is a documented public export, so this is a supported extension, not a
// patch. Predictor handling comes free from BaseDecoder.

import { addDecoder, BaseDecoder } from 'geotiff';
import { ZSTDDecoder } from 'zstddec';

const decoder = new ZSTDDecoder();
let ready = null;

class ZstdDecoder extends BaseDecoder {
  async decodeBlock(buffer) {
    if (!ready) ready = decoder.init();
    await ready;
    // zstddec needs an output-size hint; TIFF does not store the
    // uncompressed tile size, so grow geometrically until it fits.
    const input = new Uint8Array(buffer);
    let guess = Math.max(1 << 16, input.length * 8);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return decoder.decode(input, guess).buffer;
      } catch (err) {
        guess *= 4;
        if (attempt === 7) throw err;
      }
    }
    throw new Error('unreachable');
  }
}

/** Call once before reading a ZSTD-compressed GeoTIFF. */
export function registerZstdDecoder() {
  addDecoder(50000, () => ZstdDecoder);
}
