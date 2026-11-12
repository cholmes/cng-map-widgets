// @cnmw/geocoder-core -- select()'s geometry fetch (design doc §6.4
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

import { CnmwError, wkbToGeoJson, wkbToGeoJsonAsync } from '@cnmw/spec';
import { loadHyparquet } from './cdn.js';

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
 * Open a boundary file's footer and build per-row-group (country, join)
 * statistics for the two-level narrowing described above. The country
 * column is always scanned, because it narrows at every level (it IS the
 * join column at level 0, per `resolveJoinKey` above, and a cheap extra
 * narrowing pass at every other level); the join column is only scanned
 * again when it differs from the country column.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal} [signal] threaded into every range-fetch `requestInit`
 *   hyparquet issues against this file handle, so aborting it cancels any
 *   in-flight read (used by the progressive `select({ resolution: 'both' })`
 *   background upgrade to cancel a superseded fetch -- design doc task
 *   "a new select() supersedes the pending background upgrade").
 * @param {{ countryColumn: string, joinColumn: string }} columns
 */
async function openBoundaryIndex(url, fetchImpl, signal, columns) {
  const { countryColumn, joinColumn } = columns;
  const { hyparquet } = await loadHyparquet();
  const file = await hyparquet.asyncBufferFromUrl({ url, fetch: fetchImpl, requestInit: { cache: 'no-store', signal } });
  // `geoparquet: false`: hyparquet >=1.x auto-detects GeoParquet's `geo`
  // sidecar metadata key (which DuckDB writes by default for any native
  // GEOMETRY-typed column, including this boundary mirror's) and, when
  // present, silently replaces the raw WKB bytes of a matching BYTE_ARRAY
  // column with its OWN already-decoded GeoJSON object -- for *every*
  // read of that column, regardless of the `utf8` option. Design doc §6.1
  // is explicit that this is meant to be read as plain WKB bytes, decoded
  // by `@cnmw/spec`'s own decoder (chunked/yielding on the full-res path,
  // which hyparquet's built-in decoder is not); `geoparquet: false` keeps
  // it that way instead of two independent decoders fighting over one
  // column.
  const metadata = await hyparquet.parquetMetadataAsync(file, { geoparquet: false });
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
  const catalogVersion = metadata.key_value_metadata?.find((kv) => kv.key === 'cnmw:catalog_version')?.value ?? null;
  return { url, file, metadata, groups, catalogVersion };
}

/** Candidate groups whose [min,max] range could contain `value`. */
function candidatesFor(groups, minKey, maxKey, value) {
  return groups
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => g[minKey] <= value && value <= g[maxKey])
    .map(({ i }) => i);
}

/**
 * Fetch and verify the geometry for one search result, per §6.4's
 * resolution order (steps 2-3; step 1's `geometry_ref` fast path is not
 * implemented in this provisional build -- see geocoder-core's README
 * note / the task handback report).
 *
 * @param {{ featureId: string|null, country: string, level: number }} result
 * @param {string} boundaryUrl
 * @param {string|null} expectedCatalogVersion
 * @param {typeof fetch} fetchImpl
 * @param {'error'|'warn'|'ignore'} onVersionSkew
 * @param {(payload: { code: string, message: string, detail?: unknown }) => void} [onWarning]
 * @param {{ decodeAsync?: boolean, signal?: AbortSignal, entry?: object }} [options] `decodeAsync: true`
 *   decodes the geometry column with `wkbToGeoJsonAsync` (cooperative-yielding) instead of the
 *   synchronous decoder -- used on the 'full' / background-upgrade path, never needed on the small
 *   display-simplified path. `signal` cancels the fetch and is checked between decode chunks.
 *   `entry` is the manifest's `boundaries[]` entry for this result's level (see
 *   `resolveJoinKey`); omitted, every level behaves as it did before `index_key_column`/
 *   `country_column` existed (join on `feature_id_column` default `"feature_id"`, narrow on
 *   `country_column` default `"country"`).
 * @returns {Promise<{ geometry: GeoJSON.Polygon|GeoJSON.MultiPolygon, bbox?: [number,number,number,number], boundaryUrl: string }>}
 */
