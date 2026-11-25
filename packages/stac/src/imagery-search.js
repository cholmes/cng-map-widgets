// @cngeo/stac -- ImagerySearch: scenes from a STAC-GeoParquet item table, by
// area, time and attributes.
//
// It is `@cngeo/extract-core`'s `queryRows` (same resolve -> prune -> read as a
// download) plus the four things a scene search needs on top:
//
//   1. One search at a time. A new search supersedes the one in flight, which
//      stops reading and resolves empty -- never rejects, and never delivers
//      another scene (the `Geocoder.search` contract).
//   2. What planning learns is kept (a plan cache), and the dataset is resolved
//      once. E14 measured the alternative on Sentinel-2: 13 listing requests
//      and a 7.9 MB footer before EVERY search read a row.
//   3. Rows become `Scene`s: one shape whatever the collection calls its
//      columns or however it encodes a bbox, a time, or its assets.
//   4. A scene's files are resolved when it is added to the map, not for every
//      row of every search -- unless they are a small struct that came along
//      anyway.

import { CngError, validateLayerSpec } from '@cngeo/spec';
import { queryRows, describeDataset, createPlanCache } from '@cngeo/extract-core';

/**
 * @typedef {Object} Scene
 * @property {string} id
 * @property {string|null} datetime  ISO 8601.
 * @property {string|null} start     For a scene that covers a span.
 * @property {string|null} end
 * @property {[number, number, number, number]|null} bbox  `[w, s, e, n]`.
 * @property {object|null} geometry  GeoJSON footprint.
 * @property {Record<string, unknown>} properties  Every other column the search read.
 * @property {string|null} thumbnail  An http(s) URL.
 * @property {string|null} self       The scene's own STAC item document, when its row links to one.
 * @property {Record<string, { href: string, type?: string, roles?: string[] }>} [assets]  Present only when the search read them.
 */

const COG_TYPE = 'image/tiff; application=geotiff; profile=cloud-optimized';
const DEFAULT_LIMIT = 200;
const DEFAULT_SCAN_LIMIT = 5000;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** `value` as an absolute http(s) URL (resolved against `base` when given), or null. */
function httpUrl(value, base) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A stored time as ISO 8601: a `Date` (a parquet timestamp), an ISO string, or epoch milliseconds. */
function isoTime(value) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return typeof value === 'string' ? value : null;
}

/** A STAC-GeoParquet bbox -- a `[w, s, e, n]` list, a 3D list, or an `{xmin, ymin, xmax, ymax}` struct -- as `[w, s, e, n]`. */
function bboxOf(value, geometry) {
  let box = null;
  if (Array.isArray(value)) box = value.length >= 6 ? [value[0], value[1], value[3], value[4]] : value.slice(0, 4);
  else if (isObject(value)) box = [value.xmin, value.ymin, value.xmax, value.ymax];
  if (box && box.length === 4 && box.every((n) => typeof n === 'number' && Number.isFinite(n))) return box;
  return geometry ? geometryBBox(geometry) : null;
}

function geometryBBox(geometry) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
    } else for (const child of c) walk(child);
  };
  walk(geometry.coordinates ?? (geometry.geometries ?? []).map((g) => g.coordinates));
  return Number.isFinite(w) && Number.isFinite(s) ? [w, s, e, n] : null;
}

/**
 * A scene's assets as a plain map, from a struct, a JSON string, or an item
 * document. A struct column holds every key any item uses, null where this
 * item has none: those are not assets. Relative hrefs resolve against `base`.
 * @returns {Record<string, object>|undefined} `undefined` when there are none.
 */
