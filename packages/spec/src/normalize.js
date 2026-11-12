// @cnmw/spec -- name normalization (design doc §3.2 `normalize`, §6.2
// `name_norm`).
//
// Must agree with the index builder's `name_norm`: NFD -> strip combining
// marks (\p{M}) -> lowercase -> collapse whitespace -> trim. After
// normalization the alphabet is: Unicode letters (any script), digits,
// space, '-', "'". Everything else is removed.

const COMBINING_MARKS = /\p{M}/gu;
const ALLOWED_CHARS = /[^\p{L}\p{N} '-]/gu;
const WHITESPACE = /\s+/g;

/**
 * Normalize a display name into the sort/search key used by the index
 * builder and by every in-memory comparison in geocoder-core.
 * @param {string} input
 * @returns {string}
 */
export function normalizeName(input) {
  return input
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(ALLOWED_CHARS, '')
    .replace(WHITESPACE, ' ')
    .trim();
}
