// @cngeo/extract-core -- a cache of what planning learns.
//
// Planning a request answers two questions before any row is read: which
// files is this dataset made of (a part listing: a collection document and
// its item documents, or a mirror file), and what is in each file (its
// footer). Without a cache both are asked again on every `estimate()` and
// every `plan()`. E14 measured the cost on Sentinel-2: 13 listing requests
// and a 7.9 MB footer, 4-8 seconds, before each search read a single row.
//
// A cache is passed explicitly (`options.cache`); with none, nothing changes.
// It holds only metadata -- part lists and decoded footers -- never rows.
//
// Three properties worth knowing:
//
//   Loads are shared. Two plans that need the same footer at the same time
//   make one request. The load itself runs WITHOUT any caller's abort signal,
//   so a search that is superseded mid-plan still leaves its footers behind
//   for the search that superseded it; the aborting caller is simply
//   released early (see `raceAbort`).
//
//   Failures are not kept. A rejected load is evicted, so the next caller
//   retries.
//
//   Entries expire (`maxAgeMs`, 10 minutes by default). Published data
//   changes -- Sentinel-2's "live" parts are rewritten as new scenes arrive --
//   and a footer that no longer describes its file reads garbage. `evict(url)`
//   drops one file for a caller that has noticed exactly that.

import { CngError, CancelledError } from '@cngeo/spec';

/**
 * @typedef {Object} PlanCache
 * @property {(key: string, load: (signal?: AbortSignal) => Promise<any>) => Promise<any>} parts   A part listing, by enumeration identity.
 * @property {(url: string, load: (signal?: AbortSignal) => Promise<any>) => Promise<any>} footer  A file's footer, by URL.
 *   `load` is given the signal of the load's own time limit; pass it to every request it makes.
 * @property {(url: string) => void} evict   Forget one file's footer.
 * @property {() => void} clear              Forget everything.
 * @property {() => { partListings: number, footers: number, hits: number, misses: number }} stats
 */

/**
 * @param {{ maxAgeMs?: number, loadTimeoutMs?: number, now?: () => number }} [options]
 *   `maxAgeMs` (10 minutes): how long an entry is used. `loadTimeoutMs` (2 minutes): how long one
 *   listing or footer read may take before it is abandoned; `0` for no limit.
 * @returns {PlanCache}
 */
export function createPlanCache(options = {}) {
  const maxAgeMs = options.maxAgeMs ?? 600_000;
  const loadTimeoutMs = options.loadTimeoutMs ?? 120_000;
  const now = options.now ?? Date.now;
  /** @type {Map<string, { at: number, promise: Promise<any>, settled: boolean }>} */
  const partListings = new Map();
  const footers = new Map();
  let hits = 0;
  let misses = 0;

  function get(map, key, load, what) {
    const held = map.get(key);
    if (held && now() - held.at <= maxAgeMs) {
      hits++;
      return held.promise;
    }
    misses++;
    const entry = { at: now(), promise: null, settled: false };
    entry.promise = Promise.resolve().then(() => withTimeout(load, loadTimeoutMs, what));
    entry.promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        if (map.get(key) === entry) map.delete(key); // a failure is not kept
      },
    );
    map.set(key, entry);
    return entry.promise;
  }

  return {
    parts: (key, load) => get(partListings, key, load, "the list of the dataset's files"),
    footer: (url, load) => get(footers, url, load, `the footer of ${url}`),
    evict(url) {
      footers.delete(url);
    },
    clear() {
      partListings.clear();
      footers.clear();
    },
    stats: () => ({
      partListings: [...partListings.values()].filter((e) => e.settled).length,
      footers: [...footers.values()].filter((e) => e.settled).length,
      hits,
      misses,
    }),
  };
}

/**
 * Run a shared load under a time limit.
 *
 * A shared load runs without any caller's signal, so nothing a caller does can
 * stop it -- and a request that never answers would otherwise sit in the cache
 * as a promise that never settles, handed to every later caller until the
 * entry expired. The limit is that load's own: when it passes, the load's
 * signal aborts (so its requests are dropped), the load rejects as a
 * retryable `NETWORK` error with `context.reason: 'timeout'`, and -- being a
 * failure -- it is not kept.
 * @param {(signal: AbortSignal|undefined) => Promise<any>} load
 * @param {number} ms `0` (or anything not a positive finite number) means no limit.
 * @param {string} what For the message: "the footer of <url>".
 */
async function withTimeout(load, ms, what) {
  if (!(ms > 0) || !Number.isFinite(ms)) return load(undefined);
  const controller = new AbortController();
  const timedOut = () =>
    new CngError(`Timed out after ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`} waiting for ${what}.`, 'NETWORK', {
      retryable: true,
      context: { reason: 'timeout', timeoutMs: ms },
    });
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timedOut());
    }, ms);
  });
  const work = Promise.resolve().then(() => load(controller.signal));
  work.catch(() => {}); // once the limit has won, the load's own failure is nobody's to handle
  try {
    return await Promise.race([work, limit]);
  } catch (err) {
    // The abort itself surfaces from the load as a cancellation; say what it was.
    throw controller.signal.aborted ? timedOut() : err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Await a shared promise, but let THIS caller go the moment its own signal
 * aborts. The shared work is not cancelled -- other callers may be waiting on
 * it, and its result is worth keeping.
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal|undefined} signal
 * @param {string} what For the error message: "listing the dataset's parts".
 * @returns {Promise<T>}
 */
export function raceAbort(promise, signal, what) {
  if (!signal) return promise;
  const cancelled = () =>
    new CancelledError(`Cancelled while ${what}.`, { context: { reason: typeof signal.reason === 'string' ? signal.reason : undefined } });
  if (signal.aborted) {
    promise.catch(() => {}); // the shared load may still fail; that is not this caller's to report
    return Promise.reject(cancelled());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** What makes two part listings the same listing. */
export function partListingKey(source) {
  return JSON.stringify({
    kind: source.kind,
    glob: source.glob ?? null,
    enumeration: source.enumeration ?? null,
    keys: (source.keys ?? []).map((k) => [k.name, k.values ?? null]),
  });
}
