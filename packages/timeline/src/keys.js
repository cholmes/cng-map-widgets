// @cngeo/timeline -- bucket keys.
//
// A bucket key is the calendar day or month a count belongs to, as digits:
// `YYYYMMDD` on a daily axis, `YYYYMM` on a monthly one. Four digits are
// deliberately not a unit -- `0101` could be a month-day or a year.
//
// `Date` is avoided for the arithmetic on purpose. Every path through it is
// timezone-sensitive, and a bucket key names a calendar day, not an instant:
// getting that wrong shifts a whole axis by one bucket west of UTC.
//
// Ported from firms-catalog's apps/firms-explorer/timeline.js.

import { CngError } from '@cngeo/spec';

const UNITS = { month: { digits: 6 }, day: { digits: 8 } };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const invalid = (message, context) => new CngError(message, 'TIMELINE_INVALID', { retryable: false, context });
const pad = (n, width) => String(n).padStart(width, '0');

/** Days since 1970-01-01, by Hinnant's civil-calendar algorithm. */
export function daysFromCivil(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse: `[year, month, day]`. */
export function civilFromDays(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

/** Absolute ordinal of a bucket key: months since year 0, or days since the epoch. */
export function keyIndex(key, unit) {
  const u = UNITS[unit];
  if (!u) throw invalid(`unknown bucket unit ${JSON.stringify(unit)}`, { unit });
  if (typeof key !== 'string' || key.length !== u.digits || !/^\d+$/.test(key)) {
    throw invalid(`${unit} bucket key must be ${u.digits} digits, got ${JSON.stringify(key)}`, { key, unit });
  }
  const y = +key.slice(0, 4);
  const m = +key.slice(4, 6);
  if (m < 1 || m > 12) throw invalid(`bucket key ${key} has no month ${m}`, { key, unit });
  if (unit === 'month') return y * 12 + (m - 1);
  const d = +key.slice(6, 8);
  if (d < 1 || d > 31) throw invalid(`bucket key ${key} has no day ${d}`, { key, unit });
  return daysFromCivil(y, m, d);
}

/** Inverse of `keyIndex`. */
export function indexKey(index, unit) {
  const i = Math.round(index);
  if (unit === 'month') {
    const y = Math.floor(i / 12);
    return pad(y, 4) + pad(i - y * 12 + 1, 2);
  }
  if (unit !== 'day') throw invalid(`unknown bucket unit ${JSON.stringify(unit)}`, { unit });
  const [y, m, d] = civilFromDays(i);
  return pad(y, 4) + pad(m, 2) + pad(d, 2);
}

/**
 * Order two bucket keys. Keys of one unit are fixed-width and zero-padded, so
 * string order is calendar order; the width test only stops a monthly key
 * being compared against a daily one and silently winning.
 */
export function compareKeys(a, b) {
  if (a.length !== b.length) throw invalid(`cannot compare ${a} with ${b}: different bucket units`, { a, b });
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `'day'` or `'month'`, by the key's width. */
export function unitOfKey(key) {
  const k = String(key);
  if (/^\d{8}$/.test(k)) return 'day';
  if (/^\d{6}$/.test(k)) return 'month';
  throw invalid(`${JSON.stringify(key)} is not a bucket key (YYYYMMDD or YYYYMM)`, { key });
}

/** A bucket key as a person reads it: "Nov 2000", "5 Jul 2020". */
export function formatKey(key, unit) {
  if (key === null || key === undefined) return '';
  const k = String(key);
  if (unit === 'month') return `${MONTHS[+k.slice(4, 6) - 1]} ${k.slice(0, 4)}`;
  return `${+k.slice(6, 8)} ${MONTHS[+k.slice(4, 6) - 1]} ${k.slice(0, 4)}`;
}

/** A bucket key as an `<input type="month"|"date">` wants it. */
export function keyToISO(key, unit) {
  const k = String(key);
  return unit === 'month' ? `${k.slice(0, 4)}-${k.slice(4, 6)}` : `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
}

/** The inverse. Null when the value is not a complete date. */
export function isoToKey(iso, unit) {
  if (!iso) return null;
  const digits = String(iso).replace(/-/g, '');
  const want = unit === 'month' ? 6 : 8;
  return digits.length === want && /^\d+$/.test(digits) ? digits : null;
}

/** The first and last calendar day a bucket covers, as day keys. */
export function dayRangeOfKey(key, unit) {
  const k = String(key);
  if (unit === 'day') return [k, k];
  const next = keyIndex(k, 'month') + 1;
  const firstOfNext = keyIndex(`${indexKey(next, 'month')}01`, 'day');
  return [`${k}01`, indexKey(firstOfNext - 1, 'day')];
}

/** The bucket of `unit` a day falls in. */
export function bucketKeyOfDay(dayKey, unit) {
  return unit === 'month' ? String(dayKey).slice(0, 6) : String(dayKey);
}

const ZONELESS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
/**
 * A date-time that names no zone, made explicit as UTC. `Date.parse` reads
 * `2024-01-01T00:00:00` in the MACHINE's zone, so the same file would give
 * 31 December to a reader in Berlin and 1 January to one in London.
 */
const asUtc = (text) => (ZONELESS.test(text) ? `${text.replace(' ', 'T')}Z` : text);

/**
 * The UTC calendar day of a date, as a day key: from an ISO string, a `Date`,
 * or a day key (returned as it is). A date-time with no zone is taken as UTC.
 * Null when it is not a date.
 */
export function dayKeyOfDate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && /^\d{8}$/.test(value)) return value;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(asUtc(value)) : NaN;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return pad(d.getUTCFullYear(), 4) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2);
}

/** A day key `n` days later (or earlier). */
export function addDays(dayKey, n) {
  return indexKey(keyIndex(dayKey, 'day') + n, 'day');
}
