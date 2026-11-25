// @cngeo/stac -- a STAC collection as LayerSpecs.
//
// `layersFromCollection()` answers one question from the collection document
// alone: "how would a map show this?" It is synchronous and fetches nothing,
// so a catalog search can run it over thousands of collections, and a layer
// manager can run it the moment a collection JSON arrives.
//
// It never refuses a real collection. One it cannot draw comes back as a
// single `table` or `unsupported` spec that says why -- so a UI can show
// "no map layer: Zarr" instead of nothing (the same "unsupported is an
// absence, not an error" stance as extract-core's collectionDownloadSupport).
//
// The collection -> DatasetDescriptor derivation (for downloads) stays in
// @cngeo/extract-core; this is its sibling for display.

import { CngError, LAYER_SPEC, validateLayerSpec } from '@cngeo/spec';
import { attributionFromCollection } from '@cngeo/extract-core';

const PMTILES_TYPE = 'application/vnd.pmtiles';
const isPmtiles = (a) => a.type === PMTILES_TYPE || /\.pmtiles$/i.test(a.href ?? '');
const isParquet = (a) => /parquet/i.test(a.type ?? '') || /\.(parquet|pq)$/i.test(a.href ?? '');
const isCog = (a) => /profile=cloud-optimized/i.test(a.type ?? '');
const hasRole = (a, role) => (a.roles ?? []).includes(role);

