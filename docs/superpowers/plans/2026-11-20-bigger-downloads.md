# Bigger Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users download complete GeoParquet partitions or datasets as the original bytes (one file verbatim, many as a zip), and make every download's size ceiling derive from what the chosen format and sink actually cost instead of one flat number.

**Architecture:** A new passthrough branch inside `download()` copies object-storage bytes straight to the sink, using only the whole-file stages of the existing partition pruning and never touching hyparquet. A new in-repo streaming zip64 writer handles the multi-file case over a non-seekable sink. `defaultCeiling()`'s flat numbers are replaced by `effectiveCeiling({format, sink})`, driven by a new optional `memoryFactor` capability on each format plugin. Separately, `@cng/format-gpkg` stops holding every row in JS, which lifts its own (still memory-bound) ceiling.

**Tech Stack:** Plain ESM, no build step, no new runtime dependencies. Node 22 `node --test`. hyparquet 1.33.0 / hyparquet-compressors 1.1.3 / hyparquet-writer 0.18.0 (unchanged). sql.js (existing devDependency) for `@cng/format-gpkg`.

**Spec:** [`docs/superpowers/specs/2026-11-20-bigger-downloads-design.md`](../specs/2026-11-20-bigger-downloads-design.md)

## Global Constraints

- No new runtime dependency, and no bare-specifier imports. Any third-party code loads from a pinned absolute CDN URL via a package's `src/cdn.js` (AGENTS.md §Setup).
- Error **codes** are the public API; messages are not. No existing code may change meaning. New codes only.
- `download()`'s existing contract is unchanged and all additions are additive: synchronous return, `handle.estimate`, `handle.result`, `CEILING_EXCEEDED` + `acceptCeiling()`, the event names.
- `blobSink`'s 256 MiB cap stays. `memorySink` is exempt from the *sink-side* cap — but ONLY for a format with `memoryFactor === 0`. A buffering format is `memoryBudget / memoryFactor` **regardless of sink**, memorySink included, because the format's buffering cost is spent inside the writer and is the same wherever the bytes land. (Corrected 2026-11-20, pre-flight ruling R5: the original wording said "exempt from `memoryBudget` entirely", which made gpkg unbounded on a memorySink — spec anti-goal §4.1.)
- `memoryBudget` default is **1 GiB**. `largeDownloadBytes` default is **1 GiB**. `slow-download` threshold is **120 seconds**. Default assumed throughput is **10 MB/s** (`options.throughputBytesPerSecond`).
- Flat ceiling defaults become: `rows` 50,000,000; `readBytes` 64 GiB; `files` 10,000. `blobBytes` stays 256 MiB.
- `memoryFactor` defaults: `0` when `streaming === true`, `3` otherwise. Declared: `geojson` 0, `parquet-raw` 0, `geoparquet` 2, `gpkg` **measured, not guessed**.
- Zip entries use STORE (method 0) only, zip64 unconditionally, `version needed = 45`, data descriptors (general-purpose flag bit 3) with 8-byte sizes.
- A single-file raw download is **never** wrapped in a zip, share-alike or not (spec §7.1).
- `raw-size-unknown` and `raw-no-pruning` **warn and proceed**; they are never ceiling breaches and never refuse (spec §7.5).
- Baseline: 4 tests in `packages/raster-core/test/geotiff-writer.test.js` fail before this work starts and are out of scope. `npm test` must end at exactly those 4 failures, never more.

## Review Focus

Input classes the spec implies but no task's happy-path tests exercise. Each has its test assigned to the task that owns the code.

1. **A part URL fails mid-zip** (404/500/network drop on file 5 of 27). A partial zip must never commit as success — `sink.abort()` must run and `handle.result` must reject. → Task 7.
2. **Entry names that are unsafe or collide.** A part path containing `..`, a leading `/`, or a backslash must not extract outside the target directory (zip slip); two parts sharing a basename must not silently overwrite each other. → Task 2.
3. **An area crossing the antimeridian.** Part pruning must test both boxes of `area.bboxes`, never the signed `area.bbox` (AGENTS.md pitfall 6), or Fiji and Russia select the wrong files. → Task 6.
4. **Zero parts selected.** An area matching nothing must fail with a clear code before any fetch, not write a zip containing only `ATTRIBUTION.txt`. → Task 6.
5. **A server whose actual bytes disagree with the declared size** (gzip transfer-encoding, a truncated response, a stale `file_size` in the collection mirror). The zip's data descriptors must record what was actually written, and the result must report actual bytes, not the estimate. → Task 7.

---

### Task 1: CRC-32 and the zip64 local/central record layout

**Files:**
- Create: `packages/download-core/src/zip.js`
- Test: `packages/download-core/test/zip-records.test.js`

