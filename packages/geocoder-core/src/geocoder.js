// @cnmw/geocoder-core -- the Geocoder class (design doc §3.2, §6).

import { CnmwError, normalizeName, buildArea } from '@cnmw/spec';
import { Emitter } from './events.js';
import { loadManifest, resolveManifestUrl, loadFullIndex, openRangeIndex, searchRangeIndex, prefixRange } from './index-loader.js';
import { rankRow, compareRanked, scoreOf } from './ranking.js';
import { resolveGeometry } from './geometry-resolver.js';

/** @typedef {import('@cnmw/spec').BBox} BBox */

export const DEFAULT_INDEX_URL = './data/index.json';
export const VERSION = '0.1.0-experiment';

const DEFAULT_RANKING = {
  viewportBoost: 1,
  nearFactor: 2,
  matchClasses: ['exact', 'prefix', 'word-prefix'],
};

function defaultNormalize(s) {
  return normalizeName(s);
}

export class Geocoder {
  /** @param {import('./types.js').GeocoderOptions} [options] */
  constructor(options = {}) {
    this._options = options;
    this._emitter = new Emitter();
    this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this._normalize = options.normalize ?? defaultNormalize;
    this._rankingOptions = { ...DEFAULT_RANKING, ...options.ranking };
    this._loadStrategyOption = options.loadStrategy ?? 'auto';
    this._fullLoadMaxBytes = options.fullLoadMaxBytes ?? 5_242_880;
    this._onVersionSkew = options.onVersionSkew ?? 'error';

    /** @type {'idle'|'loading'|'ready'|'error'} */
    this._state = 'idle';
    /** @type {import('./types.js').IndexInfo|null} */
    this._info = null;
    /** @type {readonly object[]} */
    this._attribution = [];

    this._manifest = null;
    this._manifestUrl = typeof options.indexUrl === 'string' ? options.indexUrl : DEFAULT_INDEX_URL;
    this._full = null; // { rows, nameNorms }
    this._range = null; // range index handle

    this._loadPromise = null;
    this._searchGeneration = 0;
  }

  get state() {
    return this._state;
  }
  get info() {
    return this._info;
  }
  get attribution() {
    return this._attribution;
  }

  _setState(state) {
    this._state = state;
    this._emitter.emit('state', { state });
  }

  /** @param {AbortSignal} [signal] */
  load(signal) {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad(signal).catch((err) => {
      this._setState('error');
      this._emitter.emit('error', err);
      this._loadPromise = null; // allow retry
      throw err;
    });
    return this._loadPromise;
  }

  async _doLoad(signal) {
    this._setState('loading');
    const t0 = performance.now();
    const manifest = await loadManifest(this._manifestUrl, this._fetch);
    this._manifest = manifest;
    signal?.throwIfAborted();

    const declaredBytes = manifest.index?.size ?? 0;
    let strategy = this._loadStrategyOption;
    if (strategy === 'auto') strategy = declaredBytes <= this._fullLoadMaxBytes ? 'full' : 'range';

    const parquetUrl = resolveManifestUrl(this._manifestUrl, manifest.index.url);

    if (strategy === 'full') {
      this._full = await loadFullIndex(parquetUrl, this._fetch);
    } else {
      this._range = await openRangeIndex(parquetUrl, this._fetch);
    }

    const loadMs = performance.now() - t0;
    this._attribution = manifest.attribution ?? [];
    this._info = {
      url: this._manifestUrl,
      source: manifest.source,
      indexVersion: manifest.index_version,
      catalogVersion: manifest.catalog_version,
      rows: manifest.rows,
      levels: manifest.levels ?? [],
      bytes: declaredBytes,
      strategy,
      attribution: this._attribution,
      loadMs,
    };
    this._setState('ready');
    this._emitter.emit('load', this._info);
    return this._info;
  }

  /**
   * @param {string} prefix
   * @param {import('./types.js').SearchOptions} [options]
   */
  async search(prefix, options = {}) {
    const generation = ++this._searchGeneration;
    try {
      await this.load(options.signal);
    } catch (err) {
      if (generation !== this._searchGeneration) return [];
      throw err;
    }
    options.signal?.throwIfAborted();
    if (generation !== this._searchGeneration) return []; // superseded: resolve to [], never reject

    const t0 = performance.now();
    const results = await this._runSearch(prefix, options);
    if (generation !== this._searchGeneration) return [];

    const elapsedMs = performance.now() - t0;
    this._emitter.emit('results', { query: prefix, results, elapsedMs });
    return results;
  }

  async _runSearch(prefix, options) {
    const minPrefixLength = this._options.minPrefixLength ?? 1;
    if (prefix.length < minPrefixLength) return [];
    const queryNorm = this._normalize(prefix);
    const limit = options.limit ?? this._options.limit ?? 10;

    let rows;
    if (this._full) {
      const [start, end] = prefixRange(this._full.nameNorms, queryNorm);
      rows = this._full.rows.slice(start, end);
    } else if (this._range) {
      rows = await searchRangeIndex(this._range, queryNorm);
    } else {
      rows = [];
    }

    return this._rankAndFilter(rows, queryNorm, options, limit);
  }

