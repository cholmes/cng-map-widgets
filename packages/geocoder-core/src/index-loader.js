// @cng/geocoder-core -- index manifest + parquet loading.
//
// Reuses the proven hyparquet patterns from
// experiments/e1-search-index/public/lib/{approach-full-load,approach-range-request}.js:
// a full-load path (fetch once, decode, in-memory binary search) and a
// range-request path (footer-only, then range-read matching row groups).
// `auto` picks between them per design doc §3.2 / §6.3 item 8.

import { CnmwError } from '@cng/spec';
import { loadHyparquet } from './cdn.js';

const REQUIRED_COLUMNS = ['name', 'name_norm', 'level', 'country', 'feature_id', 'source', 'bbox'];
// Optional columns a client reads when present, but never requires:
// `parent_name` and `area_km2` (Overture's division names index),
// `country_name` and `area_km2` (geoBoundaries' CGAZ names index). Not
// enforced by `assertSchema` -- missing means `undefined` on the row, and
// `Geocoder#_rankAndFilter`/`ranking.js` handle that throughout (ranking
// sorts a missing `area_km2` last; the dropdown adapters just omit the
// secondary-text line). See design doc §3.2's amendment, "Index columns".
// `class` and `population` come from the ranking-residual follow-up
// (design doc §3.2 amendment, "Known residual limitation" / task 5) and
// are real, populated data now, not the pending columns this comment used
// to describe: the published Overture divisions index carries both, the
// Who's On First names index carries `population` (no `class` column),
// and a geoBoundaries CGAZ index carries neither. **Watch the decoded
// type:** WOF types `population` as parquet `INT64`, which hyparquet
// decodes as a `BigInt`, so anything consuming it must coerce
// `number|bigint` rather than test for `number` -- geocoder.js's
// `toFiniteNumber` is that coercion, and `ranking.js` keeps a matching
// guard. Listing a column here is documentation plus projection; nothing
// enforces its presence.
// `alt_of` (an alt-name row's primary `feature_id`, E8/ranking-residual
// follow-up) belongs on this list too -- it is read directly off the
// decoded row (`row.alt_of`) in both ranking.js and geocoder.js's
// `primaryName` resolution, exactly like every other optional column
// here, and was simply missing from the list until the "primaryName on
// alt matches" follow-up (task 1) noticed. Documentation only, as above:
// nothing enforces its presence.
const OPTIONAL_COLUMNS = ['parent_name', 'parent_id', 'area_km2', 'country_name', 'geometry_ref', 'class', 'population', 'alt_of'];

/**
 * Fetch and validate the index manifest (design doc §6.4).
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadManifest(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url);
  } catch (cause) {
    throw new CnmwError(`Couldn't load the place index manifest at ${url}.`, 'INDEX_FETCH_FAILED', { cause });
  }
  if (!res.ok) {
    throw new CnmwError(`Index manifest fetch failed: HTTP ${res.status}`, 'INDEX_FETCH_FAILED', {
      context: { status: res.status, url },
    });
  }
  const manifest = await res.json();
  if (manifest.spec !== 'cnmw-index/1.0') {
    throw new CnmwError('Index manifest has an unrecognized spec version.', 'INDEX_SCHEMA_MISMATCH', {
      context: { spec: manifest.spec },
    });
  }
  return manifest;
}

/**
 * A manifest URL may itself be relative (e.g. `'./data/index.json'`, the
 * common case for a same-origin zero-build page). `URL(rel, base)`
 * requires an absolute base, so resolve against `location.href` first
 * when running in a browser; outside one, the caller must pass an
 * absolute URL.
 */
export function toAbsoluteUrl(url) {
  if (typeof location !== 'undefined' && location.href) return new URL(url, location.href).toString();
  return new URL(url).toString();
}

/** Resolve a manifest-relative URL against the manifest's own (possibly relative) URL. */
export function resolveManifestUrl(manifestUrl, relativeUrl) {
  return new URL(relativeUrl, toAbsoluteUrl(manifestUrl)).toString();
}

