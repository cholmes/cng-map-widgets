// @cngeo/stac -- imageryProfile: how to search and show an imagery collection.
//
// Published imagery collections agree on STAC and on little else. Measured on
// the three this package is tested against:
//
//                    NAIP                 OpenAerialMap            Sentinel-2
//   item table       `data` parquet       `collection-mirror`      hive partitions
//   `assets`         struct               struct                   JSON string, ~18 KB a row
//   time             `datetime`           start/end, null datetime `datetime`
//   picture asset    `image`              `visual` (role `data`)   `visual`
//   thumbnail        none per item        an asset                 a URL column
//   columns declared two tables, in one   none                     yes
//                    list
//
// A profile absorbs those differences, once, from the collection document
// alone -- no fetch -- so that a search and a control branch on nothing.
//
// It is a READING OF THE DOCUMENT, and a document can be silent or wrong about
// its files. `columnsKnown: false` says the collection declared no columns and
// STAC's defaults were assumed; either way `ImagerySearch` checks the profile
// against the item table's real schema the first time it opens it.

import { CngError } from '@cngeo/spec';
import { layersFromCollection } from './layers-from-collection.js';

/**
 * @typedef {Object} ImageryFilter
 * @property {string} column
 * @property {string} label
 * @property {'max'|'min'|'range'|'enum'} kind
 * @property {string} type           The declared column type, or `'unknown'`.
 * @property {(string|number)[]} [values]   For `enum`, when the collection's summaries list them.
 * @property {number} [minimum]      From a summaries range.
 * @property {number} [maximum]
 */

/**
 * @typedef {Object} ImageryProfile
 * @property {string} id
 * @property {string} title
 * @property {string} collectionUrl
 * @property {object[]} attribution
 * @property {number[]} [bbox]
 * @property {[string|null, string|null]} [temporal]
 * @property {object} dataset   A `DatasetDescriptor`: one parquet file, or the collection itself to resolve.
 * @property {{ idColumn: string, geometryColumn: string, timeColumn?: string, timeInterval?: { start: string, end: string } }} table
 * @property {boolean} columnsKnown   Whether the collection declared its columns (else STAC defaults were assumed).
 * @property {string} [displayAsset]  The item asset key to draw.
 * @property {{ column?: string, asset?: string }} [thumbnail]  A URL column, or an asset key.
 * @property {'struct'|'json'|'unknown'} assets   How the `assets` column is encoded.
 * @property {ImageryFilter[]} filters
 * @property {string[]} searchColumns   What a search reads.
 * @property {(scene: object) => string|undefined} [assetHref]  A convention shortcut to a scene's picture.
 */

const MAX_FILTERS = 6;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isStringType = (type) => /^(string|large_string|utf8|varchar|text)\b/i.test(type);

const LABELS = {
  'eo:cloud_cover': 'Cloud cover (%)',
  gsd: 'Resolution (m)',
  platform: 'Platform',
  constellation: 'Constellation',
};

/** `naip:state` -> "State"; `oam:platform_type` -> "Platform type". */
function labelOf(column) {
  if (LABELS[column]) return LABELS[column];
  const words = column.slice(column.lastIndexOf(':') + 1).replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : column;
}

/**
 * The columns of the item table, as far as the collection declares them.
 *
 * A `table:columns` that describes more than one file lists them one after
 * another (NAIP: its quads table, then its overviews table, whose extra
 * `start_datetime` / `end_datetime` would otherwise be taken for the quads').
 * The first table is the one that runs until a column name repeats.
 * @returns {Map<string, string>|null} name -> declared type; `null` when nothing is declared.
 */
function declaredColumns(collection) {
  const listed = Array.isArray(collection['table:columns']) ? collection['table:columns'] : [];
  const columns = new Map();
  for (const entry of listed) {
    if (!isObject(entry) || typeof entry.name !== 'string' || !entry.name) continue;
    if (columns.has(entry.name)) break;
    columns.set(entry.name, typeof entry.type === 'string' ? entry.type : 'unknown');
  }
  return columns.size ? columns : null;
}

