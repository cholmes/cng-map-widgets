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
import { loadMinisearch } from './minisearch-loader.js';
import { layersFromCollection } from './layers-from-collection.js';
import { layersFromRender } from './render-column.js';

/** The kinds a map can draw as one layer today. `scenes` are searched, not drawn; `timeline` waits for its control. */
const DRAWABLE_KINDS = Object.freeze(['pmtiles-vector', 'cog', 'geojson']);

const WHY_NOT = {
  table: 'A table with no geometry: there is nothing to draw on a map.',
  scenes: 'An imagery collection: its scenes are found with the imagery search, not drawn as one layer.',
  timeline: 'A time series: it needs the timeline control.',
  unsupported: 'Nothing in this collection can be drawn here.',
};

/**
 * @typedef {Object} CatalogEntry
 * @property {string} key      Unique in the index: the collection's own URL.
 * @property {string} id       The collection's id. NOT unique across catalogs.
 * @property {string} title
 * @property {string} description
 * @property {string} href     The collection's JSON.
 * @property {string|null} license
 * @property {string[]} keywords
 * @property {string|null} catalog   The catalog it was registered under (the first, when there are several).
 * @property {string[]} catalogs     Every catalog it is listed under. The `catalog` filter and facet match any of them.
 * @property {{ id: string, href: string }[]} parents
 * @property {[number, number, number, number]|null} bbox  `[w, s, e, n]`; `w > e` across the antimeridian.
 * @property {string|null} start     ISO 8601.
 * @property {string|null} end       ISO 8601; null with a start means "ongoing".
 * @property {string[]} kinds        What it draws as, from the index's `render` column; `[]` when it has none.
 * @property {string|null} thumbnail
 * @property {object[]|null} render  The `render` column's value for this row.
 * @property {object[]|null} attribution  The `attribution` column's value: who to credit, when the index says.
 */

/** Read when present. `id` and `href` are required. `original`, `links` and `geometry` are never read. */
const WANTED = ['type', 'id', 'href', 'title', 'description', 'license', 'keywords', 'parents', 'bbox', 'start_datetime', 'end_datetime', 'portolan_registry:id', 'render', 'thumbnail', 'attribution'];
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

/** The catalog a row was registered under: the registry's own column, else its first parent. */
const catalogOf = (row) => text(row['portolan_registry:id']) || (Array.isArray(row.parents) ? text(row.parents.find(isObject)?.id) : '') || null;

/**
 * One index row -> one entry. `href` is the collection's URL, already made
 * absolute: the index may give it relative to itself, and so may give a
 * parent's link and a thumbnail.
 */
function entryFromRow(row, href, indexUrl) {
  const parents = (Array.isArray(row.parents) ? row.parents : []).filter(isObject).map((p) => ({ id: text(p.id), href: httpUrl(p.href, indexUrl) ?? '' }));
  const render = Array.isArray(row.render) ? row.render.filter((r) => isObject(r) && typeof r.kind === 'string') : null;
  const catalog = catalogOf(row);
  return {
    key: href,
    id: text(row.id),
    title: text(row.title) || text(row.id),
    description: text(row.description),
    href,
    license: text(row.license) || null,
    keywords: (Array.isArray(row.keywords) ? row.keywords : []).filter((k) => typeof k === 'string' && k),
    catalog,
    catalogs: catalog ? [catalog] : [],
    parents,
    bbox: bboxOf(row.bbox),
    start: isoTime(row.start_datetime),
    end: isoTime(row.end_datetime),
    kinds: render ? [...new Set(render.map((r) => r.kind))] : [],
    thumbnail: httpUrl(row.thumbnail, indexUrl),
    render: render && render.length ? render : null,
    attribution: Array.isArray(row.attribution) && row.attribution.some(isObject) ? row.attribution.filter(isObject) : null,
  };
}

const within = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

/**
 * `fetch(url)` and its JSON body, given up on after `ms` -- whether or not
 * the fetch honours its signal. Rejects with a `TimeoutError` then.
 * @returns {Promise<{ res: Response, json: any }>} `json` is null when the response is not ok.
 */
