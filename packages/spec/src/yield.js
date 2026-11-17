// @cng/spec -- cooperative yielding for long-running main-thread work.
//
// Added for the geocoder-core background-upgrade path (design doc §1/§3.2:
// `select({ resolution: 'both' })` fetches the small display-simplified
// geometry first, then fetches and simplifies the full-resolution geometry
// in the background). A raw CGAZ ADM0 ring can be hundreds of thousands of
// vertices; even an O(m log m) simplification of one is enough synchronous
// work to produce a multi-frame hitch if run in one go. `yieldToMain` and
// `forEachChunked` break that work into pieces with a cooperative yield
// between them, so no single synchronous run blocks the main thread for
// more than one chunk's worth of work.
//
// Prefers the Scheduler API's `scheduler.yield()` (Chrome 115+): unlike
// `setTimeout`, a continuation scheduled with it is not deprioritized
// behind other macrotasks, so it resumes as soon as the browser has had a
// chance to paint/handle input, not after everything already queued.
// Falls back to `setTimeout(0)` where it's unavailable (older browsers,
// Node, test environments).

/**
 * Yield to the event loop / scheduler, then resume.
 * @returns {Promise<void>}
 */
export function yieldToMain() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Run `fn` once per item of `items`, yielding to the main thread every
 * `chunkSize` items so a large loop never blocks the main thread for
 * longer than one chunk.
 * @template T
 * @param {Iterable<T>} items
 * @param {(item: T, index: number) => void} fn
 * @param {{ chunkSize?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<void>}
 */
export async function forEachChunked(items, fn, opts = {}) {
  const chunkSize = opts.chunkSize ?? 500;
  let i = 0;
  for (const item of items) {
    opts.signal?.throwIfAborted();
    fn(item, i);
    i++;
    if (i % chunkSize === 0) await yieldToMain();
  }
}
