// @cng/download-core -- raw GeoParquet passthrough: PLANNING half only.
//
// Normal `estimate()`/`download()` decode every selected part through
// hyparquet, filter rows, and re-encode into an output format. This path
// (format id `parquet-raw`) does none of that: the original published
// bytes of one or more whole files stream straight through -- one file
// verbatim, or several zipped together -- with no footer read, no
// row-group pruning and no row-level filtering. `planRaw` decides which
// files qualify and what that will cost; `rawEstimate` turns the plan into
// a public `Estimate`. The actual byte-streaming writer is a later task.
//
// Because nothing is decoded, this is the one path where `outputBytes` can
// be *exact* rather than modeled -- the whole point of the feature. Size
// resolution order is: a part's own declared `bytes` first, then one `HEAD`
// per sizeless part (always counted in `requests`, never allowed to throw:
// a failed/CORS-blocked/missing-content-length HEAD just leaves that part's
// size `null`). `outputBytes.exact` is true only when every selected part's
// size is known -- guessing one would defeat the reason this path exists.
// Same discipline for `rows`: exact only when every selected part declares
// a `rowCount`, else left `null` (not modeled -- see estimate.js's
// `genericOutputBytesModel`/row-ratio heuristic for what a *modeled* row
// count looks like elsewhere; that model has no place on an exactness
// path).
//
// Only whole-file pruning runs here: `partitionPruneCascade`'s existing
// explicit-partition/time/bbox stages, nothing below them. In particular,
// `area.bboxes` (never the signed, antimeridian-wrapping `area.bbox`) is
// what gets compared against each part's declared bbox.

import { CngError } from '@cng/spec';
import { resolveDataset } from './dataset-resolve.js';
import { enumeratePartitions, partitionPruneCascade } from './partitions.js';
import { boundedExact, boundedRange, addBounded } from './bounded.js';
import { localHeader, dataDescriptor, centralHeader, endOfCentralDirectory, sanitizeEntryName } from './zip.js';
import { effectiveCeiling } from './ceiling.js';
import { sha256Hex } from './digest.js';
import { DEFAULT_LARGE_DOWNLOAD_BYTES, DEFAULT_THROUGHPUT_BYTES_PER_SECOND, SLOW_DOWNLOAD_SECONDS } from './estimate.js';

/** The `OutputRequest.format`/`FormatPlugin.id` for raw passthrough. */
export const RAW_FORMAT_ID = 'parquet-raw';

/**
 * Static descriptor for `formats()` listing (design doc §3.4's
 * `LazyFormatDescriptor` shape, trimmed to the fields this plugin needs):
 * no decode happens, so it is `streaming` with `memoryFactor: 0` --
 * `effectiveCeiling` then derives `outputBytes` from the sink, not from any
 * buffering this plugin itself does (it does none). Registering it with
 * `registerFormat`/`registerLazyFormat` is a later task's job; this module
 * only defines the shape.
 */
export const rawFormatDescriptor = {
  id: RAW_FORMAT_ID,
  label: 'GeoParquet — original files',
  extension: 'parquet',
  streaming: true,
  capabilities: { memoryFactor: 0 },
};

/** Source kinds `planRaw` knows how to enumerate whole files from. */
const SUPPORTED_SOURCE_KINDS = new Set(['parquet', 'parquet-set', 'hive', 'stac-geoparquet']);

/** The zip entry a future writer embeds the request's attribution text as. */
const ATTRIBUTION_ENTRY_NAME = 'ATTRIBUTION.txt';

