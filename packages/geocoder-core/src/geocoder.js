// @cnmw/geocoder-core -- the Geocoder class (design doc §3.2, §6).

import { CnmwError, normalizeName, buildArea, simplifyToVertexCeilingAsync, MAX_SYNC_SIMPLIFY_VERTICES } from '@cnmw/spec';
import { Emitter } from './events.js';
import { loadManifest, resolveManifestUrl, loadFullIndex, openRangeIndex, searchRangeIndex, prefixRange } from './index-loader.js';
import { rankRow, compareRanked, scoreOf, applyDiversity, DEFAULT_EXACT_LEVEL_PROMOTION, DEFAULT_DIVERSITY } from './ranking.js';
import { resolveGeometry, openBoundaryFile } from './geometry-resolver.js';
import { GenerationGuard } from './generation-guard.js';

/**
 * Schedule `fn` for idle/background execution (task 2's footer prefetch):
 * `requestIdleCallback` in a browser, `setTimeout(fn, 0)` everywhere else
 * (Node test environment, a browser old enough to lack it). Not meant to
 * be precise -- it only needs to run *after* whatever the main thread is
 * doing right now, specifically after `load()`'s own caller has gotten
 * its result and moved on to rendering a dropdown.
 * @param {() => void} fn
 */
function scheduleIdle(fn) {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 0);
  }
}

/**
 * Two-wave search (task 3): true when `next` contains at least one row
 * `previous` didn't have, by `featureId`. This is the literal "replacing
 * the first only if it adds rows" rule from the second wave's semantics --
 * a final wave that re-ranks the exact same rows (the common case once
 * the prominent index already held every match) never triggers a second
 * `'results'` emission.
 * @param {readonly { featureId: string }[]} previous
 * @param {readonly { featureId: string }[]} next
 * @returns {boolean}
 */
function resultsAddRows(previous, next) {
  const previousIds = new Set(previous.map((r) => r.featureId));
  return next.some((r) => !previousIds.has(r.featureId));
}

/**
 * The exact-size footer read (task 1/manifest contract addition): which of
 * a manifest file-entry's two declared sizes to pass as hyparquet's
 * `initialFetchSize`. **`footer_metadata_bytes` -- the thrift footer
 * alone -- not `footer_bytes`.** `footer_bytes` is the whole trailing
 * span (footer + page index); hyparquet has no sub-chunk read and never
 * reads the page-index bodies at all, so `footer_metadata_bytes` is
 * strictly the smaller, sufficient, correct number for it -- fetching
 * `footer_bytes` worth would just over-fetch page-index bytes nothing in
 * this codebase reads. Falls back to `footer_bytes` on an older manifest
 * that declares only that (pre-dating this distinction), then to
 * `undefined` (the pre-existing default) when neither is declared.
 * @param {{ footer_metadata_bytes?: number, footer_bytes?: number } | undefined} entry
 * @returns {number | undefined}
 */
function initialFetchSizeOf(entry) {
  return entry?.footer_metadata_bytes ?? entry?.footer_bytes;
}

/** @typedef {import('@cnmw/spec').BBox} BBox */

export const DEFAULT_INDEX_URL = './data/index.json';
export const VERSION = '0.1.0-experiment';

