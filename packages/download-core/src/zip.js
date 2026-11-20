// @cng/download-core -- CRC-32 and zip64 record builders for the raw
// GeoParquet passthrough zip writer (Task 2 streams these into a sink).
//
// Every entry uses STORE (method 0), zip64 unconditionally (no size-based
// fallback to the classic 32-bit layout), `version needed = 45`, and a data
// descriptor (general-purpose flag bit 3) with 8-byte zip64 sizes -- because
// the destination is a non-seekable WritableStream and sizes are not known
// until the entry has been fully written.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Standard reflected CRC-32 (polynomial 0xEDB88320), streaming-capable:
 * `crc32(b, crc32(a))` equals `crc32(concat(a, b))`.
 * @param {Uint8Array} bytes
 * @param {number} [seed] the CRC-32 returned by a previous call, or 0 to start.
 * @returns {number} unsigned CRC-32
 */
export function crc32(bytes, seed = 0) {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// zip64 extra field (header id 0x0001) for a LOCAL header: just the two
// 8-byte size fields, both zero -- the data descriptor that follows the
// entry's bytes is what actually carries the sizes, since bit 3 is set.
function zip64ExtraLocal() {
  const extra = new Uint8Array(20);
  const dv = new DataView(extra.buffer);
  dv.setUint16(0, 0x0001, true); // zip64 extra header id
  dv.setUint16(2, 16, true); // data size: two 8-byte fields
  dv.setBigUint64(4, 0n, true); // uncompressed size (placeholder)
  dv.setBigUint64(12, 0n, true); // compressed size (placeholder)
  return extra;
}

// zip64 extra field (header id 0x0001) for a CENTRAL header: the sizes AND
// the relative offset of the local header, since all three 32-bit fields in
// the fixed part are unconditionally set to 0xffffffff.
function zip64ExtraCentral(size, offset) {
  const extra = new Uint8Array(28);
  const dv = new DataView(extra.buffer);
  dv.setUint16(0, 0x0001, true);
  dv.setUint16(2, 24, true); // data size: three 8-byte fields
  dv.setBigUint64(4, BigInt(size), true); // uncompressed size
  dv.setBigUint64(12, BigInt(size), true); // compressed size
  dv.setBigUint64(20, BigInt(offset), true); // relative offset of local header
  return extra;
}

/**
 * A zip64 local file header. No sizes are known yet -- they are deferred to
 * the data descriptor written right after the entry's bytes.
 * @param {{ name: string, flags?: number }} opts
 * @returns {Uint8Array}
 */
export function localHeader({ name, flags = 0 }) {
  const nameBytes = new TextEncoder().encode(name);
  const extra = zip64ExtraLocal();
  const buf = new Uint8Array(30 + nameBytes.length + extra.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x04034b50, true); // local file header signature
  dv.setUint16(4, 45, true); // version needed to extract (zip64)
  dv.setUint16(6, (flags | 0x08) & 0xffff, true); // bit 3: sizes follow in a descriptor
  dv.setUint16(8, 0, true); // compression method: STORE
  dv.setUint16(10, 0, true); // last mod file time
  dv.setUint16(12, 0x21, true); // last mod file date: 1980-01-01
  dv.setUint32(14, 0, true); // crc-32: deferred to the data descriptor
  dv.setUint32(18, 0xffffffff, true); // compressed size: deferred to zip64
  dv.setUint32(22, 0xffffffff, true); // uncompressed size: deferred to zip64
  dv.setUint16(26, nameBytes.length, true);
  dv.setUint16(28, extra.length, true);
  buf.set(nameBytes, 30);
  buf.set(extra, 30 + nameBytes.length);
  return buf;
}

/**
 * A zip64 data descriptor (with its optional signature), 8-byte sizes.
 * STORE means compressed size === uncompressed size, so one `size` covers
 * both.
 * @param {{ crc: number, size: number }} opts
 * @returns {Uint8Array}
 */
export function dataDescriptor({ crc, size }) {
  const buf = new Uint8Array(24);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x08074b50, true); // data descriptor signature
  dv.setUint32(4, crc >>> 0, true);
  dv.setBigUint64(8, BigInt(size), true); // compressed size
  dv.setBigUint64(16, BigInt(size), true); // uncompressed size
  return buf;
}

