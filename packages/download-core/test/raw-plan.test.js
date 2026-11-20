import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRaw, rawEstimate, rawZipEntryNames } from '../src/raw.js';

function neverFetch() {
  return async () => {
    throw new Error('planRaw must not fetch here');
  };
}

test('planRaw uses only the whole-file stages and makes no footer reads', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method });
    if (method === 'HEAD') {
      return { ok: true, headers: { get: (k) => (k === 'content-length' ? '4096' : null) } };
    }
    throw new Error(`unexpected non-HEAD fetch (would be a footer read): ${url}`);
  };

  const parts = Array.from({ length: 27 }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return {
      url: `https://example.test/day=${day}/data.parquet`,
      interval: [`2026-01-${day}T00:00:00Z`, `2026-01-${day}T23:59:59Z`],
    };
  });
  const dataset = { source: { kind: 'hive', parts } };
  const filter = { time: { start: '2026-01-15T00:00:00Z', end: '2026-01-15T23:59:59Z' } };

  const plan = await planRaw(dataset, null, filter, { fetch: fetchImpl });

  assert.equal(plan.selected.length, 1);
  assert.equal(plan.selected[0].url, 'https://example.test/day=15/data.parquet');
  assert.equal(calls.filter((c) => c.method !== 'HEAD').length, 0, 'no footer reads / body GETs');
  assert.equal(calls.filter((c) => c.method === 'HEAD').length, 1, 'exactly one HEAD, for the one sizeless selected part');
  assert.equal(plan.requests, 1);
  assert.ok(plan.stages.some((s) => s.stage === 'part-time'));
});

test('planRaw tests every box of a split area, not the signed bbox', async () => {
  // A part sitting at lon -177 would be excluded by the SIGNED bbox
  // [170,-20,-175,-10] (w > e, since bbox is signed and wraps), but must
  // be selected when tested against each of area.bboxes individually.
  const part = { url: 'https://example.test/antimeridian.parquet', bbox: [-178, -15, -176, -12], bytes: 500 };
  const dataset = { source: { kind: 'parquet-set', parts: [part] } };
  const area = { bboxes: [[170, -20, 180, -10], [-180, -20, -175, -10]], bbox: [170, -20, -175, -10] };

  const plan = await planRaw(dataset, area, {}, { fetch: neverFetch() });

  assert.deepEqual(plan.selected.map((p) => p.url), [part.url]);
});

test('zero selected parts throws FILTER_NO_MATCH before any fetch', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    throw new Error('must not fetch');
  };
  const part = { url: 'https://example.test/only.parquet', bbox: [0, 0, 1, 1], bytes: 10 };
  const dataset = { source: { kind: 'parquet-set', parts: [part] } };
  const area = { bboxes: [[50, 50, 51, 51]] };

  await assert.rejects(
    planRaw(dataset, area, {}, { fetch: fetchImpl }),
    (err) => err.code === 'FILTER_NO_MATCH',
  );
  assert.equal(calls.length, 0);
});

test('planRaw leaves a sizeless part null when its HEAD fails or omits content-length, without throwing', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://example.test/a.parquet') throw new Error('network down');
    if (url === 'https://example.test/b.parquet') return { ok: true, headers: { get: () => null } };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const parts = [
    { url: 'https://example.test/a.parquet' },
    { url: 'https://example.test/b.parquet' },
  ];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: fetchImpl });

  assert.equal(plan.sizes.get('https://example.test/a.parquet'), null);
  assert.equal(plan.sizes.get('https://example.test/b.parquet'), null);
  assert.equal(plan.requests, 2);
});

// Regression: a `collection-mirror`-enumerated part's `bytes`/`rowCount`
// are read straight off a hyparquet-decoded row (`partFromMirrorRow` in
// partitions.js), and an INT64 parquet column decodes as `BigInt` --
// exactly the shape FIRMS/s2-stac-geoparquet (this feature's own target
// catalogs) publish. Before this fix, `typeof part.bytes === 'number'`
// in resolvePartSizes treated a declared BigInt size as absent (an
// avoidable extra HEAD), and `JSON.stringify({ parts, filter })` in
// rawEstimate's digest threw outright on a BigInt rowCount/bytes
// anywhere in the unpruned `parts` array.
test('planRaw and rawEstimate handle BigInt-valued bytes/rowCount without throwing or re-fetching a declared size (regression)', async () => {
  const parts = [{ url: 'https://example.test/a.parquet', bytes: 1234n, rowCount: 5678n }];
  const fetchImpl = async () => {
    throw new Error('must not HEAD a part that already declared its size');
  };

  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: fetchImpl });
  assert.equal(plan.requests, 0, 'a declared BigInt size must be honored, not treated as absent');
  assert.equal(plan.sizes.get('https://example.test/a.parquet'), 1234);

  const est = await rawEstimate(plan, {}, {}); // must not throw TypeError on BigInt serialization

  assert.equal(est.outputBytes.exact, true);
  assert.equal(est.outputBytes.estimate, 1234);
  assert.equal(est.rows.exact, true);
  assert.equal(est.rows.estimate, 5678);
  assert.equal(typeof est.requestDigest, 'string');
  assert.ok(est.requestDigest.length > 0);
});

