import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, localHeader, dataDescriptor, centralHeader, endOfCentralDirectory } from '../src/zip.js';

test('crc32 matches the published check value', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(bytes), 0xcbf43926);
});

test('crc32 is streaming: folding in two halves equals folding at once', () => {
  const all = new TextEncoder().encode('the quick brown fox');
  const a = all.subarray(0, 9);
  const b = all.subarray(9);
  assert.equal(crc32(b, crc32(a)), crc32(all));
});

test('localHeader sets the zip64 version, the data-descriptor flag and STORE', () => {
  const h = localHeader({ name: 'a/b.parquet' });
  const dv = new DataView(h.buffer, h.byteOffset);
  assert.equal(dv.getUint32(0, true), 0x04034b50); // local file header signature
  assert.equal(dv.getUint16(4, true), 45); // version needed = zip64
  assert.equal(dv.getUint16(6, true) & 0x08, 0x08); // bit 3: sizes follow in a descriptor
  assert.equal(dv.getUint16(8, true), 0); // method 0 = STORE
  assert.equal(dv.getUint32(18, true), 0xffffffff); // compressed size deferred to zip64
});

test('dataDescriptor writes 8-byte zip64 sizes', () => {
  const d = dataDescriptor({ crc: 0xcbf43926, size: 5_000_000_000 });
  const dv = new DataView(d.buffer, d.byteOffset);
  assert.equal(dv.getUint32(0, true), 0x08074b50);
  assert.equal(dv.getUint32(4, true), 0xcbf43926);
  assert.equal(dv.getBigUint64(8, true), 5_000_000_000n); // compressed
  assert.equal(dv.getBigUint64(16, true), 5_000_000_000n); // uncompressed
});

test('endOfCentralDirectory emits the zip64 record, its locator, and the legacy EOCD', () => {
  const e = endOfCentralDirectory({ entryCount: 3, centralSize: 300, centralOffset: 9_000_000_000 });
  const dv = new DataView(e.buffer, e.byteOffset);
  assert.equal(dv.getUint32(0, true), 0x06064b50); // zip64 EOCD record
  const locatorAt = Number(dv.getBigUint64(4, true)) + 12;
  assert.equal(dv.getUint32(locatorAt, true), 0x07064b50); // zip64 EOCD locator
});
