// In-memory STAC-GeoParquet item tables in the three shapes the real
// collections come in, written with hyparquet-writer and served over Range.
// Only the network is faked: the production search, planner and reader run.
//
// Eight scenes, in row groups of four:
//
//   i   lon      day (June 2025)   cloud   gsd   state
//   0   0        1                 0       0.3   ca
//   1   10       6                 10      0.6   ca
//   2   20       11                20      0.3   or
//   3   30       16                30      0.6   or
//   4   40       21                40      1.0   wa
//   5   50       26                50      1.0   wa
//   6   179      28                5       0.3   fj     <- either side of
//   7   -179.9   29                5       0.3   fj     <- the antimeridian
//
// Each is a 0.9-degree square with its south-west corner at (lon, 0).

import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { setHyparquetModules } from '@cngeo/extract-core';

setHyparquetModules({ hyparquet, compressors });

export const COG_TYPE = 'image/tiff; application=geotiff; profile=cloud-optimized';
export const LONS = [0, 10, 20, 30, 40, 50, 179, -179.9];
const DAYS = [1, 6, 11, 16, 21, 26, 28, 29];
const CLOUD = [0, 10, 20, 30, 40, 50, 5, 5];
const GSD = [0.3, 0.6, 0.3, 0.6, 1.0, 1.0, 0.3, 0.3];
const STATE = ['ca', 'ca', 'or', 'or', 'wa', 'wa', 'fj', 'fj'];
const SIZE = 0.9;

export const day = (d) => new Date(Date.UTC(2025, 5, d));
export const iso = (d) => day(d).toISOString();