/**
 * A zip64 central directory header for one entry.
 * @param {{ name: string, crc: number, size: number, offset: number }} opts
 *   `offset` is the byte offset of this entry's local header from the start
 *   of the archive.
 * @returns {Uint8Array}
 */
export function centralHeader({ name, crc, size, offset }) {
  const nameBytes = new TextEncoder().encode(name);
  const extra = zip64ExtraCentral(size, offset);
  const buf = new Uint8Array(46 + nameBytes.length + extra.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x02014b50, true); // central file header signature
  dv.setUint16(4, 45, true); // version made by (zip64)
  dv.setUint16(6, 45, true); // version needed to extract (zip64)
  dv.setUint16(8, 0x08, true); // general purpose bit flag: bit 3
  dv.setUint16(10, 0, true); // compression method: STORE
  dv.setUint16(12, 0, true); // last mod file time
  dv.setUint16(14, 0x21, true); // last mod file date: 1980-01-01
  dv.setUint32(16, crc >>> 0, true);
  dv.setUint32(20, 0xffffffff, true); // compressed size: deferred to zip64
  dv.setUint32(24, 0xffffffff, true); // uncompressed size: deferred to zip64
  dv.setUint16(28, nameBytes.length, true);
  dv.setUint16(30, extra.length, true);
  dv.setUint16(32, 0, true); // file comment length
  dv.setUint16(34, 0, true); // disk number start
  dv.setUint16(36, 0, true); // internal file attributes
  dv.setUint32(38, 0, true); // external file attributes
  dv.setUint32(42, 0xffffffff, true); // relative offset of local header: deferred to zip64
  buf.set(nameBytes, 46);
  buf.set(extra, 46 + nameBytes.length);
  return buf;
}

/**
 * The zip64 end-of-central-directory record, its locator, and the legacy
 * EOCD record that points readers at the zip64 record above it -- all three
 * concatenated into one block, in that order, as they are written to the
 * stream.
 * @param {{ entryCount: number, centralSize: number, centralOffset: number }} opts
 * @returns {Uint8Array}
 */
export function endOfCentralDirectory({ entryCount, centralSize, centralOffset }) {
  const record = new Uint8Array(56);
  {
    const dv = new DataView(record.buffer);
    dv.setUint32(0, 0x06064b50, true); // zip64 end of central directory signature
    dv.setBigUint64(4, 44n, true); // size of this record, excluding the leading 12 bytes
    dv.setUint16(12, 45, true); // version made by
    dv.setUint16(14, 45, true); // version needed to extract
    dv.setUint32(16, 0, true); // number of this disk
    dv.setUint32(20, 0, true); // disk with the start of the central directory
    dv.setBigUint64(24, BigInt(entryCount), true); // entries on this disk
    dv.setBigUint64(32, BigInt(entryCount), true); // total entries
    dv.setBigUint64(40, BigInt(centralSize), true); // size of the central directory
    dv.setBigUint64(48, BigInt(centralOffset), true); // offset of the start of the central directory
  }

  const locator = new Uint8Array(20);
  {
    const dv = new DataView(locator.buffer);
    dv.setUint32(0, 0x07064b50, true); // zip64 EOCD locator signature
    dv.setUint32(4, 0, true); // disk with the start of the zip64 EOCD record
    dv.setBigUint64(8, BigInt(centralOffset) + BigInt(centralSize), true); // offset of the zip64 EOCD record
    dv.setUint32(16, 1, true); // total number of disks
  }

  const legacy = new Uint8Array(22);
  {
    const dv = new DataView(legacy.buffer);
    dv.setUint32(0, 0x06054b50, true); // end of central directory signature
    dv.setUint16(4, 0xffff, true); // number of this disk: zip64 sentinel
    dv.setUint16(6, 0xffff, true); // disk with the start of the central directory: zip64 sentinel
    dv.setUint16(8, 0xffff, true); // entries on this disk: zip64 sentinel
    dv.setUint16(10, 0xffff, true); // total entries: zip64 sentinel
    dv.setUint32(12, 0xffffffff, true); // size of central directory: zip64 sentinel
    dv.setUint32(16, 0xffffffff, true); // offset of start of central directory: zip64 sentinel
    dv.setUint16(20, 0, true); // comment length
  }

  const out = new Uint8Array(record.length + locator.length + legacy.length);
  out.set(record, 0);
  out.set(locator, record.length);
  out.set(legacy, record.length + locator.length);
  return out;
}