**Interfaces:**
- Produces: `crc32(bytes: Uint8Array, seed?: number): number` — streaming-capable, returns the unsigned CRC-32 after folding `bytes` into `seed` (seed defaults to 0). `localHeader({ name, flags }): Uint8Array`, `dataDescriptor({ crc, size }): Uint8Array`, `centralHeader({ name, crc, size, offset }): Uint8Array`, `endOfCentralDirectory({ entryCount, centralSize, centralOffset }): Uint8Array`. All little-endian; all zip64.

- [ ] **Step 1: Write the failing tests**

```js
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
  assert.equal(dv.getUint32(0, true), 0x04034b50);  // local file header signature
  assert.equal(dv.getUint16(4, true), 45);          // version needed = zip64
  assert.equal(dv.getUint16(6, true) & 0x08, 0x08); // bit 3: sizes follow in a descriptor
  assert.equal(dv.getUint16(8, true), 0);           // method 0 = STORE
  assert.equal(dv.getUint32(18, true), 0xffffffff); // compressed size deferred to zip64
});

test('dataDescriptor writes 8-byte zip64 sizes', () => {
  const d = dataDescriptor({ crc: 0xcbf43926, size: 5_000_000_000 });
  const dv = new DataView(d.buffer, d.byteOffset);
  assert.equal(dv.getUint32(0, true), 0x08074b50);
  assert.equal(dv.getUint32(4, true), 0xcbf43926);
  assert.equal(dv.getBigUint64(8, true), 5_000_000_000n);  // compressed
  assert.equal(dv.getBigUint64(16, true), 5_000_000_000n); // uncompressed
});

test('endOfCentralDirectory emits the zip64 record, its locator, and the legacy EOCD', () => {
  const e = endOfCentralDirectory({ entryCount: 3, centralSize: 300, centralOffset: 9_000_000_000 });
  const dv = new DataView(e.buffer, e.byteOffset);
  assert.equal(dv.getUint32(0, true), 0x06064b50);   // zip64 EOCD record
  const locatorAt = Number(dv.getBigUint64(4, true)) + 12;
  assert.equal(dv.getUint32(locatorAt, true), 0x07064b50); // zip64 EOCD locator
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/download-core/test/zip-records.test.js`
Expected: FAIL — `zip.js` does not exist.

- [ ] **Step 3: Implement `crc32` and the four record builders in `packages/download-core/src/zip.js`**

`crc32` uses the standard reflected table (polynomial `0xEDB88320`), table built once at module load. Every record builder returns a fresh `Uint8Array` and writes the zip64 extra field (header id `0x0001`) on local and central headers, with the 32-bit size fields set to `0xffffffff`. The legacy EOCD that follows the zip64 locator carries `0xffff`/`0xffffffff` sentinels so readers that understand zip64 use the records above it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test packages/download-core/test/zip-records.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/download-core/src/zip.js packages/download-core/test/zip-records.test.js
git commit -m "feat(download-core): crc32 and zip64 record builders"
```

---

### Task 2: The streaming zip writer

**Files:**
- Modify: `packages/download-core/src/zip.js`
- Test: `packages/download-core/test/zip-writer.test.js`
- Test: `packages/download-core/test/zip-large.verify.mjs` (opt-in, not in `npm test`)

**Interfaces:**
- Consumes: Task 1's record builders.
- Produces: `createZipWriter(writer: WritableStreamDefaultWriter<Uint8Array>): { addEntry(name: string, chunks: AsyncIterable<Uint8Array>): Promise<{ name: string, bytes: number }>, addFile(name: string, bytes: Uint8Array): Promise<{ name: string, bytes: number }>, close(): Promise<{ bytes: number, entries: number }> }`. Entries are written in call order; `close()` writes the central directory. `sanitizeEntryName(name: string, taken: Set<string>): string` is exported for its own tests.

- [ ] **Step 1: Write the failing tests**

```js
// Round-trip through Python's zipfile, which is an independent reader.
test('a two-entry archive round-trips through python zipfile', async () => { /* write a/one.parquet + b/two.parquet, assert namelist and contents via python3 -c */ });

test('entry names preserve hive partition directories', async () => { /* 'acq_date=2026-09-01/part-0.parquet' survives verbatim */ });

test('sanitizeEntryName strips traversal and absolute paths', () => {
  const taken = new Set();
  assert.equal(sanitizeEntryName('../../etc/passwd', taken), 'etc/passwd');
  assert.equal(sanitizeEntryName('/abs/x.parquet', taken), 'abs/x.parquet');
  assert.equal(sanitizeEntryName('a\\b.parquet', taken), 'a/b.parquet');
});

test('sanitizeEntryName suffixes a colliding name instead of overwriting', () => {
  const taken = new Set();
  assert.equal(sanitizeEntryName('part-0.parquet', taken), 'part-0.parquet');
  assert.equal(sanitizeEntryName('part-0.parquet', taken), 'part-0-1.parquet');
});

