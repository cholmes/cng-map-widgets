// @cnmw/geocoder-core -- select()'s geometry fetch (design doc §6.4
// "select()'s resolution order").
//
// The boundary mirror is sorted by (country, feature_id) (§6.4's
// requirement on the E2 mirror). `country` is therefore the *outer* sort
// key and is globally monotonic across row groups, which makes it safe to
// binary-search row groups by `country` min/max statistics. Within a
// single country's contiguous span, `feature_id` is monotonically
// increasing, so once country narrows the candidate groups down, the
// `feature_id` min/max statistics on those same groups correctly narrow
// further to (usually) exactly one group. This two-level narrowing is
// what "binary search row groups via shapeID column stats" means in
// practice for a file that is not globally sorted by shapeID alone --
// documented here because a literal single-column binary search on
// `feature_id` alone would be unsound on this layout.

import { CnmwError, wkbToGeoJson, wkbToGeoJsonAsync } from '@cnmw/spec';
import { loadHyparquet } from './cdn.js';

/**
 * Open a boundary file's footer and build per-row-group (country,
 * feature_id) statistics for the two-level narrowing described above.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal} [signal] threaded into every range-fetch `requestInit`
 *   hyparquet issues against this file handle, so aborting it cancels any
 *   in-flight read (used by the progressive `select({ resolution: 'both' })`
 *   background upgrade to cancel a superseded fetch -- design doc task
 *   "a new select() supersedes the pending background upgrade").
 */
async function openBoundaryIndex(url, fetchImpl, signal) {
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
    const countryCol = rg.columns.find((c) => c.meta_data?.path_in_schema.join('.') === 'country');
    const idCol = rg.columns.find((c) => c.meta_data?.path_in_schema.join('.') === 'feature_id');
    const countryStats = countryCol?.meta_data?.statistics;
    const idStats = idCol?.meta_data?.statistics;
    const numRows = Number(rg.num_rows);
    groups.push({
      rowStart,
      rowEnd: rowStart + numRows,
      countryMin: countryStats ? String(countryStats.min_value) : '',
      countryMax: countryStats ? String(countryStats.max_value) : '￿',
      idMin: idStats ? String(idStats.min_value) : '',
      idMax: idStats ? String(idStats.max_value) : '￿',
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
 * @param {{ featureId: string, country: string, level: number }} result
 * @param {string} boundaryUrl
 * @param {string|null} expectedCatalogVersion
 * @param {typeof fetch} fetchImpl
 * @param {'error'|'warn'|'ignore'} onVersionSkew
 * @param {(payload: { code: string, message: string, detail?: unknown }) => void} [onWarning]
 * @param {{ decodeAsync?: boolean, signal?: AbortSignal }} [options] `decodeAsync: true` decodes the
 *   geometry column with `wkbToGeoJsonAsync` (cooperative-yielding) instead of the synchronous
 *   decoder -- used on the 'full' / background-upgrade path, never needed on the small
 *   display-simplified path. `signal` cancels the fetch and is checked between decode chunks.
 * @returns {Promise<{ geometry: GeoJSON.Polygon|GeoJSON.MultiPolygon, bbox?: [number,number,number,number], boundaryUrl: string }>}
 */
export async function resolveGeometry(result, boundaryUrl, expectedCatalogVersion, fetchImpl, onVersionSkew, onWarning, options = {}) {
  const { hyparquet, compressors } = await loadHyparquet();
  const handle = await openBoundaryIndex(boundaryUrl, fetchImpl, options.signal);

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
  const byId = pool.filter((i) => {
    const g = handle.groups[i];
    return g.idMin <= result.featureId && result.featureId <= g.idMax;
  });
  const candidateGroupIndices = byId.length > 0 ? byId : pool;

  for (const gi of candidateGroupIndices) {
    const g = handle.groups[gi];
    // Pass 1: locate the exact row within this group using the
    // *string* columns only (feature_id, bbox) -- hyparquet's default
    // `utf8: true` conversion is correct and cheap for these.
    const rows = await hyparquet.parquetReadObjects({
      file: handle.file,
      metadata: handle.metadata,
      columns: ['feature_id', 'bbox'],
      rowStart: g.rowStart,
      rowEnd: g.rowEnd,
      compressors,
    });
    const localIndex = rows.findIndex((r) => r.feature_id === result.featureId);
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

  throw new CnmwError(`Feature "${result.featureId}" not found in boundary file.`, 'GEOMETRY_NOT_FOUND', {
    context: { featureId: result.featureId, boundaryUrl },
  });
}
