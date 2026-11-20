// @cng/download-core -- wiring `effectiveCeiling` (Task 3) into
// `estimate()`/`download()` (Task 4, design doc §7.3/§7.8).
//
// Uses a fake `Engine` (no network) for the download() tests, so this
// exercises the ceiling-derivation wiring itself, not the real parquet
// pruning/reading pipeline (covered by prune.test.js et al.) -- the same
// approach download-handle.test.js uses, except these tests do NOT pass
// `estimateOverride`: they need the REAL `finalizeEstimate` path, because
// that is exactly what is under test.
//
// The estimate()-only tests (5/6) need a real `planRequest`, so they use
// a tiny on-disk parquet fixture shared with infer-table.test.js /
// geoparquet-decode.test.js, through a plain file:// fetch stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import './helpers/hyparquet-setup.js';
import { estimate } from '../src/estimate.js';
import { download } from '../src/download.js';
import { memorySink } from '../src/sinks.js';
import { boundedExact } from '../src/bounded.js';
import { registerFormat } from '../src/registry.js';
import { CeilingExceededError } from '@cng/spec';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const DATASET = { spec: 'cng-dataset/1.0', source: { kind: 'parquet', url: 'https://example.test/d.parquet' } };
const FILTER = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };

/** A complete-enough `planRequest()`-shaped plan for `finalizeEstimate` to run against for real (unlike download-handle.test.js's MINIMAL_PLAN, which is only ever used alongside `estimateOverride` and so skips finalizeEstimate entirely). */
function minimalPlan({ rows = boundedExact(10), readBytes = boundedExact(100) } = {}) {
  return {
    geometryColumn: 'geometry',
    table: { crs: 'OGC:CRS84', columns: [{ name: 'id', type: 'string' }, { name: 'geometry', type: 'geometry' }] },
    resolved: { attribution: [] },
    outputColumns: ['id', 'geometry'],
    readColumns: ['id', 'geometry'],
    covering: { kind: 'none' },
    perPart: [],
    partStages: [],
    rowGroupBboxStage: { stage: 'row-group-bbox', before: 0, after: 0, basis: 'no area supplied' },
    rowGroupStatsStage: { stage: 'row-group-stats', before: 0, after: 0, basis: 'no time filter' },
    rowGroupWhereStage: { stage: 'row-group-where', before: 0, after: 0, basis: 'no where filter' },
    whereDecidable: false,
    whereStatsSeen: false,
    avgGeometryBytes: null,
    parts: [{ url: 'https://example.test/d.parquet' }],
    selectedParts: [{ url: 'https://example.test/d.parquet' }],
    allRowGroupsTotal: 1,
    selectedRowGroupsTotal: 1,
    maxRowsBeforeLimit: 10,
    rows,
    readBytes,
    requests: 1,
  };
}

function fakeEngine(plan) {
  return {
    id: 'fake',
    capabilities: ['bbox', 'intersects'],
    async plan(dataset, area, filter) {
      return { dataset, area, filter, plan };
    },
    async run() {
      return { rows: 0, readBytes: 0, requests: 0 };
    },
  };
}

/** A minimal but complete `FormatPlugin`: fixed `estimateBytes`, a no-op writer. */
function fakeFormat({ id, streaming, memoryFactor, bytes }) {
  return {
    id,
    extension: 'bin',
    mediaType: 'application/octet-stream',
    streaming,
    capabilities: { nestedColumns: true, mixedGeometryTypes: true, crs: ['OGC:CRS84'], memoryFactor },
    estimateBytes() {
      return boundedExact(bytes);
    },
    async open() {
      return {
        async writeBatch() {},
        async close() {
          return { rows: 0, bytes: 0 };
        },
        async abort() {},
      };
    },
  };
}

test('download() creates the sink before the ceiling gate, so the ceiling sees its kind', async () => {
  registerFormat(fakeFormat({ id: 'wiring-streaming-1', streaming: true, memoryFactor: 0, bytes: 500 * MiB }));
  const output = { spec: 'cng-output/1.0', format: 'wiring-streaming-1', filename: 'out.bin' };
  const handle = download(DATASET, null, FILTER, output, {
    engine: fakeEngine(minimalPlan()),
    sink: memorySink(),
  });

  const est = await handle.estimate;
  // Streaming format + a memory sink is exempt from the memory budget
  // (ceiling.js's documented carve-out) -- 500 MiB must NOT breach.
  assert.equal(est.ceiling.exceeded, false, JSON.stringify(est.ceiling));

  await handle.result;
  assert.equal(handle.state, 'done');
});

