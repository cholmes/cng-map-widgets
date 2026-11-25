// ImagerySearch against in-memory item tables in the three shapes the real
// collections come in (helpers/fake-items.js). Only the network is faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArea, validateLayerSpec } from '@cngeo/spec';
import { readFileSync } from 'node:fs';
import { ImagerySearch, sortScenes } from '../src/imagery-search.js';
import { imageryProfile } from '../src/imagery-profile.js';
import { allHost, itemsHost, naipProfile, oamProfile, s2Profile, naipItems, oamItems, iso, COG_TYPE, NAIP_URL, S2_ITEM_URL } from './helpers/fake-items.js';

const ids = (scenes) => scenes.map((s) => s.id);
const byId = (scenes, id) => scenes.find((s) => s.id === id);
const square = (w, e) => ({ type: 'Polygon', coordinates: [[[w, -1], [e, -1], [e, 2], [w, 2], [w, -1]]] });
const areaOf = (geometry) => buildArea({ name: 'test', geometry, source: 'draw', features: [] });
const window = (from, to) => ({ start: iso(from), end: iso(to), closed: '[)' });

// --- what a scene is --------------------------------------------------------------

test('NAIP-like: scenes carry id, time, bbox, geometry, properties and their struct assets', async () => {
  const host = allHost();
  const { scenes, truncated, matched } = await new ImagerySearch(naipProfile(), { fetch: host.fetch }).search();
  assert.deepEqual(ids(scenes), [7, 6, 5, 4, 3, 2, 1, 0].map((i) => `naip-${i}`), 'newest first by default');
  assert.equal(truncated, false);
  assert.equal(matched, 8);
  assert.deepEqual(byId(scenes, 'naip-0'), {
    id: 'naip-0',
    datetime: iso(1),
    start: null,
    end: null,
    bbox: [0, 0, 0.9, 0.9],
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.9, 0], [0.9, 0.9], [0, 0.9], [0, 0]]] },
    properties: { gsd: 0.3, 'naip:state': 'ca', 'naip:year': 2025 },
    thumbnail: null,
    self: null,
    assets: { image: { href: 'https://imagery.invalid/naip/0.tif', type: COG_TYPE, roles: ['data'] } },
  });
});

test('OpenAerialMap-like: a null datetime, a start and an end, a thumbnail from the assets', async () => {
  const host = allHost();
  const { scenes } = await new ImagerySearch(oamProfile(), { fetch: host.fetch }).search();
  const scene = byId(scenes, 'oam-0');
  assert.equal(scene.datetime, null);
  assert.equal(scene.start, iso(1));
  assert.equal(scene.end, iso(3));
  assert.deepEqual(scene.bbox, [0, 0, 0.9, 0.9]);
  assert.equal(scene.thumbnail, 'https://imagery.invalid/oam/0.png');
  assert.equal(scene.properties.title, 'Flight 0');
  assert.deepEqual(Object.keys(scene.assets), ['visual', 'thumbnail']);
  // Scene 5 has no thumbnail asset: the struct holds a null there, which is not an asset.
  assert.equal(byId(scenes, 'oam-5').thumbnail, null);
  assert.deepEqual(Object.keys(byId(scenes, 'oam-5').assets), ['visual']);
  assert.deepEqual(ids(scenes).slice(0, 2), ['oam-7', 'oam-6'], 'newest first, by start when datetime is null');
});

test('Sentinel-2-like: a list bbox, a thumbnail column, its own item link -- and no assets read', async () => {
  const host = allHost();
  const { scenes } = await new ImagerySearch(s2Profile(), { fetch: host.fetch }).search();
  assert.deepEqual(byId(scenes, 's2-0'), {
    id: 's2-0',
    datetime: iso(1),
    start: null,
    end: null,
    bbox: [0, 0, 0.9, 0.9],
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.9, 0], [0.9, 0.9], [0, 0.9], [0, 0]]] },
    properties: { 'eo:cloud_cover': 0, platform: 'sentinel-2a' },
    thumbnail: 'https://imagery.invalid/s2/0/thumb.jpg',
    self: S2_ITEM_URL(0),
  });
  assert.equal(scenes.length, 8);
});

// --- narrowing -----------------------------------------------------------------------