  /**
   * Zero-await typeahead (design doc §3.2, O4): available only when fully
   * loaded. Throws `GEOCODER_NOT_LOADED` otherwise.
   * @param {string} prefix
   * @param {Omit<import('./types.js').SearchOptions, 'signal'>} [options]
   */
  searchSync(prefix, options = {}) {
    if (this._state !== 'ready' || !this._full) {
      throw new CnmwError(
        'searchSync requires a fully-loaded index; call load() (or use search()) first.',
        'GEOCODER_NOT_LOADED',
      );
    }
    const minPrefixLength = this._options.minPrefixLength ?? 1;
    if (prefix.length < minPrefixLength) return [];
    const queryNorm = this._normalize(prefix);
    const limit = options.limit ?? this._options.limit ?? 10;
    const [start, end] = prefixRange(this._full.nameNorms, queryNorm);
    const rows = this._full.rows.slice(start, end);
    return this._rankAndFilter(rows, queryNorm, options, limit);
  }

  _rankAndFilter(rows, queryNorm, options, limit) {
    const levels = options.levels ?? this._options.levels;
    const countries = options.countries ?? this._options.countries;
    const rankOpts = { ...this._rankingOptions, viewport: options.viewport };

    const ranked = [];
    for (const row of rows) {
      if (levels && !levels.includes(row.level)) continue;
      if (countries && !countries.includes(row.country)) continue;
      const rowBBox = [row.bbox.xmin, row.bbox.ymin, row.bbox.xmax, row.bbox.ymax];
      const rank = rankRow({ nameNorm: row.name_norm, level: row.level, bbox: rowBBox, featureId: row.feature_id }, queryNorm, rankOpts);
      if (rank === null) continue;
      ranked.push({
        featureId: row.feature_id,
        name: row.name,
        nameNorm: row.name_norm,
        level: row.level,
        country: row.country,
        parentName: row.parent_name ?? undefined,
        bbox: rowBBox,
        source: row.source,
        rank,
        score: scoreOf(rank),
        geometryRef: row.geometry_ref
          ? { file: row.geometry_ref.file, rowGroup: row.geometry_ref.row_group, row: row.geometry_ref.row }
          : undefined,
      });
    }
    ranked.sort(compareRanked);
    return ranked.slice(0, limit);
  }

  /**
   * @param {import('./types.js').SearchResult} result
   * @param {import('./types.js').GeometryResolverOptions & { signal?: AbortSignal }} [options]
   */
  async select(result, options = {}) {
    await this.load(options.signal);
    const t0 = performance.now();
    const manifest = this._manifest;
    const entry = manifest.boundaries?.find((b) => b.level === result.level);
    if (!entry) {
      throw new CnmwError(`No boundary file declared for level ${result.level}.`, 'GEOMETRY_NOT_FOUND', {
        context: { level: result.level },
      });
    }
    const resolution = options.resolution ?? this._options.geometry?.resolution ?? 'display';
    const variantKey = resolution === 'full' ? 'full' : 'display';
    const boundaryUrl = resolveManifestUrl(this._manifestUrl, entry[variantKey].url);

    const { geometry, bbox } = await resolveGeometry(
      result,
      boundaryUrl,
      manifest.catalog_version,
      this._fetch,
      options.onVersionSkew ?? this._onVersionSkew,
      (warning) => this._emitter.emit('warning', warning),
    );

    const area = buildArea({
      name: result.name,
      geometry,
      source: 'geocoder',
      features: [
        {
          featureId: result.featureId,
          name: result.name,
          level: result.level,
          country: result.country,
          bbox: bbox ?? result.bbox,
        },
      ],
      combine: 'single',
      geometryVariant: variantKey === 'display' ? 'display-simplified' : 'full',
      attribution: this._attribution,
      filterVertexCeiling: options.filterVertexCeiling ?? this._options.geometry?.filterVertexCeiling ?? 10_000,
      displayVertexCeiling: options.displayVertexCeiling ?? this._options.geometry?.displayVertexCeiling ?? 200_000,
      provenanceExtra: {
        geocoder: {
          indexUrl: this._manifestUrl,
          indexSource: manifest.source,
          indexVersion: manifest.index_version,
          catalogVersion: manifest.catalog_version,
          boundaryUrl,
          matchedName: result.name,
        },
      },
    });

    const elapsedMs = performance.now() - t0;
    this._emitter.emit('select', { result, area, elapsedMs });
    return area;
  }

  /**
   * @template {keyof import('./types.js').GeocoderEvents} K
   * @param {K} event
   * @param {(payload: import('./types.js').GeocoderEvents[K]) => void} handler
   */
  on(event, handler) {
    return this._emitter.on(event, handler);
  }

  close() {
    this._searchGeneration++; // invalidate any in-flight search
    this._full = null;
    this._range = null;
    this._manifest = null;
    this._loadPromise = null;
    this._setState('idle');
  }
}
