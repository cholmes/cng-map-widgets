// @cngeo/stac -- CatalogIndex: a catalog of collections, searched in the browser.
//
// A Portolan catalog publishes an index of everything in it as one parquet
// file, `collections.parquet`: a row per catalog and per collection, with the
// title, description, keywords, extent and licence of each as columns, and the
// collection's whole JSON in a column called `original`.
//
// The registry's index is 20 MB (measured 2026-11-25): 12.5 MB of it is
// `original` and 5.6 MB is `links`. Everything a search needs is the other
// 2.3 MB, in three range requests -- so that is all this ever reads. The
// rows are then searched in memory: 17,585 of them is nothing.

import { CngError } from '@cngeo/spec';
import { queryRows, describeDataset, createPlanCache } from '@cngeo/extract-core';

/**
 * @typedef {Object} CatalogEntry
 * @property {string} key      Unique in the index: the collection's own URL.
 * @property {string} id       The collection's id. NOT unique across catalogs.
 * @property {string} title
 * @property {string} description
 * @property {string} href     The collection's JSON.
 * @property {string|null} license
 * @property {string[]} keywords
 * @property {string|null} catalog   The catalog it was registered under.
 * @property {{ id: string, href: string }[]} parents
 * @property {[number, number, number, number]|null} bbox  `[w, s, e, n]`; `w > e` across the antimeridian.
 * @property {string|null} start     ISO 8601.
 * @property {string|null} end       ISO 8601; null with a start means "ongoing".
 * @property {string[]} kinds        What it draws as, from the index's `render` column; `[]` when it has none.
 * @property {string|null} thumbnail
 * @property {object[]|null} render  The `render` column's value for this row.
 */

/** Read when present. `id` and `href` are required. `original`, `links` and `geometry` are never read. */
const WANTED = ['type', 'id', 'href', 'title', 'description', 'license', 'keywords', 'parents', 'bbox', 'start_datetime', 'end_datetime', 'portolan_registry:id', 'render', 'thumbnail'];
const REQUIRED = ['id', 'href'];
const DEFAULT_TIMEOUT_MS = 60_000;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');

function httpUrl(value, base) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function isoTime(value) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A bbox column value -- a `{xmin, ymin, xmax, ymax}` struct or a `[w, s, e, n]` list -- as `[w, s, e, n]`, or null. */
function bboxOf(value) {
  const box = Array.isArray(value) ? (value.length >= 6 ? [value[0], value[1], value[3], value[4]] : value.slice(0, 4)) : isObject(value) ? [value.xmin, value.ymin, value.xmax, value.ymax] : null;
  return box && box.length === 4 && box.every((n) => typeof n === 'number' && Number.isFinite(n)) ? box : null;
}

function invalid(message, context) {
  return new CngError(message, 'CATALOG_INDEX_INVALID', { retryable: false, context });
}

/** One index row -> one entry. */
function entryFromRow(row) {
  const parents = (Array.isArray(row.parents) ? row.parents : []).filter(isObject).map((p) => ({ id: text(p.id), href: text(p.href) }));
  const render = Array.isArray(row.render) ? row.render.filter((r) => isObject(r) && typeof r.kind === 'string') : null;
  const href = text(row.href);
  return {
    key: href,
    id: text(row.id),
    title: text(row.title) || text(row.id),
    description: text(row.description),
    href,
    license: text(row.license) || null,
    keywords: (Array.isArray(row.keywords) ? row.keywords : []).filter((k) => typeof k === 'string' && k),
    catalog: text(row['portolan_registry:id']) || parents[0]?.id || null,
    parents,
    bbox: bboxOf(row.bbox),
    start: isoTime(row.start_datetime),
    end: isoTime(row.end_datetime),
    kinds: render ? [...new Set(render.map((r) => r.kind))] : [],
    thumbnail: httpUrl(row.thumbnail),
    render: render && render.length ? render : null,
  };
}

export class CatalogIndex {
  /**
   * @param {string} url  A `collections.parquet`, or a `catalog.json` that links to one with `rel: "data"`.
   * @param {{ fetch?: typeof fetch, cache?: object, timeoutMs?: number }} [options]
   *   `timeoutMs` (60 s; 0 for none) bounds each request made while loading.
   */
  constructor(url, options = {}) {
    this.url = url;
    /** The parquet file's URL, once known. */
    this.indexUrl = null;
    /** @type {CatalogEntry[]} Collections. Empty until `load()` resolves. */
    this.entries = [];
    /** @type {{ id: string, title: string, href: string }[]} The index's catalog rows. */
    this.catalogs = [];
    /** Whether the index says how each collection is drawn (a `render` column). */
    this.hasRender = false;
    this._fetch = options.fetch;
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._ownsCache = !options.cache;
    this._cache = options.cache ?? createPlanCache({ loadTimeoutMs: this._timeoutMs });
    /** @type {Promise<void>|null} */
    this._loading = null;
  }

