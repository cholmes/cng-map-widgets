// @cngeo/extract-core -- Ruling R14: the public `estimate()` (index.js) is a
// thin ROUTER. `options.output?.format === RAW_FORMAT_ID` must delegate to
// raw.js's decode-free `planRaw`/`rawEstimate`, never to estimate.js's own
// `estimate()` -- which, before this fix, both (a) threw a bare `TypeError`
// (`finalizeEstimate` unconditionally calls `format.estimateBytes(...)`
// once `getFormat('parquet-raw')` resolves `rawFormatDescriptor`, which has
// no such method) and (b) would have opened parquet FOOTERS even if it
// didn't throw -- exactly what the raw-passthrough path exists to avoid.
//
// Imports `estimate` from `../src/index.js` specifically, not
// `../src/estimate.js`: the router lives ONLY in index.js (estimate.js
// cannot import raw.js without creating a cycle, since raw.js already
// imports three constants FROM estimate.js), so `estimate.js`'s own
// `estimate()` deliberately does not route -- that is a documented,
// intentional asymmetry, not a gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/hyparquet-setup.js'; // non-raw test below reaches openParquetFile -> hyparquet
import { estimate, RAW_FORMAT_ID } from '../src/index.js';

function neverFetch() {
  return async (url) => {
    throw new Error(`must not fetch at all -- the raw path reads no footer, and every part here declares its own size (got: ${url})`);
  };
}

test('estimate() from index.js routes parquet-raw to the decode-free raw path, not estimate.js', async () => {
  const part = { url: 'https://example.test/solo.parquet', bytes: 12345 };
  const dataset = { spec: 'cng-dataset/1.0', source: { kind: 'parquet-set', parts: [part] } };
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };
  const output = { spec: 'cng-output/1.0', format: RAW_FORMAT_ID };

  // THE discrimination check: before Ruling R14's fix, this call throws a
  // bare TypeError ("format.estimateBytes is not a function") because
  // estimate.js's `finalizeEstimate` resolves `getFormat('parquet-raw')`
  // (which succeeds -- rawFormatDescriptor IS registered) and then calls
  // `format.estimateBytes(...)` unconditionally. `assert.doesNotThrow`
  // alone would already fail pre-fix; the richer assertions below also
  // confirm the result is raw-SHAPED, not merely "didn't crash".
  const est = await estimate(dataset, null, filter, { output, fetch: neverFetch() });

  // Raw-shaped, not decode-shaped: rawEstimate's own honest fields.
  assert.equal(est.rowGroups.total, 0, 'no row group was ever examined -- the raw path never reads a footer');
  assert.equal(est.rowGroups.selected, 0);
  assert.deepEqual(est.columns, [], 'no projection -- every column of every selected file passes through verbatim');
  assert.equal(est.files.selected, 1);
  assert.equal(est.outputBytes.exact, true, 'the one declared part size is exact, the whole point of this path');
  assert.equal(est.outputBytes.estimate, 12345);
  assert.equal(est.readBytes.estimate, 12345);

  // Zero network requests at all -- `neverFetch` above throws on ANY call;
  // reaching this line proves none happened (no HEAD, since the part
  // already declares `bytes`, and -- the actual point of the test --
  // no footer-metadata GET either).
});

test('estimate() from index.js still reads a footer (the normal decode path) for a non-raw format', async () => {
  // The router's "else" branch, and its mirror discriminator: a format id
  // other than parquet-raw (or no `output` at all) must still reach
  // estimate.js's real decode path -- which opens a parquet FOOTER -- and
  // must NOT be silently routed into raw.js's zero-fetch path.
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    throw new Error('stop here -- this test only cares that a fetch was attempted (a footer read), not that it succeeds');
  };
  const dataset = { spec: 'cng-dataset/1.0', source: { kind: 'parquet', url: 'https://example.test/decoded.parquet' } };
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };

  await assert.rejects(estimate(dataset, null, filter, { fetch: fetchImpl }));
  assert.ok(calls.length > 0, 'the non-raw path actually attempted a fetch (a footer read) -- it was not routed into the zero-fetch raw path');
});