test('area, time and where narrow the result; sort and limit apply', async () => {
  const host = allHost();
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  const query = { area: areaOf(square(5, 45)), time: window(6, 21), where: [{ col: 'gsd', op: '<=', value: 0.6 }] };
  // Area: scenes 1-4. Time [6th, 21st): 1, 2, 3. gsd <= 0.6: all three.
  const all = await search.search(query);
  assert.deepEqual(ids(all.scenes), ['naip-3', 'naip-2', 'naip-1']);
  const sorted = await search.search({ ...query, sort: { by: 'gsd', order: 'asc' }, limit: 2 });
  assert.deepEqual(ids(sorted.scenes), ['naip-2', 'naip-1']);
  assert.equal(sorted.truncated, true);
  assert.equal(sorted.matched, 3);
  assert.equal(sorted.partial, false);
  assert.equal(sorted.plan.files.selected, 1);
});

test('interval items are found by a window overlapping their span', async () => {
  // Spans are [day, day + 2]: scene 2 is the 11th-13th, scene 3 the 16th-18th.
  const host = allHost();
  const { scenes } = await new ImagerySearch(oamProfile(), { fetch: host.fetch }).search({ time: window(12, 17) });
  assert.deepEqual(ids(scenes), ['oam-3', 'oam-2']);
});

test('an area crossing the antimeridian searches both boxes; no area searches everything', async () => {
  const host = allHost();
  const search = new ImagerySearch(s2Profile(), { fetch: host.fetch });
  const fiji = areaOf({
    type: 'MultiPolygon',
    coordinates: [
      [[[177.0, -1], [179.95, -1], [179.95, 2], [177.0, 2], [177.0, -1]]],
      [[[-179.95, -1], [-176.8, -1], [-176.8, 2], [-179.95, 2], [-179.95, -1]]],
    ],
  });
  assert.equal(fiji.crossesAntimeridian, true);
  assert.deepEqual(ids((await search.search({ area: fiji })).scenes).sort(), ['s2-6', 's2-7']);
  assert.equal((await search.search({})).scenes.length, 8);
});

test('the read stops at scanLimit, and says the result is partial', async () => {
  const host = allHost();
  const result = await new ImagerySearch(naipProfile(), { fetch: host.fetch }).search({ limit: 2, scanLimit: 4 });
  // Only the first row group's four rows were read; the newest two OF THOSE.
  assert.deepEqual(ids(result.scenes), ['naip-3', 'naip-2']);
  assert.equal(result.partial, true);
  assert.equal(result.truncated, true);
  assert.equal(result.matched, 4);
});

// --- one search at a time (Review Focus 1) ------------------------------------------------

test('a superseded search resolves [] and delivers nothing further', async () => {
  const host = allHost({ delayMs: 5 });
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  await search.warm();
  const delivered = [];
  const first = search.search({ onScenes: (batch) => delivered.push(...ids(batch)) });
  const second = search.search({ time: window(1, 12) });
  assert.deepEqual(await first, { scenes: [], truncated: false, matched: 0, partial: false, plan: null, superseded: true });
  assert.deepEqual(ids((await second).scenes), ['naip-2', 'naip-1', 'naip-0']);
  assert.deepEqual(delivered, [], 'the first search delivered nothing after it was superseded');
});

test('superseding a search that is already streaming: it delivers no later batch', async () => {
  const host = allHost({ delayMs: 2 });
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  const batches = [];
  let second;
  const first = search.search({
    onScenes: (batch) => {
      batches.push(ids(batch));
      second ??= search.search({ time: window(1, 12) });
    },
  });
  assert.equal((await first).superseded, true);
  assert.equal(batches.length, 1, 'the first row group arrived; the second never did');
  assert.equal((await second).scenes.length, 3);
});

test('a search superseded while the dataset is still being prepared also resolves []', async () => {
  const host = allHost({ delayMs: 5 });
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  const first = search.search();
  const second = search.search();
  assert.equal((await first).superseded, true);
  assert.equal((await second).scenes.length, 8);
});

test('close() ends the search in flight the same way', async () => {
  const host = allHost({ delayMs: 5 });
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  await search.warm();
  const pending = search.search();
  search.close();
  assert.equal((await pending).superseded, true);
});