/** @param {number|bigint|undefined} v @returns {number|undefined} */
function toNumber(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** @param {string} url @returns {string} */
function decodedPathname(url) {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

/** @param {string} pathname @returns {string[]} */
function pathSegments(pathname) {
  return pathname.split(/[\\/]+/).filter((s) => s !== '');
}

/**
 * How many leading segments every one of `pathLists` shares, capped so the
 * shortest path always keeps at least its own last segment (typically the
 * filename) -- otherwise a set of parts that happen to share a full path
 * (or a single-part list, trivially "common" with itself) would collapse
 * to an empty relative name.
 * @param {string[][]} pathLists
 * @returns {number}
 */
function commonPathPrefixLength(pathLists) {
  if (pathLists.length === 0) return 0;
  const cap = Math.max(0, Math.min(...pathLists.map((p) => p.length)) - 1);
  let len = 0;
  while (len < cap && pathLists.every((p) => p[len] === pathLists[0][len])) len += 1;
  return len;
}

/**
 * Ruling R10: the zip entry name for each selected part is its path
 * *relative to the common prefix of every selected part's own path* --
 * preserving the dataset's partition layout (design doc §7.2:
 * `acq_date=2026-09-01/part-0.parquet`, not the whole bucket path) --
 * sanitized and deduplicated against each other and against the
 * `ATTRIBUTION.txt` entry. Exported so the byte-streaming writer (a later
 * task) uses this exact function instead of reimplementing the same
 * derivation: the predicted zip overhead below and the real zip's entry
 * names must come from one source or they will drift (the same reasoning
 * Ruling R1 applied to the record builders themselves).
 * @param {{ url: string }[]} selectedParts
 * @returns {{ parts: string[], attribution: string }} `parts` in the same order as `selectedParts`.
 */
export function rawZipEntryNames(selectedParts) {
  const pathLists = selectedParts.map((p) => pathSegments(decodedPathname(p.url)));
  const prefixLen = commonPathPrefixLength(pathLists);
  const taken = new Set();
  const parts = pathLists.map((segs) => sanitizeEntryName(segs.slice(prefixLen).join('/'), taken));
  const attribution = sanitizeEntryName(ATTRIBUTION_ENTRY_NAME, taken);
  return { parts, attribution };
}

/**
 * The exact zip container overhead for the given selected parts plus one
 * `ATTRIBUTION.txt` entry, derived from Task 1's own record builders
 * (`localHeader`/`dataDescriptor`/`centralHeader`/`endOfCentralDirectory`)
 * and `rawZipEntryNames`/`sanitizeEntryName` -- never hand-copied constants
 * (Ruling R1): a change to those builders' layout, or to the entry-naming
 * convention, changes this function's answer for free instead of silently
 * drifting from it. Entry byte *content* sizes are irrelevant to the
 * overhead itself: every size field is a fixed-width zip64 field (0 takes
 * exactly as many bytes as a real file length would), so placeholder
 * `crc`/`size`/`offset` of 0 are exact stand-ins -- only the entry *name*
 * lengths matter, which is why a shorter name (after R10's prefix
 * stripping) means a smaller header.
 * @param {{ url: string }[]} selectedParts
 * @returns {number}
 */
function zipOverheadBytes(selectedParts) {
  const { parts: partNames, attribution: attributionName } = rawZipEntryNames(selectedParts);
  let overhead = 0;
  const addEntry = (name) => {
    overhead += localHeader({ name }).length;
    overhead += dataDescriptor({ crc: 0, size: 0 }).length;
    overhead += centralHeader({ name, crc: 0, size: 0, offset: 0 }).length;
  };
  for (const name of partNames) addEntry(name);
  addEntry(attributionName);
  overhead += endOfCentralDirectory({ entryCount: partNames.length + 1, centralSize: 0, centralOffset: 0 }).length;
  return overhead;
}

/**
 * Resolve every selected part's byte size: its own declared `bytes` first,
 * then one `HEAD` per sizeless part. A `HEAD` that throws, resolves
 * `!ok`, or has no readable `content-length` leaves that part's size
 * `null` -- it is never allowed to fail the whole plan, because several
 * real sources (an `enumerateStacItems`-built part, for one) carry no size
 * at all. Every attempted `HEAD` counts toward `requests`, successful or
 * not.
 * @param {{ url: string, bytes?: number }[]} selectedParts
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{ sizes: Map<string, number|null>, requests: number }>}
 */
async function resolvePartSizes(selectedParts, fetchImpl, signal) {
  /** @type {Map<string, number|null>} */
  const sizes = new Map();
  let requests = 0;
  for (const part of selectedParts) {
    if (typeof part.bytes === 'number') {
      sizes.set(part.url, part.bytes);
      continue;
    }
    requests += 1;
    let size = null;
    try {
      const res = await fetchImpl(part.url, { method: 'HEAD', signal });
      const header = res?.ok ? res.headers?.get?.('content-length') : null;
      if (header != null) {
        const n = Number(header);
        if (Number.isFinite(n)) size = n;
      }
    } catch {
      // Network failure, CORS, an abort -- leave this part's size null
      // rather than letting one uncooperative server fail the whole plan.
    }
    sizes.set(part.url, size);
  }
  return { sizes, requests };
}

/**
 * Decide which whole files a raw-passthrough download will fetch, and
 * what their sizes are. No footer is read and no row group is pruned --
 * only `partitionPruneCascade`'s explicit-partition/time/bbox stages, the
 * same ones `estimate()`'s `planRequest` uses before it goes on to open
 * every selected part's footer (this function stops right where that
 * would start).
 *
 * @param {import('./types.js').DatasetDescriptor} dataset
 * @param {import('@cng/spec').Area|null} area
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('./types.js').DownloadCoreOptions} [options]
 * @returns {Promise<{ parts: import('./types.js').DatasetPart[], selected: import('./types.js').DatasetPart[], sizes: Map<string, number|null>, requests: number, stages: import('./types.js').PruneStage[], warnings: import('./types.js').EstimateWarning[] }>}
 */
export async function planRaw(dataset, area, filter, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const signal = options.signal;
  let requests = 0;

  const resolved = await resolveDataset(dataset, { fetch: fetchImpl, signal });
  const src = resolved.source;
  if (!SUPPORTED_SOURCE_KINDS.has(src.kind)) {
    throw new CngError(
      `Raw passthrough does not support the "${src.kind}" source kind.`,
      'FORMAT_CAPABILITY',
      { context: { kind: src.kind } },
    );
  }

  /** @type {import('./types.js').DatasetPart[]} */
  let parts;
  if (src.kind === 'parquet') {
    parts = [{ url: src.url }];
  } else if (src.kind === 'parquet-set') {
    parts = src.parts ?? src.urls.map((url) => ({ url }));
  } else {
    const en = await enumeratePartitions(src, { fetch: fetchImpl, signal });
    parts = en.parts;
    requests += en.requests;
  }

  const areaBBoxes = area ? area.bboxes : null;
  const { selected, stages } = partitionPruneCascade(parts, areaBBoxes, filter.time, filter.partitions);

  if (selected.length === 0) {
    throw new CngError(
      'No file in this dataset matches the requested area, time window or partition filter.',
      'FILTER_NO_MATCH',
      { context: { files: parts.length } },
    );
  }

  const { sizes, requests: headRequests } = await resolvePartSizes(selected, fetchImpl, signal);
  requests += headRequests;

  // Reserved for a future plan-level warning (Task 8's `raw-size-unknown`/
  // `raw-no-pruning`) that needs `sizes`/`stages` rather than `filter` --
  // nothing is raised at the planning stage in this task.
  return { parts, selected, sizes, requests, stages, warnings: [] };
}

/**
 * Turn a `planRaw` result into a public `Estimate` -- the same shape
 * `estimate()`/`finalizeEstimate` produce, so a consumer that only looks at
 * `Estimate`'s fields cannot tell which path built it. `rowGroups` is
 * honestly `{ total: 0, selected: 0 }` (no row group was ever examined) and
 * `columns` is `[]` (no projection happens; every column of every selected
 * file passes through).
 *
 * @param {Awaited<ReturnType<typeof planRaw>>} rawPlan
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('./types.js').DownloadCoreOptions & { sink?: { kind: string }|null }} [options]
 * @returns {Promise<import('./types.js').Estimate>}
 */
export async function rawEstimate(rawPlan, filter, options = {}) {
  const t0 = performance.now();
  const { parts, selected, sizes, requests, stages, warnings: planWarnings } = rawPlan;

  const knownSizes = selected.map((p) => sizes.get(p.url));
  const allSizesKnown = knownSizes.every((s) => typeof s === 'number');
  const sumKnownBytes = knownSizes.reduce((n, s) => n + (typeof s === 'number' ? s : 0), 0);

  // `max` stays a genuine upper bound: when a part's size is unknown there
  // is no true ceiling on it, so `max` is `Infinity` rather than quietly
  // understating it as "no bigger than what we do know". `estimate`/`min`
  // never guess -- an unknown part contributes 0, a floor, not a guess.
  const rawBytes = allSizesKnown
    ? boundedExact(sumKnownBytes)
    : boundedRange(sumKnownBytes, Infinity, sumKnownBytes, false);

  const readBytes = rawBytes; // bytes pulled from storage; no decode changes this.
  const overhead = selected.length > 1 ? zipOverheadBytes(selected) : 0;
  const outputBytes = overhead > 0 ? addBounded(rawBytes, boundedExact(overhead)) : rawBytes;

  const rowCounts = selected.map((p) => toNumber(p.rowCount));
  const allRowsKnown = rowCounts.every((r) => typeof r === 'number' && Number.isFinite(r));
  const rows = allRowsKnown ? boundedExact(rowCounts.reduce((n, r) => n + r, 0)) : null;

  const warnings = [...planWarnings];
  const dropped = [];
  if ((filter.where && filter.where.length > 0) || filter.whereSql) dropped.push('where');
  const columnsReq = filter.columns;
  if (
    columnsReq &&
    ((columnsReq.include && columnsReq.include.length > 0) ||
      (columnsReq.exclude && columnsReq.exclude.length > 0) ||
      columnsReq.includeBbox ||
      columnsReq.dropGeometry)
  ) {
    dropped.push('columns');
  }
  if (filter.spatial?.mode === 'intersects' || filter.spatial?.mode === 'clip') dropped.push('spatial-row-level');
  if (dropped.length > 0) warnings.push({ code: 'raw-passthrough-unfiltered', dropped });

  // Same thresholds/constants `finalizeEstimate` uses, unconditionally --
  // a later task adds the `outputBytes.exact &&` guard that suppresses
  // these when the size is unknown; this task deliberately leaves that
  // one-line change for it rather than anticipating it.
  const throughputBytesPerSecond = options.throughputBytesPerSecond ?? DEFAULT_THROUGHPUT_BYTES_PER_SECOND;
  const largeDownloadBytes = options.largeDownloadBytes ?? DEFAULT_LARGE_DOWNLOAD_BYTES;
  const estimatedSeconds = Math.round(outputBytes.estimate / throughputBytesPerSecond);
  if (outputBytes.estimate > largeDownloadBytes) {
    warnings.push({ code: 'large-download', bytes: outputBytes.estimate, estimatedSeconds });
  }
  if (estimatedSeconds > SLOW_DOWNLOAD_SECONDS) {
    warnings.push({ code: 'slow-download', estimatedSeconds });
  }

  // Ruling R9: an unknown part size must never manufacture a ceiling
  // breach on its own (design doc §7.5 -- the user chose "warn distinctly,
  // always proceed" over "warn and require explicit acceptance" for this
  // exact case, and STAC-sourced parts routinely carry no size at all, so
  // this is the common case, not an edge case). `outputBytes.max`/
  // `readBytes.max` are `Infinity` whenever any size is unknown -- a
  // genuine, honest upper bound for the *reported* `Bounded` (kept as-is
  // above) -- but a breach check must compare against what is actually
  // KNOWN: the sum of known part sizes, plus the (always-known) zip
  // overhead. `files` is unaffected -- it counts parts, not bytes, and
  // stays the hard backstop per §7.5 regardless of size knowledge.
  const knownOutputBytes = sumKnownBytes + overhead;
  const ceiling = effectiveCeiling({ format: rawFormatDescriptor, sink: options.sink ?? null, overrides: options.ceiling });
  const breaches = [];
  if (rows && rows.max > ceiling.rows) breaches.push('rows');
  if (knownOutputBytes > ceiling.outputBytes) breaches.push('outputBytes');
  if (sumKnownBytes > ceiling.readBytes) breaches.push('readBytes');
  if (selected.length > ceiling.files) breaches.push('files');

  const requestDigest = await sha256Hex(JSON.stringify({ parts, filter }));

  return {
    requestDigest,
    rows,
    readBytes,
    outputBytes,
    files: { total: parts.length, selected: selected.length },
    rowGroups: { total: 0, selected: 0 },
    requests,
    prune: stages,
    columns: [],
    warnings,
    ceiling: { exceeded: breaches.length > 0, limits: ceiling, breaches },
    elapsedMs: performance.now() - t0,
  };
}