function normalizeAssets(value, base) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!isObject(raw)) return undefined;
  const out = {};
  for (const [key, asset] of Object.entries(raw)) {
    if (!isObject(asset) || typeof asset.href !== 'string' || !asset.href) continue;
    const clean = {};
    for (const [k, v] of Object.entries(asset)) if (v !== null && v !== undefined) clean[k] = v;
    if (base) {
      try {
        clean.href = new URL(asset.href, base).href;
      } catch {
        // an href that is not a URL at all is kept as published
      }
    }
    out[key] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Order scenes. `sort.by` is `'datetime'` (a scene's instant, else the start
 * of its span) or a property name; a scene with no value sorts LAST in either
 * direction; ties keep their order. Returns a new array.
 * @param {Scene[]} scenes
 * @param {{ by?: string, order?: 'asc'|'desc' }} [sort] Default: newest first.
 */
export function sortScenes(scenes, sort = {}) {
  const by = sort.by ?? 'datetime';
  const direction = (sort.order ?? (by === 'datetime' ? 'desc' : 'asc')) === 'desc' ? -1 : 1;
  const keyOf = (scene) => {
    if (by === 'datetime') {
      const ms = Date.parse(scene.datetime ?? scene.start ?? scene.end ?? '');
      return Number.isFinite(ms) ? ms : null;
    }
    const v = scene.properties?.[by];
    return v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v)) ? null : v;
  };
  return scenes
    .map((scene) => ({ scene, key: keyOf(scene) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) return a.key === b.key ? 0 : a.key === null ? 1 : -1;
      return a.key < b.key ? -direction : a.key > b.key ? direction : 0;
    })
    .map((entry) => entry.scene);
}

const superseded = () => ({ scenes: [], truncated: false, matched: 0, partial: false, plan: null, superseded: true });

/**
 * Check a profile -- a reading of the collection DOCUMENT -- against what the
 * item table really holds, and add the two columns only this class knows it
 * wants (`links`, to resolve a scene later; `title`, for a layer's name).
 *
 * `described.columns` is the file's real schema when the dataset is one file.
 * For a partitioned dataset no footer has been read, and the columns the
 * collection declared are all there is to go on.
 */
function settleProfile(profile, described) {
  const real = described.columns ? new Map(described.columns.map((c) => [c.name, c])) : null;
  const declared = Array.isArray(described.dataset.table?.columns) ? new Set(described.dataset.table.columns.map((c) => c?.name)) : null;
  const has = (name) => (real ? real.has(name) : declared ? declared.has(name) : false);
  const settled = { ...profile, table: { ...profile.table }, filters: [...profile.filters] };

  if (real) {
    if (settled.table.timeColumn && !has(settled.table.timeColumn)) delete settled.table.timeColumn;
    const interval = settled.table.timeInterval;
    if (interval && !(has(interval.start) && has(interval.end))) delete settled.table.timeInterval;
    const assets = real.get('assets');
    settled.assets = assets ? (assets.struct ? 'struct' : 'json') : 'unknown';
    if (!settled.displayAsset && assets?.struct) {
      const fields = assets.fields ?? [];
      settled.displayAsset = fields.find((f) => f === 'visual') ?? fields.find((f) => f === 'image') ?? fields[0];
    }
    if (settled.thumbnail?.column && !has(settled.thumbnail.column)) delete settled.thumbnail;
    settled.filters = settled.filters.filter((f) => has(f.column));
  }

  const columns = new Set(real ? profile.searchColumns.filter(has) : profile.searchColumns);
  if (real) for (const c of [settled.table.timeColumn, settled.table.timeInterval?.start, settled.table.timeInterval?.end]) if (c) columns.add(c);
  if (settled.assets === 'struct') columns.add('assets');
  else {
    // A JSON `assets` is most of the file (E14) and is never read per search;
    // the row's own item link is how one scene is resolved later.
    columns.delete('assets');
    if (has('links')) columns.add('links');
  }
  if (has('title')) columns.add('title');
  settled.searchColumns = [...columns];
  return settled;
}

