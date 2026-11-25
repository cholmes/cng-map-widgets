// @cngeo/maplibre -- attribution for layers.
//
// "Attribution and share-alike are always displayed" is a rule of this
// project (design call #11). For layers MapLibre draws, the natural place is
// MapLibre's own attribution control, which shows the `attribution` string of
// every source in use -- and sets that string as HTML.
//
// A layer's attribution comes from a remote collection document. This module
// is the ONE place that text becomes markup, so it is the one place that
// escapes it, and the one place a credit's `url` is checked before it becomes
// a link. Everything else in the layer code writes text with `textContent`.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

/** An absolute http(s) URL, or null. Anything else (`javascript:`, `data:`, junk) is not linked. */
function safeHref(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Attribution entries as one line of safe HTML: `Name (LICENCE, share-alike) | …`.
 * A name links to its `url` only when that is http(s). Duplicate credits are
 * stated once. Returns `''` when there is nothing to credit.
 * @param {{ text?: string, license?: string, url?: string, shareAlike?: boolean, share_alike?: boolean }[]|undefined} attribution
 * @returns {string}
 */
export function attributionHtml(attribution) {
  const seen = new Set();
  const parts = [];
  for (const a of Array.isArray(attribution) ? attribution : []) {
    if (!a || typeof a !== 'object') continue;
    const name = typeof a.text === 'string' ? a.text.trim() : '';
    const licence = typeof a.license === 'string' ? a.license.trim() : '';
    if (!name && !licence) continue;
    const href = safeHref(a.url);
    const shareAlike = Boolean(a.shareAlike ?? a.share_alike);
    const label = name
      ? href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`
        : escapeHtml(name)
      : '';
    const terms = [licence ? escapeHtml(licence) : '', shareAlike ? 'share-alike' : ''].filter(Boolean).join(', ');
    const html = [label, terms ? `(${terms})` : ''].filter(Boolean).join(' ');
    if (seen.has(html)) continue;
    seen.add(html);
    parts.push(html);
  }
  return parts.join(' | ');
}

/**
 * A copy of a plan's sources with the layer's credit on each one that does
 * not already carry its own (a published style may credit its source itself).
 * @param {Record<string, any>} sources
 * @param {object[]} attribution
 */
export function creditSources(sources, attribution) {
  const html = attributionHtml(attribution);
  if (!html) return sources;
  return Object.fromEntries(Object.entries(sources).map(([id, def]) => [id, def.attribution ? def : { ...def, attribution: html }]));
}
