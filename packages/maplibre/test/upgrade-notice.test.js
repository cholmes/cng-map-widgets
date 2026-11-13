import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  upgradeNoticeReducer,
  formatMagnitude,
  describeUpgradeNotice,
  DEFAULT_UPGRADE_NOTICE_STRINGS,
  HIDDEN_NOTICE_STATE,
} from '../src/upgrade-notice.js';

// Pure state machine + formatting behind GeocoderControl's "upgradeDisplay"
// notice -- no DOM, no map, no geocoder. See geocoder-control.js for the
// wiring this drives.

test('upgradeNoticeReducer: the happy path, select -> upgrading -> upgraded', () => {
  let state = HIDDEN_NOTICE_STATE;
  state = upgradeNoticeReducer(state, { type: 'select' });
  assert.deepEqual(state, { phase: 'hidden' });

  state = upgradeNoticeReducer(state, { type: 'upgrading', estimate: { bytes: 16_000, vertices: 1000 } });
  assert.deepEqual(state, { phase: 'upgrading', estimate: { bytes: 16_000, vertices: 1000 } });

  state = upgradeNoticeReducer(state, { type: 'upgraded' });
  assert.deepEqual(state, { phase: 'upgraded' });

  state = upgradeNoticeReducer(state, { type: 'timeout' });
  assert.deepEqual(state, { phase: 'hidden' });
});

test('upgradeNoticeReducer: the cancel path', () => {
  let state = upgradeNoticeReducer(HIDDEN_NOTICE_STATE, { type: 'upgrading', estimate: {} });
  state = upgradeNoticeReducer(state, { type: 'cancelled' });
  assert.deepEqual(state, { phase: 'cancelled' });
  state = upgradeNoticeReducer(state, { type: 'timeout' });
  assert.deepEqual(state, { phase: 'hidden' });
});

test('upgradeNoticeReducer: "upgrading" with no estimate at all still carries an (empty) estimate object', () => {
  const state = upgradeNoticeReducer(HIDDEN_NOTICE_STATE, { type: 'upgrading' });
  assert.deepEqual(state, { phase: 'upgrading', estimate: {} });
});

test('upgradeNoticeReducer: "upgraded"/"cancelled" are no-ops unless a notice was actually "upgrading"', () => {
  assert.deepEqual(upgradeNoticeReducer(HIDDEN_NOTICE_STATE, { type: 'upgraded' }), HIDDEN_NOTICE_STATE);
  assert.deepEqual(upgradeNoticeReducer(HIDDEN_NOTICE_STATE, { type: 'cancelled' }), HIDDEN_NOTICE_STATE);
  const upgraded = { phase: 'upgraded' };
  assert.deepEqual(upgradeNoticeReducer(upgraded, { type: 'upgraded' }), upgraded, 'a stray second "upgraded" must not reset its own transient state');
});

test('upgradeNoticeReducer: "timeout" is a no-op while still "upgrading"', () => {
  const upgrading = { phase: 'upgrading', estimate: {} };
  assert.deepEqual(upgradeNoticeReducer(upgrading, { type: 'timeout' }), upgrading);
});

test('upgradeNoticeReducer: "select" and "dismiss" always force hidden, from any phase', () => {
  for (const state of [HIDDEN_NOTICE_STATE, { phase: 'upgrading', estimate: {} }, { phase: 'upgraded' }, { phase: 'cancelled' }]) {
    assert.deepEqual(upgradeNoticeReducer(state, { type: 'select' }), HIDDEN_NOTICE_STATE);
    assert.deepEqual(upgradeNoticeReducer(state, { type: 'dismiss' }), HIDDEN_NOTICE_STATE);
  }
});

test('formatMagnitude: below 1000 is exact', () => {
  assert.equal(formatMagnitude(0), '0');
  assert.equal(formatMagnitude(7), '7');
  assert.equal(formatMagnitude(999), '999');
});

test('formatMagnitude: K/M/B thresholds, capped at 3 significant figures', () => {
  assert.equal(formatMagnitude(1000), '1.0K');
  assert.equal(formatMagnitude(1200), '1.2K');
  assert.equal(formatMagnitude(69_000), '69K');
  assert.equal(formatMagnitude(69_499), '69K');
  assert.equal(formatMagnitude(999_999), '1000K');
  assert.equal(formatMagnitude(1_234_000), '1.2M');
  assert.equal(formatMagnitude(500_000_000), '500M');
  assert.equal(formatMagnitude(2_000_000_000), '2.0B');
});

test('formatMagnitude: non-finite or negative input is never shown as a number', () => {
  assert.equal(formatMagnitude(NaN), '');
  assert.equal(formatMagnitude(Infinity), '');
  assert.equal(formatMagnitude(-5), '');
});

test('describeUpgradeNotice: hidden renders nothing', () => {
  assert.equal(describeUpgradeNotice(HIDDEN_NOTICE_STATE), null);
});

test('describeUpgradeNotice: upgrading with a vertex estimate, default strings', () => {
  const described = describeUpgradeNotice({ phase: 'upgrading', estimate: { vertices: 69_000 } });
  assert.equal(described.text, 'Loading full detail… ~69K vertices');
  assert.equal(described.showCancel, true);
});

test('describeUpgradeNotice: upgrading with no usable estimate falls back to the no-number sentence', () => {
  assert.equal(describeUpgradeNotice({ phase: 'upgrading', estimate: {} }).text, 'Loading full detail…');
  assert.equal(describeUpgradeNotice({ phase: 'upgrading', estimate: { vertices: 0 } }).text, 'Loading full detail…');
  assert.equal(describeUpgradeNotice({ phase: 'upgrading', estimate: { vertices: -1 } }).text, 'Loading full detail…');
});

test('describeUpgradeNotice: upgraded/cancelled never show the cancel affordance', () => {
  assert.equal(describeUpgradeNotice({ phase: 'upgraded' }).showCancel, false);
  assert.equal(describeUpgradeNotice({ phase: 'cancelled' }).showCancel, false);
  assert.equal(describeUpgradeNotice({ phase: 'upgraded' }).text, DEFAULT_UPGRADE_NOTICE_STRINGS.upgraded);
  assert.equal(describeUpgradeNotice({ phase: 'cancelled' }).text, DEFAULT_UPGRADE_NOTICE_STRINGS.cancelled);
});

test('describeUpgradeNotice: i18n override replaces only the keys given, by phase', () => {
  const fr = {
    upgrading: (v) => (v ? `Chargement du détail complet… ~${v} sommets` : 'Chargement du détail complet…'),
    cancelled: 'Contour simplifié conservé.',
  };
  assert.equal(describeUpgradeNotice({ phase: 'upgrading', estimate: { vertices: 69_000 } }, fr).text, 'Chargement du détail complet… ~69K sommets');
  assert.equal(describeUpgradeNotice({ phase: 'cancelled' }, fr).text, 'Contour simplifié conservé.');
  // Untouched key still falls back to the English default.
  assert.equal(describeUpgradeNotice({ phase: 'upgraded' }, fr).text, DEFAULT_UPGRADE_NOTICE_STRINGS.upgraded);
});
