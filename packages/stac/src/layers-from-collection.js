// @cngeo/stac -- a STAC collection as LayerSpecs.
//
// `layersFromCollection()` answers one question from the collection document
// alone: "how would a map show this?" It is synchronous and fetches nothing,
// so a catalog search can run it over thousands of collections, and a layer
// manager can run it the moment a collection JSON arrives.
//
// It never refuses a collection. One it cannot draw comes back as a single
// `table` or `unsupported` spec that says why -- so a UI can show "no map
// layer: Zarr" instead of nothing (the same "unsupported is an absence, not
// an error" stance as extract-core's collectionDownloadSupport). And because
// it is run over other people's documents in bulk, every member it reads is
// treated as possibly the wrong shape: a `links` that is an object, a null in
// `table:columns`, a `roles` that is a string.
//
// It throws for exactly two things, both the CALLER's: something that is not
// a collection, and a missing `baseUrl`.
//
// The collection -> DatasetDescriptor derivation (for downloads) stays in
// @cngeo/extract-core; this is its sibling for display.

import { CngError, LAYER_SPEC, validateLayerSpec } from '@cngeo/spec';
import { attributionFromCollection } from '@cngeo/extract-core';

const PMTILES_TYPE = 'application/vnd.pmtiles';
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === 'string' ? v : '');

// Classification reads the href AS PUBLISHED (`raw`), so an asset that is not
// reachable over http(s) is still recognised for what it is.
const isPmtiles = (a) => a.type === PMTILES_TYPE || /\.pmtiles$/i.test(a.raw);
const isParquet = (a) => /parquet/i.test(text(a.type)) || /\.(parquet|pq)$/i.test(a.raw);
const isCog = (a) => /profile=cloud-optimized/i.test(text(a?.type));
// `roles` must be an array: 'metadata'.includes('data') is true.
const hasRole = (a, role) => Array.isArray(a?.roles) && a.roles.includes(role);

function invalid(message, field) {
  return new CngError(message, 'LAYER_INVALID', { retryable: false, context: { field } });
}

