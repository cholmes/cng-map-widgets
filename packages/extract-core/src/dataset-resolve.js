// @cngeo/extract-core -- `resolveDataset()`: collection JSON -> concrete
// descriptor (design doc §2.4's fixed, documented mapping).
//
// Only `portolan-collection` sources need resolving; every other source
// kind is already concrete and is returned unchanged (design doc: "a
// consumer that lacks one refuses... resolveDataset returns a fully-concrete
// descriptor... with no portolan-collection source left in it").

import { CngError } from '@cngeo/spec';

const RASTER_ZARR_TYPES = /tiff|cog|cloud-optimized|zarr|hdf5|netcdf|pmtiles|mbtiles/i;

/**
 * @param {import('./types.js').DatasetDescriptor} descriptor
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<import('./types.js').DatasetDescriptor>}
 */
export async function resolveDataset(descriptor, options = {}) {
  if (descriptor.source.kind !== 'portolan-collection') return descriptor;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  let res;
  try {
    res = await fetchImpl(descriptor.source.url, { signal: options.signal });
  } catch (cause) {
    throw new CngError(`Couldn't fetch collection JSON: ${descriptor.source.url}`, 'DATASET_UNRESOLVED', { cause });
  }
  if (!res.ok) {
    throw new CngError(`Collection fetch failed: HTTP ${res.status}`, 'DATASET_UNRESOLVED', {
      context: { status: res.status, url: descriptor.source.url },
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  let collection;
  try {
    collection = await res.json();
  } catch (cause) {
    throw new CngError('Collection JSON did not parse.', 'DATASET_UNRESOLVED', { cause });
  }
  return deriveFromCollection(collection, descriptor, descriptor.source.url);
}

/**
 * The §2.4 derivation on a collection JSON a host *already has in memory*.
 *
 * Added by E7: `portolan-browser` holds the collection as a parsed object in
 * its Vuex store and must decide synchronously, inside a widget `condition`,
 * whether a download is even possible. Re-fetching the collection through
 * `resolveDataset()` just to learn that would be a second request for data
 * already on the page, and a `condition` cannot await. The design doc put
 * this derivation in a notional `@cngeo/stac` package; it has always lived
 * here, in the package that owns §2.4, so this exports it rather than
 * duplicating the mapping in host glue (the thing §5.4 says keeps a
 * stac-browser widget a small diff).
 *
 * @param {any} collection the collection JSON (a plain object; a stac-js
 *   `Collection` works too -- only indexed property access is used).
 * @param {{ id?: string, title?: string, baseUrl?: string, attribution?: any[], extra?: any }} [options]
 *   `baseUrl` is the collection's own URL; relative asset hrefs
 *   (`./cgaz_adm0.parquet`, the Portolan norm) are resolved against it.
 * @returns {import('./types.js').DatasetDescriptor}
 */
export function descriptorFromCollection(collection, options = {}) {
  const descriptor = {
    id: options.id ?? collection.id,
    title: options.title,
    source: { kind: 'portolan-collection', url: options.baseUrl },
    attribution: options.attribution,
    extra: options.extra,
  };
  return deriveFromCollection(collection, descriptor, options.baseUrl);
}

/**
 * Can this collection be downloaded at all? The non-throwing form of
 * `descriptorFromCollection`, for a UI that renders "unsupported" as the
 * absence of the widget rather than as an error (design call #8).
 * @param {any} collection
 * @param {{ baseUrl?: string }} [options]
 * @returns {{ supported: boolean, code?: string, message?: string, descriptor?: import('./types.js').DatasetDescriptor }}
 */
export function collectionDownloadSupport(collection, options = {}) {
  if (!collection || typeof collection !== 'object') {
    return { supported: false, code: 'DATASET_UNSUPPORTED', message: 'Not a collection.' };
  }
  try {
    const descriptor = descriptorFromCollection(collection, options);
    return { supported: true, descriptor };
  } catch (err) {
    return { supported: false, code: err?.code ?? 'DATASET_UNSUPPORTED', message: err?.message ?? String(err) };
  }
}

/**
 * @param {any} collection
 * @param {import('./types.js').DatasetDescriptor} descriptor
 * @param {string|undefined} baseUrl
 */
function deriveFromCollection(collection, descriptor, baseUrl) {
  const assets = Object.entries(collection.assets ?? {}).map(([key, a]) => ({
    key,
    ...a,
    href: absolutize(a?.href, baseUrl),
  }));
  const columns = collection['table:columns'];
  const source = deriveSource(collection, assets, descriptor.source, columns);
  const table = deriveTable(collection, columns);
  const attribution = deriveAttribution(collection);

  return {
    spec: 'cng-dataset/1.0',
    id: descriptor.id,
    title: descriptor.title ?? collection.title ?? collection.id,
    source,
    ...(table ? { table } : {}),
    attribution: attribution.length ? attribution : descriptor.attribution,
    extra: descriptor.extra,
  };
}

/**
 * Portolan collections carry relative asset hrefs (`./cgaz_adm0.parquet`).
 * A descriptor must be self-contained -- it gets embedded in a shareable
 * `DownloadRequest` (§2.4) -- so every href is absolutized here, against the
 * collection's own URL. No base and a relative href means we cannot know
 * what it points at; the href is left as-is so the failure surfaces as a
 * fetch error naming the href rather than as a silently wrong URL.
 * @param {string|undefined} href @param {string|undefined} baseUrl
 */
function absolutize(href, baseUrl) {
  if (typeof href !== 'string' || !href || !baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function deriveSource(collection, assets, originalSource, columns) {
  const hasPartition = collection['partition:scheme'] === 'hive';

  if (hasPartition) {
    const glob = collection['partition:glob'];
    const keys = (collection['partition:keys'] ?? []).map((k) => ({
      name: k.name,
      type: k.type,
      description: k.description,
      values: k.values,
    }));
    const mirror = assets.find((a) => (a.roles ?? []).includes('collection-mirror'));
    const enumeration = mirror
      ? { kind: 'collection-mirror', url: mirror.href }
      : { kind: 'stac-items', collectionUrl: originalSource.url ?? '' };

    if (looksLikeStac(columns)) {
      return { kind: 'stac-geoparquet', glob, keys, enumeration };
    }
    return {
      kind: 'hive',
      scheme: 'hive',
      glob,
      keys,
      strategy: collection['partition:strategy'],
      fileCount: collection['partition:file_count'],
      enumeration,
    };
  }

  const dataAssets = assets.filter((a) => (a.roles ?? []).includes('data'));
  const parquetAsset =
    dataAssets.find((a) => a.type === 'application/vnd.apache.parquet') ??
    dataAssets.find((a) => /parquet/i.test(a.type ?? '')) ??
    // Last resort: an asset with role `data` and no declared media type at
    // all. A *declared* non-parquet type is never accepted here -- E7 found
    // that the old unconditional `dataAssets[0]` fallback handed a `.tif` or
    // `.pmtiles` href back as `{ kind: 'parquet' }`, which turned design
    // call #8's graceful "unsupported" refusal into a parquet parse error
    // several seconds later. A Portolan raster/zarr collection routinely
    // carries role `data` on its COG/zarr/pmtiles assets.
    dataAssets.find((a) => !a.type && /\.(parquet|pq)$/i.test(a.href ?? ''));

  if (!parquetAsset) {
    const foundTypes = [...new Set(assets.map((a) => a.type).filter(Boolean))];
    throw new CngError(
      foundTypes.some((t) => RASTER_ZARR_TYPES.test(t))
        ? `Downloads aren't supported for raster/zarr data. Found: ${foundTypes.join(', ')}`
        : `No parquet data asset found in collection. Found: ${foundTypes.join(', ') || '(no assets)'}`,
      'DATASET_UNSUPPORTED',
      { context: { assetTypes: foundTypes } },
    );
  }
  return { kind: 'parquet', url: parquetAsset.href };
}

/** `stac-geoparquet` sugar: STAC Item columns present (design doc §2.4). */
function looksLikeStac(columns) {
  if (!columns) return false;
  const names = new Set(columns.map((c) => c.name));
  return names.has('stac_version') && names.has('assets');
}

function deriveTable(collection, columns) {
  const geoparquetMeta = collection['geoparquet:metadata'] ?? collection.geoparquet;
  const geometryColumn = collection['table:primary_geometry'] ?? geoparquetMeta?.primary_column ?? 'geometry';
  const bbox = deriveCovering(geoparquetMeta, columns, geometryColumn);
  const timeColumn = deriveTimeColumn(columns);
  const crs = geoparquetMeta?.columns?.[geometryColumn]?.crs ? 'OGC:CRS84' : undefined;

  const hasAnything = columns || collection['table:row_count'] !== undefined || bbox.kind !== 'none';
  if (!hasAnything) return undefined;

  return {
    geometryColumn,
    geometryEncoding: 'WKB',
    crs: crs ?? 'OGC:CRS84',
    bbox,
    timeColumn,
    rowCount: collection['table:row_count'],
    columns,
  };
}

function deriveCovering(geoparquetMeta, columns, geometryColumn) {
  const covering = geoparquetMeta?.columns?.[geometryColumn]?.covering?.bbox;
  if (covering?.xmin) {
    // GeoParquet 1.1 covering: each value is a column path array, e.g.
    // ["bbox","xmin"] (struct) or ["bbox_xmin"] (flat top-level column).
    if (covering.xmin.length > 1) {
      return { kind: 'struct', column: covering.xmin[0], fields: { xmin: covering.xmin[1], ymin: covering.ymin[1], xmax: covering.xmax[1], ymax: covering.ymax[1] } };
    }
    return { kind: 'columns', xmin: covering.xmin[0], ymin: covering.ymin[0], xmax: covering.xmax[0], ymax: covering.ymax[0] };
  }
  const bboxCol = columns?.find((c) => c.name === 'bbox' && /struct/i.test(c.type ?? ''));
  if (bboxCol) return { kind: 'struct', column: 'bbox' };
  return { kind: 'none' };
}

function deriveTimeColumn(columns) {
  if (!columns) return undefined;
  if (columns.some((c) => c.name === 'datetime')) return 'datetime';
  const timeLike = columns.find((c) => /timestamp|date/i.test(c.type ?? ''));
  return timeLike?.name;
}

/**
 * A collection's licence and licensor as `Attribution[]` -- the same
 * derivation `descriptorFromCollection` uses, exported so `@cngeo/stac`'s
 * `layersFromCollection` credits a layer exactly as a download of it would.
 * @param {Record<string, any>} collection
 */
export function attributionFromCollection(collection) {
  return deriveAttribution(collection);
}

function deriveAttribution(collection) {
  const license = collection.license;
  const providers = collection.providers ?? [];
  const licensor = providers.find((p) => (p.roles ?? []).includes('licensor')) ?? providers.find((p) => (p.roles ?? []).includes('producer'));
  if (!license && !licensor) return [];
  const text = licensor?.name ?? collection.title ?? collection.id ?? 'Dataset';
  return [
    {
      text,
      license: license ?? 'unknown',
      url: licensor?.url ?? collection.links?.find((l) => l.rel === 'license')?.href,
      shareAlike: /odbl|-sa(-|$)/i.test(license ?? ''),
    },
  ];
}
