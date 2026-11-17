// @cng/openlayers -- pure helpers behind GeocoderControl's combobox UX:
// matched-text highlighting, friendly level labels, two-wave merge diff,
// IME composition gating, adaptive debounce. No DOM, no I/O -- unit
// tested directly in ../test/combobox-helpers.test.js.
//
// Duplicated verbatim in @cng/maplibre (see geocoder-control.js's
// DUPLICATION NOTE) rather than shared via an unpublished workspace.

// Per-char mirror of @cng/spec's normalizeName (NFD, strip \p{M},
// lowercase, drop disallowed chars) WITHOUT its trim/whitespace-collapse
// -- those would erase a lone space (normalizeName(' ') === ''), which
// breaks the char-by-char alignment below. Must track normalize.js.
function normalizeChar(ch) {
  return ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N} '-]/gu, '');
}

/**
 * Split `name` into matched/unmatched segments for bolding the part that
 * matched `queryNorm` under `matchClass` (`r.rank.matchClass`). Builds a
 * normalized-index -> source-char-index map so a match found against
 * diacritic-stripped/lowercased text slices the *original* string
 * correctly -- handles accents and non-Latin scripts without special
 * cases. For an alt-spelling row, `name` already *is* the matched
 * variant (e.g. "Zürech"), so this highlights it like any other row.
 * @returns {{ text: string, matched: boolean }[]}
 */
export function splitMatchHighlight(name, queryNorm, matchClass) {
  if (!name) return [{ text: name ?? '', matched: false }];
  if (!queryNorm || !matchClass) return [{ text: name, matched: false }];

  const chars = Array.from(name); // code points, not UTF-16 units
  let normalized = '';
  const charIndexOfNormIndex = [];
  for (let i = 0; i < chars.length; i++) {
    const normChar = normalizeChar(chars[i]);
    for (let k = 0; k < normChar.length; k++) charIndexOfNormIndex.push(i);
    normalized += normChar;
  }

  let startNorm = -1;
  if (matchClass === 'exact' || matchClass === 'prefix') {
    if (normalized.startsWith(queryNorm)) startNorm = 0;
  } else if (matchClass === 'word-prefix') {
    let pos = 0;
    for (const word of normalized.split(' ')) {
      if (word.startsWith(queryNorm)) {
        startNorm = pos;
        break;
      }
      pos += word.length + 1;
    }
  } else if (matchClass === 'substring') {
    const idx = normalized.indexOf(queryNorm);
    if (idx >= 0) startNorm = idx;
  }
  if (startNorm < 0) return [{ text: name, matched: false }];

  const endNorm = startNorm + queryNorm.length;
  const charStart = charIndexOfNormIndex[startNorm] ?? 0;
  const charEnd = endNorm >= charIndexOfNormIndex.length ? chars.length : charIndexOfNormIndex[endNorm];

  const segments = [];
  if (charStart > 0) segments.push({ text: chars.slice(0, charStart).join(''), matched: false });
  segments.push({ text: chars.slice(charStart, charEnd).join(''), matched: true });
  if (charEnd < chars.length) segments.push({ text: chars.slice(charEnd).join(''), matched: false });
  return segments;
}

// ADM0-4 -> plain English; an Overture `class` (city/town/village/hamlet)
// overrides the level when present -- a better descriptor for a locality
// than its admin level. Unknown class: shown title-cased, not dropped.
const LEVEL_LABELS = { 0: 'Country', 1: 'Region/State', 2: 'County/District', 3: 'Municipality', 4: 'Locality' };
const CLASS_LABELS = { city: 'City', town: 'Town', village: 'Village', hamlet: 'Hamlet' };

/** @param {number} level @param {string|undefined} placeClass @returns {string} */
export function friendlyLevelLabel(level, placeClass) {
  if (typeof placeClass === 'string' && placeClass.length > 0) {
    const known = CLASS_LABELS[placeClass.toLowerCase()];
    if (known) return known;
    return placeClass.charAt(0).toUpperCase() + placeClass.slice(1).toLowerCase();
  }
  return LEVEL_LABELS[level] ?? `ADM${level}`;
}

/**
 * What changed between the on-screen list and the next search wave, by
 * `featureId` -- lets the renderer flag newly-added rows and decide
 * whether to announce growth, without a full teardown/rebuild decision.
 * @template {{ featureId: string }} T
 * @param {readonly T[]} oldResults @param {readonly T[]} newResults
 * @returns {{ addedFeatureIds: Set<string>, removedFeatureIds: Set<string>, grew: boolean }}
 */
export function diffResultsForMerge(oldResults, newResults) {
  const oldIds = new Set(oldResults.map((r) => r.featureId));
  const newIds = new Set(newResults.map((r) => r.featureId));
  const addedFeatureIds = new Set();
  for (const r of newResults) if (!oldIds.has(r.featureId)) addedFeatureIds.add(r.featureId);
  const removedFeatureIds = new Set();
  for (const r of oldResults) if (!newIds.has(r.featureId)) removedFeatureIds.add(r.featureId);
  return { addedFeatureIds, removedFeatureIds, grew: newResults.length > oldResults.length };
}

/**
 * IME composition gating: no DOM dependency, so it's unit-testable with
 * synthetic events. Wire `start`/`end` to compositionstart/end; call
 * `shouldSuppress(inputEvent)` before searching on `input`. Also honors
 * an event's own `isComposing` for engines that fire a trailing `input`
 * a tick before `compositionend`.
 */
export class CompositionGate {
  constructor() {
    this._composing = false;
  }
  start() {
    this._composing = true;
  }
  end() {
    this._composing = false;
  }
  get composing() {
    return this._composing;
  }
  shouldSuppress(event) {
    return this._composing || Boolean(event && event.isComposing);
  }
}

/**
 * An explicit `debounceMs` always wins. Otherwise adapt to how the
 * loaded index answers (`geocoder.info.strategy`): a fully in-memory
 * (`'full'`) index ranks fast enough for a near-zero debounce; a
 * `'range'`-loaded index (or one not yet loaded) answers over the
 * network per query, so a longer debounce avoids a fetch per keystroke.
 * @param {'full'|'range'|undefined|null} strategy @param {number|undefined} explicitMs
 * @returns {number}
 */
export function adaptiveDebounceMs(strategy, explicitMs) {
  if (typeof explicitMs === 'number') return explicitMs;
  if (strategy === 'full') return 20;
  return 130;
}