test('cancel() ends the search in flight too, and keeps what was cached', async () => {
  const host = allHost({ delayMs: 5 });
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  await search.search();
  const pending = search.search();
  search.cancel();
  assert.equal((await pending).superseded, true);
  host.reset();
  assert.equal((await search.search()).scenes.length, 8);
  assert.deepEqual(host.overhead(), [], 'nothing was forgotten: the next search pays for rows only');
});

test('onScenes streams batches before the promise resolves', async () => {
  const host = allHost();
  const batches = [];
  let resolved = false;
  const result = await new ImagerySearch(naipProfile(), { fetch: host.fetch })
    .search({
      onScenes: (batch) => {
        assert.equal(resolved, false);
        batches.push(ids(batch));
      },
    })
    .then((r) => {
      resolved = true;
      return r;
    });
  assert.deepEqual(batches, [[0, 1, 2, 3].map((i) => `naip-${i}`), [4, 5, 6, 7].map((i) => `naip-${i}`)], 'one batch per row group, in file order');
  assert.deepEqual(batches.flat().sort(), ids(result.scenes).sort());
});

// --- what a search costs ----------------------------------------------------------------

test('a second search re-uses the plan cache: no listing, no footer requests', async () => {
  for (const profile of [naipProfile(), s2Profile()]) {
    const host = allHost();
    const search = new ImagerySearch(profile, { fetch: host.fetch });
    await search.search();
    host.reset();
    const again = await search.search({ time: window(1, 12) });
    assert.equal(again.scenes.length, 3);
    assert.deepEqual(host.overhead(), [], `${profile.id}: only row reads`);
    assert.ok(host.log.length > 0);
  }
});

test('warm() prepares once, however often it is called, and a search after it pays for rows only', async () => {
  const host = allHost();
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  await Promise.all([search.warm(), search.warm()]);
  const warmRequests = host.log.length;
  assert.ok(warmRequests > 0);
  await search.warm();
  assert.equal(host.log.length, warmRequests);
  host.reset();
  await search.search();
  assert.deepEqual(host.overhead(), []);
});

test('a failed warm is not remembered: the next search tries again', async () => {
  let fail = true;
  const real = allHost();
  const fetch = (url, init) => (fail ? Promise.resolve(new Response(null, { status: 503 })) : real.fetch(url, init));
  const search = new ImagerySearch(naipProfile(), { fetch });
  await assert.rejects(search.search());
  fail = false;
  assert.equal((await search.search()).scenes.length, 8);
});

// Phase 2 review, I1: a request that never answers. `search()` awaited the
// preparation without racing its own cancellation, so Stop did nothing, the
// search never resolved, and neither did the next one.
/** `allHost()` whose requests all hang while `stuck` is true; a hung request gives up only when aborted. */
function hangableHost() {
  const real = allHost();
  const state = { stuck: true };
  const fetch = (url, init = {}) =>
    state.stuck
      ? new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      : real.fetch(url, init);
  return { fetch, state };
}

test('cancelling while the dataset is being prepared over a hung network resolves at once', async () => {
  const host = hangableHost();
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch, timeoutMs: 60 });
  const pending = search.search();
  search.cancel();
  assert.equal((await pending).superseded, true);
  // The network comes back, and the stalled preparation times out rather than being waited on forever.
  host.state.stuck = false;
  await new Promise((r) => setTimeout(r, 90));
  assert.equal((await search.search()).scenes.length, 8);
});

test('a preparation that never answers times out as a retryable error and is not remembered', async () => {
  const host = hangableHost();
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch, timeoutMs: 40 });
  await assert.rejects(search.search(), (e) => {
    assert.equal(e.code, 'NETWORK');
    assert.equal(e.retryable, true);
    assert.equal(e.context.reason, 'timeout');
    return true;
  });
  host.state.stuck = false;
  assert.equal((await search.search()).scenes.length, 8);
});

test('a superseding search is not held up by the one it replaced being stuck', async () => {
  const host = hangableHost();
  const search = new ImagerySearch(s2Profile(), { fetch: host.fetch, timeoutMs: 50 });
  const first = search.search();
  const second = search.search();
  assert.equal((await first).superseded, true, 'released without waiting for the timeout');
  await assert.rejects(second, (e) => e.code === 'NETWORK');
});