/** An absolute http(s) URL, or `undefined` for anything a browser cannot fetch (`s3://`, `gs://`, junk). */
function httpUrl(href, baseUrl) {
  if (typeof href !== 'string' || !href) return undefined;
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
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

/**
 * Licence and licensor, with both key styles in agreement (as geocoder-core
 * normalises attribution), and a `url` only when it is http(s): it becomes a
 * link in someone's UI.
 */
function attributionOf(collection, links, baseUrl) {
  let derived = [];
  try {
    derived = attributionFromCollection({ ...collection, links, providers: asArray(collection.providers).filter(isObject) });
  } catch {
    /* an odd licence or provider shape: no attribution is better than no layer */
  }
  return asArray(derived).filter(isObject).map((a) => {
    const shareAlike = Boolean(a.shareAlike ?? a.share_alike);
    const { url: _url, ...rest } = a;
    const url = httpUrl(a.url, baseUrl);
    return { ...rest, ...(url ? { url } : {}), shareAlike, share_alike: shareAlike };
  });
}

/** Which asset key should a scene be drawn from? */
function displayAssetOf(itemAssets) {
  const entries = Object.entries(isObject(itemAssets) ? itemAssets : {}).filter(([, a]) => isObject(a));
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
  const named = columns.find((c) => c.name === 'stac_version' && typeof c.asset === 'string')?.asset;
  const byName = named && candidates.find((a) => a.key === named);
  if (byName) return byName;
  const titled = candidates.filter((a) => /stac|items/i.test(`${a.key} ${text(a.title)}`));
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
 * Only assets reachable over http(s) count: a collection whose tiles are at
 * `s3://…` is `unsupported`, and says so.
 *
 * @param {Record<string, any>} collection A STAC Collection.
 * @param {{ baseUrl: string }} options `baseUrl` is the collection document's own absolute URL. Required:
 *   Portolan collections use relative hrefs, and a layer must be self-contained.
 * @returns {import('@cngeo/spec').LayerSpec[]}
 */
export function layersFromCollection(collection, options = {}) {
  if (!isObject(collection) || typeof collection.id !== 'string' || !collection.id) {
    throw invalid('layersFromCollection needs a STAC collection object with an id', 'collection');
  }
  const baseUrl = httpUrl(options?.baseUrl);
  if (!baseUrl) {
    throw invalid("layersFromCollection needs { baseUrl }: the collection document's own absolute http(s) URL", 'baseUrl');
  }

  /** hrefs that exist but cannot be fetched by a browser, for the `unsupported` reason. */
  const unreachable = [];
  const reach = (href) => {
    const url = httpUrl(href, baseUrl);
    if (!url && typeof href === 'string' && href) unreachable.push(href);
    return url;
  };

  const assets = Object.entries(isObject(collection.assets) ? collection.assets : {})
    .filter(([, a]) => isObject(a))
    .map(([key, a]) => ({ key, ...a, raw: text(a.href), href: reach(a.href) }));
  const links = asArray(collection.links).filter(isObject);
  const columns = (Array.isArray(collection['table:columns'])
    ? collection['table:columns']
    : asArray(assets.find((a) => Array.isArray(a['table:columns']))?.['table:columns'])
  ).filter(isObject);
  const hasColumns = columns.length > 0;
  const columnNames = new Set(columns.map((c) => c.name));
  const title = text(collection.title) || collection.id;

  const common = {
    spec: LAYER_SPEC,
    attribution: attributionOf(collection, links, baseUrl),
    ...(bboxOf(collection) ? { bbox: bboxOf(collection) } : {}),
    ...(temporalOf(collection) ? { temporal: temporalOf(collection) } : {}),
  };
  // Resolved without `reach()`: an unfetchable thumbnail is not why a layer cannot be drawn.
  const thumbnail = httpUrl(assets.find((a) => hasRole(a, 'thumbnail'))?.raw, baseUrl);
  if (thumbnail) common.thumbnail = thumbnail;

  /** @type {import('@cngeo/spec').LayerSpec[]} */
  const out = [];
  // The first layer IS the collection (its id and title); any further one is
  // a named part of it.
  const push = (key, { title: partTitle, ...partial }) => {
    out.push({
      ...common,
      id: out.length === 0 ? collection.id : `${collection.id}:${key}`,
      title: out.length === 0 ? title : text(partTitle) || `${title} — ${key}`,
      ...partial,
    });
  };

  // --- 1. Vector tiles ------------------------------------------------------
  const pmtilesLink = links.find((l) => l.rel === 'pmtiles');
  const pmtilesAsset = assets.find(isPmtiles);
  const pmtilesUrl = (pmtilesLink ? reach(pmtilesLink.href) : undefined) ?? pmtilesAsset?.href;
  if (pmtilesUrl) {
    const styles = assets.filter((a) => hasRole(a, 'style') && a.href);
    const style = styles.find((a) => hasRole(a, 'default')) ?? (styles.length === 1 ? styles[0] : undefined);
    const linked = pmtilesLink?.['pmtiles:layers'];
    const tileLayers = Array.isArray(linked) ? linked : asArray(collection['pmtiles:layers']);
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
        items: itemsAsset ? { kind: 'parquet', url: itemsAsset.href } : { kind: 'partitioned' },
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
  const assetTypes = [...new Set(assets.map((a) => a.type).filter((t) => typeof t === 'string' && t))];
  const unsupported = (key, reason) => {
    push(key, { kind: 'unsupported', source: { reason, assetTypes } });
    return out.map(validateLayerSpec);
  };

  const dataParquet = assets.find((a) => a.href && isParquet(a) && hasRole(a, 'data')) ?? assets.find((a) => a.href && isParquet(a) && !Array.isArray(a.roles));
  if (dataParquet) {
    const primary = text(collection['table:primary_geometry']) || 'geometry';
    const spatial = columns.some((c) => /geometry|geography/i.test(text(c.type)) || (c.name === primary && /binary|wkb/i.test(text(c.type))));
    if (hasColumns && !spatial) {
      push(dataParquet.key, { kind: 'table', source: { url: dataParquet.href } });
      return out.map(validateLayerSpec);
    }
    return unsupported(
      dataParquet.key,
      hasColumns
        ? 'Spatial GeoParquet with no vector tiles to draw it from.'
        : 'Parquet data with no vector tiles, and no declared columns to tell whether it is spatial.',
    );
  }

  // Something drawable is published, but not where a browser can fetch it.
  const blocked = assets.filter((a) => !a.href && a.raw && (isPmtiles(a) || isCog(a) || isParquet(a))).map((a) => a.raw);
  const blockedLink = pmtilesLink && !httpUrl(pmtilesLink.href, baseUrl) && text(pmtilesLink.href) ? [pmtilesLink.href] : [];
  const notReachable = [...new Set([...blockedLink, ...blocked])];
  if (notReachable.length) {
    return unsupported('none', `Its data is not reachable over http(s): ${notReachable.slice(0, 3).join(', ')}${notReachable.length > 3 ? ', …' : ''}.`);
  }

  const zarr = assetTypes.some((t) => /zarr/i.test(t)) || assets.some((a) => /\.zarr\/?$/i.test(a.raw));
  const itemCogs = Object.values(isObject(collection.item_assets) ? collection.item_assets : {}).some(isCog);
  return unsupported(
    'none',
    zarr
      ? 'Zarr data: not drawable here yet.'
      : itemCogs
        ? 'Imagery items with no GeoParquet item table to search.'
        : `No drawable asset found${assetTypes.length ? ` (found: ${assetTypes.join(', ')})` : ''}.`,
  );
}