test('a buffering format breaches where a streaming one does not, same plan', async () => {
  registerFormat(fakeFormat({ id: 'wiring-streaming-2', streaming: true, memoryFactor: 0, bytes: 500 * MiB }));
  registerFormat(fakeFormat({ id: 'wiring-buffering-2', streaming: false, memoryFactor: 3.5, bytes: 500 * MiB }));

  const streamingHandle = download(
    DATASET, null, FILTER, { spec: 'cng-output/1.0', format: 'wiring-streaming-2' },
    { engine: fakeEngine(minimalPlan()), sink: memorySink() },
  );
  await streamingHandle.result;
  assert.equal(streamingHandle.state, 'done');

  const bufferingHandle = download(
    DATASET, null, FILTER, { spec: 'cng-output/1.0', format: 'wiring-buffering-2' },
    { engine: fakeEngine(minimalPlan()), sink: memorySink() },
  );
  await assert.rejects(bufferingHandle.result, (e) => e.code === 'CEILING_EXCEEDED');
  assert.equal(bufferingHandle.state, 'blocked');
});

test('CeilingExceededError names formats whose own ceiling would fit', async () => {
  registerFormat(fakeFormat({ id: 'geojson', streaming: true, memoryFactor: 0, bytes: 500 * MiB }));
  registerFormat(fakeFormat({ id: 'wiring-buffering-3', streaming: false, memoryFactor: 3.5, bytes: 500 * MiB }));

  const handle = download(
    DATASET, null, FILTER, { spec: 'cng-output/1.0', format: 'wiring-buffering-3' },
    { engine: fakeEngine(minimalPlan()), sink: memorySink() },
  );
  const err = await handle.result.then(() => null, (e) => e);
  assert.ok(err instanceof CeilingExceededError, `expected CeilingExceededError, got ${err}`);
  assert.ok(
    err.context.suggestedFormats.includes('geojson'),
    `expected 'geojson' among suggestedFormats, got ${JSON.stringify(err.context.suggestedFormats)}`,
  );
});

// Task 7 fix round 1: `suggestedFormatsFor`'s loop iterates every
// registered format, and `index.js` now registers `rawFormatDescriptor`
// under `RAW_FORMAT_ID` as a side effect of being imported -- a
// descriptor with no `estimateBytes` (it has no schema/rows model; its
// size comes from part metadata instead). Without `download.js`'s guard
// (`if (typeof candidate.estimateBytes !== 'function') continue;`), this
// exact scenario -- some OTHER format breaching its ceiling, with the raw
// descriptor merely registered alongside it -- throws a TypeError out of
// the suggestion loop instead of producing the `CeilingExceededError` the
// breach itself should surface. This test pins that: it imports
// `index.js` for its registration side effect (this file otherwise only
// ever imports `registry.js`/`download.js` directly, so that side effect
// has never run in this process before this line), then breaches the
// ceiling on an unrelated fake format so the loop actually runs over the
// raw descriptor.
//
// Verified to discriminate: temporarily removing the guard line in
// download.js and re-running this file reproduces the TypeError
// ("candidate.estimateBytes is not a function") as an unhandled rejection
// of `handle.result`, failing this test; restoring the guard makes it
// pass again.
test('suggestedFormatsFor does not crash on a registered format with no estimateBytes (the raw-passthrough descriptor)', async () => {
  await import('../src/index.js'); // registers rawFormatDescriptor (and geojson/geoparquet) as a side effect

  registerFormat(fakeFormat({ id: 'wiring-raw-guard-5', streaming: false, memoryFactor: 3.5, bytes: 500 * MiB }));

  const handle = download(
    DATASET, null, FILTER, { spec: 'cng-output/1.0', format: 'wiring-raw-guard-5' },
    { engine: fakeEngine(minimalPlan()), sink: memorySink() },
  );
  const err = await handle.result.then(() => null, (e) => e);
  assert.ok(err instanceof CeilingExceededError, `expected CeilingExceededError, got ${err}`);
  assert.ok(Array.isArray(err.context.suggestedFormats), 'the suggestion loop ran to completion without throwing');
  assert.equal(
    err.context.suggestedFormats.includes('parquet-raw'),
    false,
    'raw passthrough has no schema/rows model and must never appear as a suggested alternative',
  );
});

