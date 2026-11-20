// @cng/download-core -- default ceilings (design doc §3.4, O8: "as
// tabled") and `requirementsOf(filter)`.
//
// DEVIATION: the design doc places `requirementsOf` on `@cng/spec`
// (§2.5), but this experiment's `@cng/spec` package was built for E3 only
// and does not export it. Implemented here instead; a real release would
// move it to `@cng/spec` so the Python side can share the same table.
//
// Amendment, 2026-11-20 -- `defaultCeiling()`'s single flat `outputBytes`
// (2 GiB) was wrong in both directions: it capped a streaming format that
// writes straight to disk for no reason, and it was too permissive for a
// format that buffers its whole output in memory several times over
// (measured: GeoPackage at 3-4x). `effectiveCeiling` replaces it with a
// derivation from two things -- `memoryFactorOf(format)` (how many bytes
// of peak memory a format holds per output byte) and whether `sink` is
// memory-backed at all. `defaultCeiling()` itself is UNCHANGED: existing
// callers (`estimate.js`) still spread it as their base and are wired to
// `effectiveCeiling` in a later task.

/** The unbounded sentinel: a streaming format writing straight to disk
 * has no memory-driven output cap, but `Ceiling.outputBytes` is still a
 * finite number other code can compare against. */
export const UNBOUNDED_BYTES = 1024 ** 4; // 1 TiB

/** Default memory budget `effectiveCeiling` divides by a buffering
 * format's `memoryFactor` to get `outputBytes`. */
export const MEMORY_BUDGET_DEFAULT = 1024 ** 3; // 1 GiB

/** @returns {import('./types.js').Ceiling} */
export function defaultCeiling() {
  return {
    rows: 5_000_000,
    outputBytes: 2 * 1024 ** 3,
    readBytes: 4 * 1024 ** 3,
    files: 500,
    blobBytes: 256 * 1024 ** 2,
  };
}

/** The flat ceiling fields `effectiveCeiling` starts from -- raised from
 * `defaultCeiling()`'s values (rows: 50M not 5M, readBytes: 64 GiB not 4
 * GiB, files: 10,000 not 500) now that `outputBytes` carries its own
 * weight; `blobBytes` is unchanged. Kept separate from `defaultCeiling()`
 * so that function's existing callers see no behavior change. */
function baseCeiling() {
  return {
    rows: 50_000_000,
    readBytes: 64 * 1024 ** 3,
    files: 10_000,
    blobBytes: 256 * 1024 ** 2,
  };
}

/**
 * How many bytes of peak memory a format holds per byte of output it
 * writes. Reads only `format.streaming` and `format.capabilities.memoryFactor`
 * -- true of both a `FormatPlugin` and a `LazyFormatDescriptor`, so this
 * never needs the format's heavy `load()` to have run.
 *
 * A declared `capabilities.memoryFactor` always wins. Absent that, the
 * default is 0 for a streaming format (it writes bytes as they arrive,
 * holding nothing beyond one batch) and 3 for a buffering one (the
 * generic "accumulates the whole output, plus working copies" case --
 * `format-gpkg`'s measured 3.5 is why this is a per-format override, not
 * a constant).
 *
 * @param {{ streaming?: boolean, capabilities?: { memoryFactor?: number } }} format
 * @returns {number}
 */
export function memoryFactorOf(format) {
  const declared = format?.capabilities?.memoryFactor;
  if (typeof declared === 'number') return declared;
  return format?.streaming ? 0 : 3;
}

/**
 * Derives a `Ceiling` from a format's memory cost and the sink it is
 * writing into, instead of one flat `outputBytes` for every format.
 *
 * - A streaming format (`memoryFactorOf` 0) holds nothing of its own, so
 *   `outputBytes` depends entirely on where the bytes land: unbounded on
 *   a disk-backed sink (`filesystem`, or any other non-memory kind),
 *   `blobBytes` on a `blob` sink (which really does buffer the whole
 *   output as a `Blob`), and unbounded again on a `memory` sink --
 *   `memorySink` is a test/small-download convenience this budget
 *   deliberately does not police (see module doc, global constraints).
 *   `sink: null` (not yet created, e.g. before a picker has resolved one)
 *   is treated as if it were memory-backed like `blob` -- the
 *   conservative direction, since the real sink is unknown.
 * - A buffering format holds `memoryFactor` bytes of memory per output
 *   byte regardless of the sink (its own buffers exist independent of
 *   where the bytes end up), so `outputBytes` is `memoryBudget /
 *   memoryFactor`.
 * - An explicit `overrides.outputBytes` always wins over either
 *   derivation.
 *
 * @param {{ format: { streaming?: boolean, capabilities?: { memoryFactor?: number } }, sink: { kind: string } | null, overrides?: Partial<import('./types.js').Ceiling & { memoryBudget: number }> }} args
 * @returns {import('./types.js').Ceiling}
 */
export function effectiveCeiling({ format, sink, overrides = {} } = {}) {
  const base = baseCeiling();
  const blobBytes = overrides.blobBytes ?? base.blobBytes;
  const memoryBudget = overrides.memoryBudget ?? MEMORY_BUDGET_DEFAULT;

  let outputBytes;
  if (Object.prototype.hasOwnProperty.call(overrides, 'outputBytes')) {
    outputBytes = overrides.outputBytes;
  } else {
    const factor = memoryFactorOf(format);
    if (factor === 0) {
      // Streaming: the memory cost, if any, lives in the sink, not the
      // format. A `memory` sink is exempt from the budget entirely -- a
      // deliberate carve-out for a destination this package controls
      // end-to-end (see module doc) -- while `sink == null` is treated
      // the same as `blob`, the conservative choice when the real sink
      // isn't known yet.
      outputBytes = sink?.kind === 'memory' ? UNBOUNDED_BYTES : sink == null || sink.kind === 'blob' ? blobBytes : UNBOUNDED_BYTES;
    } else {
      // Buffering: the format's own memory cost (JS row arrays, a wasm
      // heap, an exported copy, ...) is spent inside the writer and
      // dominates regardless of the sink -- including a `memory` sink,
      // which exempts only the sink's own buffering, not the format's.
      outputBytes = Math.floor(memoryBudget / factor);
    }
  }

  return {
    rows: overrides.rows ?? base.rows,
    outputBytes,
    readBytes: overrides.readBytes ?? base.readBytes,
    files: overrides.files ?? base.files,
    blobBytes,
  };
}

/**
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('@cng/spec').Area|null} [area]
 * @returns {readonly import('./types.js').FilterRequirement[]}
 */
export function requirementsOf(filter, area) {
  /** @type {import('./types.js').FilterRequirement[]} */
  const reqs = [];
  if (filter.whereSql) reqs.push('sql');
  if (filter.spatial?.mode === 'clip') reqs.push('exact-clip');
  if (area?.provenance?.combine === 'dissolve') reqs.push('dissolve');
  return reqs;
}
