#!/usr/bin/env node
// Opt-in, not run by `npm test`: writes a real >4 GiB zip archive (past the
// classic 32-bit size/offset limits that zip64 exists to lift) to a temp
// file and asserts Python's `zipfile` -- an independent reader -- lists
// both entries with the exact sizes written. `node --test`'s normal run
// does not reach this: it is slow and disk-hungry, so it is run by hand.
//
// Usage: node packages/download-core/test/zip-large.verify.mjs

import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZipWriter } from '../src/zip.js';

const CHUNK_SIZE = 16 * 1024 * 1024;
const ENTRY_SIZES = [2_200_000_000, 2_200_000_000]; // sum > 4 GiB (4_294_967_296)

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
  console.log(`${cond ? 'ok' : 'FAIL'} - ${msg}`);
}

/** A writer backed by a real file on disk, driven through a WritableStream like any sink. */
function fileWriter(path) {
  const fileStream = createWriteStream(path);
  const stream = new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        fileStream.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        fileStream.end((err) => (err ? reject(err) : resolve()));
      });
    },
  });
  return stream.getWriter();
}

/** Yields `total` synthetic bytes as reused `CHUNK_SIZE` chunks, so memory stays flat. */
async function* syntheticChunks(total) {
  const chunk = new Uint8Array(CHUNK_SIZE);
  for (let i = 0; i < chunk.length; i++) chunk[i] = i & 0xff;
  let remaining = total;
  while (remaining > 0) {
    const n = Math.min(CHUNK_SIZE, remaining);
    yield n === chunk.length ? chunk : chunk.subarray(0, n);
    remaining -= n;
  }
}

const PY_SIZES_SCRIPT = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
sizes = {info.filename: info.file_size for info in z.infolist()}
# testzip() reads and CRC-checks every entry's full contents, not just the
# recorded sizes -- the thing item 7 (whole-branch review) found missing:
# a correct size with a wrong/absent CRC-32 at zip64 scale would have
# passed the old verifier silently. Returns the name of the first bad
# entry, or None when every entry's CRC checks out.
bad = z.testzip()
print(json.dumps({'sizes': sizes, 'bad': bad}))
`;

/** @returns {boolean} */
function hasUnzip() {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'zip-large-verify-'));
  const archivePath = join(dir, 'large.zip');
  try {
    console.log(`writing ${archivePath} (target ${(ENTRY_SIZES.reduce((a, b) => a + b, 0) / 1024 ** 3).toFixed(2)} GiB)...`);
    const writer = fileWriter(archivePath);
    const zip = createZipWriter(writer);

    const names = [];
    for (let i = 0; i < ENTRY_SIZES.length; i++) {
      const name = `part-${i}.parquet`;
      const result = await zip.addEntry(name, syntheticChunks(ENTRY_SIZES[i]));
      check(result.bytes === ENTRY_SIZES[i], `entry ${name}: addEntry reported ${result.bytes} bytes (expected ${ENTRY_SIZES[i]})`);
      names.push(name);
    }

    const closeResult = await zip.close();
    await writer.close();

    const onDisk = statSync(archivePath).size;
    check(closeResult.bytes === onDisk, `close() reported ${closeResult.bytes} bytes; file on disk is ${onDisk}`);
    check(onDisk > 4 * 1024 ** 3, `archive exceeds 4 GiB (got ${onDisk} bytes)`);

    console.log('reading back sizes and CRC-checking every entry via python zipfile.testzip() (slow at this scale)...');
    const out = execFileSync('python3', ['-I', '-c', PY_SIZES_SCRIPT, archivePath], { encoding: 'utf8' });
    const { sizes, bad } = JSON.parse(out);
    for (let i = 0; i < ENTRY_SIZES.length; i++) {
      check(sizes[names[i]] === ENTRY_SIZES[i], `python zipfile reports ${names[i]} as ${sizes[names[i]]} bytes (expected ${ENTRY_SIZES[i]})`);
    }
    check(bad === null, `python zipfile.testzip() found a bad entry: ${bad} (expected null -- every CRC-32 checks out)`);

    // Anti-goal (design doc §4): "readable by unzip, macOS Archive
    // Utility, and Python zipfile." `unzip -t` is a SECOND, independent
    // reader -- it has its own zip64 parser, distinct from Python's --
    // and exercises CRC + zip64 field widths against it. Skipped
    // gracefully, not failed, when `unzip` isn't on PATH.
    if (hasUnzip()) {
      console.log('running `unzip -t` (slow at this scale)...');
      const unzipOut = execFileSync('unzip', ['-t', archivePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      check(/No errors detected/.test(unzipOut), `unzip -t reported errors:\n${unzipOut}`);
    } else {
      console.log('skip - unzip not on PATH, skipping the second-reader check');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll zip-large checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
