import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumeratePartitions, partitionPruneCascade } from '../src/partitions.js';

// Synthetic FIRMS-shaped hive source (design doc §2.7 worked example):
// year=* partitions, declared values -- the 'declared' enumeration needs
// zero HTTP requests.
const firmsLikeSource = {
  kind: 'hive',
  scheme: 'hive',
  glob: 'https://example.test/detections/year=*/data.parquet',
  keys: [{ name: 'year', type: 'int32', values: [2023, 2024, 2025, 2026] }],
  strategy: 'temporal',
  enumeration: { kind: 'declared' },
};

test('enumeratePartitions: declared enumeration cross-products key values into concrete URLs with zero requests', async () => {
  const { parts, requests } = await enumeratePartitions(firmsLikeSource);
  assert.equal(requests, 0);
  assert.deepEqual(
    parts.map((p) => p.url),
    [
      'https://example.test/detections/year=2023/data.parquet',
      'https://example.test/detections/year=2024/data.parquet',
      'https://example.test/detections/year=2025/data.parquet',
      'https://example.test/detections/year=2026/data.parquet',
    ],
  );
  assert.deepEqual(parts[0].keys, { year: 2023 });
});

test('enumeratePartitions: a declared key with no values throws DATASET_UNRESOLVED', async () => {
  const bad = { kind: 'hive', scheme: 'hive', glob: 'https://x/year=*/d.parquet', keys: [{ name: 'year', type: 'int32' }], enumeration: { kind: 'declared' } };
  await assert.rejects(enumeratePartitions(bad), (err) => err.code === 'DATASET_UNRESOLVED');
});

test('enumeratePartitions: explicit source.parts short-circuits enumeration entirely', async () => {
  const source = { ...firmsLikeSource, parts: [{ url: 'https://example.test/explicit.parquet' }] };
  const { parts, requests } = await enumeratePartitions(source);
  assert.equal(requests, 0);
  assert.deepEqual(parts, [{ url: 'https://example.test/explicit.parquet' }]);
});

test('enumeratePartitions: cross product over two partition keys', async () => {
  const source = {
    kind: 'hive',
    scheme: 'hive',
    glob: 'https://x/a=*/b=*/d.parquet',
    keys: [{ name: 'a', type: 'string', values: ['NL', 'LI'] }, { name: 'b', type: 'int32', values: [1, 2] }],
    enumeration: { kind: 'declared' },
  };
  const { parts } = await enumeratePartitions(source);
  assert.deepEqual(
    parts.map((p) => p.url),
    ['https://x/a=NL/b=1/d.parquet', 'https://x/a=NL/b=2/d.parquet', 'https://x/a=LI/b=1/d.parquet', 'https://x/a=LI/b=2/d.parquet'],
  );
});

// --- partitionPruneCascade: synthetic listing with per-part bbox/interval,
// matching how a collection-mirror would describe its parts (design doc
// §2.7 steps 1-2). ---

function syntheticParts() {
  return [
    { url: 'https://x/year=2023/d.parquet', keys: { year: 2023 }, bbox: [-10, -10, 10, 10], interval: ['2023-01-01T00:00:00Z', '2024-01-01T00:00:00Z'] },
    { url: 'https://x/year=2024/d.parquet', keys: { year: 2024 }, bbox: [-10, -10, 10, 10], interval: ['2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z'] },
    { url: 'https://x/year=2025/d.parquet', keys: { year: 2025 }, bbox: [100, 40, 120, 60], interval: ['2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z'] },
  ];
}

test('partitionPruneCascade: time window prunes to the one overlapping part (zero requests, pure metadata)', () => {
  const { selected, stages } = partitionPruneCascade(syntheticParts(), null, { start: '2024-06-01T00:00:00Z', end: '2024-07-01T00:00:00Z' }, undefined);
  assert.deepEqual(selected.map((p) => p.keys.year), [2024]);
  assert.ok(stages.some((s) => s.stage === 'part-time'));
});

test('partitionPruneCascade: area bbox prunes parts whose declared bbox does not intersect', () => {
  const { selected, stages } = partitionPruneCascade(syntheticParts(), [[-5, -5, 5, 5]], undefined, undefined);
  assert.deepEqual(selected.map((p) => p.keys.year), [2023, 2024]);
  assert.ok(stages.some((s) => s.stage === 'part-bbox'));
});

test('partitionPruneCascade: explicit filter.partitions narrows by key value (in)', () => {
  const { selected, stages } = partitionPruneCascade(syntheticParts(), null, undefined, { year: { op: 'in', values: [2025] } });
  assert.deepEqual(selected.map((p) => p.keys.year), [2025]);
  assert.ok(stages.some((s) => s.stage === 'partition'));
});

test('partitionPruneCascade: explicit filter.partitions "between"', () => {
  const { selected } = partitionPruneCascade(syntheticParts(), null, undefined, { year: { op: 'between', low: 2024, high: 2025 } });
  assert.deepEqual(selected.map((p) => p.keys.year), [2024, 2025]);
});

test('partitionPruneCascade: cascade composes -- time then area narrows further than either alone', () => {
  // Time window overlaps only 2023's interval (ends before 2024 starts);
  // area bbox would otherwise also admit 2024 (same declared bbox as
  // 2023), so this exercises both stages narrowing in sequence.
  const { selected } = partitionPruneCascade(syntheticParts(), [[-5, -5, 5, 5]], { start: '2023-01-01T00:00:00Z', end: '2023-12-31T00:00:00Z' }, undefined);
  assert.deepEqual(selected.map((p) => p.keys.year), [2023]);
});

test('partitionPruneCascade: parts with no bbox/interval metadata at all are never pruned (honest no-op)', () => {
  const bare = [{ url: 'https://x/a.parquet' }, { url: 'https://x/b.parquet' }];
  const { selected } = partitionPruneCascade(bare, [[0, 0, 1, 1]], { start: '2020-01-01', end: '2020-02-01' }, undefined);
  assert.equal(selected.length, 2);
});