/**
 * Project one decoded index row onto the canonical schema (design doc
 * §6.2) that `ranking.js`/`geocoder.js` read from -- `row.feature_id`,
 * `row.source`, etc. Not every published index literally has those column
 * names: geoboundaries-catalog's names index calls its stable id column
 * `shape_id` (matching its boundary files' `shapeID`), declared in the
 * manifest as `index.feature_id_column`, and carries no `source` column
 * at all, because it has exactly one source and repeats nothing on every
 * row. `defaultSource` (the manifest's own top-level `source` field)
 * fills that in.
 * @param {Record<string, unknown>} row
 * @param {{ featureIdColumn: string, defaultSource?: string }} opts
 */
function projectRow(row, { featureIdColumn, defaultSource }) {
  let out = row;
  if (featureIdColumn !== 'feature_id') {
    const { [featureIdColumn]: featureId, ...rest } = row;
    out = { ...rest, feature_id: featureId };
  }
  if (out.source === undefined && defaultSource !== undefined) {
    out = { ...out, source: defaultSource };
  }
  return out;
}

function assertSchema(firstRow, { featureIdColumn, defaultSource } = {}) {
  const idColumn = featureIdColumn ?? 'feature_id';
  const sourceColumnPresent = 'source' in firstRow;
  for (const col of REQUIRED_COLUMNS) {
    if (col === 'feature_id') {
      if (!(idColumn in firstRow)) {
        throw new CnmwError(`Index parquet is missing required column "${idColumn}" (declared as the feature-id column).`, 'INDEX_SCHEMA_MISMATCH', {
          context: { column: idColumn },
        });
      }
      continue;
    }
    if (col === 'source' && !sourceColumnPresent) {
      if (defaultSource === undefined) {
        throw new CnmwError('Index parquet has no "source" column, and the manifest has no top-level "source" to default it from.', 'INDEX_SCHEMA_MISMATCH', {
          context: { column: 'source' },
        });
      }
      continue; // synthesized from the manifest's `source` field instead
    }
    if (!(col in firstRow)) {
      throw new CnmwError(`Index parquet is missing required column "${col}".`, 'INDEX_SCHEMA_MISMATCH', {
        context: { column: col },
      });
    }
  }
}

/**
 * Full-load strategy: fetch the whole index parquet, decode every row,
 * return an in-memory structure ready for binary-search prefix queries.
 * @param {string} parquetUrl
 * @param {typeof fetch} fetchImpl
 * @param {{ featureIdColumn?: string, defaultSource?: string }} [options] see `projectRow`.
 */
export async function loadFullIndex(parquetUrl, fetchImpl, options = {}) {
  const featureIdColumn = options.featureIdColumn ?? 'feature_id';
  const { defaultSource } = options;
  const { hyparquet, compressors } = await loadHyparquet();
  const t0 = performance.now();
  const res = await fetchImpl(parquetUrl);
  if (!res.ok) {
    throw new CnmwError(`Index parquet fetch failed: HTTP ${res.status}`, 'INDEX_FETCH_FAILED', {
      context: { status: res.status, url: parquetUrl },
    });
  }
  const buf = await res.arrayBuffer();
  let rows;
  try {
    rows = await hyparquet.parquetReadObjects({ file: buf, compressors });
  } catch (cause) {
    throw new CnmwError('Failed to decode index parquet.', 'INDEX_SCHEMA_MISMATCH', { cause });
  }
  if (rows.length > 0) {
    assertSchema(rows[0], { featureIdColumn, defaultSource });
    rows = rows.map((r) => projectRow(r, { featureIdColumn, defaultSource }));
  }
  const nameNorms = rows.map((r) => r.name_norm);
  // Builder guarantee check (design doc §6.3 item 1): ascending, byte-wise.
  for (let i = 1; i < nameNorms.length; i++) {
    if (nameNorms[i - 1] > nameNorms[i]) {
      throw new CnmwError('Index parquet is not sorted ascending by name_norm.', 'INDEX_SCHEMA_MISMATCH', {
        context: { atRow: i },
      });
    }
  }
  const loadMs = performance.now() - t0;
  return { strategy: 'full', rows, nameNorms, bytes: buf.byteLength, loadMs };
}

/** Binary search a sorted array of strings for the half-open range starting with `prefix`. */
function lowerBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** [start, end) indices of entries starting with `prefix` in a sorted array. */
export function prefixRange(arr, prefix) {
  const start = lowerBound(arr, prefix);
  const end = lowerBound(arr, prefix + '￿');
  return [start, end];
}

