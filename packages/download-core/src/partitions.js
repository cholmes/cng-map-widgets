// @cnmw/download-core -- partition enumeration + the partition-level
// pruning cascade (design doc §2.1 PartitionEnumeration, §2.7 step 1-2,
// O9).
//
// Enumeration ('how the browser learns the actual partition values, since
// it cannot list an object-storage prefix over HTTP') is implemented for
// 'declared', 'values', 'collection-mirror' and a bounded 'stac-items'
// (O9's "bounded concurrency of 8, hard cap of 200 item fetches"). Not
// exercised against a live catalog in this experiment's tests/demo (the
// demo's datasets are single-file `parquet` sources); covered instead by a
// synthetic-listing unit test.

import { CnmwError, bboxesIntersect } from '@cnmw/spec';
import { loadHyparquet } from './cdn.js';

const STAC_ITEM_CONCURRENCY = 8;
const STAC_ITEM_CAP = 200;

// Substitute `*` segments of a hive glob with concrete partition values,
// in `keys` order. The glob already spells out the literal `key=` prefix
// itself (a 'year=' directory holding a fixed 'data.parquet' file, per
// design doc section 2.7's worked example), so only the value is
// substituted -- not `key=value` again. Only usable when the glob has
// exactly one `*` per declared key and no other wildcard (a fixed
// filename per partition); a glob with an extra wildcard for the
// filename itself (the real FIRMS glob has a second one, for the file
// name within each year directory) cannot be resolved this way and needs
// a 'collection-mirror'/'stac-items' enumeration instead, which supplies
// the concrete file URL per part.
// @param {string} glob @param {import('./types.js').PartitionKey[]} keys @param {(string|number)[]} values
function fillGlob(glob, keys, values) {
  let i = 0;
  return glob.replace(/\*/g, () => {
    const value = values[i];
    i += 1;
    return String(value);
  });
}

function cartesian(arrays) {
  return arrays.reduce((acc, arr) => acc.flatMap((combo) => arr.map((v) => [...combo, v])), [[]]);
}

/**
 * @param {import('./types.js').HivePartitionedSource|import('./types.js').StacGeoparquetSource} source
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<{ parts: import('./types.js').DatasetPart[], requests: number }>}
 */
export async function enumeratePartitions(source, options = {}) {
  if (source.parts && source.parts.length > 0) return { parts: source.parts, requests: 0 };

  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const glob = source.glob;
  const keys = source.keys ?? [];
  const enumeration = source.enumeration;

  if (!enumeration || enumeration.kind === 'declared') {
    const valueLists = keys.map((k) => {
      if (!k.values) {
        throw new CnmwError(
          `Partition key "${k.name}" has no declared values and no other enumeration was given.`,
          'DATASET_UNRESOLVED',
          { context: { key: k.name } },
        );
      }
      return k.values;
    });
    const combos = keys.length ? cartesian(valueLists) : [[]];
    const parts = combos.map((values) => ({
      url: fillGlob(glob, keys, values),
      keys: Object.fromEntries(keys.map((k, i) => [k.name, values[i]])),
    }));
    return { parts, requests: 0 };
  }

  if (enumeration.kind === 'values') {
    const res = await fetchImpl(enumeration.url, { signal: options.signal });
    if (!res.ok) throw new CnmwError(`Partition values fetch failed: HTTP ${res.status}`, 'DATASET_UNRESOLVED', { context: { status: res.status } });
    const tuples = await res.json();
    const parts = tuples.map((tuple) => {
      const values = Array.isArray(tuple) ? tuple : keys.map((k) => tuple[k.name]);
      return { url: fillGlob(glob, keys, values), keys: Object.fromEntries(keys.map((k, i) => [k.name, values[i]])) };
    });
    return { parts, requests: 1 };
  }

  if (enumeration.kind === 'collection-mirror') {
    const { hyparquet, compressors } = await loadHyparquet();
    const file = await hyparquet.asyncBufferFromUrl({ url: enumeration.url, fetch: fetchImpl, requestInit: { cache: 'no-store', signal: options.signal } });
    // `geoparquet: false` for the same reason as parquet-io.js's
    // openParquetFile: a collection-mirror is itself a STAC-GeoParquet
    // file and may carry a `geo`-tagged footprint geometry column.
    // `partFromMirrorRow` doesn't currently read that column, but a
    // stray auto-decode shouldn't silently change what `parquetReadObjects`
    // hands back here either.
    const metadata = await hyparquet.parquetMetadataAsync(file, { geoparquet: false });
    // `utf8: false` alongside `geoparquet: false` -- see parquet-io.js's
    // readRows() for why both are needed together.
    const rows = await hyparquet.parquetReadObjects({ file, metadata, compressors, utf8: false });
    const parts = rows.map((row) => partFromMirrorRow(row, keys, enumeration.url));
    return { parts, requests: 1 };
  }

  if (enumeration.kind === 'stac-items') {
    return enumerateStacItems(enumeration.collectionUrl, keys, fetchImpl, options.signal);
  }

  if (enumeration.kind === 'bucket-listing') {
    return enumerateBucketListing(enumeration.endpoint, enumeration.prefix, fetchImpl, options.signal);
  }

  throw new CnmwError(`Unsupported partition enumeration kind: ${enumeration.kind}`, 'DATASET_UNRESOLVED');
}

