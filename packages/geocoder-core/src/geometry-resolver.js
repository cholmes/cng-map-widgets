// @cng/geocoder-core -- select()'s geometry fetch (design doc §6.4
// "select()'s resolution order").
//
// The ideal boundary mirror is sorted by (country, feature_id) (§6.4's
// requirement on the E2 mirror): `country` as the *outer*, globally
// monotonic sort key makes it safe to binary-search row groups by
// `country` min/max statistics, and then `feature_id`'s min/max narrows
// the within-country candidates further, usually to exactly one group.
// Not every published mirror is sorted that way -- the real
// geoboundaries-catalog boundary files are not globally sorted by
// (shapeGroup, shapeID) at all (verified directly against the published
// files; see geoboundaries-catalog's names/index.json notes) -- so this
// two-level narrowing is treated as an optimization, never a correctness
// assumption: `candidatesFor` below returns every row group whose
// statistics *could* contain the value, which degrades to "most/all
// groups" on an unsorted mirror but is never wrong, and the exact match
// within each candidate group is always a linear scan, never a trust in
// sort order.
//
// Which column is "feature_id" and which is "country" is manifest-driven,
// not hardcoded: see `resolveJoinKey` below for why (CGAZ ADM0 has no
// shapeID column at all, so that level's manifest entry joins on country
// instead).
//
// STEP 1 -- the geometry_ref fast path (design doc §6.2/§6.4 amendments).
// Measured live against the published geoboundaries-catalog, the stats-
// pruning scan above is genuinely slow: the catalog's boundary files are
// Hilbert-sorted for compactness, not sorted by (country, feature_id), so
// row-group statistics prune weakly (e.g. 34 of 55 candidate groups survive
// pruning for Canada's ADM0 row) and `select()` -> outline took 5.6-28.2s
// live. `geometry_ref` -- a `{file, row_group, row}` pointer a names-index
// row carries straight to its physical offset in the boundary file -- turns
// that into one exactly-sized range read. It is advisory, never
// authoritative (this is the whole point: the boundary files are not
// globally sorted, so nothing guarantees the pointer still lines up if the
// boundary file is rebuilt independently of the index), so
// `geometryRefRowRange` below never trusts it blindly -- it recomputes the
// row group from `row` and the manifest's own `row_group_rows` and refuses
// the ref outright if the two disagree -- and `resolveGeometry` always
// verifies the fetched row's join key against `result` before returning its
// geometry, falling back to the stats-pruning scan (now with bounded
// concurrency, see `firstMatch`) on any mismatch.

import { CnmwError, wkbToGeoJson, wkbToGeoJsonAsync } from '@cng/spec';
import { loadHyparquet } from './cdn.js';

/** How many candidate row groups the stats-pruning fallback reads at once
 * (task: "bounded concurrency (~4-6)"). This path is now a rare safety net
 * -- the common case resolves through the geometry_ref fast path above and
 * never reaches it -- so the number only matters when a mirror has no
 * geometry_ref, a stale one, or an unsorted boundary file wide open after a
 * version skew. */
const FALLBACK_CONCURRENCY = 5;

/**
 * Pure decision logic for which boundary-file column, and which value off
 * the search `result`, locates this result's row in its level's boundary
 * file. Extracted so it's unit-testable without any network/hyparquet
 * dependency (same reasoning as `resolveResolutionMode` in geocoder.js).
 *
 * Almost every level joins the names index's `feature_id` against the
 * boundary file's stable per-row id column (`entry.feature_id_column`,
 * e.g. `shapeID`). CGAZ's ADM0 is the documented exception (design doc §6.4
 * "amendments", geoboundaries-catalog's names/index.json manifest): the
 * ADM0 boundary file has no `shapeID` column at all, not merely null
 * values, so there is nothing for `feature_id_column` to name. The
 * manifest instead declares `index_key_column: "country"` for that level,
 * meaning the join uses the names index's `country` column against the
 * boundary file's `country_column` (e.g. `shapeGroup`) -- the one column
 * every level's boundary file has, because every unit belongs to a
 * country.
 *
 * @param {{ feature_id_column?: string|null, country_column?: string, index_key_column?: string }} [entry]
 *   The manifest's `boundaries[]` entry for this result's level. Missing
 *   fields fall back to the historical defaults (`feature_id_column:
 *   "feature_id"`, `country_column: "country"`, joining on `feature_id`),
 *   which keeps every pre-existing caller (and test double) working
 *   unchanged when it has no manifest entry to pass.
 * @param {{ featureId: string|null, country: string }} result
 * @returns {{ column: string, value: string }} the boundary-file column to
 *   match, and the value from `result` to match it against.
 */
