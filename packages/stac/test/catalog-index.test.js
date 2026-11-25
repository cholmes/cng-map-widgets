// CatalogIndex: loading a `collections.parquet` catalog index. The index is a
// real parquet file built in memory (helpers/fake-index.js), shaped like the
// Portolan registry's; only the network is faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogIndex } from '../src/catalog-index.js';
import { itemsHost } from './helpers/fake-items.js';
import { buildIndex, columnRanges, catalogJson, COLLECTIONS, INDEX_URL, CATALOG_URL, hrefOf } from './helpers/fake-index.js';

const byKey = (index, key) => index.entries.find((e) => e.key === hrefOf(COLLECTIONS.find((c) => c.key === key)));

test('load() reads the light columns once and gives collections and catalogs apart', async () => {
  const host = itemsHost({ [INDEX_URL]: buildIndex() });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  assert.deepEqual(index.entries, [], 'nothing before load()');
  await index.load();
  assert.equal(index.entries.length, 8);
  assert.deepEqual(index.catalogs.map((c) => c.id), ['kenya', 'global', 'pacific']);
  assert.deepEqual(index.catalogs[0], { id: 'kenya', title: 'Open data of Kenya', href: 'https://data.invalid/kenya/catalog.json' });
  assert.deepEqual(byKey(index, 'roads'), {
    key: 'https://data.invalid/kenya/roads/collection.json',
    id: 'roads',
    title: 'Roads of Kenya',
    description: 'Primary and secondary roads, from the national survey.',
    href: 'https://data.invalid/kenya/roads/collection.json',
    license: 'CC-BY-4.0',
    keywords: ['transport', 'roads'],
    catalog: 'kenya',
    catalogs: ['kenya'],
    parents: [{ id: 'kenya', href: 'https://data.invalid/kenya/catalog.json' }],
    bbox: [33.9, -4.7, 41.9, 5.5],
    start: '2020-01-01T00:00:00.000Z',
    end: '2021-01-01T00:00:00.000Z',
    kinds: [],
    thumbnail: null,
    render: null,
    attribution: null,
  });
  assert.equal(index.hasRender, false);
});

// The live index is 20 MB, of which `original` is 12.5 MB and `links` 5.6 MB.
test('the fat columns are never requested', async () => {
  const bytes = buildIndex();
  const host = itemsHost({ [INDEX_URL]: bytes });
  await new CatalogIndex(INDEX_URL, { fetch: host.fetch }).load();
  const ranges = columnRanges(bytes);
  const overlaps = ([a, b], [c, d]) => a < d && c < b;
  // Not the footer read (which runs to the end of a file this small) and not the one-byte size probe.
  const reads = host.log.filter((r) => r.range && !r.footer && r.range[1] - r.range[0] > 1).map((r) => r.range);
  assert.ok(reads.length > 0);
  // (`geometry` is not asked for either, but in this fixture it is four bytes
  // a row between two wanted columns, and the reader rightly merges a gap
  // that small into one read. In the real index it is 146 KB and is skipped.)
  for (const fat of ['original', 'links']) {
    assert.deepEqual(reads.filter((r) => overlaps(r, ranges[fat])), [], `${fat} was read`);
  }
  const read = reads.reduce((sum, [a, b]) => sum + (b - a), 0);
  assert.ok(read < bytes.byteLength / 4, `read ${read} of ${bytes.byteLength} bytes`);
});

test('bbox, times and keywords are plain values; what is missing is null or empty', async () => {
  const host = itemsHost({ [INDEX_URL]: buildIndex() });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  const fiji = byKey(index, 'fiji');
  assert.deepEqual(fiji.bbox, [177, -19, -178, -16], 'an antimeridian box keeps west > east');
  assert.equal(fiji.start, null);
  assert.equal(fiji.end, null);
  assert.equal(byKey(index, 'nairobi').end, null, 'open-ended');
  assert.doesNotThrow(() => JSON.stringify(index.entries));
  assert.ok(index.entries.every((e) => Array.isArray(e.keywords) && Array.isArray(e.kinds) && Array.isArray(e.parents)));
});