function absolutize(href, baseUrl) {
  if (typeof href !== 'string' || !href) return undefined;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

/** `[w, s, e, n]` from the collection's first spatial extent, when it is a usable box. */
function bboxOf(collection) {
  const b = collection.extent?.spatial?.bbox?.[0];
  if (!Array.isArray(b)) return undefined;
  // A 3D bbox is [w, s, minz, e, n, maxz].
  const box = b.length === 6 ? [b[0], b[1], b[3], b[4]] : b;
  if (box.length !== 4 || !box.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  // An antimeridian-crossing extent (w > e) has no single-box form here; leave it off.
  if (box[0] > box[2] || box[1] > box[3]) return undefined;
  return box;
}

function temporalOf(collection) {
  const t = collection.extent?.temporal?.interval?.[0];
  if (!Array.isArray(t) || t.length !== 2) return undefined;
  const clean = t.map((v) => (typeof v === 'string' ? v : null));
  return clean[0] === null && clean[1] === null ? undefined : clean;
}

/** Both key styles, in agreement -- as geocoder-core normalises attribution. */
function attributionOf(collection) {
  return attributionFromCollection(collection).map((a) => {
    const shareAlike = Boolean(a.shareAlike ?? a.share_alike);
    return { ...a, shareAlike, share_alike: shareAlike };
  });
}

/** The columns a collection declares, wherever it declares them. */
function columnsOf(collection, assets) {
  if (Array.isArray(collection['table:columns'])) return collection['table:columns'];
  return assets.find((a) => Array.isArray(a['table:columns']))?.['table:columns'] ?? null;
}

/** Which asset key should a scene be drawn from? */
function displayAssetOf(itemAssets) {
  const entries = Object.entries(itemAssets ?? {});
  if (!entries.length) return undefined;
  const byRole = entries.find(([, a]) => hasRole(a, 'visual'));
  if (byRole) return byRole[0];
  // OpenAerialMap's picture asset is keyed `visual` but carries role `data` only.
  const byKey = entries.find(([key]) => key === 'visual' || key === 'image');
  if (byKey) return byKey[0];
  return entries.find(([, a]) => isCog(a))?.[0];
}

/** Of several parquet assets, which is the item table? */
function pickItemsAsset(candidates, columns) {
  if (candidates.length <= 1) return candidates[0];
  const mirror = candidates.find((a) => hasRole(a, 'collection-mirror'));
  if (mirror) return mirror;
  // A collection-level table:columns may name the asset each column belongs
  // to (NAIP does); the STAC columns then point straight at the item table.
  const named = (columns ?? []).find((c) => c.name === 'stac_version' && typeof c.asset === 'string')?.asset;
  const byName = named && candidates.find((a) => a.key === named);
  if (byName) return byName;
  const titled = candidates.filter((a) => /stac|items/i.test(`${a.key} ${a.title ?? ''}`));
  const pool = titled.length ? titled : candidates;
  return [...pool].sort((a, b) => Number(b['file:size'] ?? 0) - Number(a['file:size'] ?? 0))[0];
}

/**
 * How a map would show a STAC collection, as zero-fetch LayerSpecs.
 *
 * Rules, in this order; a collection can yield more than one layer:
 *   1. pmtiles-vector -- a `rel:"pmtiles"` link, else a PMTiles asset; with
 *                        the `style`+`default` asset (or the only style).
 *   2. scenes         -- an imagery item table: a `collection-mirror` asset,
 *                        or STAC item columns over hive partitions or a
 *                        `data` parquet asset.
 *   3. cog            -- each collection-level Cloud-Optimized GeoTIFF.
 *   4. table          -- parquet with no geometry column: described, not drawn.
 *   5. unsupported    -- anything else, with the reason and the types found.
 *
 * @param {Record<string, any>} collection A STAC Collection.
 * @param {{ baseUrl: string }} options `baseUrl` is the collection document's own URL.
 * @returns {import('@cngeo/spec').LayerSpec[]}
 */
export function layersFromCollection(collection, options = {}) {
  if (!collection || typeof collection !== 'object' || typeof collection.id !== 'string' || !collection.id) {
    throw new CngError('layersFromCollection needs a STAC collection object with an id', 'LAYER_INVALID', {
      retryable: false,
      context: { field: 'collection' },
    });
  }
  const { baseUrl } = options;
  const assets = Object.entries(collection.assets ?? {}).map(([key, a]) => ({ key, ...a, href: absolutize(a?.href, baseUrl) }));
  const links = collection.links ?? [];
  const columns = columnsOf(collection, assets);
  const columnNames = new Set((columns ?? []).map((c) => c.name));
  const title = collection.title ?? collection.id;

  const common = {
    spec: LAYER_SPEC,
    attribution: attributionOf(collection),
    ...(bboxOf(collection) ? { bbox: bboxOf(collection) } : {}),
    ...(temporalOf(collection) ? { temporal: temporalOf(collection) } : {}),
  };
  const thumbnail = assets.find((a) => hasRole(a, 'thumbnail'))?.href;
  if (thumbnail) common.thumbnail = thumbnail;

  /** @type {import('@cngeo/spec').LayerSpec[]} */
  const out = [];
  // The first layer IS the collection (its id and title); any further one is
  // a named part of it.
  const push = (key, { title: partTitle, ...partial }) => {
    out.push({
      ...common,
      id: out.length === 0 ? collection.id : `${collection.id}:${key}`,
      title: out.length === 0 ? title : partTitle ?? `${title} — ${key}`,
      ...partial,
    });
  };

  // --- 1. Vector tiles ------------------------------------------------------
  const pmtilesLink = links.find((l) => l.rel === 'pmtiles');
  const pmtilesAsset = assets.find(isPmtiles);
  const pmtilesUrl = absolutize(pmtilesLink?.href, baseUrl) ?? pmtilesAsset?.href;
  if (pmtilesUrl) {
    const styles = assets.filter((a) => hasRole(a, 'style') && a.href);
    const style = styles.find((a) => hasRole(a, 'default')) ?? (styles.length === 1 ? styles[0] : undefined);
    const tileLayers = pmtilesLink?.['pmtiles:layers'] ?? collection['pmtiles:layers'] ?? [];
    push(pmtilesAsset?.key ?? 'pmtiles', {
      kind: 'pmtiles-vector',
      source: {
        url: pmtilesUrl,
        layers: tileLayers.filter((l) => typeof l === 'string'),
        ...(style ? { style: { url: style.href } } : {}),
      },
    });
  }

  // --- 2. Imagery scenes ----------------------------------------------------
  const stacColumns = columnNames.has('stac_version') && columnNames.has('assets');
  const mirror = assets.find((a) => hasRole(a, 'collection-mirror') && a.href);
  const partitioned = Boolean(collection['partition:scheme']) && stacColumns;
  const itemTables = assets.filter((a) => a.href && isParquet(a) && (hasRole(a, 'collection-mirror') || (stacColumns && hasRole(a, 'data'))));
  const itemsAsset = mirror ?? pickItemsAsset(itemTables, columns);
  if (partitioned || itemsAsset) {
    const displayAsset = displayAssetOf(collection.item_assets);
    push(itemsAsset?.key ?? 'items', {
      kind: 'scenes',
      source: {
        collectionUrl: baseUrl,
        items: partitioned && !mirror ? { kind: 'partitioned' } : { kind: 'parquet', url: itemsAsset.href },
        ...(displayAsset ? { displayAsset } : {}),
      },
    });
  }

  // --- 3. Collection-level COGs ---------------------------------------------
  for (const asset of assets.filter((a) => a.href && isCog(a))) {
    push(asset.key, { kind: 'cog', source: { url: asset.href }, title: asset.title });
  }

  if (out.length) return out.map(validateLayerSpec);

  // --- 4 and 5. Nothing to draw: say what this is ------------------------------
  const assetTypes = [...new Set(assets.map((a) => a.type).filter(Boolean))];
  const dataParquet = assets.find((a) => a.href && isParquet(a) && hasRole(a, 'data')) ?? assets.find((a) => a.href && isParquet(a));
  if (dataParquet) {
    const primary = collection['table:primary_geometry'] ?? 'geometry';
    const spatial = (columns ?? []).some((c) => /geometry|geography/i.test(c.type ?? '') || (c.name === primary && /binary|wkb/i.test(c.type ?? '')));
    if (columns && !spatial) {
      push(dataParquet.key, { kind: 'table', source: { url: dataParquet.href } });
      return out.map(validateLayerSpec);
    }
    push(dataParquet.key, {
      kind: 'unsupported',
      source: {
        reason: columns
          ? 'Spatial GeoParquet with no vector tiles to draw it from.'
          : 'Parquet data with no vector tiles, and no declared columns to tell whether it is spatial.',
        assetTypes,
      },
    });
    return out.map(validateLayerSpec);
  }

  const zarr = assetTypes.some((t) => /zarr/i.test(t)) || assets.some((a) => /\.zarr\/?$/i.test(a.href ?? ''));
  const itemCogs = Object.values(collection.item_assets ?? {}).some(isCog);
  push('none', {
    kind: 'unsupported',
    source: {
      reason: zarr
        ? 'Zarr data: not drawable here yet.'
        : itemCogs
          ? 'Imagery items with no GeoParquet item table to search.'
          : `No drawable asset found${assetTypes.length ? ` (found: ${assetTypes.join(', ')})` : ''}.`,
      assetTypes,
    },
  });
  return out.map(validateLayerSpec);
}