/**
 * The path forms an absolute URI could be compared by, most specific first.
 *
 * Two forms, because the same file's `s3://` and `https://` spellings put
 * the bucket in different places: source.coop serves `s3://ftw/x/y.parquet`
 * at `https://data.source.coop/ftw/x/y.parquet`, so the s3 URI's *host* is
 * the http URL's first path segment. Comparing "host included" catches
 * that pairing; "host dropped" catches an alternate on the same host under
 * a different domain. Pure.
 * @param {string} uri
 * @returns {string[]}
 */
function candidatePaths(uri) {
  const noScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[?#].*$/, '');
  const firstSlash = noScheme.indexOf('/');
  const hostDropped = firstSlash === -1 ? '/' : noScheme.slice(firstSlash);
  return [`/${noScheme}`, hostDropped];
}

function isAbsoluteUri(href) {
  return typeof href === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** Every `alternate` href a STAC asset may carry, in declaration order. */
function alternateHrefs(asset) {
  const alternate = asset?.alternate;
  if (!alternate || typeof alternate !== 'object') return [];
  return Object.values(alternate)
    .map((entry) => entry?.href)
    .filter((href) => typeof href === 'string' && href);
}

/**
 * The absolute URL of a collection-mirror row's data file.
 *
 * A mirror row is a STAC Item serialized into a parquet row, and a STAC
 * Item's asset hrefs are relative to *that item's own* canonical URL --
 * which a parquet row, unlike a JSON document, does not inherently know.
 * stac-geoparquet therefore says mirror hrefs SHOULD be absolute, but real
 * catalogs publish relative ones: Fields of the World's 2019 mirror
 * (`.../vector/2019/items.parquet`) stores `./utm01.parquet` for an item
 * whose canonical URL is `.../vector/2019/zone=01/utm01.json`.
 *
 * Before this function existed, that bare `./utm01.parquet` was handed
 * straight to `fetch`. In Node that throws `Failed to parse URL`; in a
 * browser it silently resolves against the *page's* location, so every
 * part read hit `http://localhost:8081/utm01.parquet` and the whole
 * estimate failed as DATASET_UNRESOLVED ("this dataset's files could not
 * be read") -- a generic network error for what is really an unresolved
 * relative href. `enumerateStacItems` below already carries the same
 * lesson in its own comment; the mirror path never got it.
 *
 * Resolution order, most authoritative first:
 *
 *  1. An already-absolute href -- nothing to do.
 *  2. The row's own `self` link: the canonical STAC answer to "where does
 *     this item live", and what a conformant mirror carries.
 *  3. An `alternate` href (`alternate.s3.href` is the Portolan/source.coop
 *     norm) whose path runs through the mirror's own directory. `alternate`
 *     means "the same file, another scheme or endpoint", so the part of its
 *     path *below* the mirror directory is the file's path below the
 *     collection -- `zone=01/utm01.parquet` for FTW. This recovers the hive
 *     directory that the relative href dropped.
 *  4. Plain document-relative resolution against the mirror's own URL. The
 *     previous behaviour's evident intent, and at worst an honest 404 that
 *     names a real URL instead of a string `fetch` cannot parse.
 *
 * @param {object} row a decoded mirror row
 * @param {string|undefined} mirrorUrl the mirror parquet's own absolute URL
 * @returns {string|undefined}
 */
export function resolveMirrorPartUrl(row, mirrorUrl) {
  const asset = row?.assets?.data;
  const href = row?.href ?? row?.url ?? asset?.href ?? row?.['assets.data.href'];
  if (typeof href !== 'string' || !href) return href ?? undefined;
  if (isAbsoluteUri(href)) return href;

  const selfLink = (row?.links ?? []).find((l) => l?.rel === 'self')?.href;
  if (isAbsoluteUri(selfLink)) {
    try {
      return new URL(href, selfLink).toString();
    } catch { /* fall through */ }
  }

  if (mirrorUrl) {
    const mirrorDir = mirrorUrl.replace(/[^/]*$/, '');
    let mirrorDirPath;
    try {
      mirrorDirPath = new URL(mirrorDir).pathname;
    } catch {
      mirrorDirPath = null;
    }
    if (mirrorDirPath) {
      for (const alt of alternateHrefs(asset)) {
        if (!isAbsoluteUri(alt)) continue;
        for (const altPath of candidatePaths(alt)) {
          const at = altPath.indexOf(mirrorDirPath);
          if (at === -1) continue;
          const belowCollection = altPath.slice(at + mirrorDirPath.length);
          if (!belowCollection) continue;
          try {
            return new URL(belowCollection, mirrorDir).toString();
          } catch { /* fall through */ }
        }
      }
    }
    try {
      return new URL(href, mirrorUrl).toString();
    } catch { /* fall through */ }
  }

  return href;
}

/** Best-effort mapping of a collection-mirror (STAC-GeoParquet) row to a DatasetPart. */
function partFromMirrorRow(row, keys, mirrorUrl) {
  const url = resolveMirrorPartUrl(row, mirrorUrl);
  const bbox = Array.isArray(row.bbox)
    ? /** @type {[number,number,number,number]} */ (row.bbox)
    : row.bbox
      ? [row.bbox.xmin, row.bbox.ymin, row.bbox.xmax, row.bbox.ymax]
      : undefined;
  const start = row.start_datetime ?? row.datetime ?? null;
  const end = row.end_datetime ?? row.datetime ?? null;
  const partKeys = {};
  for (const k of keys) if (row[k.name] !== undefined) partKeys[k.name] = row[k.name];
  // A mirror row usually repeats its hive key as a column -- but FTW's does
  // not (its `zone` lives only in the item's directory), and until the URL
  // above resolved to a real path there was nothing to read it back from.
  // Same fallback `stac-items` parts get, for the same reason: without it
  // an explicit `filter.partitions` silently matches every part.
  const resolvedKeys = Object.keys(partKeys).length ? partKeys : (url ? keysFromHiveUrl(url, keys) : undefined);
  return {
    url,
    keys: resolvedKeys,
    bbox,
    rowCount: row.row_count ?? row['table:row_count'],
    bytes: row.file_size ?? row.bytes,
    interval: start || end ? [start, end] : undefined,
  };
}

/**
 * Recover a part's hive partition key values from its own URL (the
 * `name=value` path segments every hive layout writes), the same way an
 * S3/filesystem reader would. A `stac-items`-enumerated part never carries
 * `keys` otherwise -- unlike `collection-mirror` rows, a STAC Item has no
 * reason to repeat its own hive directory as a property -- so without this,
 * `partitionPruneCascade`'s explicit `filter.partitions` stage (the "just
 * year=2024 regardless of what the time filter implies" escape hatch,
 * design doc §2.2) silently does nothing for a `stac-items`-enumerated
 * source: `p.keys` is `undefined` on every part, and that stage's `if
 * (!p.keys) return true` treats "we don't know" as "it passes" for every
 * part. Found while exercising `partitions:` filters against the real
 * FIRMS/s2-stac-geoparquet catalogs for this package's E6 stress test.
 * @param {string} url @param {import('./types.js').PartitionKey[]} keys
 * @returns {Record<string, string|number>|undefined}
 */
function keysFromHiveUrl(url, keys) {
  if (!keys || keys.length === 0) return undefined;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const found = {};
  for (const match of pathname.matchAll(/([^/=]+)=([^/]+)/g)) {
    found[match[1]] = match[2];
  }
  const partKeys = {};
  for (const k of keys) {
    if (!(k.name in found)) continue;
    const raw = found[k.name];
    partKeys[k.name] = k.type === 'int32' || k.type === 'int64' || k.type === 'float64' ? Number(raw) : raw;
  }
  return Object.keys(partKeys).length ? partKeys : undefined;
}

async function enumerateStacItems(collectionUrl, keys, fetchImpl, signal) {
  const res = await fetchImpl(collectionUrl, { signal });
  if (!res.ok) throw new CnmwError(`Collection fetch failed: HTTP ${res.status}`, 'DATASET_UNRESOLVED', { context: { status: res.status, url: collectionUrl } });
  const collection = await res.json();
  const itemLinks = (collection.links ?? []).filter((l) => l.rel === 'item').slice(0, STAC_ITEM_CAP);
  let requests = 1;
  const parts = new Array(itemLinks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < itemLinks.length) {
      const i = cursor++;
      // STAC item `href`s are routinely relative to the document that links
      // them (every real catalog we tested against -- firms-catalog,
      // s2-stac-geoparquet -- publishes "./year=2026/2026.json" style
      // hrefs), so resolve against `collectionUrl` before fetching. A bare
      // `fetch(itemLinks[i].href)` either throws (Node, no base URL) or
      // silently resolves against the wrong document (a browser resolves a
      // relative URL against the *page's* location, not the collection
      // JSON's), so every item fetch 404s against a real collection.
      const itemUrl = new URL(itemLinks[i].href, collectionUrl).toString();
      const itemRes = await fetchImpl(itemUrl, { signal });
      requests += 1;
      if (!itemRes.ok) continue;
      const item = await itemRes.json();
      const dataAsset = Object.values(item.assets ?? {}).find((a) => a.roles?.includes('data')) ?? Object.values(item.assets ?? {})[0];
      // Same relative-href problem one level down: an asset href is
      // relative to the *item's* URL, not the collection's.
      const partUrl = dataAsset?.href ? new URL(dataAsset.href, itemUrl).toString() : undefined;
      parts[i] = {
        url: partUrl,
        bbox: item.bbox,
        interval: [item.properties?.datetime ?? item.properties?.start_datetime ?? null, item.properties?.datetime ?? item.properties?.end_datetime ?? null],
        keys: partUrl ? keysFromHiveUrl(partUrl, keys) : undefined,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAC_ITEM_CONCURRENCY, itemLinks.length) }, worker));
  return { parts: parts.filter(Boolean), requests };
}

