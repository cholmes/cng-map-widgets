// Shared helpers for the E1 autocomplete benchmark harness.
// Plain ESM, no build step. Imported directly by browser pages.

/** Pinned CDN module specifiers (exact versions, per PLAN.md "hyparquet-first"). */
export const CDN = {
  hyparquet: 'https://cdn.jsdelivr.net/npm/hyparquet@1.33.0/src/index.js',
  // hyparquet-compressors' src/index.js has bare imports (fzstd, hysnappy)
  // that only resolve through a bundler, so pull its pre-bundled ESM via
  // jsdelivr's +esm endpoint rather than the raw source.
  hyparquetCompressors: 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.3/+esm',
  duckdbWasm: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm',
}

/**
 * Normalize a name the same way build-index.sql does:
 * strip_accents(lower(name)). JS has no direct strip_accents, so we use
 * Unicode NFKD decomposition + strip combining marks, which matches
 * DuckDB's strip_accents for the Latin-script cases that matter for the
 * scripted queries ("contra costa", "san f", "ber", ...).
 *
 * @param {string} s
 * @returns {string}
 */
export function normalize(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

/**
 * Create a fetch wrapper that tallies bytes transferred and request count,
 * read from the Content-Length response header (CORS-exposed on both
 * localhost's serve.py and the tge-labs mirror's
 * access-control-expose-headers: *). HEAD responses report the size a GET
 * would return without transferring a body, so they are not counted.
 *
 * IMPORTANT: hyparquet's asyncBufferFromUrl captures whatever `fetch`
 * function you hand it ONCE, in its own closure, and reuses that same
 * function for every later .slice() call on the returned AsyncBuffer --
 * including calls made long after this function returns. Monkey-patching
 * `window.fetch` per-call does NOT work here: by the time a later
 * `parquetRead` triggers a `.slice()`, hyparquet is still holding the OLD
 * wrapped fetch reference from whenever `asyncBufferFromUrl` was first
 * called, not whatever `window.fetch` happens to be "now". So we build one
 * stable tracked-fetch function per logical measurement session and pass
 * it explicitly via the `fetch` option, instead of swapping the global.
 *
 * @returns {{ fetch: typeof globalThis.fetch, reset(): void, stats(): {bytes:number, requests:number} }}
 */
export function createTrackedFetch() {
  // Capture the real fetch ONCE, at creation time -- never read the
  // (possibly already-patched) global inside the wrapper itself, or
  // instrumentFetch() below would recurse into itself forever.
  const realFetch = window.fetch.bind(window)
  let bytes = 0
  let requests = 0
  const trackedFetch = async (...args) => {
    requests++
    const res = await realFetch(...args)
    const init = args[1]
    const method = (init && init.method) || (args[0] instanceof Request ? args[0].method : 'GET')
    if (String(method).toUpperCase() !== 'HEAD') {
      const cl = res.headers.get('content-length')
      if (cl) bytes += parseInt(cl, 10)
    }
    return res
  }
  return {
    fetch: trackedFetch,
    reset() {
      bytes = 0
      requests = 0
    },
    stats() {
      return { bytes, requests }
    },
  }
}

/**
 * Patch the global fetch for the duration of a measurement. Safe to use
 * when the caller does its own `fetch(url)` directly (approach a) or for
 * libraries (duckdb-wasm) that re-read `window.fetch` fresh on every call
 * rather than capturing it once. NOT safe for hyparquet's
 * asyncBufferFromUrl -- use createTrackedFetch + the `fetch` option there.
 *
 * @returns {{ stop(): {bytes:number, requests:number} }}
 */
export function instrumentFetch() {
  const origFetch = window.fetch.bind(window)
  const tracked = createTrackedFetch()
  window.fetch = tracked.fetch
  return {
    stop() {
      window.fetch = origFetch
      return tracked.stats()
    },
  }
}

/**
 * Binary-search a sorted array of strings for the half-open range of
 * entries starting with `prefix`. Returns [start, end) indices.
 *
 * @param {string[]} arr sorted ascending
 * @param {string} prefix
 * @returns {[number, number]}
 */
function lowerBound(arr, target) {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function prefixRange(arr, prefix) {
  // [prefix, prefix + '￿') brackets every string starting with prefix,
  // since '￿' sorts after any realistic name character.
  const start = lowerBound(arr, prefix)
  const end = lowerBound(arr, prefix + '￿')
  return [start, end]
}

/** Scripted queries used by every approach, per PLAN.md E1 harness spec. */
export const SCRIPTED_QUERIES = ['s', 'sa', 'san', 'san f', 'contra costa', 'ber', 'united']

/** Percentile helper over an array of numbers. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}
