import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { findCandidateGroups, searchRangeIndex } from '../src/index.js';
import { setHyparquetModules, clearHyparquetModules } from '../src/cdn.js';

// The range strategy's row-group pruning (index-loader.js's
// findCandidateGroups) has to treat a query prefix as an INTERVAL overlap
// test against each group's [min, max] name_norm statistics, not a point-
// containment test. A typed prefix is usually not itself a stored value
// (nobody is named "californi"), so it can sort strictly between one
// group's max and the next group's min -- in the gap between two groups'
// *stored values* -- while still being the correct prefix for rows that
// live in one of those neighbouring groups. A predicate that only asks
// "is prefix within [group.min, group.max]" misses this entirely and
// would select zero groups, producing "no matches" for a prefix whose
// full word (which append-matches an existing value) works fine --
// reported live against the 5.6M-row Overture index in range mode, where
// row-group statistics make this reachable; the small geoBoundaries index
// is usually small enough to full-load, which has no stats step at all.
//
// Investigated against this exact live repro (the Overture staging index
// served locally, prefixes "californi"/"california") with both a direct
// `search()` call and simulated real keystroke typing (including the
// backspace-from-"california" sequence): both returned correct results in
// the current code, and the real row-group statistics for that index were
// found strictly ordered with no gaps the current algorithm mishandles.
// These tests exist regardless, to pin down *why* that is (a correct
// lower-bound binary search plus a forward scan that continues past the
// first candidate) and to catch a future regression toward the point-
// containment version of this bug.

afterEach(() => clearHyparquetModules());

test('findCandidateGroups: a prefix with no exact match in the data still finds the group whose rows extend it (the gap case)', () => {
  // Exactly Chris's scenario: one group ends 'califonia' (a short name,
  // nothing to do with California), the next begins 'california...', and
  // the query prefix 'californi' sorts strictly between the two group
  // boundaries -- in the gap -- while the matches live in group 2.
  const groups = [
    { min: 'aardvark', max: 'bazaar' },
    { min: 'bazaar', max: 'califonia' },
    { min: 'california', max: 'californium' },
    { min: 'californium', max: 'zoo' },
  ];
  assert.deepEqual(findCandidateGroups(groups, 'californi'), [2, 3]);
});

test('findCandidateGroups: a point-containment predicate would wrongly select zero groups here -- confirms the gap is real', () => {
  const groups = [
    { min: 'bazaar', max: 'califonia' },
    { min: 'california', max: 'californium' },
  ];
  // 'califonia' < 'californi' < 'california' is false for the naive
  // "prefix is between this group's own min and max" test on *either*
  // group (group 0's max 'califonia' < 'californi'; group 1's min
  // 'california' > 'californi' because 'californi' is a strict prefix of
  // 'california', hence sorts before it) -- a point-containment check on
  // either group alone would reject it. The interval-overlap predicate
  // this function actually implements must still select group 1.
  assert.ok('califonia' < 'californi', 'sanity: the prefix is lexically past group 0s own max');
  assert.ok('californi' < 'california', 'sanity: the prefix is lexically before group 1s own min');
  assert.deepEqual(findCandidateGroups(groups, 'californi'), [1]);
});

test('findCandidateGroups: matches spanning a row-group boundary are collected from every overlapping group, not just the first', () => {
  // "California" rows straddle the cut between groups 1 and 2 (a run of
  // identical/near-identical values split by row-group size, which is
  // exactly what the real Overture index's row-group boundaries do --
  // verified directly: many consecutive groups share an identical
  // min/max value at the cut). The scan must not stop at the first
  // candidate group.
  const groups = [
    { min: 'aardvark', max: 'bazaar' },
    { min: 'bazaar', max: 'california' },
    { min: 'california', max: 'californium' },
    { min: 'californium', max: 'zoo' },
  ];
  assert.deepEqual(findCandidateGroups(groups, 'california'), [1, 2]);
  assert.deepEqual(findCandidateGroups(groups, 'californi'), [1, 2, 3]);
});

test('findCandidateGroups: a prefix entirely between two non-adjacent groups with no overlap at all returns none of the unrelated groups', () => {
  const groups = [
    { min: 'aardvark', max: 'bazaar' },
    { min: 'california', max: 'californium' },
  ];
  assert.deepEqual(findCandidateGroups(groups, 'denmark'), []);
});

test('findCandidateGroups: an exact-value prefix at a group boundary selects both the group it ends in and any it continues into', () => {
  const groups = [
    { min: 'a', max: 'california' },
    { min: 'california', max: 'z' },
  ];
  assert.deepEqual(findCandidateGroups(groups, 'california'), [0, 1]);
});

// --- searchRangeIndex: the same gap case, end to end -----------------------

function fakeRangeHyparquet(rows) {
  return {
    hyparquet: {
      parquetReadObjects: async ({ rowStart, rowEnd }) => rows.slice(rowStart, rowEnd),
    },
    compressors: {},
  };
}

test('searchRangeIndex: resolves a gap-straddling prefix to the real matches, reading every overlapping group', async () => {
  // Row data laid out exactly like the gap scenario above: group 1 holds
  // one unrelated row plus the start of the California run, group 2 holds
  // the rest of it.
  // Ascending by name_norm, as the real file always is: "califonia creek"
  // < "california" < "californica" < "californie" (verified by the
  // sanity assertions below -- easy to get backwards by eye).
  const rows = [
    { name: 'Bazaar District', name_norm: 'bazaar district', feature_id: '1' },
    { name: 'Califonia Creek', name_norm: 'califonia creek', feature_id: '2' }, // unrelated, ends group 0
    { name: 'California', name_norm: 'california', feature_id: '3' }, // starts group 1
    { name: 'Californica', name_norm: 'californica', feature_id: '4' },
    { name: 'Californie', name_norm: 'californie', feature_id: '5' }, // starts group 2
  ];
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].name_norm < rows[i].name_norm, `fixture rows must be sorted: ${rows[i - 1].name_norm} < ${rows[i].name_norm}`);
  }
  setHyparquetModules(fakeRangeHyparquet(rows));

  const handle = {
    groups: [
      { rowStart: 0, rowEnd: 2, min: 'bazaar district', max: 'califonia creek' },
      { rowStart: 2, rowEnd: 4, min: 'california', max: 'californica' },
      { rowStart: 4, rowEnd: 5, min: 'californie', max: 'californie' },
    ],
    file: {},
    metadata: {},
    featureIdColumn: 'feature_id',
    defaultSource: undefined,
  };

  const matched = await searchRangeIndex(handle, 'californi');
  const names = matched.map((r) => r.name).sort();
  assert.deepEqual(names, ['California', 'Californica', 'Californie']);
  assert.equal(matched.some((r) => r.name === 'Califonia Creek'), false, 'the unrelated row must be excluded by the startsWith filter, not just the group pruning');
});