/**
 * Range-request strategy: read the parquet footer only, bucket row groups
 * by their name_norm min/max statistics, and fetch just the candidate
 * group(s) per query.
 * @param {string} parquetUrl
 * @param {typeof fetch} fetchImpl
 * @param {number} initialFetchSize
 * @param {{ featureIdColumn?: string, defaultSource?: string }} [options] see `projectRow` in the
 *   full-load path above; carried on the returned handle so `searchRangeIndex` can project its
 *   rows onto the same canonical schema.
 */
export async function openRangeIndex(parquetUrl, fetchImpl, initialFetchSize = 65_536, options = {}) {
  const { hyparquet } = await loadHyparquet();
  const t0 = performance.now();
  const file = await hyparquet.asyncBufferFromUrl({ url: parquetUrl, fetch: fetchImpl, requestInit: { cache: 'no-store' } });
  // `geoparquet: false` for consistency with geometry-resolver.js (this
  // index file has no geometry column per design doc §6.1, so it's
  // defensive rather than load-bearing here). Also fixes a pre-existing
  // bug: `initialFetchSize` must be passed inside the options object --
  // `parquetMetadataAsync(file, initialFetchSize)` silently dropped it
  // (destructuring `{ initialFetchSize }` from a bare number yields
  // `undefined`), so the range path was always using hyparquet's default
  // 512KB speculative footer fetch, not the tuned 64KB this function
  // documents (design doc §6.3 item 9).
  const metadata = await hyparquet.parquetMetadataAsync(file, { initialFetchSize, geoparquet: false });
  const groups = [];
  let rowStart = 0;
  for (const rg of metadata.row_groups) {
    const col = rg.columns.find((c) => c.meta_data && c.meta_data.path_in_schema.join('.') === 'name_norm');
    const stats = col && col.meta_data && col.meta_data.statistics;
    const numRows = Number(rg.num_rows);
    groups.push({
      rowStart,
      rowEnd: rowStart + numRows,
      min: stats ? String(stats.min_value) : '',
      max: stats ? String(stats.max_value) : '￿',
    });
    rowStart += numRows;
  }
  if (groups.length === 0) {
    throw new CnmwError('Index parquet has no row groups.', 'INDEX_SCHEMA_MISMATCH');
  }
  const loadMs = performance.now() - t0;
  return {
    strategy: 'range',
    url: parquetUrl,
    file,
    metadata,
    groups,
    rows: rowStart,
    loadMs,
    featureIdColumn: options.featureIdColumn ?? 'feature_id',
    defaultSource: options.defaultSource,
  };
}

/** Which row-group indices could contain `prefix`, via a binary search over group [min,max]. */
export function findCandidateGroups(groups, prefix) {
  const hiBound = prefix + '￿';
  let lo = 0;
  let hi = groups.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (groups[mid].max < prefix) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [];
  for (let i = lo; i < groups.length; i++) {
    if (groups[i].min > hiBound) break;
    candidates.push(i);
  }
  return candidates;
}

/** Bounded concurrency for `searchRangeIndex`'s row-group fetches
 *  (follow-up task 4, "range-mode query latency"), default `~4-6` per the
 *  task. See that function's doc comment for the measured before/after. */
export const DEFAULT_RANGE_GROUP_CONCURRENCY = 5;

/** How many candidate row groups `searchRangeIndex` will actually fetch
 *  for one query before giving up and reporting `truncated` (follow-up
 *  task 4). A prefix this unselective -- "a", "e", a single CJK
 *  character -- is not a case this function tries to answer completely;
 *  see that function's doc comment for the honest semantics. */
export const DEFAULT_RANGE_MAX_CANDIDATE_GROUPS = 24;