test('close() reports the total bytes written and the entry count', async () => { /* 2 entries, bytes equals the sink total */ });

test('unzip -t reports no errors', async () => { /* skip when `unzip` is absent */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/download-core/test/zip-writer.test.js`
Expected: FAIL — `createZipWriter` is not exported.

- [ ] **Step 3: Implement `createZipWriter` and `sanitizeEntryName` in `packages/download-core/src/zip.js`**

`addEntry` writes the local header, then each chunk straight through to `writer` while folding it into a running `crc32` and byte count, then the data descriptor — so nothing is buffered and no header is ever rewritten. The writer tracks each entry's starting offset for the central directory it writes in `close()`. `sanitizeEntryName` splits on both separators, drops `.`/`..`/empty segments and any leading separator, then appends `-N` before the extension until the name is unused.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test packages/download-core/test/zip-writer.test.js`
Expected: PASS

- [ ] **Step 5: Write the opt-in large-archive verifier**

`packages/download-core/test/zip-large.verify.mjs` writes a >4 GiB archive (two entries of synthetic bytes) to a temp file and asserts Python `zipfile` lists both with correct sizes. Not referenced by `npm test`; documented in the package README as `node packages/download-core/test/zip-large.verify.mjs`.

- [ ] **Step 6: Commit**

```bash
git add packages/download-core/src/zip.js packages/download-core/test/zip-writer.test.js packages/download-core/test/zip-large.verify.mjs
git commit -m "feat(download-core): streaming zip64 writer for non-seekable sinks"
```

---

### Task 3: `effectiveCeiling` and `memoryFactor`

**Files:**
- Modify: `packages/download-core/src/ceiling.js`
- Modify: `packages/download-core/src/formats/geojson.js:73-74`, `packages/download-core/src/formats/geoparquet.js:93-94`
- Modify: `packages/download-core/src/registry.js:38` (the `capabilities` typedef)
- Modify: `packages/format-shapefile/src/index.js`, `packages/format-flatgeobuf/src/index.js` (declare or document the factor)
- Modify: `packages/format-gpkg/src/index.js` and `packages/format-gpkg/src/gpkg-writer.js` (declare `memoryFactor: 3.5`)
- Test: `packages/download-core/test/ceiling.test.js`

**Interfaces:**
- Produces: `effectiveCeiling({ format, sink, overrides }): Ceiling` where `format` is a `FormatPlugin` or `LazyFormatDescriptor` (only `streaming` and `capabilities.memoryFactor` are read) and `sink` is `{ kind: string }` or `null`. `memoryFactorOf(format): number`. `defaultCeiling()` stays exported, unchanged, as a compat shim.

- [ ] **Step 1: Write the failing tests**

```js
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const streaming = { streaming: true, capabilities: {} };
const gpkgLike = { streaming: false, capabilities: { memoryFactor: 3.5 } };

test('memoryFactorOf defaults to 0 for streaming and 3 for buffering', () => {
  assert.equal(memoryFactorOf(streaming), 0);
  assert.equal(memoryFactorOf({ streaming: false, capabilities: {} }), 3);
});

test('a streaming format on a disk-backed sink is effectively unbounded', () => {
  const c = effectiveCeiling({ format: streaming, sink: { kind: 'filesystem' } });
  assert.equal(c.outputBytes, 1024 ** 4);
});

test('a streaming format on a blob sink is capped at blobBytes', () => {
  const c = effectiveCeiling({ format: streaming, sink: { kind: 'blob' } });
  assert.equal(c.outputBytes, 256 * MiB);
});

test('memorySink is exempt from the memory budget', () => {
  const c = effectiveCeiling({ format: streaming, sink: { kind: 'memory' } });
  assert.equal(c.outputBytes, 1024 ** 4);
});

// Ruling R6: this assertion lives in packages/format-gpkg's OWN test suite,
// not here -- download-core does not depend on format-gpkg, so a cross-package
// import resolves only via workspace hoisting. ceiling.test.js asserts
// memoryFactorOf against literal descriptor shapes instead.

test('a buffering format stays memoryBudget / memoryFactor even on a memory sink', () => {
  const c = effectiveCeiling({ format: gpkgLike, sink: { kind: 'memory' } });
  assert.equal(c.outputBytes, Math.floor(GiB / 3.5));
});

test('a buffering format is memoryBudget / memoryFactor regardless of sink', () => {
  const c = effectiveCeiling({ format: gpkgLike, sink: { kind: 'filesystem' } });
  assert.equal(c.outputBytes, Math.floor(GiB / 3.5));
});

test('the raised flat defaults apply', () => {
  const c = effectiveCeiling({ format: streaming, sink: { kind: 'filesystem' } });
  assert.equal(c.rows, 50_000_000);
  assert.equal(c.readBytes, 64 * GiB);
  assert.equal(c.files, 10_000);
});

test('options.ceiling overrides field by field, including memoryBudget', () => {
  const c = effectiveCeiling({ format: gpkgLike, sink: { kind: 'filesystem' }, overrides: { memoryBudget: 4 * GiB } });
  assert.equal(c.outputBytes, Math.floor((4 * GiB) / 3.5));
  const d = effectiveCeiling({ format: gpkgLike, sink: null, overrides: { outputBytes: 7 } });
  assert.equal(d.outputBytes, 7);
});

test('defaultCeiling() is unchanged for existing callers', () => {
  assert.equal(defaultCeiling().blobBytes, 256 * MiB);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/download-core/test/ceiling.test.js`
Expected: FAIL — `effectiveCeiling` is not exported.

- [ ] **Step 3: Implement `effectiveCeiling` and `memoryFactorOf` in `packages/download-core/src/ceiling.js`**

An explicit `overrides.outputBytes` wins over any derivation. `sink: null` (not yet created) is treated as memory-backed, the conservative direction. Add `memoryFactor: 0` to `geojson.js`'s capabilities and `memoryFactor: 2` to `geoparquet.js`'s, and document the field in `registry.js`'s `capabilities` typedef.

`format-gpkg` must declare `memoryFactor: 3.5` — the value measured in spec §1 for the *current* writer — on both `gpkgFormatDescriptor.capabilities` and the plugin's. Leaving it absent would apply the default of 3, understating gpkg's real cost and raising its ceiling above what memory can take: spec anti-goal §4.1. Task 9 revises this to the post-change measured value.

For `format-shapefile` and `format-flatgeobuf` (spec §8): either measure the factor with the same method as Task 9 Step 5 and declare it, or leave the field absent so the default of 3 applies and add one line to that package's README saying the factor is unmeasured. Do not declare a guessed number — the ceiling is computed from it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test packages/download-core/test/ceiling.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/download-core/src/ceiling.js packages/download-core/src/formats packages/download-core/src/registry.js packages/download-core/test/ceiling.test.js
git commit -m "feat(download-core): derive ceilings from format memory cost and sink kind"
```

---

### Task 4: Wire the derived ceiling into `estimate()` and `download()`

**Files:**
- Modify: `packages/download-core/src/estimate.js:320` (`estimate`), `:339` (`finalizeEstimate`), `:375-395`
- Modify: `packages/download-core/src/download.js:136-186` (the gate), `:190` (sink creation)
- Test: `packages/download-core/test/ceiling-wiring.test.js`

**Interfaces:**
- Consumes: Task 3's `effectiveCeiling`.
- Produces: `estimate(dataset, area, filter, options)` accepts two new optional options, `output: OutputSpec` and `sink: { kind: string }`; when `output.format` names a registered format its `estimateBytes` and `memoryFactor` are used instead of the generic model. `CeilingExceededError.context` gains `suggestedFormats: string[]`. `est.ceiling.limits` reports the derived numbers.

- [ ] **Step 1: Write the failing tests**

```js
test('download() creates the sink before the ceiling gate, so the ceiling sees its kind', async () => { /* a fake streaming format + memorySink: a 500 MiB estimate does NOT breach */ });

test('a buffering format breaches where a streaming one does not, same plan', async () => { /* same estimateOverride; gpkg-like rejects CEILING_EXCEEDED, geojson-like resolves */ });

test('CeilingExceededError names formats whose own ceiling would fit', async () => {
  // register a buffering format (memoryFactor 3.5) and a streaming one; breach on the former
  assert.ok(err.context.suggestedFormats.includes('geojson'));
});

test('est.ceiling.limits reports the derived outputBytes, not the flat default', async () => { /* gpkg-like => floor(GiB/3.5) */ });

test('estimate() with options.output uses that format estimateBytes', async () => { /* differs from the generic model */ });

test('estimate() without options.output behaves exactly as before', async () => { /* unchanged snapshot of est.outputBytes */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/download-core/test/ceiling-wiring.test.js`
Expected: FAIL

- [ ] **Step 3: Implement the wiring**

In `download.js`, move the `options.sink ?? await autoSink(...)` line to just before the ceiling check and pass the sink into `finalizeEstimate`; delete the hardcoded `!format.streaming && est.outputBytes.max > blobBytes` block, which `effectiveCeiling` now subsumes. On a breach, compute `suggestedFormats` by running each registered format's synchronous `estimateBytes(schema, plan.rows, estimateCtx)` against that format's own `effectiveCeiling` — `formats()` lists lazy descriptors without loading them, so this needs no `load()`. In `estimate.js`, thread `options.output`/`options.sink` through to `effectiveCeiling`.

- [ ] **Step 4: Run the tests and the full suite**

Run: `node --test packages/download-core/test/ceiling-wiring.test.js && npm test 2>&1 | tail -5`
Expected: new tests PASS; `npm test` at exactly the 4 baseline failures.

- [ ] **Step 5: Commit**

```bash
git add packages/download-core/src packages/download-core/test/ceiling-wiring.test.js
git commit -m "feat(download-core): wire derived ceilings into estimate and download"
```

---

### Task 5: `large-download` and `slow-download` warnings

**Files:**
- Modify: `packages/download-core/src/estimate.js` (the `warnings` block)
- Test: `packages/download-core/test/download-size-warnings.test.js`

**Interfaces:**
- Produces: two `EstimateWarning` codes, `large-download` with `context: { bytes, estimatedSeconds }` and `slow-download` with `context: { estimatedSeconds }`. New option `throughputBytesPerSecond` (default `10_000_000`) and `largeDownloadBytes` (default 1 GiB) on `DownloadCoreOptions`.

- [ ] **Step 1: Write the failing tests**

```js
test('large-download fires above 1 GiB and carries bytes plus an ETA', async () => { /* 2 GiB estimate => estimatedSeconds ~ 214 */ });
test('large-download does not fire at exactly the threshold', async () => { /* 1 GiB exactly => absent */ });
test('slow-download fires when the ETA exceeds 120s', async () => { /* 2 GiB at 10 MB/s */ });
test('throughputBytesPerSecond changes the ETA and can clear slow-download', async () => { /* 1 GB/s => no slow-download */ });
test('neither fires on a small download', async () => { /* 10 MB => warnings has neither code */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/download-core/test/download-size-warnings.test.js`
Expected: FAIL

- [ ] **Step 3: Implement the two warnings in `finalizeEstimate`**

`estimatedSeconds = outputBytes.estimate / throughputBytesPerSecond`, rounded. Emitted alongside the existing warnings so they travel on both `est.warnings` and the `warning` event with no new channel.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test packages/download-core/test/download-size-warnings.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/download-core/src/estimate.js packages/download-core/test/download-size-warnings.test.js
git commit -m "feat(download-core): warn before large and slow downloads"
```

---

### Task 6: Raw passthrough planning

**Files:**
- Create: `packages/download-core/src/raw.js`
- Test: `packages/download-core/test/raw-plan.test.js`

**Interfaces:**
- Consumes: `partitionPruneCascade(parts, areaBBoxes, time, explicitPartitions) => { selected, stages }` from `partitions.js:353`; `enumeratePartitions` from the same module.
- Produces: a new error code `FILTER_NO_MATCH` (raised when pruning selects zero parts; added to the taxonomy in Task 12); `RAW_FORMAT_ID = 'parquet-raw'`; `rawFormatDescriptor` (id, label `'GeoParquet — original files'`, extension `'parquet'`, `streaming: true`, `capabilities.memoryFactor: 0`) for `formats()` listing; `planRaw(dataset, area, filter, options): Promise<RawPlan>` where `RawPlan` is `{ parts, selected, sizes: Map<string, number|null>, requests, stages, warnings }`; `rawEstimate(rawPlan, filter, options): Estimate`.

- [ ] **Step 1: Write the failing tests**

```js
test('planRaw uses only the whole-file stages and makes no footer reads', async () => { /* fake fetch counts requests; 27 parts, time filter => 1 selected, 0 GETs of parquet bodies */ });

test('planRaw tests every box of a split area, not the signed bbox', async () => {
  // area.bboxes = [[170,-20,180,-10], [-180,-20,-175,-10]], area.bbox = [170,-20,-175,-10]
  // a part at lon -177 must be SELECTED
});

test('zero selected parts throws FILTER_NO_MATCH before any fetch', async () => { /* assert err.code */ });

test('rawEstimate sums declared part sizes and is exact', async () => { /* every part has bytes => outputBytes.exact === true */ });

test('rawEstimate includes the computable zip container overhead for >1 part', async () => { /* 2 parts => outputBytes > sum of parts */ });

test('rawEstimate omits zip overhead for exactly one part', async () => { /* 1 part => outputBytes.estimate === that part bytes */ });

test('rawEstimate reports rows exactly when every part declares rowCount, else null', async () => {});

test('rawEstimate warns raw-passthrough-unfiltered listing what was dropped', async () => {
  // filter with where + columns + spatial.mode 'intersects'
  assert.deepEqual(w.context.dropped, ['where', 'columns', 'spatial-row-level']);
});

test('planRaw refuses an unsupported source kind with FORMAT_CAPABILITY', async () => { /* kind: 'pmtiles' */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/download-core/test/raw-plan.test.js`
Expected: FAIL — `raw.js` does not exist.

- [ ] **Step 3: Implement `planRaw`, `rawEstimate` and `rawFormatDescriptor` in `packages/download-core/src/raw.js`**

Supported source kinds: `parquet`, `parquet-set`, `hive`, `stac-geoparquet`. Part sizes come from `part.bytes` first, then one `HEAD` per sizeless part (each counted in `requests`); a `HEAD` that fails or omits `content-length` leaves that part's size `null` rather than throwing. Zip overhead per entry is computed from Task 1's record sizes for the sanitized name, plus the `ATTRIBUTION.txt` entry and the end records.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test packages/download-core/test/raw-plan.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/download-core/src/raw.js packages/download-core/test/raw-plan.test.js
git commit -m "feat(download-core): plan raw GeoParquet passthrough downloads"
```

---

### Task 7: Raw passthrough execution

**Files:**
- Modify: `packages/download-core/src/raw.js`
- Modify: `packages/download-core/src/download.js` (branch on `output.format === RAW_FORMAT_ID` before `engine.plan`)
- Modify: `packages/download-core/src/index.js` (export `RAW_FORMAT_ID`, `rawFormatDescriptor`)
- Test: `packages/download-core/test/raw-run.test.js`

**Interfaces:**
- Consumes: Task 2's `createZipWriter`, Task 6's `planRaw`/`rawEstimate`.
- Produces: `runRaw(rawPlan, writer, options): Promise<{ bytes, entries, readBytes }>`. `download()` returns its normal handle for `parquet-raw`, emitting `progress` with `{ phase: 'copying', fileIndex, fileCount, filename, bytesWritten, bytesTotal }`.

- [ ] **Step 1: Write the failing tests**

```js
test('one selected part is written verbatim, byte for byte', async () => { /* memorySink bytes === the source bytes; no zip signature */ });
test('one part is never wrapped in a zip, even when attribution is share-alike', async () => { /* ODbL attribution; output has no 0x04034b50 */ });
test('many parts produce a zip whose entries are the parts plus ATTRIBUTION.txt', async () => {});
test('ATTRIBUTION.txt contains the licenses and source URLs', async () => {});
test('progress reports copying with a rising fileIndex', async () => {});
test('DownloadResult.rows is null when parts declare no rowCount, and truncated is false', async () => {});

// Review Focus 1
test('a part that 404s mid-archive rejects and aborts the sink without committing', async () => {
  // fake fetch: parts 1-2 ok, part 3 => 404
  await assert.rejects(handle.result);
  assert.equal(sink.aborted, true);
});
// Review Focus 5
test('actual bytes differing from the declared size are what the descriptor and result report', async () => {
  // part declares bytes: 100, serves 150
  assert.equal(result.bytes > 150, true);   // the archive holds the real 150
  assert.equal(result.readBytes, 150);
});
test('cancel() during copying aborts the in-flight fetch and the sink', async () => {});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/download-core/test/raw-run.test.js`
Expected: FAIL

- [ ] **Step 3: Implement `runRaw` and the `download()` branch**

Parts are fetched and written strictly sequentially — each response body is drained chunk by chunk into the sink (verbatim) or into `createZipWriter.addEntry` (zipped). A non-`ok` response throws a `CngError` with code `NETWORK`, which `download()`'s existing catch turns into `formatWriter.abort()`/`sink.abort()`. `ATTRIBUTION.txt` is added last, built from `plan.resolved.attribution`. The raw branch sits before `engine.plan()` so no footer is ever read.

- [ ] **Step 4: Run the tests and the full suite**

Run: `node --test packages/download-core/test/raw-run.test.js && npm test 2>&1 | tail -5`
Expected: new tests PASS; `npm test` at exactly the 4 baseline failures.

- [ ] **Step 5: Commit**

```bash
git add packages/download-core/src packages/download-core/test/raw-run.test.js
git commit -m "feat(download-core): execute raw GeoParquet passthrough downloads"
```

---

### Task 8: Raw guard-rail warnings

**Files:**
- Modify: `packages/download-core/src/raw.js`
- Test: `packages/download-core/test/raw-guardrails.test.js`

**Interfaces:**
- Produces: `raw-size-unknown` with `context: { partsWithoutSize, partsTotal }`; `raw-no-pruning` with `context: { basis }` where `basis` is `'parts declare no bbox'` or `'parts declare no interval'`.

- [ ] **Step 1: Write the failing tests**

```js
test('raw-size-unknown fires when any part size is unobtainable, and the estimate is inexact', async () => {
  assert.equal(est.outputBytes.exact, false);
  assert.deepEqual(w.context, { partsWithoutSize: 2, partsTotal: 5 });
});
test('raw-size-unknown suppresses large-download rather than guessing', async () => { /* no large-download code present */ });
test('raw-no-pruning fires when an area narrowed nothing because parts declare no bbox', async () => {
  assert.equal(w.context.basis, 'parts declare no bbox');
});
test('raw-no-pruning does not fire when the filter asked for no narrowing', async () => { /* no area, no time => absent */ });
test('neither warning is a ceiling breach: the download still runs', async () => {
  assert.equal(est.ceiling.exceeded, false);
  assert.equal((await handle.result).bytes > 0, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/download-core/test/raw-guardrails.test.js`
Expected: FAIL

- [ ] **Step 3: Implement the two warnings in `rawEstimate`**

`raw-no-pruning` fires only when `selected.length === parts.length` **and** the filter supplied an area or a time range. Determine `basis` from whether the surviving parts lack `bbox` or lack `interval`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test packages/download-core/test/raw-guardrails.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/download-core/src/raw.js packages/download-core/test/raw-guardrails.test.js
git commit -m "feat(download-core): warn when raw sizes are unknown or pruning narrowed nothing"
```

---

### Task 9: GeoPackage step 1 — insert per batch

**Files:**
- Modify: `packages/format-gpkg/src/gpkg-writer.js:143-245`
- Create: `packages/format-gpkg/test/memory-factor.verify.mjs`
- Test: `packages/format-gpkg/test/gpkg-streaming.test.js`

**Interfaces:**
- Produces: unchanged public surface. `gpkgFormatDescriptor.capabilities.memoryFactor` and the plugin's, both set to the **measured** value from Step 5.

- [ ] **Step 1: Write the failing tests**

```js
test('rows are inserted during writeBatch, not held until close', async () => {
  // after two writeBatch calls and before close(), the open database already
  // holds 2 rows -- assert via a probe the writer exposes for tests, or by
  // asserting no row data is retained (bufferedRows is gone)
});
test('geometry_type_name is corrected at close from the geometries seen', async () => { /* all polygons => 'Polygon', mixed => 'GEOMETRY' */ });
test('gpkg_contents bounds are the union of all batches', async () => {});
test('abort() after open() closes the database and leaves nothing behind', async () => {});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/format-gpkg/test/gpkg-streaming.test.js`
Expected: FAIL

- [ ] **Step 3: Restructure `createGpkgFormat`'s writer**

`open()` creates the `SQL.Database`, writes the `gpkg_*` tables and the feature table, and inserts `gpkg_geometry_columns` with `'GEOMETRY'` and `gpkg_contents` with null bounds. `writeBatch()` inserts its rows inside a transaction and retains no row data, keeping only the existing `geometryTypeCodes` set and `overallBbox`. `close()` issues the two `UPDATE`s, then exports as today. `abort()` calls `db.close()`.

- [ ] **Step 4: Run the new tests and the existing gpkg suite**

Run: `node --test packages/format-gpkg/test/`
Expected: PASS, including the GDAL/DuckDB-validated integration tests, unchanged.

- [ ] **Step 5: Measure the new `memoryFactor` and declare it**

`packages/format-gpkg/test/memory-factor.verify.mjs` drives `createGpkgFormat()` with synthetic WKB polygons, one row-count per process (so the emscripten heap does not carry over), sampling `process.memoryUsage().rss` every 20 ms, at 2,000 rows × {100, 5,000, 20,000} vertices — the same method as the spec's §1 table. Print `peakRss / outputBytes` per case. Set `memoryFactor` to the **measured** maximum, rounded up to one decimal. If it is not below 3.5, revert Step 3 and record why in the commit message instead of declaring a factor.

- [ ] **Step 6: Commit**

```bash
git add packages/format-gpkg/src packages/format-gpkg/test
git commit -m "perf(format-gpkg): insert rows per batch instead of buffering the whole output"
```

---

### Task 10: GeoPackage step 1.5 — stream the export, or drop it

**Files:**
- Modify: `packages/format-gpkg/src/gpkg-writer.js` (only if the spike succeeds)
- Modify: `packages/format-gpkg/test/memory-factor.verify.mjs`

**Interfaces:**
- Produces: either a lower measured `memoryFactor`, or a documented note that this is not feasible on sql.js. Nothing downstream depends on which.

- [ ] **Step 1: Spike whether `SQL.FS` can stream the database file out**

Determine whether sql.js exposes the database's MEMFS path and an `FS.open`/`FS.read` path that yields chunks without materialising the whole file. Throwaway script in the scratchpad, not committed.

- [ ] **Step 2: If feasible, write the failing test**

```js
test('close() writes the database in chunks, never one whole-file Uint8Array', async () => { /* sink receives >1 chunk for a multi-megabyte database */ });
test('the chunk-streamed file is byte-identical to db.export()', async () => {});
```

- [ ] **Step 3: If feasible, implement chunked export; if not, stop here**

Replace `db.export()` with a chunked read into `ctx.writer.write`. If the spike showed it is not reachable through sql.js's public surface, make no code change.

- [ ] **Step 4: Re-measure `memoryFactor` either way**

Run: `node packages/format-gpkg/test/memory-factor.verify.mjs`
Expected: a measured factor. Declare only what was measured — never an assumed 1.5.

- [ ] **Step 5: Commit**

```bash
git add packages/format-gpkg
git commit -m "perf(format-gpkg): stream the database export"   # or: "docs(format-gpkg): record why chunked export is not reachable on sql.js"
```

---

### Task 11: The demo

**Files:**
- Modify: `examples/download-demo/index.html:396-404` and the format picker
- Modify: `examples/download-demo/verify.mjs`
- Create: `packages/download-core/test/browser/raw-opfs.verify.mjs`

**Interfaces:**
- Consumes: `RAW_FORMAT_ID`, the new warning codes, `estimate()`'s `output` option.

- [ ] **Step 1: Write the failing verifier assertions**

Extend `examples/download-demo/verify.mjs` in the house style — navigate, wait on a visible status string, assert on real output, fail on any console error:

```js
// no row cap by default
assert.equal(buildFilterLimitFor(''), undefined);
// raw passthrough is offered and downloads the real bytes
assert.ok(formatOptionValues.includes('parquet-raw'));
// a large download is gated behind an explicit confirm
assert.match(statusText, /confirm/i);
```

- [ ] **Step 2: Run the verifier to confirm it fails**

Run: `python3 serve.py 8000 & node examples/download-demo/verify.mjs 8000`
Expected: FAIL

- [ ] **Step 3: Make the demo changes**

Delete `limit: 2000` from `buildFilter` and pass `limit` only when a new "Max rows" input is non-empty (default empty = no limit). Add `parquet-raw` to the format picker labelled "GeoParquet — original files (complete, unfiltered)". Render `raw-passthrough-unfiltered`, `raw-size-unknown`, `raw-no-pruning`, `large-download` and `slow-download`, and require an explicit confirm click before starting any download carrying `large-download`. Show a copyable list of the selected source URLs beside the raw option.

- [ ] **Step 4: Run the verifier to confirm it passes**

Run: `node examples/download-demo/verify.mjs 8000`
Expected: PASS

- [ ] **Step 5: Write the OPFS browser verifier**

`packages/download-core/test/browser/raw-opfs.verify.mjs`, modelled on the existing `filesystem-sink.verify.mjs`: drives a real `parquet-raw` download into an OPFS writable and asserts the committed bytes, covering the disk-backed-sink ceiling path that `npm test` cannot reach.

- [ ] **Step 6: Commit**

```bash
git add examples/download-demo packages/download-core/test/browser
git commit -m "feat(download-demo): no default row cap, raw GeoParquet option, size warnings"
```

---

### Task 12: Documentation

**Files:**
- Modify: `AGENTS.md` (recipes 3 and 4, the pitfalls list, the ceiling defaults)
- Modify: `packages/download-core/README.md` (error codes, warning codes, formats, ceilings)
- Modify: `packages/format-gpkg/README.md` (the measured `memoryFactor`)
- Modify: `docs/verify-snippets.mjs`

**Interfaces:**
- Consumes: everything above. Every snippet added here must execute under `node docs/verify-snippets.mjs`.

- [ ] **Step 1: Update `AGENTS.md`**

Add a `parquet-raw` recipe under recipe 3; correct the ceiling defaults in recipe 4 to the derived model and the new flat numbers; add the new warning codes to recipe 4's list; add a pitfall entry stating that a raw download is complete and unfiltered and that `rows` may be `null`. Correct the §Pitfalls "`geoparquet` buffers everything in memory" note to name `memoryFactor`.

- [ ] **Step 2: Update the two package READMEs**

`download-core`: the new error code `FILTER_NO_MATCH`, the new warning codes, `effectiveCeiling`, `memoryFactor`, `parquet-raw`, `suggestedFormats` on `CEILING_EXCEEDED`, and the opt-in `zip-large.verify.mjs`. `format-gpkg`: the measured factor and the resulting practical size limit, linking issue #3 for what lifts it further.

- [ ] **Step 3: Add the new snippets to `docs/verify-snippets.mjs`**

Every snippet added to `AGENTS.md` in Step 1 must be registered and pass against live data.

- [ ] **Step 4: Run both verifiers**

Run: `npm test 2>&1 | tail -5 && node docs/verify-snippets.mjs`
Expected: `npm test` at exactly the 4 baseline failures; `verify-snippets` passes.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md packages/*/README.md docs/verify-snippets.mjs
git commit -m "docs: raw GeoParquet passthrough, derived ceilings, new warning codes"
```
