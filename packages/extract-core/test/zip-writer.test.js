// Round-trips a streamed zip through two independent readers (Python's
// `zipfile` and, when present, the `unzip` CLI) because `centralHeader`
// (Task 1) has no direct byte-layout assertion anywhere -- these are what
// actually exercise it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZipWriter, sanitizeEntryName } from '../src/zip.js';

function hasUnzip() {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A WritableStream + getWriter() pair that just appends every chunk written. */
function collectingWriter() {
  const chunks = [];
  const stream = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  return { chunks, writer: stream.getWriter() };
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Yields `parts` one at a time -- an AsyncIterable, not an array, to exercise addEntry's streaming contract. */
async function* asyncChunks(parts) {
  for (const p of parts) yield p;
}

function withTempZip(bytes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zip-writer-test-'));
  const path = join(dir, 'archive.zip');
  writeFileSync(path, bytes);
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PY_READ_SCRIPT = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
contents = {n: z.read(n).decode('utf-8') for n in names}
bad = z.testzip()
print(json.dumps({'names': names, 'contents': contents, 'bad': bad}))
`;

function readZipWithPython(path) {
  const out = execFileSync('python3', ['-I', '-c', PY_READ_SCRIPT, path], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('a two-entry archive round-trips through python zipfile', async () => {
  const { chunks, writer } = collectingWriter();
  const zip = createZipWriter(writer);

  await zip.addFile('a/one.parquet', new TextEncoder().encode('one-contents'));
  await zip.addEntry('b/two.parquet', asyncChunks([new TextEncoder().encode('two-'), new TextEncoder().encode('contents-longer')]));

  await zip.close();
  await writer.close();

  withTempZip(concatChunks(chunks), (path) => {
    const result = readZipWithPython(path);
    assert.deepEqual(result.names.sort(), ['a/one.parquet', 'b/two.parquet']);
    assert.equal(result.contents['a/one.parquet'], 'one-contents');
    assert.equal(result.contents['b/two.parquet'], 'two-contents-longer');
    assert.equal(result.bad, null); // testzip() returns null when every entry's CRC checks out
  });
});

test('entry names preserve hive partition directories', async () => {
  const { chunks, writer } = collectingWriter();
  const zip = createZipWriter(writer);

  const result = await zip.addFile('acq_date=2026-09-01/part-0.parquet', new TextEncoder().encode('row-bytes'));
  assert.equal(result.name, 'acq_date=2026-09-01/part-0.parquet');

  await zip.close();
  await writer.close();

  withTempZip(concatChunks(chunks), (path) => {
    const read = readZipWithPython(path);
    assert.deepEqual(read.names, ['acq_date=2026-09-01/part-0.parquet']);
    assert.equal(read.contents['acq_date=2026-09-01/part-0.parquet'], 'row-bytes');
  });
});

// Whole-branch review item 4 (Important): entry names are written as UTF-8
// (`TextEncoder`), but general-purpose bit 11 ("names are UTF-8") was only
// ever set, so a conforming reader falls back to CP437 and mojibakes any
// non-ASCII name. Not hypothetical: raw entry names come straight off URL
// paths, and the FTW catalog this repo targets names files after
// countries -- "Côte d'Ivoire.parquet", "Türkiye.parquet",
// "Åland Islands.parquet". No prior fixture is non-ASCII, so nothing
// caught this. Python's `zipfile` itself decodes a name as UTF-8 only when
// bit 11 is set (otherwise cp437), so this test discriminates: it fails
// against the pre-fix header (bit 11 unset) because Python would then
// decode the bytes as cp437, producing a different string.
test('a non-ASCII entry name survives a round trip through python zipfile (UTF-8 flag, bit 11)', async () => {
  const { chunks, writer } = collectingWriter();
  const zip = createZipWriter(writer);

  const names = ["Côte d'Ivoire.parquet", 'Türkiye.parquet', 'Åland Islands.parquet'];
  for (const name of names) {
    await zip.addFile(name, new TextEncoder().encode(`contents of ${name}`));
  }
  await zip.close();
  await writer.close();

  withTempZip(concatChunks(chunks), (path) => {
    const result = readZipWithPython(path);
    assert.deepEqual(result.names.sort(), names.slice().sort());
    for (const name of names) {
      assert.equal(result.contents[name], `contents of ${name}`);
    }
    assert.equal(result.bad, null);
  });
});

test('sanitizeEntryName strips traversal and absolute paths', () => {
  const taken = new Set();
  assert.equal(sanitizeEntryName('../../etc/passwd', taken), 'etc/passwd');
  assert.equal(sanitizeEntryName('/abs/x.parquet', taken), 'abs/x.parquet');
  assert.equal(sanitizeEntryName('a\\b.parquet', taken), 'a/b.parquet');
});

test('sanitizeEntryName falls back to a placeholder instead of a zero-length name', () => {
  const taken = new Set();
  assert.equal(sanitizeEntryName('/', taken), 'entry');
  assert.equal(sanitizeEntryName('..', taken), 'entry-1'); // also sanitizes to '', collides with the first
  assert.equal(sanitizeEntryName('////', taken), 'entry-2'); // ditto
});

test('sanitizeEntryName suffixes a colliding name instead of overwriting', () => {
  const taken = new Set();
  assert.equal(sanitizeEntryName('part-0.parquet', taken), 'part-0.parquet');
  assert.equal(sanitizeEntryName('part-0.parquet', taken), 'part-0-1.parquet');
});

test('close() reports the total bytes written and the entry count', async () => {
  const { chunks, writer } = collectingWriter();
  const zip = createZipWriter(writer);

  await zip.addFile('one.parquet', new Uint8Array([1, 2, 3]));
  await zip.addFile('two.parquet', new Uint8Array([4, 5]));
  const result = await zip.close();
  await writer.close();

  assert.equal(result.entries, 2);
  assert.equal(result.bytes, concatChunks(chunks).byteLength);
});

test('addEntry() after close() throws instead of corrupting the already-written central directory', async () => {
  const { writer } = collectingWriter();
  const zip = createZipWriter(writer);
  await zip.addFile('one.parquet', new Uint8Array([1]));
  await zip.close();

  await assert.rejects(() => zip.addFile('two.parquet', new Uint8Array([2])), /addEntry\(\) called after close\(\)/);
  await writer.close();
});

test('close() called twice throws rather than writing a second central directory', async () => {
  const { writer } = collectingWriter();
  const zip = createZipWriter(writer);
  await zip.addFile('one.parquet', new Uint8Array([1]));
  await zip.close();

  await assert.rejects(() => zip.close(), /close\(\) called twice/);
  await writer.close();
});

test('unzip -t reports no errors', { skip: hasUnzip() ? false : 'unzip not on PATH' }, async () => {
  const { chunks, writer } = collectingWriter();
  const zip = createZipWriter(writer);

  await zip.addFile('a/one.parquet', new TextEncoder().encode('one-contents'));
  await zip.addFile('b/two.parquet', new TextEncoder().encode('two-contents-longer'));
  await zip.close();
  await writer.close();

  withTempZip(concatChunks(chunks), (path) => {
    const out = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
    assert.match(out, /No errors detected/);
  });
});