test('rawEstimate sums declared part sizes and is exact', async () => {
  const parts = [
    { url: 'https://example.test/a.parquet', bytes: 100 },
    { url: 'https://example.test/b.parquet', bytes: 200 },
    { url: 'https://example.test/c.parquet', bytes: 300 },
  ];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: neverFetch() });
  const est = await rawEstimate(plan, {}, {});

  assert.equal(est.readBytes.exact, true);
  assert.equal(est.readBytes.estimate, 600);
  assert.equal(est.outputBytes.exact, true);
});

test('rawEstimate includes the computable zip container overhead for >1 part', async () => {
  const parts = [
    { url: 'https://example.test/a.parquet', bytes: 100 },
    { url: 'https://example.test/b.parquet', bytes: 200 },
  ];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: neverFetch() });
  const est = await rawEstimate(plan, {}, {});

  assert.equal(est.readBytes.estimate, 300);
  assert.ok(est.outputBytes.estimate > 300, `expected zip overhead on top of 300, got ${est.outputBytes.estimate}`);
});

test('rawEstimate omits zip overhead for exactly one part', async () => {
  const parts = [{ url: 'https://example.test/a.parquet', bytes: 100 }];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: neverFetch() });
  const est = await rawEstimate(plan, {}, {});

  assert.equal(est.outputBytes.estimate, 100);
});

test('rawEstimate reports rows exactly when every part declares rowCount, else null', async () => {
  const withRows = [
    { url: 'https://example.test/a.parquet', bytes: 10, rowCount: 5 },
    { url: 'https://example.test/b.parquet', bytes: 10, rowCount: 7 },
  ];
  const plan1 = await planRaw({ source: { kind: 'parquet-set', parts: withRows } }, null, {}, { fetch: neverFetch() });
  const est1 = await rawEstimate(plan1, {}, {});
  assert.equal(est1.rows.exact, true);
  assert.equal(est1.rows.estimate, 12);

  const missingRows = [
    { url: 'https://example.test/a.parquet', bytes: 10, rowCount: 5 },
    { url: 'https://example.test/b.parquet', bytes: 10 },
  ];
  const plan2 = await planRaw({ source: { kind: 'parquet-set', parts: missingRows } }, null, {}, { fetch: neverFetch() });
  const est2 = await rawEstimate(plan2, {}, {});
  assert.equal(est2.rows, null);
});

test('rawEstimate warns raw-passthrough-unfiltered listing what was dropped', async () => {
  const parts = [{ url: 'https://example.test/a.parquet', bbox: [0, 0, 1, 1], bytes: 10 }];
  const area = { bboxes: [[0, 0, 1, 1]] };
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, area, {}, { fetch: neverFetch() });
  const filter = {
    where: [{ col: 'confidence', op: '>=', value: 0.9 }],
    columns: { include: ['confidence'] },
    spatial: { mode: 'intersects' },
    limit: 50,
  };
  const est = await rawEstimate(plan, filter, {});

  const w = est.warnings.find((x) => x.code === 'raw-passthrough-unfiltered');
  assert.ok(w, 'expected a raw-passthrough-unfiltered warning');
  assert.deepEqual(w.dropped, ['where', 'columns', 'spatial-row-level', 'limit']);
});

test('rawEstimate omits raw-passthrough-unfiltered when nothing row-level was requested', async () => {
  const parts = [{ url: 'https://example.test/a.parquet', bytes: 10 }];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: neverFetch() });
  const est = await rawEstimate(plan, { spatial: { mode: 'bbox' } }, {});

  assert.equal(est.warnings.some((x) => x.code === 'raw-passthrough-unfiltered'), false);
});

