// @cng/maplibre -- unit tests for the pure combobox UX-polish helpers
// (no DOM required: see combobox-helpers.js's own header for why these
// are factored out as pure functions).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitMatchHighlight,
  friendlyLevelLabel,
  diffResultsForMerge,
  CompositionGate,
  adaptiveDebounceMs,
} from '../src/combobox-helpers.js';

test('splitMatchHighlight: prefix match on plain ASCII', () => {
  assert.deepEqual(splitMatchHighlight('Paris', 'par', 'prefix'), [
    { text: 'Par', matched: true },
    { text: 'is', matched: false },
  ]);
});

test('splitMatchHighlight: exact match highlights the whole name', () => {
  assert.deepEqual(splitMatchHighlight('Paris', 'paris', 'exact'), [{ text: 'Paris', matched: true }]);
});

test('splitMatchHighlight: diacritic-insensitive prefix match maps back onto the accented original', () => {
  // The index's name_norm strips the umlaut (query "zur" vs name_norm
  // "zurich"), but the highlighted span must land on "Zür" in the
  // original display string, not "Zur".
  assert.deepEqual(splitMatchHighlight('Zürich', 'zur', 'prefix'), [
    { text: 'Zür', matched: true },
    { text: 'ich', matched: false },
  ]);
});

test('splitMatchHighlight: the "matched \'Zürech\'" alt-spelling case -- the alt row\'s own name highlights like any other', () => {
  // A row for an alt spelling of Zurich carries `name: 'Zürech'` as its
  // own display name (see geocoder.js's `isAlt`/`alt_of` handling) --
  // highlighting treats it exactly like a primary row's name.
  assert.deepEqual(splitMatchHighlight('Zürech', 'zur', 'prefix'), [
    { text: 'Zür', matched: true },
    { text: 'ech', matched: false },
  ]);
});

test('splitMatchHighlight: CJK names (no case/diacritics, but still must slice correctly)', () => {
  assert.deepEqual(splitMatchHighlight('中文名字', '文', 'substring'), [
    { text: '中', matched: false },
    { text: '文', matched: true },
    { text: '名字', matched: false },
  ]);
});

test('splitMatchHighlight: word-prefix match highlights the matched word, not the first', () => {
  assert.deepEqual(splitMatchHighlight('San Francisco', 'fra', 'word-prefix'), [
    { text: 'San ', matched: false },
    { text: 'Fra', matched: true },
    { text: 'ncisco', matched: false },
  ]);
});

test('splitMatchHighlight: substring match in the middle of the name', () => {
  assert.deepEqual(splitMatchHighlight('Contra Costa', 'ra co', 'substring'), [
    { text: 'Cont', matched: false },
    { text: 'ra Co', matched: true },
    { text: 'sta', matched: false },
  ]);
});

test('splitMatchHighlight: apostrophe/punctuation in the name is preserved around the match', () => {
  assert.deepEqual(splitMatchHighlight("O'Brien", 'brien', 'substring'), [
    { text: "O'", matched: false },
    { text: 'Brien', matched: true },
  ]);
});

test('splitMatchHighlight: no match found returns a single unmatched segment', () => {
  assert.deepEqual(splitMatchHighlight('Nothing', 'zzz', 'prefix'), [{ text: 'Nothing', matched: false }]);
});

test('splitMatchHighlight: falsy inputs degrade to an unmatched segment rather than throwing', () => {
  assert.deepEqual(splitMatchHighlight('', 'x', 'prefix'), [{ text: '', matched: false }]);
  assert.deepEqual(splitMatchHighlight('Paris', '', 'prefix'), [{ text: 'Paris', matched: false }]);
  assert.deepEqual(splitMatchHighlight('Paris', 'par', null), [{ text: 'Paris', matched: false }]);
});

test('friendlyLevelLabel: ADM0-4 default ladder', () => {
  assert.equal(friendlyLevelLabel(0), 'Country');
  assert.equal(friendlyLevelLabel(1), 'Region/State');
  assert.equal(friendlyLevelLabel(2), 'County/District');
  assert.equal(friendlyLevelLabel(3), 'Municipality');
  assert.equal(friendlyLevelLabel(4), 'Locality');
});