const DEFAULT_RANKING = {
  viewportBoost: 1,
  nearFactor: 2,
  matchClasses: ['exact', 'prefix', 'word-prefix'],
  exactLevelPromotion: DEFAULT_EXACT_LEVEL_PROMOTION,
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
    this._full = null; // { rows, nameNorms } -- the main index, once loaded
    this._range = null; // main index's range handle, once opened

    // Two-wave search (manifest contract addition `prominent_index`, task
    // 3): a small subset index, eagerly full-loaded alongside (not after)
    // the main index, so `search()` can answer from it immediately while
    // the main index is still fetching/opening behind it. `_mainReady`
    // flips true once `_full`/`_range` above is actually usable;
    // `_mainReadyPromise` lets `search()` schedule a second wave for a
    // query that only got to answer from `_prominentFull` for its first.
    // All stay at their no-op defaults when the manifest has no
    // `prominent_index` at all.
    this._hasProminent = false;
    this._prominentFull = null;
    this._mainReady = false;
    this._mainReadyPromise = null;

    // Footer prefetch (manifest contract addition `footer_bytes`, task 2):
    // one open-file-handle cache per Geocoder instance, keyed by resolved
    // boundary URL, shared between the background prefetch below and every
    // `select()`'s own `resolveGeometry` call -- this is also the fix for
    // "verify handles are already reused across selects": before this,
    // every `select()` re-opened and re-fetched the footer of its boundary
    // file from scratch, even a second `select()` against the exact same
    // file.
    this._boundaryHandleCache = new Map();
    this._footerPrefetchStarted = false;

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
      openBoundaryFile,
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
    // Not every published index literally has a column named `feature_id`
    // (geoboundaries-catalog's names index calls it `shape_id`) or a
    // `source` column at all (single-source catalogs have no reason to
    // repeat their one source on every row) -- see index-loader.js's
    // `projectRow`/`assertSchema`.
    const indexProjection = {
      featureIdColumn: manifest.index?.feature_id_column ?? 'feature_id',
      defaultSource: manifest.source,
    };

    // Manifest contract addition `footer_bytes`/`footer_metadata_bytes`
    // (task 1): the range path's one footer fetch becomes exactly-sized
    // instead of hyparquet's speculative 512 KB default when the manifest
    // declares it -- `footer_metadata_bytes` preferred over `footer_bytes`,
    // see `initialFetchSizeOf`. Absent on an older manifest -> `undefined`
    // -> `openRangeIndex`'s own default (unchanged).
    const footerBytes = initialFetchSizeOf(manifest.index);
    const mainIndexRaw = strategy === 'full'
      ? this._deps.loadFullIndex(parquetUrl, this._fetch, indexProjection)
      : this._deps.openRangeIndex(parquetUrl, this._fetch, footerBytes, indexProjection);

    const applyMainIndex = (handle) => {
      if (strategy === 'full') this._full = handle;
      else this._range = handle;
      this._mainReady = true;
      return handle;
    };

    // Two-wave search (manifest contract addition `prominent_index`, task
    // 3). Absent manifest field -> `_hasProminent` stays false and every
    // line below this `if` is dead code for this load -- `search()`'s own
    // two-wave branch is gated on the same flag, so the feature is a
    // complete no-op end to end when the catalog hasn't shipped it yet.
    this._hasProminent = Boolean(manifest.prominent_index?.url);
    if (this._hasProminent) {
      const prominentUrl = resolveManifestUrl(this._manifestUrl, manifest.prominent_index.url);
      const prominentProjection = {
        featureIdColumn: manifest.prominent_index.feature_id_column ?? indexProjection.featureIdColumn,
        defaultSource: manifest.prominent_index.source ?? manifest.source,
      };
      // Eager full-load, started in parallel with (not after) the main
      // index above -- "full-load it eagerly on load()". A failure here
      // is reported as a warning, not a load()-aborting error: the main
      // index is still on its way, and this geocoder stays entirely
      // usable without the fast first wave.
      this._prominentFull = await this._deps
        .loadFullIndex(prominentUrl, this._fetch, prominentProjection)
        .catch((err) => {
          this._emitter.emit('warning', {
            code: 'PROMINENT_INDEX_FAILED',
            message: `Prominent index failed to load; search() will wait for the main index instead. ${err?.message ?? err}`,
            detail: err,
          });
          return null;
        });

      // The main index keeps loading in the background; `load()` resolves
      // now (right after this method returns) without waiting for it.
      // `_mainReadyPromise` never rejects into an unhandled rejection even
      // though nobody may ever await it (a page that never searches again
      // after its first, prominent-only-answered query): the `.catch`
      // below both reports the failure once and keeps the promise settled
      // for any later `.then` (`search()`'s second-wave branch) to see.
      this._mainReadyPromise = mainIndexRaw
        .then((handle) => {
          applyMainIndex(handle);
          this._emitter.emit('index:upgraded', { strategy, loadMs: handle.loadMs });
          return handle;
        })
        .catch((err) => {
          this._emitter.emit('error', err);
          return null;
        });

      if (!this._prominentFull) {
        // No usable fast wave at all: behave exactly like the no-prominent
        // path below, so this geocoder is still usable once `load()`
        // resolves rather than leaving `state` stuck on `'loading'`.
        const handle = await mainIndexRaw;
        applyMainIndex(handle);
      }
    } else {
      const handle = await mainIndexRaw;
      applyMainIndex(handle);
      this._mainReadyPromise = Promise.resolve(handle);
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
      // Present only when the manifest declared a prominent index, win or
      // lose: `ready` is false in the (rare) case its own load failed, so
      // a caller/UI can tell "two-wave search is active" apart from
      // "declared but unavailable" without inspecting internals.
      prominent: this._hasProminent
        ? {
            // The shipped manifest field is `row_count` (matching every
            // other per-file entry's own field name, `boundaries[].full`/
            // `.display` included) -- `rows` is kept as a first try only
            // for a manifest that predates this field-name confirmation.
            rows: manifest.prominent_index.rows ?? manifest.prominent_index.row_count,
            bytes: manifest.prominent_index.size,
            ready: this._prominentFull !== null,
          }
        : undefined,
    };
    this._setState('ready');
    this._emitter.emit('load', this._info);

    // Footer prefetch (manifest contract addition `footer_bytes`, task 2):
    // scheduled once `load()` is about to resolve, regardless of which
    // branch above got us here, so the very first `select()` after this
    // finds its boundary file's footer already warmed in
    // `_boundaryHandleCache` instead of paying for it synchronously.
    this._scheduleFooterPrefetch();

    return this._info;
  }

  /**
   * Background footer prefetch (manifest contract addition `footer_bytes`,
   * task 2): open every declared boundary file's footer in the
   * background, display variants first (the default `resolution`), then
   * full, one at a time via `scheduleIdle` so this never competes with
   * anything the main thread actually needs to do right now. Each opened
   * handle lands in `_boundaryHandleCache`, the same cache `select()`'s
   * `resolveGeometry` calls consult -- so by the time a user actually
   * picks a result, its footer fetch is typically already done.
   *
   * Idempotent (guarded by `_footerPrefetchStarted`) and best-effort: a
   * failed prefetch is removed from the cache so `select()` just performs
   * the real fetch itself, and is never surfaced as a `warning`/`error`
   * event -- nothing the user did caused it, and nothing is actually
   * broken yet.
   */
  _scheduleFooterPrefetch() {
    if (this._footerPrefetchStarted) return;
    this._footerPrefetchStarted = true;
    const boundaries = this._manifest?.boundaries ?? [];
    const queue = [];
    for (const entry of boundaries) if (entry.display?.url) queue.push(entry.display);
    for (const entry of boundaries) if (entry.full?.url) queue.push(entry.full);
    if (queue.length === 0) return;

    const step = () => {
      const next = queue.shift();
      if (!next) return;
      const url = resolveManifestUrl(this._manifestUrl, next.url);
      if (!this._boundaryHandleCache.has(url)) {
        const handlePromise = this._deps.openBoundaryFile(url, this._fetch, undefined, initialFetchSizeOf(next));
        this._boundaryHandleCache.set(url, handlePromise);
        handlePromise.catch(() => {
          this._boundaryHandleCache.delete(url);
        });
      }
      if (queue.length > 0) scheduleIdle(step);
    };
    scheduleIdle(step);
  }

  /**
   * Ranked results. Calls `load()` if needed (which, with a
   * `prominent_index` declared, resolves as soon as that fast wave is
   * ready -- not once the whole main index is).
   *
   * **Two-wave search semantics** (manifest contract addition
   * `prominent_index`, task 3): when this query's results come from the
   * prominent index alone -- the main index isn't `_mainReady` yet --
   * this promise still resolves with that first wave (fast answers,
   * exactly as fast as `search()` always resolves against a `'full'`-
   * strategy index), and the `'results'` event fires once for it, tagged
   * `wave: 'prominent'`. In the background, once the main index finishes
   * loading, the *same query* is re-run against it and a **second**
   * `'results'` event fires, tagged `wave: 'final'` -- but **only if** the
   * final answer actually adds at least one row the first wave didn't
   * already have (by `featureId`); an identical re-ranking of the same
   * rows never re-emits. A query superseded by a later `search()` call
   * before its second wave lands drops that wave silently, matching every
   * other superseded-query rule in this class. When the manifest has no
   * `prominent_index` at all, or the main index is already `_mainReady`
   * by the time this runs, there is only ever one wave, tagged `'final'`
   * -- unchanged behaviour from before this existed.
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
    const isFinal = this._mainReady || !this._hasProminent;
    this._emitter.emit('results', { query: prefix, results, elapsedMs, wave: isFinal ? 'final' : 'prominent' });

    if (!isFinal) this._scheduleSecondWave(prefix, options, generation, results, t0);

    return results;
  }

  /**
   * The background half of two-wave search: wait for the main index to
   * finish loading (`_mainReadyPromise`, set up in `_doLoad`), then re-run
   * the same query against it and emit a second `'results'` event -- but
   * only when doing so would actually change what the caller sees. See
   * `search()`'s doc comment for the full semantics.
   */
  _scheduleSecondWave(prefix, options, generation, wave1Results, t0) {
    this._mainReadyPromise
      ?.then(async (handle) => {
        if (handle === null) return; // the main index itself failed to load; no final wave to offer
        if (generation !== this._searchGeneration) return; // superseded by a later search() call
        options.signal?.throwIfAborted();
        const wave2Results = await this._runSearch(prefix, options);
        if (generation !== this._searchGeneration) return;
        if (!resultsAddRows(wave1Results, wave2Results)) return; // nothing new: never re-emit an identical answer
        const elapsedMs = performance.now() - t0;
        this._emitter.emit('results', { query: prefix, results: wave2Results, elapsedMs, wave: 'final' });
      })
      .catch(() => {}); // AbortError (user signal) or an abandoned generation: silently dropped, same as search() itself
  }

  async _runSearch(prefix, options) {
    const minPrefixLength = this._options.minPrefixLength ?? 1;
    if (prefix.length < minPrefixLength) return [];
    const queryNorm = this._normalize(prefix);
    const limit = options.limit ?? this._options.limit ?? 10;
    const rows = await this._searchRows(queryNorm);
    return this._rankAndFilter(rows, queryNorm, options, limit);
  }

  /**
   * Which loaded source answers a query right now: the main index once
   * it's `_mainReady`, else the prominent index (two-wave search) when
   * the manifest declared one and it loaded, else nothing -- which can
   * only happen while `_doLoad` itself is still running (never after
   * `load()` has resolved to its caller).
   * @param {string} queryNorm
   */
  async _searchRows(queryNorm) {
    if (this._mainReady) {
      if (this._full) {
        const [start, end] = prefixRange(this._full.nameNorms, queryNorm);
        return this._full.rows.slice(start, end);
      }
      if (this._range) return searchRangeIndex(this._range, queryNorm);
    }
    if (this._prominentFull) {
      const [start, end] = prefixRange(this._prominentFull.nameNorms, queryNorm);
      return this._prominentFull.rows.slice(start, end);
    }
    return [];
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
      const areaKm2 = typeof row.area_km2 === 'number' && !Number.isNaN(row.area_km2) ? row.area_km2 : undefined;
      // `population`/`class` (ranking-residual follow-up, task 5): still
      // pending columns on every shipped index today -- `undefined` on
      // every row until a catalog populates them -- passed through
      // unconditionally so the geocoder never has to change again once
      // one does. `isAlt` is derived from `alt_of` (already-shipped, E8)
      // rather than passed through verbatim: `rankRow`/`compareRanked`
      // only need to know "primary or alt", not which primary this alt
      // row points at.
      const population = typeof row.population === 'number' && !Number.isNaN(row.population) ? row.population : undefined;
      const placeClass = typeof row.class === 'string' ? row.class : undefined;
      const isAlt = row.alt_of != null;
      const rank = rankRow(
        { nameNorm: row.name_norm, level: row.level, bbox: rowBBox, featureId: row.feature_id, areaKm2, population, class: placeClass, isAlt },
        queryNorm,
        rankOpts,
      );
      if (rank === null) continue;
      ranked.push({
        featureId: row.feature_id,
        name: row.name,
        nameNorm: row.name_norm,
        level: row.level,
        country: row.country,
        // Optional context columns (design doc §3.2 amendment, "Index
        // columns"): Overture's division names index carries `parent_name`
        // (e.g. "Rajasthan" for a locality), geoBoundaries' CGAZ names
        // index carries `country_name` (e.g. "India" alongside the ISO
        // `country` code). Both are `undefined` when the loaded index has
        // neither column -- `hyparquet`'s decoded row object simply won't
        // have the key, so this is a plain `undefined`, not a parse error.
        parentName: row.parent_name ?? undefined,
        countryName: row.country_name ?? undefined,
        areaKm2,
        // **Added by the ranking-residual follow-up (task 5).** Both
        // pending on every shipped index -- `undefined` today, exposed
        // here (as `areaKm2` already is) so a UI can use them directly,
        // e.g. a population badge, once a catalog populates them.
        population,
        class: placeClass,
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

    // Result diversity (design doc §3.2 amendment, "Result diversity"):
    // collapse (nameNorm, country, level) duplicates to one row annotated
    // with `moreCount`, then cap at `maxPerGroup` rows per (country, level)
    // before the final slice to `limit` -- so a capped-out group makes room
    // for the next-ranked *distinct* group rather than just shrinking the
    // result count. This is what turns "eight identical Bag/IND/ADM4 rows"
    // into one "Bag (+7 more)" row, freeing up slots for Baghdad.
    const diversityOptions = { ...DEFAULT_DIVERSITY, ...this._options.diversity, ...options.diversity };
    const diversified = applyDiversity(ranked, diversityOptions);

    return diversified.slice(0, limit);
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

    // `maxSyncInputVertices`: opt in to @cnmw/spec's vertex-count guard on
    // every synchronous build below (fix history, "Canada ADM0 select()
    // blocks the main thread for ~24s" -- buildArea's filter-geometry pass
    // ran an O(m^2) search directly on the 68,973-vertex display geometry).
    // A build whose input is small enough simplifies for real, exactly as
    // before; one that isn't degrades straight to `filterGeometry: null`
    // (bboxes-only, design doc §1.3's `degradedToBbox`) instead of ever
    // running the slow search -- see `kickFilterOnlyUpgrade` below for how
    // that gap is closed without ever blocking the main thread.
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
        maxSyncInputVertices: MAX_SYNC_SIMPLIFY_VERTICES,
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

    // Shared by the 'full' and 'display' branches below: when the
    // synchronous build above degraded `filterGeometry` to `null` (the
    // vertex-count guard tripped, or a genuine area-delta failure), kick a
    // *filter-only* background upgrade -- the async O(m log m) simplifier
    // (design doc task: "the main thread never blocks >50ms") run on the
    // geometry already in hand, no extra network fetch. This is the choice
    // documented in the task's item 2 for 'display'-only resolution
    // (rather than leaving it permanently bbox-degraded): 'display' is the
    // default resolution, so leaving every largeish selection's
    // filterGeometry bbox-only forever would be a correctness regression
    // for any `download-core` consumer filtering against this Area, not
    // just a performance one. The same gap exists for 'full' resolution
    // (its input can be just as large), so it gets the identical fix. Mirrors
    // `_runUpgrade`'s cancellation/generation handling but skips
    // `resolveGeometry` entirely, since there is nothing new to fetch.
    const kickFilterOnlyUpgradeIfNeeded = (area, geometry) => {
      if (!area.provenance.pendingUpgrade) return area;
      const controller = new AbortController();
      this._selectGuard.attach(controller);
      this._runFilterOnlyUpgrade(result, geometry, area, generation, controller, {
        filterVertexCeiling,
        userSignal: options.signal,
      }).catch((err) => {
        if (!this._selectGuard.isCurrent(generation)) return; // superseded: silent
        if (err?.name === 'AbortError' || err?.code === 'CANCELLED') return;
        this._emitter.emit('error', err);
      });
      return area;
    };

    if (resolution === 'full') {
      const boundaryUrl = resolveManifestUrl(this._manifestUrl, entry.full.url);
      const { geometry, bbox } = await this._deps.resolveGeometry(result, boundaryUrl, manifest.catalog_version, this._fetch, onVersionSkew, onWarning, {
        decodeAsync: true,
        signal: options.signal,
        entry,
        footerBytes: initialFetchSizeOf(entry.full),
        handleCache: this._boundaryHandleCache,
      });
      let area = buildSelectedArea(geometry, bbox, 'full', boundaryUrl, false);
      if (area.filterGeometry === null) {
        area = { ...area, provenance: { ...area.provenance, pendingUpgrade: true } };
      }
      const elapsedMs = performance.now() - t0;
      this._emitter.emit('select', { result, area, elapsedMs });
      return kickFilterOnlyUpgradeIfNeeded(area, geometry);
    }

    if (resolution === 'display') {
      const boundaryUrl = resolveManifestUrl(this._manifestUrl, entry.display.url);
      const { geometry, bbox } = await this._deps.resolveGeometry(result, boundaryUrl, manifest.catalog_version, this._fetch, onVersionSkew, onWarning, {
        entry,
        footerBytes: initialFetchSizeOf(entry.display),
        handleCache: this._boundaryHandleCache,
      });
      let area = buildSelectedArea(geometry, bbox, 'display', boundaryUrl, false);
      if (area.filterGeometry === null) {
        area = { ...area, provenance: { ...area.provenance, pendingUpgrade: true } };
      }
      const elapsedMs = performance.now() - t0;
      this._emitter.emit('select', { result, area, elapsedMs });
      return kickFilterOnlyUpgradeIfNeeded(area, geometry);
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
      { entry, footerBytes: initialFetchSizeOf(entry.display), handleCache: this._boundaryHandleCache },
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
      { decodeAsync: true, signal: abortSignal, entry, footerBytes: initialFetchSizeOf(entry.full), handleCache: this._boundaryHandleCache },
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
   * Filter-only background upgrade for the 'full' and 'display' resolution
   * paths (see `kickFilterOnlyUpgradeIfNeeded` in `select()`): same shape
   * as `_runUpgrade`, but there is no boundary file to fetch -- `geometry`
   * is whatever `select()` already resolved (the full-resolution geometry
   * for 'full', the display-simplified geometry for 'display') -- so this
   * goes straight to the async simplifier. Used only when the synchronous
   * build's vertex-count guard (or a genuine area-delta failure) left
   * `filterGeometry: null`.
   * @param {import('./types.js').SearchResult} result
   * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon} geometry the geometry to re-simplify (already in hand).
   * @param {import('@cnmw/spec').Area} baseArea
   * @param {number} generation
   * @param {AbortController} controller
   * @param {{ filterVertexCeiling: number, userSignal?: AbortSignal }} opts
   */
  async _runFilterOnlyUpgrade(result, geometry, baseArea, generation, controller, opts) {
    const t0 = performance.now();
    const abortSignal = controller.signal;

    const filterResult = await this._deps.simplifyToVertexCeilingAsync(geometry, {
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
    this._hasProminent = false;
    this._prominentFull = null;
    this._mainReady = false;
    this._mainReadyPromise = null;
    this._boundaryHandleCache = new Map();
    this._footerPrefetchStarted = false;
    this._setState('idle');
  }
}