/** Top-level field names of a struct type string: `struct<a: T, b: U>` (Arrow) or `STRUCT(a T, b U)` (DuckDB). */
function structFields(type) {
  const m = /^struct\s*([<(])/i.exec(type);
  if (!m) return [];
  const [open, close, nameEnd] = m[1] === '<' ? ['<', '>', /:\s/] : ['(', ')', /\s/];
  const body = type.slice(m[0].length, type.lastIndexOf(close));
  const fields = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (ch === open || ch === '<' || ch === '(') depth++;
    else if (ch === close || ch === '>' || ch === ')') depth--;
    else if ((ch === ',' && depth === 0) || i === body.length) {
      const field = body.slice(start, i).trim();
      const end = field.search(nameEnd);
      const name = (end === -1 ? field : field.slice(0, end)).replace(/^"|"$/g, '');
      if (name) fields.push(name);
      start = i + 1;
    }
  }
  return fields;
}

function assetsEncoding(columns) {
  const type = columns?.get('assets');
  if (!type) return 'unknown';
  if (/^struct\b/i.test(type)) return 'struct';
  if (isStringType(type) || /^json\b/i.test(type)) return 'json';
  return 'unknown';
}

/** The asset key to draw, when the collection has no `item_assets` to say: read it off the struct type. */
function displayAssetFromStruct(columns) {
  const fields = structFields(columns?.get('assets') ?? '');
  return fields.find((f) => f === 'visual') ?? fields.find((f) => f === 'image') ?? fields[0];
}

function thumbnailOf(collection, columns) {
  if (columns?.has('thumbnail_url')) return { column: 'thumbnail_url' };
  const itemAssets = isObject(collection.item_assets) ? collection.item_assets : {};
  const entry = Object.entries(itemAssets).find(([key, a]) => isObject(a) && (key === 'thumbnail' || (Array.isArray(a.roles) && a.roles.includes('thumbnail'))));
  return entry ? { asset: entry[0] } : undefined;
}

/**
 * The property filters worth offering, most useful first, at most six:
 * cloud cover, resolution, then a few categorical columns, then a year.
 * Candidates come from the declared columns, or -- when a collection declares
 * none -- from its `summaries`.
 */
function filtersOf(columns, summaries) {
  const names = columns ? [...columns.keys()] : Object.keys(summaries);
  const typeOf = (name) => columns?.get(name) ?? 'unknown';
  const stringish = (name) => (columns ? isStringType(typeOf(name)) : Array.isArray(summaries[name]));
  const ENUM_PATTERNS = [(n) => n.endsWith(':state'), (n) => n.endsWith(':platform_type'), (n) => n === 'platform', (n) => n === 'constellation'];

  /** @type {[string, ImageryFilter['kind']][]} */
  const picks = [];
  if (names.includes('eo:cloud_cover')) picks.push(['eo:cloud_cover', 'max']);
  if (names.includes('gsd')) picks.push(['gsd', 'max']);
  for (const matches of ENUM_PATTERNS) for (const name of names) if (matches(name) && stringish(name)) picks.push([name, 'enum']);
  for (const name of names) if (name.endsWith(':year')) picks.push([name, 'range']);

  return picks.slice(0, MAX_FILTERS).map(([column, kind]) => {
    /** @type {ImageryFilter} */
    const filter = { column, label: labelOf(column), kind, type: typeOf(column) };
    const summary = summaries[column];
    if (kind === 'enum' && Array.isArray(summary)) {
      const values = summary.filter((v) => typeof v === 'string' || typeof v === 'number');
      if (values.length) filter.values = values;
    } else if (isObject(summary)) {
      if (Number.isFinite(summary.minimum)) filter.minimum = summary.minimum;
      if (Number.isFinite(summary.maximum)) filter.maximum = summary.maximum;
    }
    return filter;
  });
}

function searchColumnsOf(profile, columns) {
  const { table, filters, thumbnail, assets } = profile;
  const wanted = [
    table.idColumn,
    table.timeColumn,
    table.timeInterval?.start,
    table.timeInterval?.end,
    !columns || columns.has('bbox') ? 'bbox' : undefined,
    table.geometryColumn,
    ...filters.map((f) => f.column),
    thumbnail?.column,
    // Only a struct: a JSON `assets` is most of the file (E14: 85% of
    // Sentinel-2's, ~6.5 MB per row group) and is never read per search.
    assets === 'struct' ? 'assets' : undefined,
  ];
  return [...new Set(wanted.filter((c) => typeof c === 'string' && c))];
}