// --- the profile is checked against the real file ------------------------------------------

test('a profile that assumed STAC defaults is settled from the file: struct assets are read, links are not', async () => {
  const host = allHost();
  const search = new ImagerySearch(oamProfile(), { fetch: host.fetch });
  assert.equal(search.profile.assets, 'unknown');
  await search.warm();
  assert.equal(search.profile.assets, 'struct');
  assert.ok(search.profile.searchColumns.includes('assets'));
  assert.ok(search.profile.searchColumns.includes('title'));
  assert.equal(search.profile.searchColumns.includes('links'), false);
});

test('columns a profile names that the file does not have are dropped, not read', async () => {
  const host = allHost();
  const profile = {
    ...naipProfile(),
    table: { idColumn: 'id', geometryColumn: 'geometry', timeColumn: 'datetime', timeInterval: { start: 'start_datetime', end: 'end_datetime' } },
    thumbnail: { column: 'thumbnail_url' },
    filters: [...naipProfile().filters, { column: 'eo:cloud_cover', label: 'Cloud cover (%)', kind: 'max', type: 'double' }],
    searchColumns: [...naipProfile().searchColumns, 'start_datetime', 'end_datetime', 'thumbnail_url', 'eo:cloud_cover'],
  };
  const search = new ImagerySearch(profile, { fetch: host.fetch });
  const { scenes } = await search.search({ time: window(1, 12) });
  assert.deepEqual(ids(scenes), ['naip-2', 'naip-1', 'naip-0']);
  assert.equal(search.profile.table.timeInterval, undefined);
  assert.equal(search.profile.thumbnail, undefined);
  assert.deepEqual(search.profile.filters.map((f) => f.column), ['gsd', 'naip:state', 'naip:year']);
});

test('with JSON assets, the item link column is read so a scene can be resolved later', async () => {
  const host = allHost();
  const search = new ImagerySearch(s2Profile(), { fetch: host.fetch });
  await search.warm();
  assert.ok(search.profile.searchColumns.includes('links'));
  assert.equal(search.profile.searchColumns.includes('assets'), false);
});

// --- a scene's files (Review Focus 3) ----------------------------------------------------------

test('resolveAssets: struct assets come from the row, with no request', async () => {
  const host = allHost();
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  const { scenes } = await search.search();
  host.reset();
  assert.deepEqual(await search.resolveAssets(byId(scenes, 'naip-2')), { image: { href: 'https://imagery.invalid/naip/2.tif', type: COG_TYPE, roles: ['data'] } });
  assert.deepEqual(host.log, []);
});

