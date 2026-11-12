// @cnmw/download-core -- `resolveDataset()`: collection JSON -> concrete
// descriptor (design doc §2.4's fixed, documented mapping).
//
// Only `portolan-collection` sources need resolving; every other source
// kind is already concrete and is returned unchanged (design doc: "a
// consumer that lacks one refuses... resolveDataset returns a fully-concrete
// descriptor... with no portolan-collection source left in it").

import { CnmwError } from '@cnmw/spec';

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
    throw new CnmwError(`Couldn't fetch collection JSON: ${descriptor.source.url}`, 'DATASET_UNRESOLVED', { cause });
  }
  if (!res.ok) {
    throw new CnmwError(`Collection fetch failed: HTTP ${res.status}`, 'DATASET_UNRESOLVED', {
      context: { status: res.status, url: descriptor.source.url },
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  let collection;
  try {
    collection = await res.json();
  } catch (cause) {
    throw new CnmwError('Collection JSON did not parse.', 'DATASET_UNRESOLVED', { cause });
  }
  return deriveFromCollection(collection, descriptor);
}

/** @param {any} collection @param {import('./types.js').DatasetDescriptor} descriptor */
function deriveFromCollection(collection, descriptor) {
  const assets = Object.entries(collection.assets ?? {}).map(([key, a]) => ({ key, ...a }));
  const columns = collection['table:columns'];
  const source = deriveSource(collection, assets, descriptor.source, columns);
  const table = deriveTable(collection, columns);
  const attribution = deriveAttribution(collection);

  return {
    spec: 'cnmw-dataset/1.0',
    id: descriptor.id,
    title: descriptor.title ?? collection.title ?? collection.id,
    source,
    ...(table ? { table } : {}),
    attribution: attribution.length ? attribution : descriptor.attribution,
    extra: descriptor.extra,
  };
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
    dataAssets[0];

  if (!parquetAsset) {
    const foundTypes = [...new Set(assets.map((a) => a.type).filter(Boolean))];
    throw new CnmwError(
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