export class ImagerySearch {
  /**
   * @param {import('./imagery-profile.js').ImageryProfile} profile  From `imageryProfile()`.
   * @param {{
   *   cache?: object,       A `createPlanCache()` to share; one is made otherwise.
   *   fetch?: typeof fetch,
   *   maxAgeMs?: number,    Lifetime of the cache this makes (default 10 minutes).
   *   scanLimit?: number,   Most matching rows one search reads (default 5000).
   * }} [options]
   */
  constructor(profile, options = {}) {
    /** The profile in use. After `warm()` it has been checked against the item table. */
    this.profile = profile;
    this._given = profile;
    this._fetch = options.fetch;
    this._cache = options.cache ?? createPlanCache(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs });
    this._scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
    this._generation = 0;
    /** @type {AbortController|null} */
    this._controller = null;
    /** @type {Promise<void>|null} */
    this._ready = null;
    this._dataset = null;
    /** @type {Map<string, Promise<Record<string, object>>>} */
    this._items = new Map();
  }

  /**
   * Resolve the dataset, list its parts and -- for a single-file item table --
   * read its footer and settle the profile against it. Idempotent; a search
   * calls it. Call it yourself when a search panel opens, so the first search
   * does not pay for it. A failure is not remembered.
   * @returns {Promise<void>}
   */
  warm() {
    if (!this._ready) {
      const ready = describeDataset(this._given.dataset, { cache: this._cache, fetch: this._fetch }).then((described) => {
        this._dataset = described.dataset;
        this.profile = settleProfile(this._given, described);
      });
      this._ready = ready;
      ready.catch(() => {
        if (this._ready === ready) this._ready = null;
      });
    }
    return this._ready;
  }

  /**
   * Find scenes. Starting a search supersedes the one in flight, which
   * resolves `{ scenes: [], superseded: true }`.
   *
   * `sort` and `limit` apply to what was READ, and a read is bounded by
   * `scanLimit` matching rows: rows come in file order, so the newest N cannot
   * be had without reading every match. `partial: true` says the read stopped
   * at `scanLimit` and the order is over that subset only -- narrow the area or
   * the dates. `truncated` says there were more matches than `scenes` returned.
   *
   * `onScenes` receives matches as each row group is read, unsorted and
   * uncut; the resolved `scenes` is the sorted, limited answer.
   *
   * @param {{
   *   area?: import('@cngeo/spec').Area|null,
   *   time?: { start?: string, end?: string, closed?: string },
   *   where?: object[],
   *   sort?: { by?: string, order?: 'asc'|'desc' },
   *   limit?: number,
   *   scanLimit?: number,
   *   onScenes?: (scenes: Scene[]) => void|Promise<void>,
   *   onPlan?: (plan: object) => void,
   *   onProgress?: (progress: object) => void,
   * }} [query]
   * @returns {Promise<{ scenes: Scene[], truncated: boolean, matched: number, partial: boolean, plan: object|null, superseded?: true }>}
   */
  async search(query = {}) {
    const generation = ++this._generation;
    this._controller?.abort('superseded');
    const controller = new AbortController();
    this._controller = controller;
    const stale = () => generation !== this._generation;
    try {
      await this.warm();
      if (stale()) return superseded();
      const profile = this.profile;
      const limit = Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT));
      const scanLimit = Math.max(limit, Math.trunc(query.scanLimit ?? this._scanLimit));
      const filter = {
        spec: 'cng-filter/1.0',
        spatial: { mode: 'intersects' },
        ...(query.time && (query.time.start || query.time.end) ? { time: query.time } : {}),
        ...(Array.isArray(query.where) && query.where.length ? { where: query.where } : {}),
        // `includeBbox`: without it extract-core drops a covering column from the output.
        columns: { include: profile.searchColumns, includeBbox: true },
        limit: scanLimit,
      };
      /** @type {Scene[]} */
      const scenes = [];
      const result = await queryRows(this._dataset, query.area ?? null, filter, {
        cache: this._cache,
        fetch: this._fetch,
        signal: controller.signal,
        onPlan: (plan) => {
          if (!stale()) query.onPlan?.(plan);
        },
        onProgress: (progress) => {
          if (!stale()) query.onProgress?.(progress);
        },
        onRows: async (rows) => {
          if (stale()) return;
          const batch = rows.map((row) => sceneFromRow(row, profile));
          scenes.push(...batch);
          await query.onScenes?.(batch);
        },
      });
      if (stale()) return superseded();
      const sorted = sortScenes(scenes, query.sort);
      return {
        scenes: sorted.slice(0, limit),
        truncated: result.truncated || sorted.length > limit,
        matched: scenes.length,
        partial: result.truncated,
        plan: result.plan,
      };
    } catch (err) {
      // Whatever an abandoned search ran into -- its own cancellation above
      // all -- is not the caller's problem: a newer search owns the result.
      if (stale()) return superseded();
      throw err;
    } finally {
      if (this._controller === controller) this._controller = null;
    }
  }

  /**
   * A scene's files. First that applies:
   *   1. the assets its row carried (a struct read with the search);
   *   2. `profile.assetHref(scene)` -- a naming convention, as the display asset;
   *   3. the scene's own STAC item document (`scene.self`), one request, kept.
   * Otherwise `SCENE_ASSETS_UNAVAILABLE`, naming the scene.
   * @param {Scene} scene
   * @returns {Promise<Record<string, { href: string, type?: string, roles?: string[] }>>}
   */
  async resolveAssets(scene) {
    if (isObject(scene?.assets) && Object.keys(scene.assets).length) return scene.assets;
    const profile = this.profile;
    let conventional = null;
    try {
      conventional = httpUrl(profile.assetHref?.(scene));
    } catch {
      conventional = null; // a convention that throws on this scene simply does not apply to it
    }
    if (conventional) return { [profile.displayAsset ?? 'visual']: { href: conventional, type: COG_TYPE, roles: ['visual'] } };
    const self = httpUrl(scene?.self);
    if (!self) throw this._unavailable(scene, 'no-source', 'its row carries no assets and no link to its own STAC item');
    let pending = this._items.get(self);
    if (!pending) {
      pending = this._fetchItemAssets(scene, self);
      this._items.set(self, pending);
      pending.catch(() => {
        if (this._items.get(self) === pending) this._items.delete(self);
      });
    }
    return pending;
  }

  async _fetchItemAssets(scene, self) {
    const fetchImpl = this._fetch ?? globalThis.fetch.bind(globalThis);
    let item;
    try {
      const res = await fetchImpl(self);
      if (!res.ok) throw this._unavailable(scene, 'item-fetch-failed', `its STAC item returned HTTP ${res.status}`, { url: self, status: res.status });
      item = await res.json();
    } catch (cause) {
      if (cause?.code === 'SCENE_ASSETS_UNAVAILABLE') throw cause;
      throw this._unavailable(scene, 'item-fetch-failed', 'its STAC item could not be read', { url: self }, cause);
    }
    const assets = normalizeAssets(isObject(item) ? item.assets : undefined, self);
    if (!assets) throw this._unavailable(scene, 'item-has-no-assets', 'its STAC item lists no assets', { url: self });
    return assets;
  }

  _unavailable(scene, reason, why, context = {}, cause) {
    const id = scene?.id ?? '(unknown)';
    return new CngError(`The files of scene "${id}" could not be worked out: ${why}.`, 'SCENE_ASSETS_UNAVAILABLE', {
      retryable: false,
      context: { scene: id, collection: this.profile.id, reason, ...context },
      ...(cause ? { cause } : {}),
    });
  }

  /**
   * One scene as a map layer: a `cog` LayerSpec in the collection's `group`,
   * ready for `LayerManager.add()`.
   *
   * The asset is `options.asset ?? profile.displayAsset`. It must be an
   * http(s) GeoTIFF; anything else is `LAYER_UNSUPPORTED`, and a missing asset
   * `SCENE_ASSETS_UNAVAILABLE` -- never a layer that draws nothing.
   * @param {Scene} scene
   * @param {{ asset?: string }} [options]
   * @returns {Promise<object>} A validated LayerSpec.
   */
  async layerSpecFor(scene, options = {}) {
    const profile = this.profile;
    const assets = await this.resolveAssets(scene);
    const key = options.asset ?? profile.displayAsset ?? Object.keys(assets).find((k) => /tiff/i.test(assets[k].type ?? ''));
    const asset = key ? assets[key] : undefined;
    if (!asset) {
      throw this._unavailable(scene, 'no-such-asset', `it has no "${key ?? '(picture)'}" asset`, { asset: key ?? null, available: Object.keys(assets) });
    }
    const url = httpUrl(asset.href);
    const type = typeof asset.type === 'string' ? asset.type : '';
    const isTiff = /tiff/i.test(type) || (!type && /\.tiff?$/i.test(url ? new URL(url).pathname : ''));
    if (!url || !isTiff) {
      throw new CngError(
        `Asset "${key}" of scene "${scene.id}" cannot be drawn: ${url ? `it is ${type || 'not a GeoTIFF'}` : 'its address is not http(s)'}.`,
        'LAYER_UNSUPPORTED',
        { retryable: false, context: { scene: scene.id, collection: profile.id, asset: key, href: asset.href, type: type || null } },
      );
    }
    const alternate = Boolean(options.asset) && options.asset !== profile.displayAsset;
    const title = typeof scene.properties?.title === 'string' && scene.properties.title ? scene.properties.title : scene.id;
    const box = scene.bbox;
    const boxOk = Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[0] <= box[2] && box[1] <= box[3];
    const from = scene.start ?? scene.datetime ?? null;
    const to = scene.end ?? scene.datetime ?? null;
    const thumbnail = httpUrl(scene.thumbnail);
    return validateLayerSpec({
      spec: 'cng-layer/1.0',
      id: `${profile.id}:${scene.id}${alternate ? `:${key}` : ''}`,
      title: alternate ? `${title} (${key})` : title,
      kind: 'cog',
      source: { url },
      // A footprint across the antimeridian has no single [w, s, e, n] box.
      ...(boxOk ? { bbox: box } : {}),
      ...(from || to ? { temporal: [from, to] } : {}),
      attribution: profile.attribution ?? [],
      group: profile.id,
      ...(thumbnail ? { thumbnail } : {}),
    });
  }

  /** Stop the search in flight (it resolves superseded) and forget what was cached. The object stays usable. */
  close() {
    this._generation += 1;
    this._controller?.abort('closed');
    this._controller = null;
    this._items.clear();
    this._cache.clear();
    this._ready = null;
  }
}