/**
 * Fetch only the row group(s) that can contain `prefix` and filter to an
 * exact prefix match.
 *
 * **Follow-up task 4, "range-mode query latency".** Measured live against
 * the published 5.6M-row Overture index (876 row groups, 6400 rows each):
 * the pre-follow-up version of this function fetched its candidate row
 * groups **sequentially**, one `await` at a time. Per-group latency there
 * is dominated by the HTTP round trip (~1.1-1.7s observed, essentially
 * flat regardless of row count per group -- decode time is not the
 * bottleneck), so a low-selectivity prefix spanning many candidate groups
 * paid that cost once *per group*: "san" (10 candidate groups) took
 * ~11.7s; "a" (37 candidate groups) took ~43.9s. Single-group queries
 * ("zur", "san jo") were already fast (<2s) and are essentially unchanged
 * below.
 *
 * Two changes fix this:
 *  1. **Bounded-concurrency fetches** (`options.concurrency`, default
 *     `DEFAULT_RANGE_GROUP_CONCURRENCY`): candidate groups are fetched
 *     `concurrency`-at-a-time instead of one at a time, via the same
 *     worker-pool pattern as `geometry-resolver.js`'s `firstMatch`
 *     (minus its "stop on first hit" early exit -- every candidate group
 *     here can hold real matches, so every one of them, up to the cap
 *     below, has to be read).
 *  2. **A documented cap** (`options.maxGroups`, default
 *     `DEFAULT_RANGE_MAX_CANDIDATE_GROUPS`): a prefix whose candidate
 *     groups exceed the cap only has its first `maxGroups` (by row-group
 *     order, which is ascending `name_norm` order -- the builder's own
 *     sort guarantee, design doc §6.3 -- so "first by sort order" is a
 *     real, meaningful subset, not an arbitrary one) actually fetched;
 *     the rest are never requested at all. The returned array's own
 *     `truncated` property (an own, non-enumerable `true`; absent
 *     otherwise) tells the caller this happened, honestly, instead of
 *     silently returning an incomplete answer that looks complete.
 *
 * `options.onBatch(rowsSoFar, info)`, when given, fires once after every
 * individual candidate group finishes (not once per `concurrency`-sized
 * wave -- a caller that only cares about "the first wave of
 * `concurrency` groups is in" or "every group is in" filters `info.
 * completed` itself). `rowsSoFar` is the *cumulative* matched-and-
 * projected rows across every group that has completed so far (a fresh
 * array each call, safe to retain); `info` is `{ completed, total,
 * truncated }` -- `total` is the number of groups actually being fetched
 * (post-cap), `completed` counts up to it, `truncated` is this query's
 * cap status, known up front and identical on every call. This is what
 * lets `Geocoder#search()`'s range-mode path resolve early with a
 * partial answer and stream in the rest -- see `geocoder.js`'s
 * `_searchRangeRowsFirstWave`/`_scheduleRangeCompletionWave`.
 *
 * @param {ReturnType<typeof openRangeIndex> extends Promise<infer T> ? T : never} handle
 * @param {string} prefix
 * @param {{ concurrency?: number, maxGroups?: number, onBatch?: (rowsSoFar: object[], info: { completed: number, total: number, truncated: boolean }) => void }} [options]
 */
export async function searchRangeIndex(handle, prefix, options = {}) {
  const { hyparquet, compressors } = await loadHyparquet();
  const concurrency = options.concurrency ?? DEFAULT_RANGE_GROUP_CONCURRENCY;
  const maxGroups = options.maxGroups ?? DEFAULT_RANGE_MAX_CANDIDATE_GROUPS;

  const allCandidates = findCandidateGroups(handle.groups, prefix);
  const truncated = allCandidates.length > maxGroups;
  const candidateIdx = truncated ? allCandidates.slice(0, maxGroups) : allCandidates;

  const { featureIdColumn, defaultSource } = handle;
  const needsProjection = featureIdColumn !== 'feature_id' || defaultSource !== undefined;
  const project = (r) => (needsProjection ? projectRow(r, { featureIdColumn, defaultSource }) : r);

  let allRows = [];
  let completed = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= candidateIdx.length) return;
      const g = handle.groups[candidateIdx[i]];
      const rows = await hyparquet.parquetReadObjects({
        file: handle.file,
        metadata: handle.metadata,
        rowStart: g.rowStart,
        rowEnd: g.rowEnd,
        compressors,
      });
      const matched = rows.filter((r) => r.name_norm && r.name_norm.startsWith(prefix)).map(project);
      // Single-threaded JS: this read-then-write of `allRows`/`completed`
      // never straddles an `await`, so two workers can never interleave
      // in the middle of it -- no lock needed.
      allRows = allRows.concat(matched);
      completed += 1;
      options.onBatch?.(allRows.slice(), { completed, total: candidateIdx.length, truncated });
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, candidateIdx.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (truncated) Object.defineProperty(allRows, 'truncated', { value: true, enumerable: false, configurable: true });
  return allRows;
}