// Fallback for an input that sanitizes to nothing at all (e.g. '/', '..',
// '////', '../..') -- these come from partition metadata in the raw
// passthrough path, so one bad name must not corrupt the entry (a
// zero-length name is malformed to most zip readers) or abort an
// otherwise-fine multi-file download. It is deterministic, so repeated
// occurrences fall through the same collision-suffix logic below.
const EMPTY_NAME_PLACEHOLDER = 'entry';

/**
 * Turn an arbitrary entry path into a safe, unique zip entry name: split on
 * both `/` and `\`, drop `.`, `..` and empty segments (which also strips any
 * leading separator, since splitting on it yields a leading empty segment),
 * then join with `/`. An input with nothing left after that (e.g. '/', '..')
 * becomes `EMPTY_NAME_PLACEHOLDER` rather than a zero-length name. If the
 * result collides with a name already in `taken`, append `-1`, `-2`, ...
 * before the last extension until it does not. `taken` is mutated: the
 * returned name is added to it.
 * @param {string} name
 * @param {Set<string>} taken names already used in this archive
 * @returns {string}
 */
export function sanitizeEntryName(name, taken) {
  const segments = name.split(/[\\/]+/).filter((seg) => seg !== '' && seg !== '.' && seg !== '..');
  const clean = segments.join('/') || EMPTY_NAME_PLACEHOLDER;

  if (!taken.has(clean)) {
    taken.add(clean);
    return clean;
  }

  const lastSlash = clean.lastIndexOf('/');
  const dir = lastSlash >= 0 ? clean.slice(0, lastSlash + 1) : '';
  const base = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
  const dotIndex = base.lastIndexOf('.');
  const stem = dotIndex > 0 ? base.slice(0, dotIndex) : base;
  const ext = dotIndex > 0 ? base.slice(dotIndex) : '';

  let n = 1;
  let candidate;
  do {
    candidate = `${dir}${stem}-${n}${ext}`;
    n++;
  } while (taken.has(candidate));
  taken.add(candidate);
  return candidate;
}

/**
 * A streaming zip64 writer over a non-seekable `WritableStreamDefaultWriter`.
 * Entries are written in call order; nothing is buffered -- each chunk of
 * an entry's `AsyncIterable` is written straight through to `writer` as it
 * arrives, folding it into a running CRC-32 and byte count, so no header is
 * ever rewritten (sizes go out in the trailing data descriptor instead).
 * @param {WritableStreamDefaultWriter<Uint8Array>} writer
 */
export function createZipWriter(writer) {
  const taken = new Set();
  /** @type {{ name: string, crc: number, size: number, offset: number }[]} */
  const central = [];
  let offset = 0;
  let closed = false;

  async function writeBytes(bytes) {
    await writer.write(bytes);
    offset += bytes.byteLength;
  }

  /**
   * @param {string} name
   * @param {AsyncIterable<Uint8Array>} chunks
   * @returns {Promise<{ name: string, bytes: number }>}
   */
  async function addEntry(name, chunks) {
    if (closed) {
      throw new Error('createZipWriter: addEntry() called after close()');
    }
    const entryName = sanitizeEntryName(name, taken);
    const entryOffset = offset;
    await writeBytes(localHeader({ name: entryName }));

    let crc = 0;
    let size = 0;
    for await (const chunk of chunks) {
      crc = crc32(chunk, crc);
      size += chunk.byteLength;
      await writeBytes(chunk);
    }

    await writeBytes(dataDescriptor({ crc, size }));
    central.push({ name: entryName, crc, size, offset: entryOffset });
    return { name: entryName, bytes: size };
  }

  /**
   * @param {string} name
   * @param {Uint8Array} bytes
   * @returns {Promise<{ name: string, bytes: number }>}
   */
  async function addFile(name, bytes) {
    async function* single() {
      yield bytes;
    }
    return addEntry(name, single());
  }

  /** @returns {Promise<{ bytes: number, entries: number }>} */
  async function close() {
    if (closed) {
      throw new Error('createZipWriter: close() called twice');
    }
    closed = true;
    const centralOffset = offset;
    for (const entry of central) {
      await writeBytes(centralHeader(entry));
    }
    const centralSize = offset - centralOffset;
    await writeBytes(endOfCentralDirectory({ entryCount: central.length, centralSize, centralOffset }));
    return { bytes: offset, entries: central.length };
  }

  return { addEntry, addFile, close };
}
