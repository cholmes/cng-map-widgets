// @cng/openlayers -- pure state machine + formatting behind the
// "upgradeDisplay" background-fetch notice (design doc §1.3/§3.2
// amendment, "fetch higher-resolution vectors in the background, tell the
// user, let them cancel"). No DOM, no timers, no I/O -- unit tested
// directly in ../test/upgrade-notice.test.js, same split as
// ./combobox-helpers.js.
//
// Duplicated verbatim from @cng/maplibre (see geocoder-control.js's
// DUPLICATION NOTE) rather than shared via an unpublished workspace.

/**
 * @typedef {
 *   { phase: 'hidden' } |
 *   { phase: 'upgrading', estimate: { bytes?: number, vertices?: number } } |
 *   { phase: 'upgraded' } |
 *   { phase: 'cancelled' }
 * } UpgradeNoticeState
 */

export const HIDDEN_NOTICE_STATE = Object.freeze({ phase: 'hidden' });

/**
 * One state transition. Pure: the same `(state, event)` pair always
 * yields the same next state object, and nothing here touches the DOM, a
 * timer, or the network -- `geocoder-control.js` is the only thing that
 * ever calls `setTimeout`/renders this to a notice element.
 *
 * Events, each corresponding to something `GeocoderControl` observes:
 *  - `'select'`     a new `select()` call started (its own `'select'`
 *                    event, which fires synchronously *before*
 *                    `'area:upgrading'` for that same call) -- always
 *                    resets to hidden, since a new selection supersedes
 *                    whatever upgrade the old one had pending.
 *  - `'upgrading'`   `'area:upgrading'` fired: a background full-res
 *                    fetch just started. Carries `estimate`.
 *  - `'upgraded'`    `'area:upgraded'` fired: the fetch finished.
 *  - `'cancelled'`   `'area:upgrade-cancelled'` fired: the user cancelled it.
 *  - `'dismiss'`     the user closed the notice by hand (the × with no
 *                    cancel semantics left, i.e. after 'upgraded'/'cancelled').
 *  - `'timeout'`     the transient 'upgraded'/'cancelled' notice's
 *                    auto-hide elapsed.
 * @param {UpgradeNoticeState} state
 * @param {{ type: 'select'|'upgrading'|'upgraded'|'cancelled'|'dismiss'|'timeout', estimate?: { bytes?: number, vertices?: number } }} event
 * @returns {UpgradeNoticeState}
 */
export function upgradeNoticeReducer(state, event) {
  switch (event.type) {
    case 'select':
    case 'dismiss':
      return HIDDEN_NOTICE_STATE;
    case 'upgrading':
      return { phase: 'upgrading', estimate: event.estimate ?? {} };
    case 'upgraded':
      // Only a notice that was actually tracking an in-flight upgrade
      // advances to "done". Defensive, not reachable through
      // GeocoderControl's own wiring today (it gates the event on
      // `area.id` before ever dispatching here), but a reducer this
      // small costs nothing to make correct on its own terms too.
      return state.phase === 'upgrading' ? { phase: 'upgraded' } : state;
    case 'cancelled':
      return state.phase === 'upgrading' ? { phase: 'cancelled' } : state;
    case 'timeout':
      return state.phase === 'upgraded' || state.phase === 'cancelled' ? HIDDEN_NOTICE_STATE : state;
    default:
      return state;
  }
}

/**
 * Short, locale-agnostic magnitude label: `999` -> `"999"`, `1200` ->
 * `"1.2K"`, `69000` -> `"69K"`, `1234000` -> `"1.2M"`. Capped at 3
 * significant figures deliberately: the input is always a cheap
 * *estimate* (geocoder-core's `estimateUpgradeOf`, an average over an
 * entire boundary file, not this feature's real vertex count), and a
 * precise-looking `"68,973"` would overstate how much is actually known
 * before the fetch lands.
 * @param {number} n
 * @returns {string}
 */
export function formatMagnitude(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return String(Math.round(n));
  const units = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  for (const [threshold, suffix] of units) {
    if (n >= threshold) {
      const value = n / threshold;
      return `${value.toFixed(value < 10 ? 1 : 0)}${suffix}`;
    }
  }
  return String(Math.round(n)); // unreachable (n >= 1000 above), kept for type-safety
}

/**
 * Default, English, i18n-override-able strings. A host overrides any
 * subset via `GeocoderControlOptions.upgradeNoticeStrings`; unset keys
 * fall back to these (see `describeUpgradeNotice`'s merge). `upgrading`
 * is a function, not a string, because it has to thread the formatted
 * estimate label through -- `vertexLabel` is `''` when no estimate was
 * available, so a translation can and should render a shorter sentence
 * for that case rather than leaving an awkward blank.
 */
export const DEFAULT_UPGRADE_NOTICE_STRINGS = {
  upgrading: (vertexLabel) => (vertexLabel ? `Loading full detail… ~${vertexLabel} vertices` : 'Loading full detail…'),
  upgraded: 'Full detail loaded.',
  cancelled: 'Keeping simplified outline.',
  cancelLabel: '×',
  cancelTitle: 'Cancel and keep the simplified outline',
};

/**
 * Resolve one notice state to displayable text, or `null` when nothing
 * should render (`'hidden'`). `showCancel` is true only while an upgrade
 * is actually in flight -- there is nothing left to cancel once it has
 * finished or already been cancelled.
 * @param {UpgradeNoticeState} state
 * @param {Partial<typeof DEFAULT_UPGRADE_NOTICE_STRINGS>} [stringsOverride]
 * @returns {{ text: string, showCancel: boolean } | null}
 */
export function describeUpgradeNotice(state, stringsOverride) {
  const strings = { ...DEFAULT_UPGRADE_NOTICE_STRINGS, ...stringsOverride };
  if (state.phase === 'upgrading') {
    const vertices = state.estimate?.vertices;
    const vertexLabel = typeof vertices === 'number' && vertices > 0 ? formatMagnitude(vertices) : '';
    return { text: strings.upgrading(vertexLabel), showCancel: true };
  }
  if (state.phase === 'upgraded') return { text: strings.upgraded, showCancel: false };
  if (state.phase === 'cancelled') return { text: strings.cancelled, showCancel: false };
  return null;
}
