// @cng/download-core -- whole-branch review item 9 (one-liners):
// `finalizeEstimate` called `format.estimateBytes(...)` unguarded. The
// public `estimate()`/`download()` surface never hits this (`format` there
// only ever comes from `getFormat()`/`formatOverride`, both of which
// resolve a real, registered `FormatPlugin`), but anyone importing
// `finalizeEstimate` directly from `src/estimate.js` -- this file's own
// approach, matching ceiling-wiring.test.js/download-size-warnings.test.js
// -- or registering a descriptor missing `estimateBytes`, used to hit a
// bare `TypeError` instead of a named `FORMAT_CAPABILITY` (an existing
// code; "codes are the API", AGENTS.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEstimate } from '../src/estimate.js';
import { boundedExact } from '../src/bounded.js';

const FILTER = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };

/** A complete-enough `planRequest()`-shaped plan for `finalizeEstimate` to run against for real. */
function minimalPlan() {
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
    rows: boundedExact(10),
    readBytes: boundedExact(100),
    requests: 1,
  };
}

test('finalizeEstimate throws FORMAT_CAPABILITY, not a bare TypeError, for a formatOverride missing estimateBytes', async () => {
  const plan = minimalPlan();
  const brokenFormat = { id: 'broken-format', streaming: true }; // no estimateBytes at all

  await assert.rejects(
    finalizeEstimate(plan, null, FILTER, { formatOverride: brokenFormat }),
    (err) => {
      assert.equal(err.code, 'FORMAT_CAPABILITY');
      assert.match(err.message, /broken-format/);
      return true;
    },
  );
});

test('finalizeEstimate does not throw when outputBytesOverride is supplied, even for a format missing estimateBytes', async () => {
  const plan = minimalPlan();
  const brokenFormat = { id: 'broken-format', streaming: true };

  const est = await finalizeEstimate(plan, null, FILTER, { formatOverride: brokenFormat, outputBytesOverride: boundedExact(123) });
  assert.equal(est.outputBytes.estimate, 123);
});

test('finalizeEstimate still works normally when format is absent (generic model)', async () => {
  const plan = minimalPlan();
  const est = await finalizeEstimate(plan, null, FILTER, {});
  assert.ok(est.outputBytes.estimate >= 0);
});
