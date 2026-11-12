// @cnmw/geocoder-core -- the Geocoder class (design doc §3.2, §6).

import { CnmwError, normalizeName, buildArea, simplifyToVertexCeilingAsync } from '@cnmw/spec';
import { Emitter } from './events.js';
import { loadManifest, resolveManifestUrl, loadFullIndex, openRangeIndex, searchRangeIndex, prefixRange } from './index-loader.js';
import { rankRow, compareRanked, scoreOf } from './ranking.js';
import { resolveGeometry } from './geometry-resolver.js';
import { GenerationGuard } from './generation-guard.js';

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

/**
 * Pure decision logic behind `select()`'s resolution handling (design doc
 * §3.2's `GeometryResolverOptions.resolution`, task "If the manifest has
 * no display file for a level, fall back gracefully to 'full' path").
 * Extracted so it's unit-testable without any network/hyparquet
 * dependency.
 * @param {'display'|'full'|'both'|undefined} requested
 * @param {boolean} hasDisplay whether the manifest declares a `display` boundary file for this level.
 * @returns {'display'|'full'|'both'}
 */
export function resolveResolutionMode(requested, hasDisplay) {
  const resolution = requested ?? 'display';
  if ((resolution === 'display' || resolution === 'both') && !hasDisplay) {
    return 'full'; // nothing fast to show first: fall back to the one file that exists
  }
  return resolution;
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

    // Progressive select() (design doc §1/§3.2, task "fetch/attach the
    // full-res geometry in the background"): a background upgrade whose
    // generation no longer matches `_selectGuard`'s current one was
    // superseded and silently drops its result; `_selectGuard` also
    // aborts the superseded upgrade's in-flight fetch/decode/simplify
    // rather than just letting it run to a discarded result. See
    // generation-guard.js.
    this._selectGuard = new GenerationGuard();

    // Test-only dependency-injection seam (never documented as public
    // API, never set by production callers): `Geocoder#load()`/`select()`
    // can only run end-to-end against a real network and a
    // browser-capable dynamic `import()` of an `https:` URL (hyparquet is
    // loaded from a pinned CDN URL, design doc §4.2), which `node --test`
    // cannot do. `options.__deps` lets the test suite substitute fakes
    // for exactly those calls so the surrounding control flow --
    // resolution selection, event ordering, cancellation -- can be
    // exercised for real.
    this._deps = {
      loadManifest,
      loadFullIndex,
      openRangeIndex,
      resolveGeometry,
      simplifyToVertexCeilingAsync,
      ...options.__deps,
    };
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
    const manifest = await this._deps.loadManifest(this._manifestUrl, this._fetch);
    this._manifest = manifest;
    signal?.throwIfAborted();

    const declaredBytes = manifest.index?.size ?? 0;
    let strategy = this._loadStrategyOption;
    if (strategy === 'auto') strategy = declaredBytes <= this._fullLoadMaxBytes ? 'full' : 'range';

    const parquetUrl = resolveManifestUrl(this._manifestUrl, manifest.index.url);

    if (strategy === 'full') {
      this._full = await this._deps.loadFullIndex(parquetUrl, this._fetch);
    } else {
      this._range = await this._deps.openRangeIndex(parquetUrl, this._fetch);
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
   * Resolve `result`'s geometry and build its `Area` (design doc §1/§3.2).
   *
   * `resolution: 'display'` (the default) and `'full'` each fetch one
   * boundary file and return a complete `Area`. `resolution: 'both'`
   * returns as soon as the small display-simplified geometry is in hand
   * -- fast enough that a 500K-vertex ADM0 feature (e.g. Canada) no
   * longer blocks the main thread at all -- then, in the background,
   * fetches the full-resolution geometry and rebuilds just
   * `filterGeometry` from it (chunked/yielding decode + simplification,
   * so that background work never blocks the main thread either),
   * emitting `'area:upgraded'` with the result. `Area.geometry` (the
   * display variant) never changes during an upgrade.
   *
   * A boundary level with no declared `display` file in the manifest
   * falls back to the `'full'` path for `'display'` and `'both'` alike --
   * there is nothing fast to show first.
   *
   * Calling `select()` again before a pending `'both'` upgrade has
   * finished supersedes it: the superseded fetch/decode/simplify is
   * aborted and its result (if any slips through before the abort is
   * observed) is dropped rather than emitted.
   *
   * @param {import('./types.js').SearchResult} result
   * @param {import('./types.js').GeometryResolverOptions & { signal?: AbortSignal }} [options]
   */
  async select(result, options = {}) {
    // Supersede any previous pending background upgrade *before* awaiting
    // anything below, so a rapid double-select never races the two.
    const generation = this._selectGuard.next();

    await this.load(options.signal);
    const t0 = performance.now();
    const manifest = this._manifest;
    const entry = manifest.boundaries?.find((b) => b.level === result.level);
    if (!entry) {
      throw new CnmwError(`No boundary file declared for level ${result.level}.`, 'GEOMETRY_NOT_FOUND', {
        context: { level: result.level },
      });
    }

    const requested = options.resolution ?? this._options.geometry?.resolution;
    const resolution = resolveResolutionMode(requested, Boolean(entry.display?.url));

    const onVersionSkew = options.onVersionSkew ?? this._onVersionSkew;
    const filterVertexCeiling = options.filterVertexCeiling ?? this._options.geometry?.filterVertexCeiling ?? 10_000;
    const displayVertexCeiling = options.displayVertexCeiling ?? this._options.geometry?.displayVertexCeiling ?? 200_000;
    const onWarning = (warning) => this._emitter.emit('warning', warning);

    const buildSelectedArea = (geometry, bbox, variantKey, boundaryUrl, pendingUpgrade) =>
      buildArea({
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
        filterVertexCeiling,
        displayVertexCeiling,
        provenanceExtra: {
          resolution,
          pendingUpgrade,
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

    if (resolution === 'full') {
      const boundaryUrl = resolveManifestUrl(this._manifestUrl, entry.full.url);
      const { geometry, bbox } = await this._deps.resolveGeometry(result, boundaryUrl, manifest.catalog_version, this._fetch, onVersionSkew, onWarning, {
        decodeAsync: true,
        signal: options.signal,
      });
      const area = buildSelectedArea(geometry, bbox, 'full', boundaryUrl, false);
      const elapsedMs = performance.now() - t0;
      this._emitter.emit('select', { result, area, elapsedMs });
      return area;
    }

    if (resolution === 'display') {
      const boundaryUrl = resolveManifestUrl(this._manifestUrl, entry.display.url);
      const { geometry, bbox } = await this._deps.resolveGeometry(result, boundaryUrl, manifest.catalog_version, this._fetch, onVersionSkew, onWarning);
      const area = buildSelectedArea(geometry, bbox, 'display', boundaryUrl, false);
      const elapsedMs = performance.now() - t0;
      this._emitter.emit('select', { result, area, elapsedMs });
      return area;
    }

    // resolution === 'both': return the display Area immediately, then
    // upgrade filterGeometry from the full-resolution file in the background.
    const displayUrl = resolveManifestUrl(this._manifestUrl, entry.display.url);
    const { geometry: displayGeometry, bbox: displayBbox } = await this._deps.resolveGeometry(
      result,
      displayUrl,
      manifest.catalog_version,
      this._fetch,
      onVersionSkew,
      onWarning,
    );
    const area = buildSelectedArea(displayGeometry, displayBbox, 'display', displayUrl, true);
    const elapsedMs = performance.now() - t0;
    this._emitter.emit('select', { result, area, elapsedMs });

    const controller = new AbortController();
    this._selectGuard.attach(controller);
    this._runUpgrade(result, entry, manifest, area, generation, controller, {
      filterVertexCeiling,
      onVersionSkew,
      onWarning,
      userSignal: options.signal,
    }).catch((err) => {
      if (!this._selectGuard.isCurrent(generation)) return; // superseded: silent
      if (err?.name === 'AbortError' || err?.code === 'CANCELLED') return;
      this._emitter.emit('error', err);
    });

    return area;
  }

  /**
   * Background half of `select({ resolution: 'both' })`: fetch the
   * full-resolution boundary, decode + simplify it off the synchronous
   * path (chunked/yielding throughout -- see `@cnmw/spec`'s
   * `wkbToGeoJsonAsync` / `simplifyToVertexCeilingAsync`), and emit
   * `'area:upgraded'` with a copy of `baseArea` whose `filterGeometry`
   * and `vertexCount.filter` now reflect the full-resolution geometry.
   * `baseArea.geometry` (the display variant) is never touched.
   * @param {import('./types.js').SearchResult} result
   * @param {object} entry
   * @param {object} manifest
   * @param {import('@cnmw/spec').Area} baseArea
   * @param {number} generation
   * @param {AbortController} controller
   * @param {{ filterVertexCeiling: number, onVersionSkew: 'error'|'warn'|'ignore', onWarning: Function, userSignal?: AbortSignal }} opts
   */
  async _runUpgrade(result, entry, manifest, baseArea, generation, controller, opts) {
    const t0 = performance.now();
    const abortSignal = controller.signal;
    const fullUrl = resolveManifestUrl(this._manifestUrl, entry.full.url);
    const { geometry: fullGeometry } = await this._deps.resolveGeometry(
      result,
      fullUrl,
      manifest.catalog_version,
      this._fetch,
      opts.onVersionSkew,
      opts.onWarning,
      { decodeAsync: true, signal: abortSignal },
    );
    opts.userSignal?.throwIfAborted();
    if (!this._selectGuard.isCurrent(generation)) return; // superseded while fetching

    const filterResult = await this._deps.simplifyToVertexCeilingAsync(fullGeometry, {
      vertexCeiling: opts.filterVertexCeiling,
      areaDeltaMaxRatio: 0.05,
      signal: abortSignal,
    });
    opts.userSignal?.throwIfAborted();
    if (!this._selectGuard.isCurrent(generation)) return; // superseded while simplifying

    const filterGeometry = filterResult.degradedToBbox ? null : filterResult.geometry;
    const upgraded = {
      ...baseArea,
      filterGeometry,
      vertexCount: { ...baseArea.vertexCount, filter: filterGeometry ? filterResult.outputVertices : 0 },
      provenance: {
        ...baseArea.provenance,
        resolution: 'full',
        pendingUpgrade: false,
        simplification: {
          method: filterResult.method,
          toleranceDeg: filterResult.toleranceDeg,
          inputVertices: filterResult.inputVertices,
          outputVertices: filterResult.outputVertices,
          areaDeltaRatio: filterResult.areaDeltaRatio,
          degradedToBbox: filterResult.degradedToBbox,
        },
      },
    };
    this._selectGuard.detach(controller);
    const elapsedMs = performance.now() - t0;
    this._emitter.emit('area:upgraded', { result, area: upgraded, elapsedMs });
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
    this._selectGuard.cancelAll(); // invalidate/cancel any pending background upgrade
    this._full = null;
    this._range = null;
    this._manifest = null;
    this._loadPromise = null;
    this._setState('idle');
  }
}