export function resolveJoinKey(entry = {}, result) {
  const indexKeyColumn = entry.index_key_column ?? 'feature_id';
  if (indexKeyColumn === 'country') {
    return { column: entry.country_column ?? 'country', value: result.country };
  }
  return { column: entry.feature_id_column ?? 'feature_id', value: result.featureId };
}

/**
 * Coerce a value that should be a non-negative row/row-group index to a
 * plain `number`, or `null` if it isn't safely one. `geometry_ref.row` is
 * parquet `INT64`, and hyparquet decodes `INT64` as `BigInt` (not `number`)
 * -- confirmed directly against the live geoboundaries-catalog index, e.g.
 * `{ row: 10992n }` -- so treating it as already a `number` (as a naive
 * `Number.isInteger(geometryRef.row)` check would) silently fails on every
 * real row and the fast path never fires at all, which is exactly the
 * measured-slow behaviour this whole task exists to fix. `row_group`
 * (`INT32`) decodes as an ordinary `number` today, but is accepted as
 * `BigInt` too for the same reason, defensively.
 * @param {unknown} value
 * @returns {number | null}
 */
function toSafeInt(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return null;
}

/**
 * Validate a `geometry_ref`'s row-group arithmetic against the manifest's
 * declared `row_group_rows` for this level, and return the single-row
 * `[rowStart, rowEnd)` range to range-read. Pure and synchronous -- no
 * network, no hyparquet -- so the arithmetic is unit-testable on its own.
 *
 * Returns `null` (never trust the ref, skip straight to the fallback scan)
 * when: there is no ref; `row` is missing, not an integer, negative, or too
 * large to convert from `BigInt` without losing precision (see
 * `toSafeInt`); `rowGroupRows` is not a positive integer (an older manifest
 * with no `boundaries[].row_group_rows` declared); or the ref's own
 * `row_group` disagrees with `floor(row / rowGroupRows)` -- a corrupt or
 * incompatibly-rebuilt pointer is exactly the case this check exists to
 * catch *before* spending a network round trip on it.
 *
 * @param {{ row?: number|bigint, rowGroup?: number|bigint } | undefined | null} geometryRef
 * @param {number} rowGroupRows
 * @returns {{ rowStart: number, rowEnd: number, rowGroup: number } | null}
 */
export function geometryRefRowRange(geometryRef, rowGroupRows) {
  if (!geometryRef) return null;
  const row = toSafeInt(geometryRef.row);
  if (row === null) return null;
  if (!Number.isInteger(rowGroupRows) || rowGroupRows <= 0) return null;
  const computedRowGroup = Math.floor(row / rowGroupRows);
  const refRowGroup = toSafeInt(geometryRef.rowGroup);
  if (refRowGroup !== null && refRowGroup !== computedRowGroup) {
    return null; // the ref's own bookkeeping is inconsistent -- do not trust it at all
  }
  return { rowStart: row, rowEnd: row + 1, rowGroup: computedRowGroup };
}

/**
 * Run `task(item)` over `items` with at most `concurrency` in flight at
 * once, stop dispatching further items the moment one returns a non-null
 * result, and resolve to that first match (or `null` if every item was
 * tried with no match). Pure control flow -- `task` is the only
 * side-effecting part -- so it's unit-testable with a fake `task` and no
 * network at all.
 *
 * Honest limit, not papered over: this stops *starting new work* and
 * ignores late results from tasks already in flight, which is what
 * actually saves bytes/requests in the common case (a match is usually
 * found within the first `concurrency` candidates, so the remaining
 * candidates -- up to all 55 of them for a weakly-pruned ADM0 query -- are
 * never even requested). It does not reach into an in-flight `task` call
 * and cancel its own network request; `task` is responsible for threading
 * any cooperative-cancellation signal it wants through to its own fetch.
 * A `task` that throws for a reason other than "no match" (a real network
 * failure) fails the whole call, matching the pre-existing sequential
 * scan's behaviour of not swallowing a read error on any one candidate.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R | null>} task
 * @returns {Promise<R | null>}
 */
