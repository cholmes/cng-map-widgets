// @cngeo/format-shapefile -- minimal STORED-only (uncompressed) ZIP writer.
// Zero dependencies, on purpose: a Shapefile is five sibling files
// (.shp/.shx/.dbf/.prj/.cpg), and extract-core's Sink is one
// WritableStream for one file, so this package bundles them into a single
// `.shp.zip` -- the container GDAL/ogr2ogr and QGIS open directly (no
// manual unzip step), the same choice the terrio-js probe in
// experiments/e10-heavy-formats/RESULTS.md independently made. Pulling in
// `jszip` (measured: 37KB gzip) for five tiny already-in-memory buffers
// with no compression needed would be the one dependency this package
// otherwise has zero reason to carry.

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value, true); }

/**
 * @param {{ name: string, data: Uint8Array }[]} files
 * @returns {Uint8Array} a valid ZIP archive, STORED (uncompressed) entries
 */
export function writeZipStored(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const centralEntries = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20); // version needed
    u16(lv, 6, 0); // flags
    u16(lv, 8, 0); // method: stored
    u16(lv, 10, 0); // mod time
    u16(lv, 12, 0x21); // mod date (a fixed, valid DOS date: 1980-01-01)
    u32(lv, 14, crc);
    u32(lv, 18, file.data.length);
    u32(lv, 22, file.data.length);
    u16(lv, 26, nameBytes.length);
    u16(lv, 28, 0); // extra field length
    local.set(nameBytes, 30);

    parts.push(local, file.data);
    centralEntries.push({ nameBytes, crc, size: file.data.length, offset });
    offset += local.length + file.data.length;
  }

  const centralDirStart = offset;
  for (const e of centralEntries) {
    const central = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(central.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, 20); // version made by
    u16(cv, 6, 20); // version needed
    u16(cv, 8, 0); // flags
    u16(cv, 10, 0); // method
    u16(cv, 12, 0); // mod time
    u16(cv, 14, 0x21); // mod date
    u32(cv, 16, e.crc);
    u32(cv, 20, e.size);
    u32(cv, 24, e.size);
    u16(cv, 28, e.nameBytes.length);
    u16(cv, 30, 0); // extra length
    u16(cv, 32, 0); // comment length
    u16(cv, 34, 0); // disk number start
    u16(cv, 36, 0); // internal attrs
    u32(cv, 38, 0); // external attrs
    u32(cv, 42, e.offset);
    central.set(e.nameBytes, 46);
    parts.push(central);
    offset += central.length;
  }
  const centralDirSize = offset - centralDirStart;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 4, 0); // disk number
  u16(ev, 6, 0); // disk with central dir
  u16(ev, 8, centralEntries.length);
  u16(ev, 10, centralEntries.length);
  u32(ev, 12, centralDirSize);
  u32(ev, 16, centralDirStart);
  u16(ev, 20, 0); // comment length
  parts.push(eocd);

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