async function enumerateBucketListing(endpoint, prefix, fetchImpl, signal) {
  const url = `${endpoint}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new CnmwError(`Bucket listing failed: HTTP ${res.status}`, 'DATASET_UNRESOLVED', { context: { status: res.status, url } });
  const xml = await res.text();
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  return { parts: keys.map((key) => ({ url: new URL(key, endpoint).toString() })), requests: 1 };
}

/**
 * Partition-level pruning cascade (design doc §2.7 steps 1-2): explicit
 * `filter.partitions` first, then bbox/time against each part's own
 * declared `bbox`/`interval` (when present).
 * @param {import('./types.js').DatasetPart[]} parts
 * @param {import('@cnmw/spec').BBox[]|null} areaBBoxes
 * @param {import('./types.js').TimeFilter|undefined} time
 * @param {Readonly<Record<string, import('./types.js').PartitionValueFilter>>|undefined} explicitPartitions
 * @returns {{ selected: import('./types.js').DatasetPart[], stages: import('./types.js').PruneStage[] }}
 */
export function partitionPruneCascade(parts, areaBBoxes, time, explicitPartitions) {
  /** @type {import('./types.js').PruneStage[]} */
  const stages = [];
  let current = parts;

  if (explicitPartitions && Object.keys(explicitPartitions).length > 0) {
    const before = current.length;
    current = current.filter((p) => {
      if (!p.keys) return true;
      return Object.entries(explicitPartitions).every(([k, pf]) => {
        const v = p.keys[k];
        if (v === undefined) return true;
        if (pf.op === 'all') return true;
        if (pf.op === 'in') return pf.values.includes(v);
        if (pf.op === 'between') return v >= pf.low && v <= pf.high;
        return true;
      });
    });
    stages.push({ stage: 'partition', before, after: current.length, basis: `partition:keys explicit filter on ${Object.keys(explicitPartitions).join(', ')}` });
  }

  if (time && (time.start || time.end)) {
    const before = current.length;
    const startMs = time.start ? Date.parse(time.start) : -Infinity;
    const endMs = time.end ? Date.parse(time.end) : Infinity;
    const next = current.filter((p) => {
      if (!p.interval) return true;
      const [s, e] = p.interval;
      const partStart = s ? Date.parse(s) : -Infinity;
      const partEnd = e ? Date.parse(e) : Infinity;
      return partEnd >= startMs && partStart <= endMs;
    });
    if (next.length !== before) stages.push({ stage: 'part-time', before, after: next.length, basis: `time window overlaps part interval` });
    current = next;
  }

  if (areaBBoxes) {
    const before = current.length;
    const next = current.filter((p) => {
      if (!p.bbox) return true;
      return areaBBoxes.some((abox) => bboxesIntersect(p.bbox, abox));
    });
    if (next.length !== before || parts.some((p) => p.bbox)) {
      stages.push({ stage: 'part-bbox', before, after: next.length, basis: 'part bbox ∩ area bboxes' });
    }
    current = next;
  }

  return { selected: current, stages };
}