/** One read row -> one Scene. */
function sceneFromRow(row, profile) {
  const { idColumn, geometryColumn, timeColumn, timeInterval } = profile.table;
  const geometry = row[geometryColumn] ?? null;
  const assets = 'assets' in row ? normalizeAssets(row.assets) : undefined;
  const thumbnailColumn = profile.thumbnail?.column;
  const reserved = new Set([idColumn, geometryColumn, 'bbox', 'assets', 'links', timeColumn, timeInterval?.start, timeInterval?.end, thumbnailColumn]);
  const properties = {};
  for (const [key, value] of Object.entries(row)) if (!reserved.has(key)) properties[key] = value;
  const self = Array.isArray(row.links) ? row.links.find((l) => isObject(l) && l.rel === 'self' && httpUrl(l.href)) : null;
  /** @type {Scene} */
  const scene = {
    id: String(row[idColumn]),
    datetime: timeColumn ? isoTime(row[timeColumn]) : null,
    start: timeInterval ? isoTime(row[timeInterval.start]) : null,
    end: timeInterval ? isoTime(row[timeInterval.end]) : null,
    bbox: bboxOf(row.bbox, geometry),
    geometry,
    properties,
    thumbnail: httpUrl(thumbnailColumn ? row[thumbnailColumn] : assets?.[profile.thumbnail?.asset]?.href),
    self: self ? httpUrl(self.href) : null,
  };
  if (assets) scene.assets = assets;
  return scene;
}
