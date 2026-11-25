// @cngeo/stac -- timeline chunks from a STAC collection.
//
// A collection whose data is cut by time publishes an item per piece, and
// each item says what span it covers (`start_datetime` / `end_datetime`) and
// where its tiles are. That is a chunk descriptor (`@cngeo/timeline`'s:
// `{ id, start, end, unit, format, url, priority }`), so a timeline can be
// laid out from the catalog instead of from a URL convention.
//
// It returns plain objects: this package does not import `@cngeo/timeline`.
//
// One request per item. A collection with hundreds of items would do better
// with an item mirror; none of the ones this was written for has more than
// a few dozen.

const pad = (n, width) => String(n).padStart(width, '0');

/** The UTC calendar day of an ISO date, as `YYYYMMDD`; null when it is not a date. */
function dayKey(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return pad(d.getUTCFullYear(), 4) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2);
}

function absolute(href, base) {
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** `fetch(url)` and its JSON, given up on after `ms` whether or not the fetch honours its signal. */
async function fetchJsonWithin(fetchImpl, url, ms) {
  const controller = new AbortController();
  let timer;
  const limit =
    ms > 0 && Number.isFinite(ms)
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`it did not answer within ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`}`));
          }, ms);
        })
      : null;
  const work = (async () => {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })();
  work.catch(() => {});
  try {
    return await (limit ? Promise.race([work, limit]) : work);
  } finally {
    clearTimeout(timer);
  }
}

/** The asset of `type` to use: role `tiles`, then `visual`, then the first. */
function tilesAsset(item, type) {
  const assets = Object.values(item?.assets ?? {}).filter((a) => a && typeof a === 'object' && a.type === type && typeof a.href === 'string');
  const withRole = (role) => assets.find((a) => Array.isArray(a.roles) && a.roles.includes(role));
  return withRole('tiles') ?? withRole('visual') ?? assets[0] ?? null;
}

/**
 * One timeline chunk per item of a collection that has dates and a tiles
 * asset.
 *
 * An item that cannot be fetched, has no dates, or has no asset of
 * `assetType` is left out and listed in `skipped` with the reason: one bad
 * item does not cost the rest. (A rolling "latest" file or an overview that
 * the collection links to directly is not an item and has no dates here: add
 * those chunks yourself.)
 *
 * @param {object} collection  A STAC Collection document.
 * @param {Object} options
 * @param {string} options.baseUrl   The collection's own URL: item links are resolved against it.
 * @param {typeof fetch} [options.fetch]
 * @param {'day'|'month'} [options.unit]  The bucket unit inside each chunk. Default `'day'`.
 * @param {string} [options.format]       Default `'pmtiles'`.
 * @param {string} [options.assetType]    The media type of the asset to use. Default `'application/vnd.pmtiles'`.
 * @param {number} [options.concurrency]  Items fetched at once. Default 8.
 * @param {number} [options.timeoutMs]    Per item. Default 60000; 0 for none.
 * @returns {Promise<{ chunks: object[], skipped: { href: string, reason: string }[] }>}
 */
export async function chunksFromStac(collection, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const unit = options.unit ?? 'day';
  const format = options.format ?? 'pmtiles';
  const assetType = options.assetType ?? 'application/vnd.pmtiles';
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 8));
  const timeoutMs = options.timeoutMs ?? 60_000;

  const links = (Array.isArray(collection?.links) ? collection.links : []).filter((l) => l && l.rel === 'item' && typeof l.href === 'string');
  /** @type {({ chunk?: object, href: string, reason?: string })[]} one slot per link, in link order */
  const slots = links.map((l) => ({ href: absolute(l.href, options.baseUrl) ?? l.href }));

  let next = 0;
  async function worker() {
    for (;;) {
      const slot = slots[next++];
      if (!slot) return;
      try {
        const item = await fetchJsonWithin(fetchImpl, slot.href, timeoutMs);
        const props = item?.properties ?? {};
        const start = dayKey(props.start_datetime) ?? dayKey(props.datetime);
        const end = dayKey(props.end_datetime) ?? dayKey(props.datetime);
        if (!start || !end) {
          slot.reason = 'it has no dates (start_datetime and end_datetime, or datetime)';
          continue;
        }
        const asset = tilesAsset(item, assetType);
        const url = asset ? absolute(asset.href, slot.href) : null;
        if (!url) {
          slot.reason = `it has no ${assetType} asset`;
          continue;
        }
        slot.chunk = { id: typeof item.id === 'string' && item.id ? item.id : slot.href, start: start <= end ? start : end, end: start <= end ? end : start, unit, format, url, priority: 0 };
      } catch (err) {
        slot.reason = err instanceof SyntaxError ? 'it is not JSON' : String(err?.message ?? err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, slots.length) }, worker));

  const chunks = slots.filter((s) => s.chunk).map((s) => s.chunk);
  // Ids must be unique in a chunk set. Items of one collection normally are;
  // where two share one, each takes its first day too.
  const count = new Map();
  for (const c of chunks) count.set(c.id, (count.get(c.id) ?? 0) + 1);
  for (const c of chunks) if (count.get(c.id) > 1) c.id = `${c.id}@${c.start}`;
  chunks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1));
  return { chunks, skipped: slots.filter((s) => !s.chunk).map((s) => ({ href: s.href, reason: s.reason ?? 'unknown' })) };
}