/** WKB (little-endian) for the square with its south-west corner at (x, y). */
function squareWkb(x, y, size = SIZE) {
  const ring = [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
  const view = new DataView(new ArrayBuffer(1 + 4 + 4 + 4 + ring.length * 16));
  let o = 0;
  view.setUint8(o, 1);
  view.setUint32((o += 1), 3, true);
  view.setUint32((o += 4), 1, true);
  view.setUint32((o += 4), ring.length, true);
  o += 4;
  for (const [px, py] of ring) {
    view.setFloat64(o, px, true);
    view.setFloat64(o + 8, py, true);
    o += 16;
  }
  return new Uint8Array(view.buffer);
}

// --- schema building blocks (thrift SchemaElement, flat and depth-first) -----------
const str = (name) => ({ name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' });
const dbl = (name) => ({ name, type: 'DOUBLE', repetition_type: 'OPTIONAL' });
const i64 = (name) => ({ name, type: 'INT64', repetition_type: 'OPTIONAL' });
const ts = (name) => ({ name, type: 'INT64', repetition_type: 'OPTIONAL', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' } });
const bytes = (name) => ({ name, type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' });
const group = (name, children) => [{ name, repetition_type: 'OPTIONAL', num_children: children.length }, ...children.flat()];
const list = (name, element) => [
  { name, repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 },
  { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
  ...[element].flat(),
];
const asset = (name) => group(name, [str('href'), str('type'), list('roles', str('element'))]);
const bboxStruct = () => group('bbox', [dbl('xmin'), dbl('ymin'), dbl('xmax'), dbl('ymax')]);

function write(columns, rows) {
  const schema = [{ name: 'schema', num_children: columns.length }, ...columns.flat()];
  const names = columns.map((c) => (Array.isArray(c) ? c[0].name : c.name));
  const buffer = parquetWriteBuffer({ columnData: names.map((name) => ({ name, data: rows.map((r) => r[name] ?? null) })), schema, rowGroupSize: 4 });
  return new Uint8Array(buffer);
}

const bboxOf = (i) => ({ xmin: LONS[i], ymin: 0, xmax: LONS[i] + SIZE, ymax: SIZE });
const pick = (indexes) => indexes ?? LONS.map((_, i) => i);

/** NAIP-like: `datetime` (a timestamp), struct bbox, struct assets keyed `image`, an INT64 year. */
export function naipItems(indexes) {
  const rows = pick(indexes).map((i) => ({
    id: `naip-${i}`,
    datetime: day(DAYS[i]),
    bbox: bboxOf(i),
    gsd: GSD[i],
    'naip:state': STATE[i],
    'naip:year': 2025n,
    assets: { image: { href: `https://imagery.invalid/naip/${i}.tif`, type: COG_TYPE, roles: ['data'] } },
    geometry: squareWkb(LONS[i], 0),
  }));
  return write([str('id'), ts('datetime'), bboxStruct(), dbl('gsd'), str('naip:state'), i64('naip:year'), group('assets', [asset('image')]), bytes('geometry')], rows);
}

/**
 * OpenAerialMap-like: `datetime` is ALWAYS null; each item spans
 * [day, day + 2]. Struct assets with a per-item thumbnail; scene 5 has none.
 */
export function oamItems(indexes) {
  const rows = pick(indexes).map((i) => ({
    id: `oam-${i}`,
    title: `Flight ${i}`,
    datetime: null,
    start_datetime: day(DAYS[i]),
    end_datetime: day(DAYS[i] + 2),
    bbox: bboxOf(i),
    gsd: GSD[i],
    'oam:platform_type': i % 2 ? 'uav' : 'satellite',
    assets: {
      visual: { href: `https://imagery.invalid/oam/${i}.tif`, type: COG_TYPE, roles: ['data'] },
      thumbnail: i === 5 ? null : { href: `https://imagery.invalid/oam/${i}.png`, type: 'image/png', roles: ['thumbnail'] },
    },
    geometry: squareWkb(LONS[i], 0),
  }));
  return write(
    [str('id'), str('title'), ts('datetime'), ts('start_datetime'), ts('end_datetime'), bboxStruct(), dbl('gsd'), str('oam:platform_type'), group('assets', [asset('visual'), asset('thumbnail')]), bytes('geometry')],
    rows,
  );
}

export const S2_ITEM_URL = (i) => `https://items.invalid/s2/s2-${i}.json`;

/** The STAC item document a Sentinel-2-like scene's `self` link points at. */
export function s2ItemJson(i) {
  return {
    type: 'Feature',
    stac_version: '1.0.0',
    id: `s2-${i}`,
    assets: {
      visual: { href: `https://imagery.invalid/s2/${i}/TCI.tif`, type: COG_TYPE, roles: ['visual'] },
      red: { href: './B04.tif', type: COG_TYPE, roles: ['data'] },
      thumbnail: { href: `https://imagery.invalid/s2/${i}/thumb.jpg`, type: 'image/jpeg', roles: ['thumbnail'] },
    },
  };
}

/**
 * Sentinel-2-like: `assets` is a JSON STRING (never read by a search), bbox is
 * a LIST `[w, s, e, n]`, `datetime` is an ISO string, and each row carries
 * `links` with its own item URL and a `thumbnail_url`.
 */
export function s2Items(indexes) {
  const rows = pick(indexes).map((i) => ({
    thumbnail_url: `https://imagery.invalid/s2/${i}/thumb.jpg`,
    id: `s2-${i}`,
    bbox: [LONS[i], 0, LONS[i] + SIZE, SIZE],
    links: [
      { rel: 'self', href: S2_ITEM_URL(i) },
      { rel: 'collection', href: 'https://items.invalid/s2/collection.json' },
    ],
    datetime: iso(DAYS[i]),
    'eo:cloud_cover': CLOUD[i],
    platform: i % 2 ? 'sentinel-2b' : 'sentinel-2a',
    assets: JSON.stringify(s2ItemJson(i).assets),
    geometry: squareWkb(LONS[i], 0),
  }));
  return write(
    [str('thumbnail_url'), str('id'), list('bbox', dbl('element')), list('links', group('element', [str('rel'), str('href')])), str('datetime'), dbl('eo:cloud_cover'), str('platform'), str('assets'), bytes('geometry')],
    rows,
  );
}

/**
 * A `fetch` over a set of URLs. A `Uint8Array` is served with HTTP Range
 * semantics; anything else as JSON; a number as that status with no body.
 * Every request is logged. `delayMs` slows every response.
 * @param {Record<string, Uint8Array|object|number>} resources
 * @param {{ delayMs?: number }} [opts]
 */
export function itemsHost(resources, opts = {}) {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    const range = init.headers?.get?.('Range') ?? new Headers(init.headers ?? {}).get('Range');
    const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
    const body = resources[url];
    const entry = { url, method: init.method ?? 'GET', range: m ? [Number(m[1]), m[2] === '' ? null : Number(m[2]) + 1] : null, footer: false };
    log.push(entry);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (body === undefined) return new Response(null, { status: 404 });
    if (typeof body === 'number') return new Response(null, { status: body });
    if (!(body instanceof Uint8Array)) return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (entry.method === 'HEAD' || !m) return new Response(null, { status: 200, headers: { 'content-length': String(body.byteLength), 'accept-ranges': 'bytes' } });
    const start = entry.range[0];
    const end = entry.range[1] ?? body.byteLength;
    entry.footer = end >= body.byteLength;
    const slice = body.slice(start, end);
    return new Response(slice, { status: 206, headers: { 'content-range': `bytes ${start}-${end - 1}/${body.byteLength}`, 'content-length': String(slice.byteLength) } });
  };
  return {
    fetch,
    log,
    /** Requests that are not row reads: HEADs, footers, and anything that is not a parquet range. */
    overhead: () => log.filter((e) => e.method === 'HEAD' || e.footer || !e.range),
    requestsTo: (url) => log.filter((e) => e.url === url).length,
    reset: () => log.splice(0),
  };
}

// --- profiles, written out as `imageryProfile()` would return them ------------------

const ATTRIBUTION = [{ text: 'Test imagery', license: 'CC-BY-4.0', shareAlike: false, share_alike: false, url: 'https://example.org/' }];
export const NAIP_URL = 'https://data.invalid/naip/items.parquet';
export const OAM_URL = 'https://data.invalid/oam/items.parquet';
export const S2_URLS = ['https://data.invalid/s2/a.parquet', 'https://data.invalid/s2/b.parquet'];

export function naipProfile() {
  return {
    id: 'naip',
    title: 'NAIP',
    collectionUrl: 'https://data.invalid/naip/collection.json',
    attribution: ATTRIBUTION,
    dataset: { spec: 'cng-dataset/1.0', id: 'naip', source: { kind: 'parquet', url: NAIP_URL }, attribution: ATTRIBUTION },
    table: { idColumn: 'id', geometryColumn: 'geometry', timeColumn: 'datetime' },
    columnsKnown: true,
    displayAsset: 'image',
    assets: 'struct',
    filters: [
      { column: 'gsd', label: 'Resolution (m)', kind: 'max', type: 'double' },
      { column: 'naip:state', label: 'State', kind: 'enum', type: 'string' },
      { column: 'naip:year', label: 'Year', kind: 'range', type: 'int64' },
    ],
    searchColumns: ['id', 'datetime', 'bbox', 'geometry', 'gsd', 'naip:state', 'naip:year', 'assets'],
  };
}

/** As derived from a collection that declares NO columns: STAC defaults assumed, `assets` unknown. */
export function oamProfile() {
  return {
    id: 'oam',
    title: 'OpenAerialMap',
    collectionUrl: 'https://data.invalid/oam/collection.json',
    attribution: ATTRIBUTION,
    dataset: { spec: 'cng-dataset/1.0', id: 'oam', source: { kind: 'parquet', url: OAM_URL }, attribution: ATTRIBUTION },
    table: { idColumn: 'id', geometryColumn: 'geometry', timeColumn: 'datetime', timeInterval: { start: 'start_datetime', end: 'end_datetime' } },
    columnsKnown: false,
    displayAsset: 'visual',
    thumbnail: { asset: 'thumbnail' },
    assets: 'unknown',
    filters: [
      { column: 'gsd', label: 'Resolution (m)', kind: 'max', type: 'unknown' },
      { column: 'oam:platform_type', label: 'Platform type', kind: 'enum', type: 'unknown', values: ['satellite', 'uav'] },
    ],
    searchColumns: ['id', 'datetime', 'start_datetime', 'end_datetime', 'bbox', 'geometry', 'gsd', 'oam:platform_type'],
  };
}

/** Two files, so no footer is read up front and the declared table is trusted -- as for a partitioned collection. */
export function s2Profile() {
  const columns = ['thumbnail_url', 'id', 'bbox', 'links', 'datetime', 'eo:cloud_cover', 'platform', 'assets', 'geometry'];
  return {
    id: 's2',
    title: 'Sentinel-2',
    collectionUrl: 'https://data.invalid/s2/collection.json',
    attribution: [{ text: 'ESA', license: 'CC-BY-SA-3.0-IGO', shareAlike: true, share_alike: true }],
    dataset: {
      spec: 'cng-dataset/1.0',
      id: 's2',
      source: { kind: 'parquet-set', urls: S2_URLS },
      table: {
        geometryColumn: 'geometry',
        geometryEncoding: 'WKB',
        crs: 'OGC:CRS84',
        bbox: { kind: 'none' },
        timeColumn: 'datetime',
        columns: columns.map((name) => ({ name, type: 'unknown' })),
      },
      attribution: [{ text: 'ESA', license: 'CC-BY-SA-3.0-IGO', shareAlike: true }],
    },
    table: { idColumn: 'id', geometryColumn: 'geometry', timeColumn: 'datetime' },
    columnsKnown: true,
    displayAsset: 'visual',
    thumbnail: { column: 'thumbnail_url' },
    assets: 'json',
    filters: [
      { column: 'eo:cloud_cover', label: 'Cloud cover (%)', kind: 'max', type: 'double' },
      { column: 'platform', label: 'Platform', kind: 'enum', type: 'string' },
    ],
    searchColumns: ['id', 'datetime', 'bbox', 'geometry', 'eo:cloud_cover', 'platform', 'thumbnail_url'],
  };
}

/** One host serving all three collections and every Sentinel-2-like item document. */
export function allHost(opts) {
  const resources = { [NAIP_URL]: naipItems(), [OAM_URL]: oamItems(), [S2_URLS[0]]: s2Items([0, 1, 2, 3]), [S2_URLS[1]]: s2Items([4, 5, 6, 7]) };
  for (let i = 0; i < LONS.length; i++) resources[S2_ITEM_URL(i)] = s2ItemJson(i);
  return itemsHost(resources, opts);
}
