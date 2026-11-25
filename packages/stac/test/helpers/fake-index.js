// A small `collections.parquet` catalog index, shaped like the Portolan
// registry's (measured 2026-11-25): catalogs and collections in one table, one
// row group, light columns beside two fat ones (`links`, `original`) that a
// search must never read.
//
//   key        title                               bbox                 catalog   license     times
//   roads      Roads of Kenya                      Kenya                kenya     CC-BY-4.0   2020..2021
//   nairobi    Nairobi buildings                   Nairobi (small)      kenya     ODbL-1.0    2023..
//   landcover  Global land cover                   the world            global    CC-BY-4.0   2015..2020
//   buildings  Global building footprints          the world            global    ODbL-1.0    2022..
//   fiji       Fiji reefs                          across 180           pacific   CC0-1.0     —
//   census     Kenya census tables                 Kenya                kenya     CC-BY-4.0   2019..2019
//   imagery    Nairobi aerial imagery              Nairobi (small)      kenya     CC-BY-4.0   2024..
//   tonga      Tonga cyclone damage sites          Tonga                pacific   CC-BY-4.0   2018..2018

import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { setHyparquetModules } from '@cngeo/extract-core';

setHyparquetModules({ hyparquet, compressors });

export const INDEX_URL = 'https://registry.invalid/v0.1/collections.parquet';
export const CATALOG_URL = 'https://registry.invalid/v0.1/catalog.json';
const BASE = 'https://data.invalid';
const KENYA = [33.9, -4.7, 41.9, 5.5];
const NAIROBI = [36.65, -1.45, 37.1, -1.15];
const WORLD = [-180, -90, 180, 90];

const day = (y, m = 1, d = 1) => new Date(Date.UTC(y, m - 1, d));

/** What each collection would draw as: the `render` column's value, in the shape `renderFromLayers` writes. */
const render = (kind, id, extra = {}) => ({ kind, id, title: null, url: null, style: null, layers: null, display_asset: null, items: null, reason: null, ...extra });

export const COLLECTIONS = [
  { key: 'roads', title: 'Roads of Kenya', description: 'Primary and secondary roads, from the national survey.', keywords: ['transport', 'roads'], bbox: KENYA, catalog: 'kenya', license: 'CC-BY-4.0', start: day(2020), end: day(2021),
    render: [render('pmtiles-vector', 'roads', { url: `${BASE}/kenya/roads/roads.pmtiles`, style: `${BASE}/kenya/roads/style.json`, layers: ['roads'] })] },
  { key: 'nairobi', title: 'Nairobi buildings', description: 'Building footprints for the city of Nairobi.', keywords: ['buildings', 'urban'], bbox: NAIROBI, catalog: 'kenya', license: 'ODbL-1.0', start: day(2023), end: null,
    render: [render('pmtiles-vector', 'nairobi', { url: `${BASE}/kenya/nairobi/buildings.pmtiles`, layers: ['buildings'] })] },
  { key: 'landcover', title: 'Global land cover', description: 'Annual land cover classes for the whole world.', keywords: ['land cover', 'raster'], bbox: WORLD, catalog: 'global', license: 'CC-BY-4.0', start: day(2015), end: day(2020),
    render: [render('cog', 'landcover', { url: `${BASE}/global/landcover/2020.tif` })] },
  { key: 'buildings', title: 'Global building footprints', description: 'Buildings everywhere, including Nairobi.', keywords: ['buildings'], bbox: WORLD, catalog: 'global', license: 'ODbL-1.0', start: day(2022), end: null,
    render: [render('pmtiles-vector', 'buildings', { url: `${BASE}/global/buildings/buildings.pmtiles`, layers: ['buildings'] })] },
  { key: 'fiji', title: 'Fiji reefs', description: 'Coral reef extents around Fiji.', keywords: ['marine'], bbox: [177, -19, -178, -16], catalog: 'pacific', license: 'CC0-1.0', start: null, end: null,
    render: [render('pmtiles-vector', 'fiji', { url: `${BASE}/pacific/fiji/reefs.pmtiles`, layers: ['reefs'] })] },
  { key: 'census', title: 'Kenya census tables', description: 'Population counts by county. A table, with no map.', keywords: ['population', 'census'], bbox: KENYA, catalog: 'kenya', license: 'CC-BY-4.0', start: day(2019), end: day(2019, 12, 31),
    render: [render('table', 'census', { url: `${BASE}/kenya/census/census.parquet` })] },
  { key: 'imagery', title: 'Nairobi aerial imagery', description: 'Aerial scenes over Nairobi, as a STAC item table.', keywords: ['imagery'], bbox: NAIROBI, catalog: 'kenya', license: 'CC-BY-4.0', start: day(2024), end: null,
    render: [render('scenes', 'imagery', { items: `${BASE}/kenya/imagery/items.parquet`, display_asset: 'visual' })] },
  { key: 'tonga', title: 'Tonga cyclone damage sites', description: 'Damage assessment after the 2018 cyclone.', keywords: ['disaster', 'cyclone'], bbox: [-175.4, -21.5, -173.9, -18.5], catalog: 'pacific', license: 'CC-BY-4.0', start: day(2018, 2, 9), end: day(2018, 2, 20),
    render: [render('unsupported', 'tonga', { reason: 'Only zarr assets were found.' })] },
];
const CATALOGS = [
  { key: 'kenya', title: 'Open data of Kenya' },
  { key: 'global', title: 'Global layers' },
  { key: 'pacific', title: 'Pacific community' },
];
export const hrefOf = (c) => `${BASE}/${c.catalog}/${c.key}/collection.json`;