test('resolveAssets: with JSON assets unread, the item link is fetched once', async () => {
  const host = allHost();
  const search = new ImagerySearch(s2Profile(), { fetch: host.fetch });
  const { scenes } = await search.search();
  const scene = byId(scenes, 's2-3');
  const [a, b] = await Promise.all([search.resolveAssets(scene), search.resolveAssets(scene)]);
  const c = await search.resolveAssets(scene);
  assert.equal(host.requestsTo(S2_ITEM_URL(3)), 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(a.visual.href, 'https://imagery.invalid/s2/3/TCI.tif');
  // A relative href is relative to the ITEM document.
  assert.equal(a.red.href, 'https://items.invalid/s2/B04.tif');
});

test('resolveAssets: profile.assetHref wins over the item link', async () => {
  const host = allHost();
  const profile = { ...s2Profile(), assetHref: (scene) => `https://convention.invalid/${scene.id}/TCI.tif` };
  const search = new ImagerySearch(profile, { fetch: host.fetch });
  const { scenes } = await search.search();
  assert.deepEqual(await search.resolveAssets(byId(scenes, 's2-1')), {
    visual: { href: 'https://convention.invalid/s2-1/TCI.tif', type: COG_TYPE, roles: ['visual'] },
  });
  assert.equal(host.requestsTo(S2_ITEM_URL(1)), 0);
});

test('resolveAssets: nothing to go on -> SCENE_ASSETS_UNAVAILABLE naming the scene', async () => {
  const host = allHost();
  const search = new ImagerySearch(s2Profile(), { fetch: host.fetch });
  const unavailable = (reason) => (e) => {
    assert.equal(e.code, 'SCENE_ASSETS_UNAVAILABLE');
    assert.equal(e.retryable, false);
    assert.equal(e.context.scene, 'orphan');
    assert.equal(e.context.collection, 's2');
    assert.equal(e.context.reason, reason);
    assert.match(e.message, /orphan/);
    return true;
  };
  await assert.rejects(search.resolveAssets({ id: 'orphan', self: null }), unavailable('no-source'));
  // Its item document is gone.
  await assert.rejects(search.resolveAssets({ id: 'orphan', self: 'https://items.invalid/s2/gone.json' }), unavailable('item-fetch-failed'));
  // Its link is not something a browser can fetch.
  await assert.rejects(search.resolveAssets({ id: 'orphan', self: 's3://bucket/item.json' }), unavailable('no-source'));
});

test('resolveAssets: an item document with no usable assets is SCENE_ASSETS_UNAVAILABLE too', async () => {
  const host = itemsHost({ 'https://items.invalid/empty.json': { type: 'Feature', id: 'orphan', assets: {} }, 'https://items.invalid/text.json': 'not an item' });
  const search = new ImagerySearch(s2Profile(), { fetch: host.fetch });
  for (const self of ['https://items.invalid/empty.json', 'https://items.invalid/text.json']) {
    await assert.rejects(search.resolveAssets({ id: 'orphan', self }), (e) => e.code === 'SCENE_ASSETS_UNAVAILABLE' && e.context.reason === 'item-has-no-assets');
  }
});

// --- a scene as a map layer ------------------------------------------------------------------------

test("layerSpecFor gives a valid cog LayerSpec in the collection's group", async () => {
  const host = allHost();
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  const { scenes } = await search.search();
  const spec = await search.layerSpecFor(byId(scenes, 'naip-2'));
  assert.deepEqual(validateLayerSpec(spec), spec);
  assert.deepEqual(spec, {
    spec: 'cng-layer/1.0',
    id: 'naip:naip-2',
    title: 'naip-2',
    kind: 'cog',
    source: { url: 'https://imagery.invalid/naip/2.tif' },
    bbox: [20, 0, 20.9, 0.9],
    temporal: [iso(11), iso(11)],
    attribution: naipProfile().attribution,
    group: 'naip',
  });
});

test('layerSpecFor uses a scene title, span and thumbnail when it has them', async () => {
  const host = allHost();
  const search = new ImagerySearch(oamProfile(), { fetch: host.fetch });
  const { scenes } = await search.search();
  const spec = await search.layerSpecFor(byId(scenes, 'oam-2'));
  assert.equal(spec.title, 'Flight 2');
  assert.deepEqual(spec.temporal, [iso(11), iso(13)]);
  assert.equal(spec.thumbnail, 'https://imagery.invalid/oam/2.png');
  assert.equal(spec.source.url, 'https://imagery.invalid/oam/2.tif');
});

test('layerSpecFor resolves a Sentinel-2-like scene through its item, and can pick another asset', async () => {
  const host = allHost();
  const search = new ImagerySearch(s2Profile(), { fetch: host.fetch });
  const { scenes } = await search.search();
  const scene = byId(scenes, 's2-4');
  assert.equal((await search.layerSpecFor(scene)).source.url, 'https://imagery.invalid/s2/4/TCI.tif');
  const red = await search.layerSpecFor(scene, { asset: 'red' });
  assert.equal(red.source.url, 'https://items.invalid/s2/B04.tif');
  assert.equal(red.id, 's2:s2-4:red');
});

test('layerSpecFor refuses an asset that is not an http(s) COG', async () => {
  const host = allHost();
  const s2 = new ImagerySearch(s2Profile(), { fetch: host.fetch });
  const scene = byId((await s2.search()).scenes, 's2-4');
  // A JPEG is not a COG.
  await assert.rejects(s2.layerSpecFor(scene, { asset: 'thumbnail' }), (e) => e.code === 'LAYER_UNSUPPORTED' && e.context.scene === 's2-4' && e.context.asset === 'thumbnail');
  // There is no such asset.
  await assert.rejects(s2.layerSpecFor(scene, { asset: 'nope' }), (e) => {
    assert.equal(e.code, 'SCENE_ASSETS_UNAVAILABLE');
    assert.equal(e.context.reason, 'no-such-asset');
    assert.deepEqual(e.context.available, ['visual', 'red', 'thumbnail']);
    return true;
  });
  // A browser cannot fetch s3://.
  const s3 = new ImagerySearch({ ...s2Profile(), assetHref: () => 's3://bucket/scene/TCI.tif' }, { fetch: host.fetch });
  await assert.rejects(s3.layerSpecFor({ id: 'x', self: null, bbox: null }), (e) => e.code === 'SCENE_ASSETS_UNAVAILABLE' && e.context.reason === 'no-source');
});

test('layerSpecFor leaves out a bbox that crosses the antimeridian rather than sending an invalid one', async () => {
  const host = itemsHost({ [NAIP_URL]: naipItems() });
  const search = new ImagerySearch(naipProfile(), { fetch: host.fetch });
  const scene = { id: 'wrap', datetime: iso(1), start: null, end: null, bbox: [179, 0, -179, 1], thumbnail: null, self: null, properties: {}, assets: { image: { href: 'https://imagery.invalid/wrap.tif', type: COG_TYPE } } };
  const spec = await search.layerSpecFor(scene);
  assert.equal('bbox' in spec, false);
});

// --- a profile straight from imageryProfile() -----------------------------------------------------------

// The profiles above are written out by hand. These two come from the real
// collection documents, with a fake item table served at the URL each names.
test('a profile derived from the real NAIP and OpenAerialMap documents searches end to end', async () => {
  const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.collection.json`, import.meta.url), 'utf8'));
  const naip = imageryProfile(fixture('naip'), { baseUrl: 'https://nthh.github.io/data-publications/naip/collection.json' });
  const oam = imageryProfile(fixture('oam-cc-by-4-0'), { baseUrl: 'https://data.source.coop/geospatialjeff/oam-portolan/oam-cc-by-4-0/collection.json' });
  const host = itemsHost({ [naip.dataset.source.url]: naipItems(), [oam.dataset.source.url]: oamItems() });

  const naipSearch = new ImagerySearch(naip, { fetch: host.fetch });
  const found = await naipSearch.search({ area: areaOf(square(5, 45)), where: [{ col: 'naip:state', op: '=', value: 'or' }] });
  assert.deepEqual(ids(found.scenes), ['naip-3', 'naip-2']);
  assert.equal((await naipSearch.layerSpecFor(found.scenes[0])).source.url, 'https://imagery.invalid/naip/3.tif');

  const oamSearch = new ImagerySearch(oam, { fetch: host.fetch });
  const flights = await oamSearch.search({ time: window(12, 17) });
  assert.deepEqual(ids(flights.scenes), ['oam-3', 'oam-2']);
  const spec = await oamSearch.layerSpecFor(flights.scenes[0]);
  assert.equal(spec.source.url, 'https://imagery.invalid/oam/3.tif');
  assert.equal(spec.group, 'oam-cc-by-4-0');
  assert.equal(spec.attribution[0].license, 'CC-BY-4.0');
});

// --- ordering ----------------------------------------------------------------------------------------

test('sortScenes: newest first by default, nulls last in either direction, ties keep their order', () => {
  const scene = (id, datetime, cloud, start = null) => ({ id, datetime, start, end: null, properties: { 'eo:cloud_cover': cloud } });
  const scenes = [scene('a', iso(5), 10), scene('b', null, null), scene('c', iso(9), 10), scene('d', null, 3, iso(7))];
  assert.deepEqual(ids(sortScenes(scenes)), ['c', 'd', 'a', 'b']);
  assert.deepEqual(ids(sortScenes(scenes, { by: 'datetime', order: 'asc' })), ['a', 'd', 'c', 'b']);
  assert.deepEqual(ids(sortScenes(scenes, { by: 'eo:cloud_cover', order: 'asc' })), ['d', 'a', 'c', 'b']);
  assert.deepEqual(ids(sortScenes(scenes, { by: 'eo:cloud_cover', order: 'desc' })), ['a', 'c', 'd', 'b']);
  assert.deepEqual(ids(scenes), ['a', 'b', 'c', 'd'], 'the input is not reordered');
});