export async function firstMatch(items, concurrency, task) {
  let cursor = 0;
  let winner = null;
  let settled = false;

  async function worker() {
    for (;;) {
      if (settled) return;
      const i = cursor++;
      if (i >= items.length) return;
      const result = await task(items[i]);
      if (result != null && !settled) {
        settled = true;
        winner = result;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return winner;
}

/**
 * Open a boundary file's footer -- just the file handle and parsed
 * metadata, no per-row-group statistics. Both the fast path and the
 * fallback need this (the version-skew check reads footer key-value
 * metadata regardless of which path resolves the geometry); building the
 * candidate-group statistics (`buildGroups`) is deferred to the fallback
 * alone, since the fast path's common case never needs them.
 *
 * Exported (not just used internally) so `Geocoder` can call it directly
 * for its own background footer prefetch (manifest contract addition
 * `footer_bytes`, task 2) and so a test can fake it via `__deps`.
 *
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal} [signal] threaded into every range-fetch `requestInit`
 *   hyparquet issues against this file handle, so aborting it cancels any
 *   in-flight read (used by the progressive `select({ resolution: 'both' })`
 *   background upgrade to cancel a superseded fetch -- design doc task
 *   "a new select() supersedes the pending background upgrade"). Omitted
 *   (as `Geocoder`'s cache and prefetch both do) when the handle may be
 *   shared by more than one caller, so one caller's abort can never cancel
 *   another's read of the same file.
 * @param {number} [footerBytes] the manifest's declared exact trailing-byte
 *   length of this file's footer + page index (manifest contract addition
 *   `footer_bytes`, task 1). When given, this is passed as hyparquet's
 *   `initialFetchSize` so the footer comes back in exactly one range
 *   request; hyparquet's own default (512 KB, speculative) often forces a
 *   second request for a large footer and always over-fetches a small one.
 *   Omitted (an older manifest with no `footer_bytes` declared) falls back
 *   to hyparquet's own default, unchanged from before this task.
 */
export async function openBoundaryFile(url, fetchImpl, signal, footerBytes) {
  const { hyparquet } = await loadHyparquet();
  const file = await hyparquet.asyncBufferFromUrl({ url, fetch: fetchImpl, requestInit: { cache: 'no-store', signal } });
  // `geoparquet: false`: hyparquet >=1.x auto-detects GeoParquet's `geo`
  // sidecar metadata key (which DuckDB writes by default for any native
  // GEOMETRY-typed column, including this boundary mirror's) and, when
  // present, silently replaces the raw WKB bytes of a matching BYTE_ARRAY
  // column with its OWN already-decoded GeoJSON object -- for *every*
  // read of that column, regardless of the `utf8` option. Design doc §6.1
  // is explicit that this is meant to be read as plain WKB bytes, decoded
  // by `@cng/spec`'s own decoder (chunked/yielding on the full-res path,
  // which hyparquet's built-in decoder is not); `geoparquet: false` keeps
  // it that way instead of two independent decoders fighting over one
  // column.
  const metadataOptions = { geoparquet: false };
  if (typeof footerBytes === 'number' && footerBytes > 0) metadataOptions.initialFetchSize = footerBytes;
  const metadata = await hyparquet.parquetMetadataAsync(file, metadataOptions);
  const catalogVersion = metadata.key_value_metadata?.find((kv) => kv.key === 'cnmw:catalog_version')?.value ?? null;
  return { url, file, metadata, catalogVersion };
}

/**
 * Resolve the open file handle + parsed footer for `url`, reusing
 * `options.handleCache` when the caller supplied one. `Geocoder` passes
 * its own per-instance `Map` here (task 2: "verify handles are already
 * reused across selects -- if not, fix" -- they were not, each `select()`
 * re-opened and re-fetched the footer every time; this is that fix), so a
 * second `select()` against the same boundary file -- or a `select()`
 * that lands after the background footer prefetch already warmed the
 * cache -- reuses the already-open handle and already-parsed footer
 * instead of paying for either again.
 *
 * Without a cache (every direct call in this file's own test suite, and
 * any other direct caller), this is exactly `openBoundaryFile` -- one
 * fresh handle per call, `options.signal` threaded straight through.
 *
 * With a cache, the opening call deliberately never threads
 * `options.signal`: a cached handle can be reused by several concurrent
 * or later selects -- including a background-upgrade `select({
 * resolution: 'both' })` whose own abort must never cancel a *different*
 * select()'s read of the same file. A handle whose open fails is removed
 * from the cache (not left as a permanently-broken cached rejection), so
 * the next caller gets a genuinely fresh attempt.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {{ signal?: AbortSignal, footerBytes?: number, handleCache?: Map<string, Promise<{url: string, file: object, metadata: object, catalogVersion: string|null}>> }} options
 */
function getBoundaryFileHandle(url, fetchImpl, options) {
  const cache = options.handleCache;
  if (!cache) return openBoundaryFile(url, fetchImpl, options.signal, options.footerBytes);
  let handlePromise = cache.get(url);
  if (!handlePromise) {
    handlePromise = openBoundaryFile(url, fetchImpl, undefined, options.footerBytes).catch((err) => {
      cache.delete(url);
      throw err;
    });
    cache.set(url, handlePromise);
  }
  return handlePromise;
}

/**
 * Build per-row-group (country, join) statistics from an already-fetched
 * footer, for the two-level narrowing described at the top of this file.
 * Pure and synchronous: no network, because `metadata` is already in hand
 * by the time this is called (the fallback path only).
 * @param {object} metadata parsed parquet metadata (hyparquet's shape).
 * @param {{ countryColumn: string, joinColumn: string }} columns
 */
function buildGroups(metadata, { countryColumn, joinColumn }) {
  const groups = [];
  let rowStart = 0;
  for (const rg of metadata.row_groups) {
    const countryCol = rg.columns.find((c) => c.meta_data?.path_in_schema.join('.') === countryColumn);
    const joinCol = joinColumn === countryColumn ? countryCol : rg.columns.find((c) => c.meta_data?.path_in_schema.join('.') === joinColumn);
    const countryStats = countryCol?.meta_data?.statistics;
    const joinStats = joinCol?.meta_data?.statistics;
    const numRows = Number(rg.num_rows);
    groups.push({
      rowStart,
      rowEnd: rowStart + numRows,
      countryMin: countryStats ? String(countryStats.min_value) : '',
      countryMax: countryStats ? String(countryStats.max_value) : '￿',
      joinMin: joinStats ? String(joinStats.min_value) : '',
      joinMax: joinStats ? String(joinStats.max_value) : '￿',
    });
    rowStart += numRows;
  }
  return groups;
}

/** Candidate groups whose [min,max] range could contain `value`. */
function candidatesFor(groups, minKey, maxKey, value) {
  return groups
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => g[minKey] <= value && value <= g[maxKey])
    .map(({ i }) => i);
}

/**
 * Fetch the `geometry` column for exactly one absolute row and decode it,
 * reusing the already-open file handle and already-fetched join-column
 * match (for the `bbox`). Shared by both the fast path and the fallback,
 * since once either has located the row, finishing the read is identical.
 */
async function fetchMatchedGeometry({ hyparquet, compressors, file, metadata, absoluteRow, match, boundaryUrl, options }) {
  options.signal?.throwIfAborted();
  // Pass 2: fetch just the `geometry` column for that single row, with
  // `utf8: false` -- geometry is WKB, not text, and hyparquet's default
  // BYTE_ARRAY->string conversion would otherwise mangle it into a JS
  // string (one UTF-16 code unit per raw byte), corrupting the WKB. This is
  // the one column this read needs raw bytes for, so it is isolated into
  // its own narrow read rather than disabling utf8 conversion file-wide
  // (which would also break the join column).
  const geomRows = await hyparquet.parquetReadObjects({
    file,
    metadata,
    columns: ['geometry'],
    rowStart: absoluteRow,
    rowEnd: absoluteRow + 1,
    utf8: false,
    compressors,
  });
  const geometry = options.decodeAsync
    ? await wkbToGeoJsonAsync(geomRows[0].geometry, { signal: options.signal })
    : wkbToGeoJson(geomRows[0].geometry);
  const bbox = match.bbox ? [match.bbox.xmin, match.bbox.ymin, match.bbox.xmax, match.bbox.ymax] : undefined;
  return { geometry, bbox, boundaryUrl };
}

/**
 * Fetch and verify the geometry for one search result, per §6.4's
 * resolution order: step 1 tries the `geometry_ref` fast path (verified
 * before being trusted); steps 2-3 are the stats-pruning fallback,
 * scanned with bounded concurrency, used when there is no usable ref or
 * the fetched row's join key doesn't match.
 *
 * @param {{ featureId: string|null, country: string, level: number, geometryRef?: { file: string, rowGroup: number, row: number } }} result
 * @param {string} boundaryUrl
 * @param {string|null} expectedCatalogVersion
 * @param {typeof fetch} fetchImpl
 * @param {'error'|'warn'|'ignore'} onVersionSkew
 * @param {(payload: { code: string, message: string, detail?: unknown }) => void} [onWarning]
 * @param {{ decodeAsync?: boolean, signal?: AbortSignal, entry?: object, footerBytes?: number, handleCache?: Map<string, Promise<object>> }} [options] `decodeAsync: true`
 *   decodes the geometry column with `wkbToGeoJsonAsync` (cooperative-yielding) instead of the
 *   synchronous decoder -- used on the 'full' / background-upgrade path, never needed on the small
 *   display-simplified path. `signal` cancels the fetch and is checked between decode chunks.
 *   `entry` is the manifest's `boundaries[]` entry for this result's level (see
 *   `resolveJoinKey`); omitted, every level behaves as it did before `index_key_column`/
 *   `country_column`/`row_group_rows` existed (join on `feature_id_column` default `"feature_id"`,
 *   narrow on `country_column` default `"country"`, no fast path). `footerBytes`/`handleCache`:
 *   see `openBoundaryFile`/`getBoundaryFileHandle` above (manifest contract addition + task 2).
 * @returns {Promise<{ geometry: GeoJSON.Polygon|GeoJSON.MultiPolygon, bbox?: [number,number,number,number], boundaryUrl: string }>}
 */
export async function resolveGeometry(result, boundaryUrl, expectedCatalogVersion, fetchImpl, onVersionSkew, onWarning, options = {}) {
  const { hyparquet, compressors } = await loadHyparquet();
  const entry = options.entry ?? {};
  const countryColumn = entry.country_column ?? 'country';
  const { column: joinColumn, value: joinValue } = resolveJoinKey(entry, result);

  const { file, metadata, catalogVersion } = await getBoundaryFileHandle(boundaryUrl, fetchImpl, options);

  if (expectedCatalogVersion && catalogVersion && catalogVersion !== expectedCatalogVersion) {
    const message = `Boundary file catalog_version (${catalogVersion}) does not match the index's (${expectedCatalogVersion}).`;
    if (onVersionSkew === 'error') {
      throw new CnmwError(message, 'INDEX_VERSION_MISMATCH', {
        context: { indexCatalogVersion: expectedCatalogVersion, boundaryCatalogVersion: catalogVersion },
      });
    }
    if (onVersionSkew === 'warn') {
      onWarning?.({ code: 'INDEX_VERSION_MISMATCH', message, detail: { indexCatalogVersion: expectedCatalogVersion, boundaryCatalogVersion: catalogVersion } });
    }
  }

  // STEP 1: the geometry_ref fast path. `entry.row_group_rows` only exists
  // on a manifest that declares it (geoboundaries-catalog's does, per
  // level); its absence -- an older or differently-shaped manifest --
  // means `range` comes back null and this block is a no-op, falling
  // straight through to the pre-existing stats-pruning scan with no
  // behaviour change.
  const range = geometryRefRowRange(result.geometryRef, entry.row_group_rows);
  if (range) {
    options.signal?.throwIfAborted();
    // Task 4: parallelize the join-key verification read with the
    // geometry read for the *same* row, instead of waiting for
    // verification before even starting the geometry fetch. Safe here
    // specifically because `geometry_ref` already names the exact row --
    // there is nothing left to discover before the geometry read's
    // `rowStart`/`rowEnd` are known, only whether that row turns out to be
    // the right one. On a mismatch the speculative geometry read/decode is
    // simply discarded (the `.catch` below keeps a failure in it from
    // becoming an unhandled rejection); per §6.4 a mismatch here is already
    // rare (an unrebuilt mirror or a stale ref), so paying for one wasted
    // speculative read in that case is the right trade for shaving a full
    // round trip off the overwhelmingly common hit.
    const verifyPromise = hyparquet.parquetReadObjects({
      file,
      metadata,
      columns: [joinColumn, 'bbox'],
      rowStart: range.rowStart,
      rowEnd: range.rowEnd,
      compressors,
    });
    const speculativeGeomPromise = hyparquet
      .parquetReadObjects({
        file,
        metadata,
        columns: ['geometry'],
        rowStart: range.rowStart,
        rowEnd: range.rowEnd,
        utf8: false,
        compressors,
      })
      .catch(() => null);

    const rows = await verifyPromise;
    const match = rows[0];
    if (match && match[joinColumn] === joinValue) {
      const geomRows = await speculativeGeomPromise;
      if (geomRows) {
        options.signal?.throwIfAborted();
        const geometry = options.decodeAsync
          ? await wkbToGeoJsonAsync(geomRows[0].geometry, { signal: options.signal })
          : wkbToGeoJson(geomRows[0].geometry);
        const bbox = match.bbox ? [match.bbox.xmin, match.bbox.ymin, match.bbox.xmax, match.bbox.ymax] : undefined;
        return { geometry, bbox, boundaryUrl };
      }
      // The speculative geometry read itself failed (a real network
      // hiccup, not a mismatch) -- do the equivalent isolated read rather
      // than silently returning nothing.
      return fetchMatchedGeometry({ hyparquet, compressors, file, metadata, absoluteRow: range.rowStart, match, boundaryUrl, options });
    }
    // Never trust the hint past this point for this call: the row it named
    // didn't carry the expected join key (a version-skewed/rebuilt
    // boundary file, or a stale cached ref), so fall through to the scan
    // below exactly as if there had been no geometry_ref at all. The
    // speculative geometry read above is left to resolve/reject on its
    // own; its `.catch` keeps it from surfacing as an unhandled rejection.
    onWarning?.({
      code: 'GEOMETRY_REF_MISMATCH',
      message: `geometry_ref for "${joinValue}" pointed at row ${range.rowStart}, which did not carry the expected "${joinColumn}"; falling back to a stats-pruning scan.`,
      detail: { featureId: result.featureId, joinColumn, joinValue, geometryRef: result.geometryRef, boundaryUrl },
    });
  }

  // STEPS 2-3: stats-pruning fallback, scanned with bounded concurrency
  // instead of sequentially (task: "~4-6 concurrent, stop on first match").
  const groups = buildGroups(metadata, { countryColumn, joinColumn });
  const byCountry = candidatesFor(groups, 'countryMin', 'countryMax', result.country);
  const pool = byCountry.length > 0 ? byCountry : groups.map((_, i) => i);
  const byJoin = pool.filter((i) => groups[i].joinMin <= joinValue && joinValue <= groups[i].joinMax);
  const candidateGroupIndices = byJoin.length > 0 ? byJoin : pool;

  const winner = await firstMatch(candidateGroupIndices, FALLBACK_CONCURRENCY, async (gi) => {
    options.signal?.throwIfAborted();
    const g = groups[gi];
    // Pass 1: locate the exact row within this group using the *string*
    // columns only (the join column, bbox) -- hyparquet's default
    // `utf8: true` conversion is correct and cheap for these.
    const rowsInGroup = await hyparquet.parquetReadObjects({
      file,
      metadata,
      columns: [joinColumn, 'bbox'],
      rowStart: g.rowStart,
      rowEnd: g.rowEnd,
      compressors,
    });
    const localIndex = rowsInGroup.findIndex((r) => r[joinColumn] === joinValue);
    if (localIndex === -1) return null;
    return { absoluteRow: g.rowStart + localIndex, match: rowsInGroup[localIndex] };
  });

  if (winner) {
    return fetchMatchedGeometry({ hyparquet, compressors, file, metadata, absoluteRow: winner.absoluteRow, match: winner.match, boundaryUrl, options });
  }

  throw new CnmwError(`Feature "${joinValue}" not found in boundary file (joined on "${joinColumn}").`, 'GEOMETRY_NOT_FOUND', {
    context: { featureId: result.featureId, joinColumn, joinValue, boundaryUrl },
  });
}
