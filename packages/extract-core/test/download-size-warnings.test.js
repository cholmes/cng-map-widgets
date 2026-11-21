// @cngeo/extract-core -- `large-download` and `slow-download` warnings
// (Task 5, the counterpart to this plan's raised ceilings: tell the user
// before any bytes move that what they asked for is big and will take a
// while). These are warnings only -- they travel on `est.warnings` next to
// the existing codes, never block, and carry no progress-based refinement.
//
// Exercises `finalizeEstimate` directly with a `planRequest()`-shaped plan
// (same approach as ceiling-wiring.test.js's `minimalPlan`), plus
// `outputBytesOverride` to fix `outputBytes.estimate` without a real
// format plugin or network fetch -- no cross-package import, no engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEstimate } from '../src/estimate.js';
import { boundedExact } from '../src/bounded.js';

const FILTER = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } };
const GiB = 1024 ** 3;

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

async function estimateWithOutputBytes(bytes, extraOptions = {}) {
  const plan = minimalPlan();
  return finalizeEstimate(plan, null, FILTER, { outputBytesOverride: boundedExact(bytes), ...extraOptions });
}

test('large-download fires above 1 GiB and carries bytes plus an ETA', async () => {
  const bytes = 2 * GiB;
  const est = await estimateWithOutputBytes(bytes);
  const warning = est.warnings.find((w) => w.code === 'large-download');
  assert.ok(warning, `expected a large-download warning, got ${JSON.stringify(est.warnings)}`);
  assert.equal(warning.bytes, bytes);
  assert.equal(warning.estimatedSeconds, Math.round(bytes / 10_000_000));
});

test('large-download does not fire at exactly the threshold', async () => {
  const est = await estimateWithOutputBytes(1 * GiB);
  assert.ok(
    !est.warnings.some((w) => w.code === 'large-download'),
    `expected no large-download warning, got ${JSON.stringify(est.warnings)}`,
  );
});

test('slow-download fires when the ETA exceeds 120s', async () => {
  const bytes = 2 * GiB; // ~215s at the default 10 MB/s assumed throughput
  const est = await estimateWithOutputBytes(bytes);
  const warning = est.warnings.find((w) => w.code === 'slow-download');
  assert.ok(warning, `expected a slow-download warning, got ${JSON.stringify(est.warnings)}`);
  assert.equal(warning.estimatedSeconds, Math.round(bytes / 10_000_000));
  assert.ok(warning.estimatedSeconds > 120);
});

test('throughputBytesPerSecond changes the ETA and can clear slow-download', async () => {
  const bytes = 2 * GiB;
  const est = await estimateWithOutputBytes(bytes, { throughputBytesPerSecond: 1_000_000_000 });
  assert.ok(
    !est.warnings.some((w) => w.code === 'slow-download'),
    `expected no slow-download warning, got ${JSON.stringify(est.warnings)}`,
  );
  const large = est.warnings.find((w) => w.code === 'large-download');
  assert.ok(large, 'large-download should still fire -- only the ETA changed');
  assert.equal(large.estimatedSeconds, Math.round(bytes / 1_000_000_000));
});

test('neither fires on a small download', async () => {
  const est = await estimateWithOutputBytes(10 * 1024 * 1024); // 10 MiB
  assert.ok(
    !est.warnings.some((w) => w.code === 'large-download' || w.code === 'slow-download'),
    `expected neither warning, got ${JSON.stringify(est.warnings)}`,
  );
});