// Item 1 (whole-branch review, Critical): `filter.limit` is silently
// dropped on the raw path with no disclosure -- reachable via the demo's
// "Max rows" input sitting directly above the format picker that offers
// parquet-raw. A standalone case (no where/columns/spatial) pins that
// `limit` alone is enough to trigger the warning.
test('rawEstimate discloses a dropped filter.limit even when nothing else was requested', async () => {
  const parts = [{ url: 'https://example.test/a.parquet', bytes: 10 }];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: neverFetch() });
  const est = await rawEstimate(plan, { limit: 10 }, {});

  const w = est.warnings.find((x) => x.code === 'raw-passthrough-unfiltered');
  assert.ok(w, 'expected a raw-passthrough-unfiltered warning naming the dropped limit');
  assert.deepEqual(w.dropped, ['limit']);
  // DownloadResult.truncated stays false on the raw path regardless --
  // this warning is disclosure, not a behavior change to that field.
});

test('rawEstimate omits raw-passthrough-unfiltered when filter.limit is absent', async () => {
  const parts = [{ url: 'https://example.test/a.parquet', bytes: 10 }];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: neverFetch() });
  const est = await rawEstimate(plan, {}, {});

  assert.equal(est.warnings.some((x) => x.code === 'raw-passthrough-unfiltered'), false);
});

// Item 2 (whole-branch review, Important): `spatial-row-level` must fire
// for `mode: 'bbox'` too (it still filters rows on the decoded path) and
// must be driven by whether an AREA was passed, not by `spatial.mode` --
// the prior condition fired on mode alone, which the test below's "no
// area" half would have let pass undetected if the fix regressed back to
// checking mode instead.
test('rawEstimate warns spatial-row-level for mode "bbox" when an area is present', async () => {
  const parts = [{ url: 'https://example.test/a.parquet', bbox: [0, 0, 1, 1], bytes: 10 }];
  const area = { bboxes: [[0, 0, 1, 1]] };
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, area, {}, { fetch: neverFetch() });
  const est = await rawEstimate(plan, { spatial: { mode: 'bbox' } }, {});

  const w = est.warnings.find((x) => x.code === 'raw-passthrough-unfiltered');
  assert.ok(w, 'expected a raw-passthrough-unfiltered warning');
  assert.deepEqual(w.dropped, ['spatial-row-level']);
});

test('rawEstimate does not warn spatial-row-level when no area was passed, even with mode "intersects"', async () => {
  const parts = [{ url: 'https://example.test/a.parquet', bytes: 10 }];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: neverFetch() });
  const est = await rawEstimate(plan, { spatial: { mode: 'intersects' } }, {});

  assert.equal(est.warnings.some((x) => x.code === 'raw-passthrough-unfiltered'), false);
});

test('ceiling.exceeded is not set from an unknown size alone (R9)', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://example.test/unknown.parquet') throw new Error('network down');
    throw new Error(`unexpected fetch: ${url}`);
  };
  const parts = [
    { url: 'https://example.test/known.parquet', bytes: 1000 },
    { url: 'https://example.test/unknown.parquet' },
  ];
  const plan = await planRaw({ source: { kind: 'parquet-set', parts } }, null, {}, { fetch: fetchImpl });
  const est = await rawEstimate(plan, {}, {});

  assert.equal(est.outputBytes.exact, false);
  assert.equal(est.outputBytes.max, Infinity);
  assert.equal(est.readBytes.exact, false);
  assert.equal(est.readBytes.max, Infinity);
  assert.equal(est.ceiling.exceeded, false, `unexpected breaches: ${JSON.stringify(est.ceiling.breaches)}`);
  assert.deepEqual(est.ceiling.breaches, []);
});

test('rawZipEntryNames preserves partition layout relative to the parts\' common prefix (R10)', () => {
  const parts = [
    { url: 'https://example.test/detections/acq_date=2026-09-01/part-0.parquet' },
    { url: 'https://example.test/detections/acq_date=2026-09-02/part-0.parquet' },
  ];
  const { parts: names, attribution } = rawZipEntryNames(parts);
  assert.deepEqual(names, ['acq_date=2026-09-01/part-0.parquet', 'acq_date=2026-09-02/part-0.parquet']);
  assert.equal(attribution, 'ATTRIBUTION.txt');
});

test('rawZipEntryNames falls back to the full path when parts share no partition-level prefix', () => {
  const parts = [
    { url: 'https://example.test/a.parquet' },
    { url: 'https://example.test/b.parquet' },
  ];
  const { parts: names } = rawZipEntryNames(parts);
  assert.deepEqual(names, ['a.parquet', 'b.parquet']);
});

test('planRaw refuses an unsupported source kind with FORMAT_CAPABILITY', async () => {
  const dataset = { source: { kind: 'pmtiles', url: 'https://example.test/x.pmtiles' } };
  await assert.rejects(
    planRaw(dataset, null, {}, { fetch: neverFetch() }),
    (err) => err.code === 'FORMAT_CAPABILITY',
  );
});
