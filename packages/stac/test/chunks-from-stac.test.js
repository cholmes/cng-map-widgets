// Timeline chunks from a STAC collection: one per item that has dates and a
// tiles asset. Shaped like the live FIRMS collection (measured 2026-11-25): 27
// `rel: item` links, one a year, each item with start/end datetimes and a
// `pmtiles` asset beside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunksFromStac } from '../src/chunks-from-stac.js';

const BASE = 'https://data.invalid/firms/detections';
const COLLECTION_URL = `${BASE}/collection.json`;
const YEARS = Array.from({ length: 27 }, (_, i) => 2000 + i);

const item = (year) => ({
  type: 'Feature',
  stac_version: '1.1.0',
  id: String(year),
  properties: {
    datetime: null,
    start_datetime: year === 2000 ? '2000-11-01T00:13:00Z' : `${year}-01-01T00:02:00Z`,
    end_datetime: year === 2026 ? '2026-11-24T22:10:00Z' : `${year}-12-31T23:47:00Z`,
  },
  assets: {
    data: { href: './detections.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] },
    pmtiles: { href: `./fire-${year}.pmtiles`, type: 'application/vnd.pmtiles', roles: ['visual', 'tiles'] },
    'style-default': { href: './styles/default.json', type: 'application/vnd.mapbox.style+json', roles: ['style', 'default'] },
  },
});

const collection = (years = YEARS) => ({
  type: 'Collection',
  id: 'detections',
  links: [
    { rel: 'root', href: '../catalog.json' },
    { rel: 'pmtiles', href: './fire-latest.pmtiles', type: 'application/vnd.pmtiles' },
    ...years.map((y) => ({ rel: 'item', href: `./year=${y}/${y}.json`, type: 'application/geo+json' })),
  ],
});

/** A host for the items; `override(year)` may return a Response, a body, or 'hang'. */
function host(override = () => undefined) {
  const log = [];
  const fetch = async (url) => {
    log.push(String(url));
    const year = Number(/year=(\d{4})\//.exec(String(url))?.[1]);
    const special = override(year);
    if (special === 'hang') return new Promise(() => {});
    if (special instanceof Response) return special;
    return new Response(JSON.stringify(special ?? item(year)), { status: 200 });
  };
  return { fetch, log };
}

test('one chunk per item: its days in UTC, its tiles asset made absolute', async () => {
  const { fetch, log } = host();
  const { chunks, skipped } = await chunksFromStac(collection(), { baseUrl: COLLECTION_URL, fetch });
  assert.equal(chunks.length, 27);
  assert.deepEqual(skipped, []);
  assert.equal(log.length, 27);
  assert.deepEqual(chunks[0], { id: '2000', start: '20001101', end: '20001231', unit: 'day', format: 'pmtiles', url: `${BASE}/year=2000/fire-2000.pmtiles`, priority: 0 });
  assert.deepEqual(chunks.at(-1), { id: '2026', start: '20260101', end: '20261124', unit: 'day', format: 'pmtiles', url: `${BASE}/year=2026/fire-2026.pmtiles`, priority: 0 });
  assert.deepEqual(chunks.map((c) => c.id), YEARS.map(String), 'in order of time, whatever order the answers came in');
});

test('an item that is gone, and one with no tiles, are skipped with the reason; the rest are chunks', async () => {
  const { fetch } = host((year) => {
    if (year === 2005) return new Response(null, { status: 404 });
    if (year === 2010) return { ...item(2010), assets: { data: item(2010).assets.data } };
    return undefined;
  });
  const { chunks, skipped } = await chunksFromStac(collection(), { baseUrl: COLLECTION_URL, fetch });
  assert.equal(chunks.length, 25);
  assert.equal(chunks.some((c) => c.id === '2005' || c.id === '2010'), false);
  assert.deepEqual(skipped.map((s) => s.href), [`${BASE}/year=2005/2005.json`, `${BASE}/year=2010/2010.json`]);
  assert.match(skipped[0].reason, /404/);
  assert.match(skipped[1].reason, /application\/vnd\.pmtiles/);
});

test('an item with no dates, or that is not JSON, is skipped too', async () => {
  const { fetch } = host((year) => {
    if (year === 2001) return { ...item(2001), properties: { datetime: null } };
    if (year === 2002) return new Response('<html>', { status: 200 });
    return undefined;
  });
  const { chunks, skipped } = await chunksFromStac(collection([2000, 2001, 2002]), { baseUrl: COLLECTION_URL, fetch });
  assert.deepEqual(chunks.map((c) => c.id), ['2000']);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /date/);
});

test('an item with one instant is a chunk of that one day', async () => {
  const { fetch } = host(() => ({ ...item(2003), properties: { datetime: '2003-06-15T12:00:00Z' } }));
  const { chunks } = await chunksFromStac(collection([2003]), { baseUrl: COLLECTION_URL, fetch });
  assert.deepEqual([chunks[0].start, chunks[0].end], ['20030615', '20030615']);
});

test('the tiles asset is the one with role "tiles", then "visual", then any of the type', async () => {
  const assets = {
    other: { href: './other.pmtiles', type: 'application/vnd.pmtiles', roles: ['data'] },
    look: { href: './look.pmtiles', type: 'application/vnd.pmtiles', roles: ['visual'] },
    tiles: { href: 'https://cdn.invalid/t.pmtiles', type: 'application/vnd.pmtiles', roles: ['tiles'] },
  };
  const pick = async (keep) => {
    const { fetch } = host(() => ({ ...item(2003), assets: Object.fromEntries(keep.map((k) => [k, assets[k]])) }));
    return (await chunksFromStac(collection([2003]), { baseUrl: COLLECTION_URL, fetch })).chunks[0].url;
  };
  assert.equal(await pick(['other', 'look', 'tiles']), 'https://cdn.invalid/t.pmtiles');
  assert.equal(await pick(['other', 'look']), `${BASE}/year=2003/look.pmtiles`);
  assert.equal(await pick(['other']), `${BASE}/year=2003/other.pmtiles`);
});

test('unit, format and asset type can be said; a collection with no items gives nothing', async () => {
  const { fetch } = host(() => ({ ...item(2003), assets: { cells: { href: './cells.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] } } }));
  const { chunks } = await chunksFromStac(collection([2003]), { baseUrl: COLLECTION_URL, fetch, unit: 'month', format: 'geoparquet', assetType: 'application/vnd.apache.parquet' });
  assert.deepEqual(chunks[0], { id: '2003', start: '20030101', end: '20031231', unit: 'month', format: 'geoparquet', url: `${BASE}/year=2003/cells.parquet`, priority: 0 });
  assert.deepEqual(await chunksFromStac({ type: 'Collection', id: 'x', links: [] }, { baseUrl: COLLECTION_URL, fetch }), { chunks: [], skipped: [] });
  assert.deepEqual(await chunksFromStac({ type: 'Collection', id: 'x' }, { baseUrl: COLLECTION_URL, fetch }), { chunks: [], skipped: [] });
});

test('an item whose host never answers is skipped after the time limit, and does not hold up the rest', async () => {
  const { fetch } = host((year) => (year === 2001 ? 'hang' : undefined));
  const started = Date.now();
  const { chunks, skipped } = await chunksFromStac(collection([2000, 2001, 2002]), { baseUrl: COLLECTION_URL, fetch, timeoutMs: 100 });
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(chunks.map((c) => c.id), ['2000', '2002']);
  assert.match(skipped[0].reason, /did not answer/);
});

test('no more than `concurrency` items are fetched at once', async () => {
  let open = 0;
  let most = 0;
  const fetch = async (url) => {
    open += 1;
    most = Math.max(most, open);
    await new Promise((r) => setTimeout(r, 2));
    open -= 1;
    const year = Number(/year=(\d{4})\//.exec(String(url))[1]);
    return new Response(JSON.stringify(item(year)), { status: 200 });
  };
  const { chunks } = await chunksFromStac(collection(), { baseUrl: COLLECTION_URL, fetch, concurrency: 4 });
  assert.equal(chunks.length, 27);
  assert.ok(most <= 4, `${most} at once`);
});

test('two items with one id get ids of their own', async () => {
  const { fetch } = host((year) => ({ ...item(year), id: 'detections' }));
  const { chunks } = await chunksFromStac(collection([2003, 2004]), { baseUrl: COLLECTION_URL, fetch });
  assert.equal(new Set(chunks.map((c) => c.id)).size, 2);
});

// Review. `Date.parse` reads a date-time with no zone in the MACHINE's zone,
// so one catalog gave different days to a reader in Berlin and one in London.
test('a date-time with no zone is read as UTC, wherever this runs', async () => {
  const before = process.env.TZ;
  try {
    for (const zone of ['Europe/Berlin', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      const { fetch } = host(() => ({ ...item(2024), properties: { start_datetime: '2024-01-01T00:00:00', end_datetime: '2024-12-31T23:59:59' } }));
      const { chunks } = await chunksFromStac(collection([2024]), { baseUrl: COLLECTION_URL, fetch });
      assert.deepEqual([chunks[0].start, chunks[0].end], ['20240101', '20241231'], zone);
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

// An interval that ends at exactly midnight ends BEFORE that day: read as
// including it, 2023 owned the first of January 2024 and showed it as zero.
test('an interval ending at midnight does not include the day that starts then', async () => {
  const { fetch } = host(() => ({ ...item(2023), properties: { start_datetime: '2023-01-01T00:00:00Z', end_datetime: '2024-01-01T00:00:00Z' } }));
  const { chunks } = await chunksFromStac(collection([2023]), { baseUrl: COLLECTION_URL, fetch });
  assert.deepEqual([chunks[0].start, chunks[0].end], ['20230101', '20231231']);
  // ...but one instant at midnight is still that day.
  const one = host(() => ({ ...item(2023), properties: { datetime: '2023-06-01T00:00:00Z' } }));
  const single = await chunksFromStac(collection([2023]), { baseUrl: COLLECTION_URL, fetch: one.fetch });
  assert.deepEqual([single.chunks[0].start, single.chunks[0].end], ['20230601', '20230601']);
});
