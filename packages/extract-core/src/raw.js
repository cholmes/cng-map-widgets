// @cngeo/extract-core -- raw GeoParquet passthrough: PLANNING half only.
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

import { CngError, CancelledError } from '@cngeo/spec';
import { resolveDataset } from './dataset-resolve.js';
import { enumeratePartitions, partitionPruneCascade } from './partitions.js';
import { boundedExact, boundedRange, addBounded } from './bounded.js';
import { localHeader, dataDescriptor, centralHeader, endOfCentralDirectory, sanitizeEntryName, createZipWriter } from './zip.js';
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
 * buffering this plugin itself does (it does none). Registered via
 * `registerFormat` in `index.js`'s module-side-effect block, same as
 * geojson/geoparquet -- listed by `formats()`, but never resolved into the
 * normal decode pipeline: it has no `estimateBytes`/`open`, and
 * `download()` branches to the raw path on `output.format === RAW_FORMAT_ID`
 * before `getFormat()`/`resolveFormat()` would ever be asked for it.
 */
export const rawFormatDescriptor = {
  id: RAW_FORMAT_ID,
  label: 'GeoParquet — original files',
  extension: 'parquet',
  // The single-file case (the common one) really is this media type; the
  // multi-file zip case overrides it per-run in `download()`'s own
  // `mediaType` derivation, which reads this field rather than duplicating
  // the string.
  mediaType: 'application/vnd.apache.parquet',
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

/**
 * Coerce any `bigint` found anywhere inside `value` to a `number`, leaving
 * everything else untouched. `bbox`/`interval` are normally plain doubles
 * and ISO strings in every live catalog, but both are read straight off a
 * hyparquet-decoded row for collection-mirror sources -- the same route
 * that makes `bytes`/`rowCount` BigInt-shaped (see `toNumber` above and
 * AGENTS.md pitfall 5) -- so an INT64-typed bound is possible in principle.
 * Used only for `requestDigest`'s `JSON.stringify`, which otherwise throws
 * on a BigInt anywhere in the object graph.
 * @param {unknown} value
 * @returns {unknown}
 */
function coerceBigInts(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(coerceBigInts);
  return value;
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
 * A declared `bytes` may be a `bigint` -- a `collection-mirror` row's
 * `file:size`/`bytes` column is read straight off a hyparquet-decoded
 * row (`partFromMirrorRow`, `partitions.js`), and an `INT64` parquet
 * column decodes as `BigInt` (this codebase's own documented pitfall:
 * "coerce `number|bigint` rather than testing for `number`"). `toNumber`
 * handles that before the presence check, so a declared `BigInt` size is
 * honored here rather than silently falling through to an unnecessary
 * `HEAD`.
 * @param {{ url: string, bytes?: number|bigint }[]} selectedParts
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{ sizes: Map<string, number|null>, requests: number }>}
 */
async function resolvePartSizes(selectedParts, fetchImpl, signal) {
  /** @type {Map<string, number|null>} */
  const sizes = new Map();
  let requests = 0;
  for (const part of selectedParts) {
    const declaredBytes = toNumber(part.bytes);
    if (typeof declaredBytes === 'number') {
      sizes.set(part.url, declaredBytes);
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
 * @param {import('@cngeo/spec').Area|null} area
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

  // `resolved` is the fully-concrete `DatasetDescriptor` `resolveDataset`
  // produced above -- carried through so `runRaw` (and `rawEstimate`'s
  // share-alike check, if it ever needs one) can read `resolved.attribution`
  // the same way `estimate.js`'s `plan.resolved.attribution` already does
  // for the decoded path. Additive: `raw-plan.test.js`'s existing
  // assertions on this object's other fields are unaffected.
  //
  // `areaBBoxes` is carried through (rather than re-deriving `!!area` in
  // `rawEstimate`) so Task 8's `raw-no-pruning` warning can tell "the
  // caller asked for an area-narrowed selection" from "no area was passed
  // at all" -- `partitionPruneCascade` above already computed exactly this
  // value from `area`, so this just hands it onward instead of recomputing it.
  return { parts, selected, sizes, requests, stages, warnings: [], resolved, areaBBoxes };
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
  const { parts, selected, sizes, requests, stages, warnings: planWarnings, areaBBoxes } = rawPlan;

  const knownSizes = selected.map((p) => sizes.get(p.url));
  const allSizesKnown = knownSizes.every((s) => typeof s === 'number');
  const sumKnownBytes = knownSizes.reduce((n, s) => n + (typeof s === 'number' ? s : 0), 0);
  const partsWithoutSize = knownSizes.filter((s) => typeof s !== 'number').length;

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

  // Case 1 (design doc §7.5): at least one selected part's size could not
  // be resolved (no declared `bytes` and a failed/CORS-blocked/missing
  // `content-length` HEAD -- `resolvePartSizes` above). This is the
  // honesty layer for the headline guard-rail: without it, a dataset whose
  // parts carry no size at all (every `enumerateStacItems`-built part)
  // would reach this point with nothing to warn about, silently skipping
  // "tell the user before anything is fetched that this is big". Flat
  // fields per ruling R8 -- not nested under `context`.
  if (partsWithoutSize > 0) {
    warnings.push({ code: 'raw-size-unknown', partsWithoutSize, partsTotal: selected.length });
  }

  // Case 2 (design doc §7.5): the filter asked for an area and/or time
  // narrowing, but partition-level pruning kept every file -- the
  // `partitionPruneCascade`/§2.7 stages treat a part with no declared
  // `bbox`/`interval` as "passes" (`if (!p.bbox) return true`), so a
  // dataset whose parts carry no such declarations silently turns "just
  // this area" into "the entire dataset". Fires only when something was
  // actually asked for (a filter that narrowed nothing by request is not
  // noise-worthy) and only when the surviving parts are the reason nothing
  // was pruned, not a coincidental full match against real declared data.
  const askedForAreaNarrowing = !!areaBBoxes;
  const askedForTimeNarrowing = !!(filter.time && (filter.time.start || filter.time.end));
  if (selected.length === parts.length && selected.length > 0 && (askedForAreaNarrowing || askedForTimeNarrowing)) {
    if (askedForAreaNarrowing && selected.every((p) => !p.bbox)) {
      warnings.push({ code: 'raw-no-pruning', basis: 'parts declare no bbox' });
    } else if (askedForTimeNarrowing && selected.every((p) => !p.interval)) {
      warnings.push({ code: 'raw-no-pruning', basis: 'parts declare no interval' });
    }
  }

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
  // Any area, regardless of `filter.spatial.mode`, means the decoded path
  // would apply row-level spatial filtering: `'bbox'` filters rows by their
  // own bbox, an omitted `spatial` block defaults to `'intersects'`
  // downstream, and `'intersects'`/`'clip'` filter explicitly. Raw
  // passthrough returns whole files regardless, so whenever an area was
  // passed there is always something row-level being dropped -- the mode
  // only changes what it *would* have been, never whether anything was.
  // With no area there is nothing to filter rows by in the first place, so
  // nothing is dropped.
  if (areaBBoxes) dropped.push('spatial-row-level');
  // `filter.limit` cannot be honored on this path either: a whole file is
  // returned verbatim, never truncated. Spec §7.1 names `limit` explicitly
  // among what raw cannot honor, and silently dropping it is the anti-goal
  // §4 forbids -- the user must be told before the download starts, not
  // discover it after receiving every row.
  if (filter.limit != null) dropped.push('limit');
  if (dropped.length > 0) warnings.push({ code: 'raw-passthrough-unfiltered', dropped });

  // Same thresholds/constants `finalizeEstimate` uses, with one addition:
  // `outputBytes.exact &&` guards both warnings below. When any selected
  // part's size is unknown, `outputBytes.estimate` is only the sum of the
  // KNOWN part sizes (R9's model, above) -- presenting *that* partial sum
  // as "the size" would imply small when the truth is unknown, which
  // design doc §7.5 calls out as worse than saying nothing. `raw-size-unknown`
  // (pushed above) is the honest replacement for this exact case, so these
  // two are suppressed outright rather than fired on a guess. This mirrors
  // (but does not call) `finalizeEstimate` in estimate.js, which has no
  // such guard: on the normal decode path `outputBytes` is routinely
  // non-exact (it's a selectivity model, not a guess born from a missing
  // byte count), so gating there would wrongly silence `large-download` for
  // ordinary downloads -- a different path, a different meaning of "not exact".
  const throughputBytesPerSecond = options.throughputBytesPerSecond ?? DEFAULT_THROUGHPUT_BYTES_PER_SECOND;
  const largeDownloadBytes = options.largeDownloadBytes ?? DEFAULT_LARGE_DOWNLOAD_BYTES;
  const estimatedSeconds = Math.round(outputBytes.estimate / throughputBytesPerSecond);
  if (outputBytes.exact && outputBytes.estimate > largeDownloadBytes) {
    warnings.push({ code: 'large-download', bytes: outputBytes.estimate, estimatedSeconds });
  }
  if (outputBytes.exact && estimatedSeconds > SLOW_DOWNLOAD_SECONDS) {
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

  // `parts` is the full, unpruned list straight off `enumeratePartitions`
  // (or a `collection-mirror`'s decoded rows, for stac-geoparquet/hive),
  // and its `bytes`/`rowCount` may be `bigint` for the same reason
  // `resolvePartSizes` above has to coerce them: `JSON.stringify` throws
  // on a `BigInt` anywhere in the object graph. Projecting to this small,
  // explicit, coerced shape fixes that and also means a future field
  // added to `DatasetPart` can't change this digest or reintroduce an
  // unserializable value.
  const digestParts = parts.map((p) => ({
    url: p.url,
    bytes: toNumber(p.bytes) ?? null,
    rowCount: toNumber(p.rowCount) ?? null,
    bbox: coerceBigInts(p.bbox) ?? null,
    interval: coerceBigInts(p.interval) ?? null,
  }));
  const requestDigest = await sha256Hex(JSON.stringify({ parts: digestParts, filter }));

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

// ---------------------------------------------------------------------
// Execution half (Task 7): write the bytes `planRaw` decided to fetch.
// ---------------------------------------------------------------------

/**
 * Map a thrown error to `CancelledError` when the copy's own signal is
 * already aborted -- same convention `parquet-io.js`'s `cancellationOf`
 * uses, duplicated here (not imported: that helper is private to that
 * module) rather than exported cross-module for a four-line function.
 * An aborted fetch/read rejects with a bare `AbortError` DOMException (or,
 * through a caller-supplied `fetch`, whatever that implementation throws)
 * -- indistinguishable from a genuine network failure except by checking
 * the signal itself.
 * @param {unknown} cause
 * @param {AbortSignal|undefined} signal
 * @param {string} what
 * @returns {CancelledError|null}
 */
function cancellationOf(cause, signal, what) {
  if (!signal?.aborted) return null;
  return new CancelledError(`Cancelled while ${what}.`, {
    context: { reason: typeof signal.reason === 'string' ? signal.reason : undefined },
  });
}

/**
 * Human-readable `ATTRIBUTION.txt` body: every declared attribution entry
 * (text/license/url, Ruling-matching `shareAlike ?? share_alike`) plus the
 * exact list of original source URLs this archive's entries came from --
 * so the licence and the provenance survive even once the files are
 * unzipped and separated from this request's `Area`/`DownloadResult`.
 * @param {{ url: string }[]} selectedParts
 * @param {{ text?: string, license?: string, url?: string, shareAlike?: boolean, share_alike?: boolean }[]} attribution
 * @returns {string}
 */
function buildAttributionText(selectedParts, attribution) {
  const lines = ['This archive contains unmodified, original published source files.', ''];
  if (attribution.length === 0) {
    lines.push('No attribution metadata was declared for this dataset.', '');
  } else {
    for (const a of attribution) {
      const shareAlike = a.shareAlike ?? a.share_alike;
      lines.push(a.text ?? '(untitled)');
      if (a.license) lines.push(`License: ${a.license}`);
      if (a.url) lines.push(`URL: ${a.url}`);
      if (shareAlike) lines.push('This licence requires derivative works to be shared under the same terms (share-alike).');
      lines.push('');
    }
  }
  lines.push('Source files included in this archive:');
  for (const part of selectedParts) lines.push(`- ${part.url}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Stream one part's response body, yielding each chunk as it arrives and
 * reporting `onProgress({ phase: 'copying', ... })` per chunk. The reader
 * is always cancelled on the way out (normal completion, an error, or an
 * abort) so a thrown error never leaves a dangling lock on the stream.
 * `signal.aborted` is checked before every read, not just relied on to
 * reject the read itself, so a slow/stalled body does not delay noticing
 * a cancel that already happened.
 * @param {Response} res
 * @param {{ fileIndex: number, fileCount: number, filename: string, bytesTotal: number|null }} meta
 * @param {{ signal?: AbortSignal, onProgress(p: object): void|Promise<void>, onBytes(n: number): void }} ctx
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* copyBody(res, meta, ctx) {
  const reader = res.body.getReader();
  let bytesWritten = 0;
  try {
    while (true) {
      if (ctx.signal?.aborted) {
        throw cancellationOf(new Error('aborted'), ctx.signal, `copying ${meta.filename}`);
      }
      let chunk;
      try {
        chunk = await reader.read();
      } catch (cause) {
        throw (
          cancellationOf(cause, ctx.signal, `copying ${meta.filename}`) ??
          new CngError(`Failed reading "${meta.filename}": ${cause?.message ?? cause}`, 'NETWORK', { cause, context: { filename: meta.filename } })
        );
      }
      if (chunk.done) break;
      bytesWritten += chunk.value.byteLength;
      ctx.onBytes(chunk.value.byteLength);
      await ctx.onProgress({
        phase: 'copying',
        fileIndex: meta.fileIndex,
        fileCount: meta.fileCount,
        filename: meta.filename,
        bytesWritten,
        bytesTotal: meta.bytesTotal,
      });
      yield chunk.value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed, or already erroring -- nothing left to release.
    }
  }
}

/**
 * Fetch one selected part, refusing anything that is not a usable `200`
 * response with a body. A non-`ok` response (a 404 on a stale manifest
 * entry, for one) throws `NETWORK` -- never silently skipped, because a
 * partial archive that looks complete is worse than a failed download
 * (see raw-run.test.js's "mid-archive 404" case).
 * @param {{ url: string }} part
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<Response>}
 */
async function fetchPartOrThrow(part, fetchImpl, signal) {
  let res;
  try {
    res = await fetchImpl(part.url, { signal });
  } catch (cause) {
    throw cancellationOf(cause, signal, `fetching ${part.url}`) ?? new CngError(`Couldn't fetch "${part.url}".`, 'NETWORK', { cause, context: { url: part.url } });
  }
  if (!res.ok) {
    throw new CngError(`HTTP ${res.status} fetching "${part.url}".`, 'NETWORK', { context: { url: part.url, status: res.status } });
  }
  if (!res.body) {
    throw new CngError(`No response body for "${part.url}".`, 'NETWORK', { context: { url: part.url } });
  }
  return res;
}

/**
 * The default sink filename for a raw-passthrough run, when the caller's
 * `OutputRequest` declares none: the single selected part's own basename
 * (so a user piping a parquet file straight through keeps its real name),
 * or `${dataset.id}.zip` for the multi-file case (spec §7.1) -- for an
 * archive of several, possibly multi-gigabyte files, the dataset's own name
 * is a far more useful artifact name than a generic `download.zip`.
 * `rawPlan.resolved.id` is the fully-resolved `DatasetDescriptor`'s id, the
 * same object `runRaw` already reads `.attribution` off. `download()` uses
 * this for `sink.open()`'s `filename` and `autoSink`'s `suggestedName`.
 * @param {Awaited<ReturnType<typeof planRaw>>} rawPlan
 * @returns {string}
 */
export function rawSuggestedFilename(rawPlan) {
  if (rawPlan.selected.length === 1) {
    return pathSegments(decodedPathname(rawPlan.selected[0].url)).pop() ?? 'download.parquet';
  }
  return `${rawPlan.resolved?.id ?? 'download'}.zip`;
}

/**
 * Write the bytes a `planRaw` plan selected: one file streamed verbatim
 * (Decision 1 -- NEVER wrapped in a zip, not even for share-alike
 * attribution: "just get people the file"), or several files plus a
 * trailing `ATTRIBUTION.txt` streamed into a zip via `createZipWriter`.
 * Parts are fetched and written strictly sequentially, in `selected`'s
 * order -- never concurrently -- so a failure on part N never leaves part
 * N+1's bytes half-written into the archive. Nothing is buffered beyond
 * one in-flight chunk: each chunk read from a part's response body is
 * written straight to `writer` (or folded into the zip entry's running
 * CRC/size by `createZipWriter.addEntry`) before the next chunk is read.
 *
 * A part that fails (a non-`ok` response, a network error, or a read that
 * errors mid-body) throws and leaves the zip's central directory /
 * end-of-central-directory unwritten -- so a reader that only trusts the
 * central directory (every real zip reader) sees a truncated, invalid
 * archive rather than a complete-looking one missing its tail entries.
 * `download()`'s existing catch is what turns that throw into
 * `sink.abort()`; this function never aborts the sink itself, since it
 * only ever receives `writer`, not the sink.
 *
 * Declared sizes (`planRaw`'s `sizes` map, from a part's own `bytes` field
 * or a `HEAD`) are used only for the `bytesTotal` progress hint -- never
 * trusted for what gets written. The zip's data descriptor and this
 * function's returned `bytes`/`readBytes` always reflect bytes actually
 * read, which is why a part that serves more (or less) than it declared
 * still produces a correct, openable archive.
 *
 * @param {Awaited<ReturnType<typeof planRaw>>} rawPlan
 * @param {WritableStreamDefaultWriter<Uint8Array>} writer
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal, onProgress?: (p: object) => void|Promise<void> }} [options]
 * @returns {Promise<{ bytes: number, entries: number, readBytes: number }>}
 */
export async function runRaw(rawPlan, writer, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const signal = options.signal;
  const onProgress = options.onProgress ?? (() => {});
  const { selected } = rawPlan;
  const attribution = rawPlan.resolved?.attribution ?? [];

  let readBytes = 0;
  const onBytes = (n) => {
    readBytes += n;
  };

  if (selected.length === 1) {
    const part = selected[0];
    const res = await fetchPartOrThrow(part, fetchImpl, signal);
    const bytesTotal = rawPlan.sizes?.get(part.url) ?? null;
    const filename = rawSuggestedFilename(rawPlan);
    let bytesWritten = 0;
    for await (const chunk of copyBody(res, { fileIndex: 1, fileCount: 1, filename, bytesTotal }, { signal, onProgress, onBytes })) {
      await writer.write(chunk);
      bytesWritten += chunk.byteLength;
    }
    return { bytes: bytesWritten, entries: 1, readBytes };
  }

  const zip = createZipWriter(writer);
  const { parts: partNames, attribution: attributionName } = rawZipEntryNames(selected);
  for (let i = 0; i < selected.length; i++) {
    const part = selected[i];
    const res = await fetchPartOrThrow(part, fetchImpl, signal);
    const bytesTotal = rawPlan.sizes?.get(part.url) ?? null;
    const meta = { fileIndex: i + 1, fileCount: selected.length, filename: partNames[i], bytesTotal };
    await zip.addEntry(partNames[i], copyBody(res, meta, { signal, onProgress, onBytes }));
  }
  const attributionBytes = new TextEncoder().encode(buildAttributionText(selected, attribution));
  await zip.addFile(attributionName, attributionBytes);
  const { bytes, entries } = await zip.close();
  return { bytes, entries, readBytes };
}