/** A collection JSON that `layersFromCollection` reads as one styled PMTiles layer. */
export function collectionJson(c) {
  return {
    type: 'Collection',
    stac_version: '1.0.0',
    id: c.key,
    title: c.title,
    description: c.description,
    license: c.license,
    extent: { spatial: { bbox: [c.bbox] }, temporal: { interval: [[c.start?.toISOString() ?? null, c.end?.toISOString() ?? null]] } },
    providers: [{ name: 'Test publisher', roles: ['producer'], url: 'https://publisher.invalid/' }],
    links: [{ rel: 'pmtiles', href: `./${c.key}.pmtiles`, type: 'application/vnd.pmtiles' }],
    assets: {},
  };
}

// --- schema building blocks ----------------------------------------------------------------
const str = (name) => ({ name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' });
const dbl = (name) => ({ name, type: 'DOUBLE', repetition_type: 'OPTIONAL' });
const ts = (name) => ({ name, type: 'INT64', repetition_type: 'OPTIONAL', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' } });
const group = (name, children) => [{ name, repetition_type: 'OPTIONAL', num_children: children.length }, ...children.flat()];
const list = (name, element) => [{ name, repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 }, { name: 'list', repetition_type: 'REPEATED', num_children: 1 }, ...[element].flat()];

const RENDER_FIELDS = [str('kind'), str('id'), str('title'), str('url'), str('style'), list('layers', str('element')), str('display_asset'), str('items'), str('reason')];

/**
 * Build the index. `withRender` adds the `render`, `thumbnail` and
 * `attribution` columns (E13's enriched index); `without` leaves named
 * columns out, to model an index that is not one.
 * `duplicate` repeats one collection's row at the end, as the live index does for some.
 * @param {{ withRender?: boolean, without?: string[], duplicate?: string }} [opts]
 */
export function buildIndex({ withRender = false, without = [], duplicate } = {}) {
  // Text that does not compress away, so the two fat columns really are fat
  // (in the registry's index they are 12.5 MB and 5.6 MB of 20). A reader
  // merges a read with a small neighbour; it must not do that to these.
  let seed = 12345;
  const noise = (length) => {
    let out = '';
    while (out.length < length) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out += seed.toString(36);
    }
    return out.slice(0, length);
  };
  const fat = (c) => JSON.stringify({ ...collectionJson(c), padding: noise(60_000) });
  const rows = [
    ...CATALOGS.map((c) => ({ type: 'Catalog', id: c.key, href: `${BASE}/${c.key}/catalog.json`, title: c.title, description: `Everything published by ${c.title}.`, parents: [], 'portolan_registry:id': c.key })),
    ...COLLECTIONS.map((c) => ({
      type: 'Collection',
      id: c.key,
      href: hrefOf(c),
      links: [{ rel: 'self', href: hrefOf(c), type: 'application/json', title: noise(30_000) }],
      parents: [{ id: c.catalog, href: `${BASE}/${c.catalog}/catalog.json` }],
      geometry: new Uint8Array([1, 2, 3, 4]),
      bbox: { xmin: c.bbox[0], ymin: c.bbox[1], xmax: c.bbox[2], ymax: c.bbox[3] },
      start_datetime: c.start,
      end_datetime: c.end,
      description: c.description,
      license: c.license,
      original: fat(c),
      title: c.title,
      keywords: c.keywords,
      'portolan_registry:id': c.catalog,
      render: c.render,
      thumbnail: c.key === 'roads' ? `${BASE}/kenya/roads/thumbnail.png` : null,
      attribution: c.key === 'roads' ? [{ text: 'Kenya Roads Board', license: 'CC-BY-4.0', url: 'https://roads.invalid/', share_alike: false }] : [{ text: 'Test publisher', license: c.license, url: null, share_alike: c.license === 'ODbL-1.0' }],
    })),
  ];
  if (duplicate) rows.push({ ...rows.find((r) => r.type === 'Collection' && r.id === duplicate) });
  let columns = [
    str('type'), str('id'), str('href'),
    list('links', group('element', [str('rel'), str('href'), str('type'), str('title')])),
    list('parents', group('element', [str('id'), str('href')])),
    { name: 'geometry', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' },
    group('bbox', [dbl('xmin'), dbl('ymin'), dbl('xmax'), dbl('ymax')]),
    ts('start_datetime'), ts('end_datetime'),
    str('description'), str('license'), str('original'), str('title'),
    list('keywords', str('element')),
    str('portolan_registry:id'),
    ...(withRender
      ? [list('render', group('element', RENDER_FIELDS)), str('thumbnail'), list('attribution', group('element', [str('text'), str('license'), str('url'), { name: 'share_alike', type: 'BOOLEAN', repetition_type: 'OPTIONAL' }]))]
      : []),
  ];
  const nameOf = (c) => (Array.isArray(c) ? c[0].name : c.name);
  columns = columns.filter((c) => !without.includes(nameOf(c)));
  const buffer = parquetWriteBuffer({
    columnData: columns.map((c) => ({ name: nameOf(c), data: rows.map((r) => r[nameOf(c)] ?? null) })),
    schema: [{ name: 'schema', num_children: columns.length }, ...columns.flat()],
    rowGroupSize: 1000, // one row group, like the real one
  });
  return new Uint8Array(buffer);
}

/** The byte range `[start, end)` each top-level column's chunk occupies in the file. */
export function columnRanges(bytes) {
  const metadata = hyparquet.parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const ranges = {};
  for (const rg of metadata.row_groups) {
    for (const col of rg.columns) {
      const m = col.meta_data;
      const start = Number(m.dictionary_page_offset ?? m.data_page_offset);
      const end = start + Number(m.total_compressed_size);
      const top = m.path_in_schema[0];
      ranges[top] = ranges[top] ? [Math.min(ranges[top][0], start), Math.max(ranges[top][1], end)] : [start, end];
    }
  }
  return ranges;
}

/** A catalog document whose `rel: data` link points at the index. */
export const catalogJson = (href = './collections.parquet') => ({
  type: 'Catalog',
  stac_version: '1.0.0',
  id: 'registry',
  description: 'A test registry',
  links: [
    { rel: 'self', href: CATALOG_URL, type: 'application/json' },
    { rel: 'data', href, type: 'application/vnd.apache.parquet', title: 'Collections index' },
  ],
});