test('est.ceiling.limits reports the derived outputBytes, not the flat default', async () => {
  registerFormat(fakeFormat({ id: 'wiring-gpkg-like-4', streaming: false, memoryFactor: 3.5, bytes: 10 }));
  const handle = download(
    DATASET, null, FILTER, { spec: 'cng-output/1.0', format: 'wiring-gpkg-like-4' },
    { engine: fakeEngine(minimalPlan()), sink: memorySink() },
  );
  const est = await handle.estimate;
  assert.equal(est.ceiling.limits.outputBytes, Math.floor(GiB / 3.5));
  // Let the run settle (it may go on to the blocked gate) before the test
  // ends -- `current`'s deferred already self-catches, this is just hygiene.
  await new Promise((r) => setTimeout(r, 0));
});

// --- estimate()-only: no Engine, a real planRequest over a tiny fixture ---

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function fetchLocalFile(url) {
  const path = fileURLToPath(new URL(String(url)));
  const buf = await readFile(path);
  return new Response(buf, { status: 200, headers: { 'content-length': String(buf.byteLength), 'accept-ranges': 'bytes' } });
}

function fixtureDataset() {
  return {
    spec: 'cng-dataset/1.0',
    id: 'ceiling-wiring-fixture',
    source: { kind: 'parquet', url: `file://${FIXTURES}geo-metadata.parquet` },
  };
}

test('estimate() with options.output uses that format estimateBytes', async () => {
  registerFormat(fakeFormat({ id: 'wiring-estimate-fmt-5', streaming: true, memoryFactor: 0, bytes: 999 }));
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };
  const est = await estimate(fixtureDataset(), null, filter, {
    fetch: fetchLocalFile,
    output: { spec: 'cng-output/1.0', format: 'wiring-estimate-fmt-5' },
  });
  assert.deepEqual(est.outputBytes, boundedExact(999));
});

test('estimate() without options.output behaves exactly as before', async () => {
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };
  const est = await estimate(fixtureDataset(), null, filter, { fetch: fetchLocalFile });
  // The generic, format-agnostic model -- `exact: false` is its signature,
  // and it must not coincide with the format-specific fixed value above.
  assert.equal(est.outputBytes.exact, false);
  assert.notEqual(est.outputBytes.estimate, 999);
  assert.ok(est.outputBytes.estimate > 0);
});

// Whole-branch review fix-wave re-review, Ruling R17: `registerFormat`
// performs no validation that a plugin declares `estimateBytes` (and must
// not -- `rawFormatDescriptor` is registered through it deliberately
// WITHOUT one, see raw.js), so a misregistered third-party plugin reaches
// `download()`'s real `run()` at the line that calls
// `format.estimateBytes(schema, plan.rows, estimateCtx)` directly and
// unguarded -- BEFORE `finalizeEstimate`'s own `FORMAT_CAPABILITY` guard
// (added earlier in this same fix wave) ever gets a chance to run. This
// drives `download()` end-to-end (not `finalizeEstimate` directly) against
// exactly that format shape.
function fakeFormatWithoutEstimateBytes(id) {
  return {
    id,
    extension: 'bin',
    mediaType: 'application/octet-stream',
    streaming: true,
    capabilities: { nestedColumns: true, mixedGeometryTypes: true, crs: ['OGC:CRS84'], memoryFactor: 0 },
    // No `estimateBytes` at all -- the exact shape of a misregistered plugin.
    async open() {
      return {
        async writeBatch() {},
        async close() {
          return { rows: 0, bytes: 0 };
        },
        async abort() {},
      };
    },
  };
}

test('download() throws FORMAT_CAPABILITY, not a bare TypeError, for a registered format missing estimateBytes', async () => {
  registerFormat(fakeFormatWithoutEstimateBytes('wiring-no-estimatebytes-1'));
  const handle = download(
    DATASET, null, FILTER, { spec: 'cng-output/1.0', format: 'wiring-no-estimatebytes-1' },
    { engine: fakeEngine(minimalPlan()), sink: memorySink() },
  );

  const err = await handle.result.then(() => null, (e) => e);
  assert.ok(err, 'expected download() to reject');
  assert.equal(err.code, 'FORMAT_CAPABILITY', `expected FORMAT_CAPABILITY, got ${err.constructor?.name}: ${err.code ?? err.message}`);
  assert.match(err.message, /wiring-no-estimatebytes-1/);
});