test('a catalog.json URL is followed to its rel:data parquet link', async () => {
  const host = itemsHost({ [CATALOG_URL]: catalogJson(), [INDEX_URL]: buildIndex() });
  const index = new CatalogIndex(CATALOG_URL, { fetch: host.fetch });
  await index.load();
  assert.equal(index.entries.length, 8);
  assert.equal(index.indexUrl, INDEX_URL);
});

test('a catalog with no parquet link is CATALOG_INDEX_INVALID', async () => {
  const host = itemsHost({ [CATALOG_URL]: { type: 'Catalog', id: 'x', links: [{ rel: 'child', href: './a/catalog.json' }] } });
  await assert.rejects(new CatalogIndex(CATALOG_URL, { fetch: host.fetch }).load(), (e) => {
    assert.equal(e.code, 'CATALOG_INDEX_INVALID');
    assert.equal(e.retryable, false);
    assert.equal(e.context.url, CATALOG_URL);
    return true;
  });
});

test('an index with no id or href column is CATALOG_INDEX_INVALID, naming it', async () => {
  const host = itemsHost({ [INDEX_URL]: buildIndex({ without: ['href'] }) });
  await assert.rejects(new CatalogIndex(INDEX_URL, { fetch: host.fetch }).load(), (e) => e.code === 'CATALOG_INDEX_INVALID' && e.context.missing.includes('href'));
});

test('an index with only the essentials still loads', async () => {
  const host = itemsHost({ [INDEX_URL]: buildIndex({ without: ['type', 'description', 'license', 'keywords', 'parents', 'bbox', 'start_datetime', 'end_datetime', 'portolan_registry:id', 'geometry', 'links', 'original'] }) });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  // With no `type` column every row is taken for a collection.
  assert.equal(index.entries.length, 11);
  assert.deepEqual(index.catalogs, []);
  const entry = index.entries.find((e) => e.id === 'roads');
  assert.deepEqual([entry.bbox, entry.license, entry.catalog, entry.description], [null, null, null, '']);
});

test('an index with a render column reports hasRender, and each entry its kinds and thumbnail', async () => {
  const host = itemsHost({ [INDEX_URL]: buildIndex({ withRender: true }) });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  assert.equal(index.hasRender, true);
  assert.deepEqual(byKey(index, 'roads').kinds, ['pmtiles-vector']);
  assert.deepEqual(byKey(index, 'census').kinds, ['table']);
  assert.equal(byKey(index, 'roads').thumbnail, 'https://data.invalid/kenya/roads/thumbnail.png');
  assert.equal(byKey(index, 'roads').render[0].url, 'https://data.invalid/kenya/roads/roads.pmtiles');
  assert.deepEqual(byKey(index, 'roads').render[0].layers, ['roads']);
});

// Measured on the live registry: 108 of 7,049 collection rows repeat another
// row's `href` -- the same collection, listed twice. One collection is one
// result, and one thing to add to a map.
test('a collection listed twice is one entry', async () => {
  const host = itemsHost({ [INDEX_URL]: buildIndex({ duplicate: 'roads' }) });
  const index = new CatalogIndex(INDEX_URL, { fetch: host.fetch });
  await index.load();
  assert.equal(index.entries.length, 8);
  assert.equal(new Set(index.entries.map((e) => e.key)).size, 8);
  assert.equal(index.duplicates, 1);
});

test('load() is idempotent, and a failed load is tried again', async () => {
  let fail = true;
  const real = itemsHost({ [INDEX_URL]: buildIndex() });
  const fetch = (url, init) => (fail ? Promise.resolve(new Response(null, { status: 503 })) : real.fetch(url, init));
  const index = new CatalogIndex(INDEX_URL, { fetch });
  await assert.rejects(index.load());
  fail = false;
  await Promise.all([index.load(), index.load()]);
  const requests = real.log.length;
  await index.load();
  assert.equal(real.log.length, requests);
  assert.equal(index.entries.length, 8);
});