async function fetchJsonWithin(fetchImpl, url, ms) {
  const controller = new AbortController();
  let timer;
  const limit =
    ms > 0 && Number.isFinite(ms)
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            const timeout = new Error(`${url} did not answer within ${within(ms)}`);
            timeout.name = 'TimeoutError';
            controller.abort(timeout);
            reject(timeout);
          }, ms);
        })
      : null;
  const work = (async () => {
    const res = await fetchImpl(url, { signal: controller.signal });
    return { res, json: res.ok ? await res.json() : null };
  })();
  work.catch(() => {}); // when the limit wins, this one's later rejection is nobody's
  try {
    return await (limit ? Promise.race([work, limit]) : work);
  } finally {
    clearTimeout(timer);
  }
}

/** A word as it is indexed and as it is looked for: lower case, accents off ("Bäume" and "baume" are one word). */
const foldTerm = (term) => term.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

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
    // registry repeats 108 of 7,049): its URL is its identity. The first row
    // describes it; a later one only adds the catalog IT was listed under,
    // so a catalog whose collections are all listed elsewhere first (live:
    // all 79 of `harmonized-field-data`) is still there to filter by.
    const seen = new Map();
    let duplicates = 0;
    for (const row of rows) {
      if (typed && row.type !== 'Collection') {
        if (row.type === 'Catalog') catalogs.push({ id: text(row.id), title: text(row.title) || text(row.id), href: httpUrl(row.href, indexUrl) ?? text(row.href) });
        continue;
      }
      // Absolute, or relative to the index file. Anything that is not then
      // http(s) is not something to offer a person to fetch.
      const href = httpUrl(row.href, indexUrl);
      if (!href) continue;
      const earlier = seen.get(href);
      if (earlier) {
        duplicates += 1;
        const also = catalogOf(row);
        if (also && !earlier.catalogs.includes(also)) earlier.catalogs.push(also);
        continue;
      }
      const entry = entryFromRow(row, href, indexUrl);
      seen.set(href, entry);
      entries.push(entry);
    }
    this.indexUrl = indexUrl;
    this.entries = entries;
    this.catalogs = catalogs;
    /** How many collection rows repeated an earlier row's URL and were folded into its entry. */
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
      const { res, json } = await fetchJsonWithin(fetchImpl, this.url, this._timeoutMs);
      if (!res.ok) throw new CngError(`The catalog returned HTTP ${res.status}: ${this.url}`, 'NETWORK', { retryable: res.status >= 500 || res.status === 429, context: { url: this.url, status: res.status } });
      catalog = json;
    } catch (cause) {
      if (cause instanceof CngError) throw cause;
      if (cause?.name === 'TimeoutError') throw new CngError(`The catalog did not answer within ${within(this._timeoutMs)}: ${this.url}`, 'NETWORK', { retryable: true, cause, context: { url: this.url, reason: 'timeout' } });
      throw new CngError(`Couldn't read the catalog: ${this.url}`, 'NETWORK', { cause, context: { url: this.url } });
    }
    const links = Array.isArray(catalog?.links) ? catalog.links.filter(isObject) : [];
    const link = links.find((l) => l.rel === 'data' && (/parquet/i.test(text(l.type)) || /\.(parquet|pq)(\?|$)/i.test(text(l.href))));
    const href = httpUrl(link?.href, this.url);
    if (!href) throw invalid(`${this.url} does not link to a collections index (a parquet link with rel "data").`, { url: this.url, rels: links.map((l) => l.rel) });
    return href;
  }

  /**
   * Find collections. Every filter is optional; with none, everything matches.
   *
   * - `text`: every word must be found (in the title, keywords, id or
   *   description); the last may be unfinished, and a small misspelling is
   *   forgiven. A title match counts for more than a description match.
   * - `area`: an `Area`. Keeps collections whose extent intersects it; one
   *   with no extent is not in any area.
   * - `time`: `{ start?, end? }`. Keeps collections whose own span overlaps;
   *   a collection with a start and no end is ongoing; one with no dates is
   *   in no window.
   * - `license`, `catalog`, `kinds`: a value or a list. `kinds` is known only
   *   for an index with a `render` column.
   *
   * **Order.** By how well the text matches -- and, when an area is given,
   * by how much of the collection lies inside it (`fit`, 0..1): a city's own
   * buildings come before a global buildings layer for the same words. Ties
   * by title.
   *
   * **Facets** say what each filter could be set to and how many collections
   * that would leave. Each is counted over the matches of all the OTHER
   * filters, so choosing a licence does not empty the list of licences.
   *
   * One search at a time: a new call supersedes the one in flight, which
   * resolves `{ results: [], total: 0, superseded: true }`.
   *
   * @param {{ text?: string, area?: object|null, time?: { start?: string, end?: string }, license?: string|string[],
   *   catalog?: string|string[], kinds?: string|string[], limit?: number }} [query]
   * @returns {Promise<{ results: (CatalogEntry & { score: number, fit: number|null })[], total: number,
   *   facets: { license: Facet[], catalog: Facet[], kinds: Facet[] }, superseded?: true }>}
   * @typedef {{ value: string, count: number }} Facet
   */
  async search(query = {}) {
    const generation = (this._generation = (this._generation ?? 0) + 1);
    const superseded = () => ({ results: [], total: 0, facets: { license: [], catalog: [], kinds: [] }, superseded: true });
    await this.load();
    if (generation !== this._generation) return superseded();

    const words = typeof query.text === 'string' ? query.text.trim() : '';
    /** @type {Map<number, number>|null} entry position -> text score; null when there are no words */
    let textScores = null;
    if (words) {
      const mini = await this._textIndex();
      if (generation !== this._generation) return superseded();
      textScores = new Map();
      const how = { boost: { title: 3, keywords: 2, id: 2 }, prefix: (term, i, terms) => i === terms.length - 1, combineWith: 'AND' };
      // One letter of give, and only on a word of six letters or more:
      // enough for "buildings" to find "Building" and for a slip of the
      // finger, not enough for "Bäume" (trees) to bring "Räume" (rooms) --
      // which a flat 20% did, for every five-letter word.
      let hits = mini.search(words, { ...how, fuzzy: (term) => (term.length >= 6 ? 1 : false) });
      // More give is offered only when nothing matches at all (the
      // geocoder's rule too).
      if (!hits.length && words.length >= 3) hits = mini.search(words, { ...how, fuzzy: 0.2 });
      for (const hit of hits) textScores.set(hit.id, hit.score);
    }

    const viewBoxes = Array.isArray(query.area?.bboxes) && query.area.bboxes.length ? query.area.bboxes : null;
    const from = query.time?.start ? Date.parse(query.time.start) : null;
    const to = query.time?.end ? Date.parse(query.time.end) : null;
    const timed = Number.isFinite(from) || Number.isFinite(to);
    const chosen = { license: asSet(query.license), catalog: asSet(query.catalog), kinds: asSet(query.kinds) };
    const facetOk = {
      license: (e) => !chosen.license || chosen.license.has(e.license),
      catalog: (e) => !chosen.catalog || e.catalogs.some((c) => chosen.catalog.has(c)),
      kinds: (e) => !chosen.kinds || e.kinds.some((k) => chosen.kinds.has(k)),
    };

    const counts = { license: new Map(), catalog: new Map(), kinds: new Map() };
    const bump = (map, value) => {
      if (value !== null && value !== undefined && value !== '') map.set(value, (map.get(value) ?? 0) + 1);
    };
    const matched = [];
    this.entries.forEach((entry, position) => {
      if (textScores && !textScores.has(position)) return;
      let fit = null;
      if (viewBoxes) {
        fit = fitOf(entry.bbox, viewBoxes);
        if (fit === null) return;
      }
      if (timed && !overlaps(entry, from, to)) return;
      // Past the text, the area and the time. Each facet now counts this
      // entry if every OTHER facet's choice allows it.
      const ok = { license: facetOk.license(entry), catalog: facetOk.catalog(entry), kinds: facetOk.kinds(entry) };
      if (ok.catalog && ok.kinds) bump(counts.license, entry.license);
      if (ok.license && ok.kinds) for (const catalog of entry.catalogs) bump(counts.catalog, catalog);
      if (ok.license && ok.catalog) for (const kind of entry.kinds) bump(counts.kinds, kind);
      if (!ok.license || !ok.catalog || !ok.kinds) return;
      const text = textScores ? textScores.get(position) : 1;
      matched.push({ ...entry, score: fit === null ? text : text * (0.25 + 0.75 * fit), fit });
    });
    matched.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const limit = Number.isFinite(query.limit) && query.limit > 0 ? Math.trunc(query.limit) : 50;
    const facet = (map) => [...map].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
    return { results: matched.slice(0, limit), total: matched.length, facets: { license: facet(counts.license), catalog: facet(counts.catalog), kinds: facet(counts.kinds) } };
  }

  /**
   * What a found collection puts on a map.
   *
   * From the index's `render` column when the entry has one -- no request.
   * Otherwise the collection's JSON is fetched (once; kept) and read with
   * `layersFromCollection`.
   *
   * The layers are sorted into `drawable` and `undrawable`, the latter each
   * with a reason a person can read: a search result that adds nothing to the
   * map has to say why.
   *
   * @param {CatalogEntry} result
   * @param {{ drawableKinds?: string[] }} [options]  Default: `pmtiles-vector`, `cog`, `geojson`.
   * @returns {Promise<{ layers: object[], source: 'render'|'collection', drawable: object[],
   *   undrawable: { id: string, title: string, kind: string, reason: string }[] }>}
   * @throws {CngError} `LAYER_LOAD_FAILED` (naming the collection) when its JSON cannot be fetched or is not a collection.
   */
  async resolve(result, options = {}) {
    const drawableKinds = options.drawableKinds ?? DRAWABLE_KINDS;
    let layers = [];
    let source = 'render';
    try {
      layers = layersFromRender(result);
    } catch {
      layers = []; // a render value that cannot be a layer: fall back to the document itself
    }
    if (!layers.length) {
      layers = await this._collectionLayers(result);
      source = 'collection';
    }
    const drawable = layers.filter((l) => drawableKinds.includes(l.kind));
    const undrawable = layers
      .filter((l) => !drawableKinds.includes(l.kind))
      .map((l) => ({ id: l.id, title: l.title, kind: l.kind, reason: l.kind === 'unsupported' ? (l.source?.reason ?? WHY_NOT.unsupported) : (WHY_NOT[l.kind] ?? `A "${l.kind}" layer cannot be drawn here.`) }));
    return { layers, source, drawable, undrawable };
  }

  /** The layers of a collection, from its own JSON. One request per collection; a failure is not kept. */
  _collectionLayers(result) {
    this._collections ??= new Map();
    let pending = this._collections.get(result.key);
    if (!pending) {
      pending = this._fetchCollectionLayers(result);
      this._collections.set(result.key, pending);
      pending.catch(() => {
        if (this._collections.get(result.key) === pending) this._collections.delete(result.key);
      });
    }
    return pending;
  }

  async _fetchCollectionLayers(result) {
    const fetchImpl = this._fetch ?? globalThis.fetch.bind(globalThis);
    const failed = (why, extra = {}, retryable = true, cause) =>
      new CngError(`Couldn't read "${result.title}": ${why}.`, 'LAYER_LOAD_FAILED', { retryable, context: { collection: result.id, url: result.href, ...extra }, ...(cause ? { cause } : {}) });
    let collection;
    try {
      const { res, json } = await fetchJsonWithin(fetchImpl, result.href, this._timeoutMs);
      if (!res.ok) throw failed(`its collection document returned HTTP ${res.status}`, { status: res.status }, res.status >= 500 || res.status === 429 || res.status === 404 || res.status === 408);
      collection = json;
    } catch (cause) {
      if (cause instanceof CngError) throw cause;
      if (cause?.name === 'TimeoutError') throw failed(`its host did not answer within ${within(this._timeoutMs)}`, { reason: 'timeout' }, true, cause);
      throw failed('its collection document could not be fetched', {}, true, cause);
    }
    try {
      return layersFromCollection(collection, { baseUrl: result.href });
    } catch (cause) {
      throw failed('what is published there is not a STAC collection', {}, false, cause);
    }
  }

  /** The text index over the loaded entries, built on first use. */
  _textIndex() {
    if (!this._mini || this._miniFor !== this.entries) {
      const entries = this.entries;
      this._miniFor = entries;
      this._mini = loadMinisearch().then((MiniSearch) => {
        const mini = new MiniSearch({
          idField: 'n',
          fields: ['title', 'keywords', 'id', 'description'],
          storeFields: [],
          processTerm: foldTerm,
          extractField: (doc, field) => (field === 'keywords' ? doc.keywords.join(' ') : doc[field]),
        });
        mini.addAll(entries.map((e, n) => ({ n, title: e.title, keywords: e.keywords, id: e.id, description: e.description })));
        return mini;
      });
      this._mini.catch(() => {
        this._mini = null;
      });
    }
    return this._mini;
  }

  /** Forget what was read. The object can be loaded again. */
  close() {
    this._generation = (this._generation ?? 0) + 1;
    this._loading = null;
    this._mini = null;
    this._collections?.clear();
    this.entries = [];
    this.catalogs = [];
    if (this._ownsCache) this._cache.clear();
  }
}