test('friendlyLevelLabel: an unrecognized level falls back to the raw ADM spelling', () => {
  assert.equal(friendlyLevelLabel(9), 'ADM9');
});

test('friendlyLevelLabel: an Overture class overrides the level label', () => {
  assert.equal(friendlyLevelLabel(2, 'city'), 'City');
  assert.equal(friendlyLevelLabel(4, 'hamlet'), 'Hamlet');
  assert.equal(friendlyLevelLabel(3, 'TOWN'), 'Town'); // case-insensitive lookup
});

test('friendlyLevelLabel: an unrecognized class string is still shown (title-cased) rather than dropped', () => {
  assert.equal(friendlyLevelLabel(2, 'suburb'), 'Suburb');
});

test('diffResultsForMerge: detects rows added by the second wave', () => {
  const prominent = [{ featureId: 'a' }, { featureId: 'b' }];
  const final = [{ featureId: 'a' }, { featureId: 'b' }, { featureId: 'c' }];
  const diff = diffResultsForMerge(prominent, final);
  assert.deepEqual([...diff.addedFeatureIds], ['c']);
  assert.deepEqual([...diff.removedFeatureIds], []);
  assert.equal(diff.grew, true);
});

test('diffResultsForMerge: a pure re-rank with no new rows reports no additions and no growth', () => {
  const prominent = [{ featureId: 'a' }, { featureId: 'b' }];
  const final = [{ featureId: 'b' }, { featureId: 'a' }]; // same set, reordered
  const diff = diffResultsForMerge(prominent, final);
  assert.equal(diff.addedFeatureIds.size, 0);
  assert.equal(diff.removedFeatureIds.size, 0);
  assert.equal(diff.grew, false);
});

test('diffResultsForMerge: a final wave can also drop a row the prominent wave had (diversity re-capping)', () => {
  const prominent = [{ featureId: 'a' }, { featureId: 'b' }];
  const final = [{ featureId: 'a' }, { featureId: 'c' }];
  const diff = diffResultsForMerge(prominent, final);
  assert.deepEqual([...diff.addedFeatureIds], ['c']);
  assert.deepEqual([...diff.removedFeatureIds], ['b']);
});

test('CompositionGate: suppresses while composing, stops once ended', () => {
  const gate = new CompositionGate();
  assert.equal(gate.shouldSuppress(), false);
  gate.start();
  assert.equal(gate.composing, true);
  assert.equal(gate.shouldSuppress(), true);
  gate.end();
  assert.equal(gate.composing, false);
  assert.equal(gate.shouldSuppress(), false);
});

test('CompositionGate: also suppresses on a synthetic event whose own isComposing is true, even if start() was never called', () => {
  const gate = new CompositionGate();
  assert.equal(gate.shouldSuppress({ isComposing: true }), true);
  assert.equal(gate.shouldSuppress({ isComposing: false }), false);
  assert.equal(gate.shouldSuppress(undefined), false);
});

test('CompositionGate: a realistic compositionstart/input*/compositionend sequence for 中文 input only searches once, at the end', () => {
  const gate = new CompositionGate();
  const searchedQueries = [];
  function onInput(value, event) {
    if (gate.shouldSuppress(event)) return;
    searchedQueries.push(value);
  }

  gate.start();
  onInput('中', { isComposing: true });
  onInput('中文', { isComposing: true });
  gate.end();
  onInput('中文', { isComposing: false }); // compositionend's own follow-up input fires after end()

  assert.deepEqual(searchedQueries, ['中文']);
});

test('adaptiveDebounceMs: an explicit override always wins', () => {
  assert.equal(adaptiveDebounceMs('full', 999), 999);
  assert.equal(adaptiveDebounceMs('range', 0), 0);
  assert.equal(adaptiveDebounceMs(undefined, 50), 50);
});

test('adaptiveDebounceMs: a fully in-memory index gets a near-zero debounce', () => {
  assert.equal(adaptiveDebounceMs('full'), 20);
});

test('adaptiveDebounceMs: a range-loaded (or not-yet-known) index gets the longer, network-friendly debounce', () => {
  assert.equal(adaptiveDebounceMs('range'), 130);
  assert.equal(adaptiveDebounceMs(undefined), 130);
  assert.equal(adaptiveDebounceMs(null), 130);
});
