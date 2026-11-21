import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumeratePartitions, partitionPruneCascade, resolveMirrorPartUrl } from '../src/partitions.js';
import { setHyparquetModules, clearHyparquetModules } from '../src/cdn.js';

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

// Real catalogs (firms-catalog, s2-stac-geoparquet) publish `rel: 'item'`
// links and asset `href`s as relative URLs -- "./year=2026/2026.json" from
// the collection document, "./detections.parquet" from the item document.
// Regression test for the bug where `enumerateStacItems` fetched
// `itemLinks[i].href` and `dataAsset.href` verbatim instead of resolving
// them against their containing document's URL, which 404s (or throws, in
// Node) against every real STAC-GeoParquet catalog of this shape.
test('enumeratePartitions: stac-items enumeration resolves relative item and asset hrefs against their containing document', async () => {
  const collectionUrl = 'https://example.test/mock/detections/collection.json';
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (url === collectionUrl) {
      return {
        ok: true,
        json: async () => ({
          links: [
            { rel: 'item', href: './year=2025/2025.json' },
            { rel: 'item', href: './year=2026/2026.json' },
          ],
        }),
      };
    }
    if (url === 'https://example.test/mock/detections/year=2025/2025.json') {
      return {
        ok: true,
        json: async () => ({
          bbox: [-10, -10, 10, 10],
          properties: { start_datetime: '2025-01-01T00:00:00Z', end_datetime: '2025-12-31T23:59:59Z' },
          assets: { data: { href: './detections.parquet', roles: ['data'] } },
        }),
      };
    }
    if (url === 'https://example.test/mock/detections/year=2026/2026.json') {
      return {
        ok: true,
        json: async () => ({
          bbox: [-20, -20, 20, 20],
          properties: { start_datetime: '2026-01-01T00:00:00Z', end_datetime: '2026-09-14T00:00:00Z' },
          assets: { data: { href: './detections.parquet', roles: ['data'] } },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const source = {
    kind: 'hive',
    scheme: 'hive',
    glob: 'https://example.test/mock/detections/year=*/*.parquet',
    keys: [{ name: 'year', type: 'int32' }],
    enumeration: { kind: 'stac-items', collectionUrl },
  };
  const { parts, requests } = await enumeratePartitions(source, { fetch: fetchImpl });

  assert.equal(requests, 3); // 1 collection + 2 items
  assert.deepEqual(
    parts.map((p) => p.url),
    [
      'https://example.test/mock/detections/year=2025/detections.parquet',
      'https://example.test/mock/detections/year=2026/detections.parquet',
    ],
  );
  assert.deepEqual(parts[0].bbox, [-10, -10, 10, 10]);
  assert.deepEqual(parts[0].interval, ['2025-01-01T00:00:00Z', '2025-12-31T23:59:59Z']);
  assert.ok(calls.includes(collectionUrl));

  // Regression: a stac-items-enumerated part must carry `.keys` (recovered
  // from its own hive-style URL), or `partitionPruneCascade`'s explicit
  // `filter.partitions` stage silently narrows nothing -- `!p.keys` reads
  // as "unknown, so keep it" for every part.
  assert.deepEqual(parts[0].keys, { year: 2025 });
  assert.deepEqual(parts[1].keys, { year: 2026 });
  const { selected } = partitionPruneCascade(parts, null, undefined, { year: { op: 'in', values: [2026] } });
  assert.deepEqual(selected.map((p) => p.keys.year), [2026]);
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

// --- resolveMirrorPartUrl: a collection-mirror row's relative asset href
// (design doc §2.1 PartitionEnumeration; found against the live Fields of
// the World 2019 collection, whose mirror stores `./utm01.parquet` for an
// item that actually lives in `zone=01/`). ---

const FTW_MIRROR = 'https://data.source.coop/ftw/global-data-2e/vector/2019/items.parquet';

test('resolveMirrorPartUrl: an already-absolute href is returned untouched', () => {
  const row = { assets: { data: { href: 'https://example.test/a/b.parquet' } } };
  assert.equal(resolveMirrorPartUrl(row, FTW_MIRROR), 'https://example.test/a/b.parquet');
});

test('resolveMirrorPartUrl: a relative href resolves against the row\'s own self link', () => {
  const row = {
    assets: { data: { href: './utm01.parquet' } },
    links: [{ rel: 'self', href: 'https://data.source.coop/ftw/global-data-2e/vector/2019/zone=01/utm01.json' }],
  };
  assert.equal(
    resolveMirrorPartUrl(row, FTW_MIRROR),
    'https://data.source.coop/ftw/global-data-2e/vector/2019/zone=01/utm01.parquet',
  );
});

test('resolveMirrorPartUrl: FTW\'s real shape -- a relative href recovers its hive directory from the s3 alternate', () => {
  // Exactly the row shape read off the live mirror: a relative href, no
  // self link, no `zone` column, and an `alternate.s3.href` carrying the
  // full path. This is the case that made every estimate fail.
  const row = {
    id: 'utm01',
    assets: {
      data: {
        href: './utm01.parquet',
        alternate: { s3: { href: 's3://ftw/global-data-2e/vector/2019/zone=01/utm01.parquet' } },
      },
    },
  };
  assert.equal(
    resolveMirrorPartUrl(row, FTW_MIRROR),
    'https://data.source.coop/ftw/global-data-2e/vector/2019/zone=01/utm01.parquet',
  );
});

test('resolveMirrorPartUrl: with neither self link nor alternate, falls back to the mirror\'s own directory', () => {
  const row = { assets: { data: { href: './flat.parquet' } } };
  assert.equal(
    resolveMirrorPartUrl(row, FTW_MIRROR),
    'https://data.source.coop/ftw/global-data-2e/vector/2019/flat.parquet',
  );
});

test('resolveMirrorPartUrl: never returns a bare relative string once a mirror URL is known', () => {
  for (const href of ['./a.parquet', 'a.parquet', '../up/a.parquet', '/abs/a.parquet']) {
    const out = resolveMirrorPartUrl({ assets: { data: { href } } }, FTW_MIRROR);
    assert.ok(/^https:\/\//.test(out), `${href} -> ${out}`);
  }
});

test('enumeratePartitions: a collection-mirror yields absolute part URLs and recovers hive keys from them', async () => {
  // A mirror whose rows look like FTW's, served through an injected
  // hyparquet so the test stays offline.
  const rows = [
    {
      id: 'utm01',
      bbox: { xmin: -175.3, ymin: -21.2, xmax: -175.0, ymax: -21.0 },
      'table:row_count': 7335,
      assets: {
        data: {
          href: './utm01.parquet',
          'file:size': 4379586,
          alternate: { s3: { href: 's3://ftw/global-data-2e/vector/2019/zone=01/utm01.parquet' } },
        },
      },
    },
    {
      id: 'utm10',
      bbox: { xmin: -124.5, ymin: 34.4, xmax: -119.1, ymax: 57.7 },
      'table:row_count': 305720,
      assets: {
        data: {
          href: './utm10.parquet',
          'file:size': 282789498,
          alternate: { s3: { href: 's3://ftw/global-data-2e/vector/2019/zone=10/utm10.parquet' } },
        },
      },
    },
  ];
  setHyparquetModules({
    hyparquet: {
      asyncBufferFromUrl: async () => ({}),
      parquetMetadataAsync: async () => ({}),
      parquetReadObjects: async () => rows,
    },
    compressors: {},
  });
  try {
    const { parts, requests } = await enumeratePartitions({
      kind: 'hive',
      scheme: 'hive',
      glob: 'https://data.source.coop/ftw/global-data-2e/vector/2019/zone=*/utm*.parquet',
      keys: [{ name: 'zone', type: 'string' }],
      enumeration: { kind: 'collection-mirror', url: FTW_MIRROR },
    });
    assert.equal(requests, 1);
    assert.deepEqual(parts.map((p) => p.url), [
      'https://data.source.coop/ftw/global-data-2e/vector/2019/zone=01/utm01.parquet',
      'https://data.source.coop/ftw/global-data-2e/vector/2019/zone=10/utm10.parquet',
    ]);
    // The hive key the mirror never stored as a column, read back off the URL.
    assert.deepEqual(parts.map((p) => p.keys), [{ zone: '01' }, { zone: '10' }]);
    assert.deepEqual(parts[0].bbox, [-175.3, -21.2, -175.0, -21.0]);
    assert.equal(parts[0].rowCount, 7335);
  } finally {
    clearHyparquetModules();
  }
});