/**
 * Read an imagery collection into what a scene search needs. Synchronous; no fetch.
 *
 * `options.overrides` replaces derived values: `displayAsset`, `thumbnail`,
 * `filters`, `assets`, `assetHref`, `table` (merged), `searchColumns`. Unless
 * `searchColumns` is itself overridden it is computed AFTER the others, so it
 * follows them.
 *
 * @param {object} collection  A STAC collection.
 * @param {{ baseUrl: string, overrides?: Partial<ImageryProfile> }} options  `baseUrl` is the collection's own URL.
 * @returns {ImageryProfile}
 * @throws {CngError} `LAYER_UNSUPPORTED` when the collection has no item table to search;
 *   `LAYER_INVALID` (from `layersFromCollection`) for a non-collection or a missing `baseUrl`.
 */
export function imageryProfile(collection, options = {}) {
  const layers = layersFromCollection(collection, { baseUrl: options.baseUrl });
  const scenes = layers.find((l) => l.kind === 'scenes');
  if (!scenes) {
    throw new CngError(`Collection "${collection.id}" has no item table of scenes to search.`, 'LAYER_UNSUPPORTED', {
      context: { collection: collection.id, kinds: layers.map((l) => l.kind) },
    });
  }
  const overrides = isObject(options.overrides) ? options.overrides : {};
  const columns = declaredColumns(collection);
  const summaries = isObject(collection.summaries) ? collection.summaries : {};
  const collectionUrl = scenes.source.collectionUrl;

  const dataset =
    scenes.source.items.kind === 'parquet'
      ? {
          spec: 'cng-dataset/1.0',
          id: collection.id,
          title: scenes.title,
          // No `table`: for one file, extract-core reads the table off the
          // file's own schema, which cannot be out of date.
          source: { kind: 'parquet', url: scenes.source.items.url },
          attribution: scenes.attribution,
        }
      : { spec: 'cng-dataset/1.0', id: collection.id, title: scenes.title, source: { kind: 'portolan-collection', url: collectionUrl } };

  const hasInterval = columns ? columns.has('start_datetime') && columns.has('end_datetime') : true;
  const hasInstant = columns ? columns.has('datetime') : true;
  const table = {
    idColumn: 'id',
    geometryColumn: typeof collection['table:primary_geometry'] === 'string' ? collection['table:primary_geometry'] : 'geometry',
    ...(hasInstant ? { timeColumn: 'datetime' } : {}),
    ...(hasInterval ? { timeInterval: { start: 'start_datetime', end: 'end_datetime' } } : {}),
    ...(isObject(overrides.table) ? overrides.table : {}),
  };

  const displayAsset = overrides.displayAsset ?? scenes.source.displayAsset ?? displayAssetFromStruct(columns);
  const thumbnail = 'thumbnail' in overrides ? overrides.thumbnail : thumbnailOf(collection, columns);
  /** @type {ImageryProfile} */
  const profile = {
    id: collection.id,
    title: typeof collection.title === 'string' && collection.title ? collection.title : scenes.title,
    collectionUrl,
    attribution: scenes.attribution,
    ...(scenes.bbox ? { bbox: scenes.bbox } : {}),
    ...(scenes.temporal ? { temporal: scenes.temporal } : {}),
    dataset,
    table,
    columnsKnown: Boolean(columns),
    ...(displayAsset ? { displayAsset } : {}),
    ...(thumbnail ? { thumbnail } : {}),
    assets: overrides.assets ?? assetsEncoding(columns),
    filters: Array.isArray(overrides.filters) ? overrides.filters : filtersOf(columns, summaries),
    searchColumns: [],
    ...(typeof overrides.assetHref === 'function' ? { assetHref: overrides.assetHref } : {}),
  };
  profile.searchColumns = Array.isArray(overrides.searchColumns) ? overrides.searchColumns : searchColumnsOf(profile, columns);
  return profile;
}