/** A filter value -- one, or a list -- as a Set; null for "not filtered". */
function asSet(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = (Array.isArray(value) ? value : [value]).filter((v) => v !== undefined && v !== null && v !== '');
  return list.length ? new Set(list) : null;
}

/** A `[w, s, e, n]` box as one or two boxes with `w <= e`: two when it crosses the antimeridian. */
function unwrap(box) {
  const [w, s, e, n] = box;
  return w > e ? [[w, s, 180, n], [-180, s, e, n]] : [box];
}

const areaOfBox = ([w, s, e, n]) => Math.max(0, e - w) * Math.max(0, n - s);

/**
 * How much of a collection's extent lies inside the view, 0..1 -- or `null`
 * when it does not touch the view at all (or has no extent).
 *
 * The extent's share, not an intersection-over-union: a small local dataset
 * wholly inside the view is as "here" as one the size of the view, while a
 * global layer, of which the view is a sliver, is barely here at all.
 */
function fitOf(bbox, viewBoxes) {
  if (!bbox) return null;
  const extent = unwrap(bbox);
  let touches = false;
  let inside = 0;
  for (const a of extent) {
    for (const v of viewBoxes) {
      if (a[0] > v[2] || v[0] > a[2] || a[1] > v[3] || v[1] > a[3]) continue;
      touches = true;
      inside += areaOfBox([Math.max(a[0], v[0]), Math.max(a[1], v[1]), Math.min(a[2], v[2]), Math.min(a[3], v[3])]);
    }
  }
  if (!touches) return null;
  const whole = extent.reduce((sum, b) => sum + areaOfBox(b), 0);
  // A point or a line has no area to take a share of: it is simply in the view.
  return whole > 0 ? Math.min(1, inside / whole) : 1;
}

/** Does the entry's own span overlap `[from, to]` (either may be null for open)? */
function overlaps(entry, from, to) {
  const start = entry.start ? Date.parse(entry.start) : null;
  const end = entry.end ? Date.parse(entry.end) : null;
  if (start === null && end === null) return false;
  const lo = start ?? -Infinity;
  const hi = end ?? Infinity;
  return (to === null || !Number.isFinite(to) || lo <= to) && (from === null || !Number.isFinite(from) || hi >= from);
}