  /**
   * Read the index. Idempotent; concurrent calls share one read; a failure is
   * not remembered. Rejects `CATALOG_INDEX_INVALID` for something that is not
   * a collections index, and with the reader's own error (`NETWORK`,
   * `DATASET_UNRESOLVED`, both retryable) when it cannot be fetched.
   * @returns {Promise<void>}
   */
  load() {
    if (!this._loading) {
      const loading = this._load();
      this._loading = loading;
      loading.catch(() => {
        if (this._loading === loading) this._loading = null;
      });
    }
    return this._loading;
  }

  async _load() {
    const fetchImpl = this._fetch ?? globalThis.fetch.bind(globalThis);
    const indexUrl = await this._locate(fetchImpl);
    const shared = { cache: this._cache, fetch: this._fetch };
    const described = await describeDataset({ spec: 'cng-dataset/1.0', id: 'catalog-index', source: { kind: 'parquet', url: indexUrl } }, shared);
    const names = (described.columns ?? []).map((c) => c.name);
    const missing = REQUIRED.filter((c) => !names.includes(c));
    if (missing.length) throw invalid(`${indexUrl} is not a collections index: it has no ${missing.map((c) => `"${c}"`).join(' or ')} column.`, { url: indexUrl, missing, columns: names });
    const include = WANTED.filter((c) => names.includes(c));
    // Declared, not inferred: the reader's inference takes the LAST column for
    // the geometry when none is called `geometry`, and would then drop it.
    // Nothing here is spatial as far as the reader is concerned -- `bbox` is
    // read as an ordinary column and compared in memory.
    const dataset = {
      ...described.dataset,
      table: { geometryColumn: names.includes('geometry') ? 'geometry' : ' no geometry column', geometryEncoding: 'WKB', crs: 'OGC:CRS84', bbox: { kind: 'none' }, columns: names.map((name) => ({ name, type: 'unknown' })) },
    };
    const { rows } = await queryRows(dataset, null, { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' }, columns: { include, dropGeometry: true } }, { ...shared, geometry: 'none', requestTimeoutMs: this._timeoutMs, readRetries: 2 });

    const typed = names.includes('type');
    const entries = [];
    const catalogs = [];
    // A collection is one entry however often the index lists it (the live
    // registry repeats 108 of 7,049): its URL is its identity, and the first
    // row wins.
    const seen = new Set();
    let duplicates = 0;
    for (const row of rows) {
      if (typed && row.type !== 'Collection') {
        if (row.type === 'Catalog') catalogs.push({ id: text(row.id), title: text(row.title) || text(row.id), href: text(row.href) });
        continue;
      }
      const href = text(row.href);
      if (!href) continue;
      if (seen.has(href)) {
        duplicates += 1;
        continue;
      }
      seen.add(href);
      entries.push(entryFromRow(row));
    }
    this.indexUrl = indexUrl;
    this.entries = entries;
    this.catalogs = catalogs;
    /** How many collection rows repeated an earlier row's URL and were left out. */
    this.duplicates = duplicates;
    this.hasRender = names.includes('render');
  }

  /** The parquet file's URL: `this.url` itself, or the `rel: "data"` parquet link of the catalog it names. */
  async _locate(fetchImpl) {
    let pathname = '';
    try {
      pathname = new URL(this.url).pathname;
    } catch {
      throw invalid(`A catalog index needs an absolute URL (got ${JSON.stringify(this.url)}).`, { url: this.url });
    }
    if (/\.(parquet|pq)$/i.test(pathname)) return this.url;
    let catalog;
    try {
      const res = await fetchImpl(this.url);
      if (!res.ok) throw new CngError(`The catalog returned HTTP ${res.status}: ${this.url}`, 'NETWORK', { retryable: res.status >= 500 || res.status === 429, context: { url: this.url, status: res.status } });
      catalog = await res.json();
    } catch (cause) {
      if (cause instanceof CngError) throw cause;
      throw new CngError(`Couldn't read the catalog: ${this.url}`, 'NETWORK', { cause, context: { url: this.url } });
    }
    const links = Array.isArray(catalog?.links) ? catalog.links.filter(isObject) : [];
    const link = links.find((l) => l.rel === 'data' && (/parquet/i.test(text(l.type)) || /\.(parquet|pq)(\?|$)/i.test(text(l.href))));
    const href = httpUrl(link?.href, this.url);
    if (!href) throw invalid(`${this.url} does not link to a collections index (a parquet link with rel "data").`, { url: this.url, rels: links.map((l) => l.rel) });
    return href;
  }

  /** Forget what was read. The object can be loaded again. */
  close() {
    this._loading = null;
    this.entries = [];
    this.catalogs = [];
    if (this._ownsCache) this._cache.clear();
  }
}
