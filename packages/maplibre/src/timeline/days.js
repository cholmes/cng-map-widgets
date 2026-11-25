// @cngeo/maplibre -- the little calendar arithmetic the timeline's map side
// needs on bucket keys (`YYYYMMDD`, `YYYYMM`).
//
// `@cngeo/timeline` has the full set, and this package deliberately does not
// import it statically (a page that shows no timeline should not have to map
// it). These few are UTC-only -- `Date.UTC` in, `getUTC*` out -- so no local
// time zone can move a day.

const MS_PER_DAY = 86_400_000;
const pad = (n, width) => String(n).padStart(width, '0');

export const isBucketKey = (key) => typeof key === 'string' && /^\d{6}$|^\d{8}$/.test(key);

/** Days since 1970-01-01 of a `YYYYMMDD` key. */
export const dayNumber = (key) => Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8)) / MS_PER_DAY;

export function keyOfDayNumber(n) {
  const d = new Date(n * MS_PER_DAY);
  return pad(d.getUTCFullYear(), 4) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2);
}

const monthIndex = (key) => +key.slice(0, 4) * 12 + (+key.slice(4, 6) - 1);
const keyOfMonthIndex = (i) => pad(Math.floor(i / 12), 4) + pad((i % 12) + 1, 2);

/** How many buckets `from`..`to` holds, inclusive. */
export function bucketsBetween(from, to, unit) {
  return unit === 'month' ? monthIndex(to) - monthIndex(from) + 1 : dayNumber(to) - dayNumber(from) + 1;
}

/** Every bucket key from `from` to `to`, inclusive. */
export function keysBetween(from, to, unit) {
  const out = [];
  if (unit === 'month') for (let i = monthIndex(from); i <= monthIndex(to); i++) out.push(keyOfMonthIndex(i));
  else for (let n = dayNumber(from); n <= dayNumber(to); n++) out.push(keyOfDayNumber(n));
  return out;
}

/** The first and last day NUMBER a bucket covers. */
export function dayNumbersOfBucket(key, unit) {
  if (unit !== 'month') return [dayNumber(key), dayNumber(key)];
  const first = dayNumber(`${key}01`);
  const next = dayNumber(`${keyOfMonthIndex(monthIndex(key) + 1)}01`);
  return [first, next - 1];
}