export async function resolveGeometry(result, boundaryUrl, expectedCatalogVersion, fetchImpl, onVersionSkew, onWarning, options = {}) {
  const { hyparquet, compressors } = await loadHyparquet();
  const entry = options.entry ?? {};
  const countryColumn = entry.country_column ?? 'country';
  const { column: joinColumn, value: joinValue } = resolveJoinKey(entry, result);
  const handle = await openBoundaryIndex(boundaryUrl, fetchImpl, options.signal, { countryColumn, joinColumn });

  if (expectedCatalogVersion && handle.catalogVersion && handle.catalogVersion !== expectedCatalogVersion) {
    const message = `Boundary file catalog_version (${handle.catalogVersion}) does not match the index's (${expectedCatalogVersion}).`;
    if (onVersionSkew === 'error') {
      throw new CnmwError(message, 'INDEX_VERSION_MISMATCH', {
        context: { indexCatalogVersion: expectedCatalogVersion, boundaryCatalogVersion: handle.catalogVersion },
      });
    }
    if (onVersionSkew === 'warn') {
      onWarning?.({ code: 'INDEX_VERSION_MISMATCH', message, detail: { indexCatalogVersion: expectedCatalogVersion, boundaryCatalogVersion: handle.catalogVersion } });
    }
  }

  const byCountry = candidatesFor(handle.groups, 'countryMin', 'countryMax', result.country);
  const pool = byCountry.length > 0 ? byCountry : handle.groups.map((_, i) => i);
  const byJoin = pool.filter((i) => {
    const g = handle.groups[i];
    return g.joinMin <= joinValue && joinValue <= g.joinMax;
  });
  const candidateGroupIndices = byJoin.length > 0 ? byJoin : pool;

  for (const gi of candidateGroupIndices) {
    const g = handle.groups[gi];
    // Pass 1: locate the exact row within this group using the
    // *string* columns only (the join column, bbox) -- hyparquet's
    // default `utf8: true` conversion is correct and cheap for these.
    const rows = await hyparquet.parquetReadObjects({
      file: handle.file,
      metadata: handle.metadata,
      columns: [joinColumn, 'bbox'],
      rowStart: g.rowStart,
      rowEnd: g.rowEnd,
      compressors,
    });
    const localIndex = rows.findIndex((r) => r[joinColumn] === joinValue);
    if (localIndex !== -1) {
      const absoluteRow = g.rowStart + localIndex;
      // Pass 2: fetch just the `geometry` column for that single row,
      // with `utf8: false` -- geometry is WKB, not text, and hyparquet's
      // default BYTE_ARRAY->string conversion would otherwise mangle it
      // into a JS string (one UTF-16 code unit per raw byte), corrupting
      // the WKB. This is the one column this read needs raw bytes for,
      // so it is isolated into its own narrow read rather than disabling
      // utf8 conversion file-wide (which would also break feature_id).
      options.signal?.throwIfAborted();
      const geomRows = await hyparquet.parquetReadObjects({
        file: handle.file,
        metadata: handle.metadata,
        columns: ['geometry'],
        rowStart: absoluteRow,
        rowEnd: absoluteRow + 1,
        utf8: false,
        compressors,
      });
      const geometry = options.decodeAsync
        ? await wkbToGeoJsonAsync(geomRows[0].geometry, { signal: options.signal })
        : wkbToGeoJson(geomRows[0].geometry);
      const match = rows[localIndex];
      const bbox = match.bbox ? [match.bbox.xmin, match.bbox.ymin, match.bbox.xmax, match.bbox.ymax] : undefined;
      return { geometry, bbox, boundaryUrl };
    }
  }

  throw new CnmwError(`Feature "${joinValue}" not found in boundary file (joined on "${joinColumn}").`, 'GEOMETRY_NOT_FOUND', {
    context: { featureId: result.featureId, joinColumn, joinValue, boundaryUrl },
  });
}
