import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { geometryRefRowRange, firstMatch, resolveGeometry, openBoundaryFile } from '../src/index.js';
import { setHyparquetModules, clearHyparquetModules } from '../src/cdn.js';

// geometry-resolver.js's select()-fast-path task: the ref arithmetic
// (geometryRefRowRange), the bounded-concurrency "stop on first match"
// scan (firstMatch), and resolveGeometry's end-to-end wiring of both --
// a geometry_ref hit skips the stats-pruning scan entirely, and a
// geometry_ref miss (a stale/rebuilt boundary file) falls back to it with
// a warning, never trusting the hint past the point it stopped matching.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => clearHyparquetModules());

// --- geometryRefRowRange: pure row-group arithmetic -----------------------

test('geometryRefRowRange: valid ref returns the single-row range and its row group', () => {
  assert.deepEqual(geometryRefRowRange({ file: 'x', rowGroup: 2, row: 1034 }, 512), {
    rowStart: 1034,
    rowEnd: 1035,
    rowGroup: 2,
  });
});

test('geometryRefRowRange: recomputes the row group even when the ref omits it', () => {
  assert.deepEqual(geometryRefRowRange({ row: 1034 }, 512), { rowStart: 1034, rowEnd: 1035, rowGroup: 2 });
});

test('geometryRefRowRange: refuses a ref whose own row_group disagrees with floor(row / row_group_rows)', () => {
  // Exactly the corrupt/incompatibly-rebuilt case this check exists to
  // catch before spending a network round trip on it.
  assert.equal(geometryRefRowRange({ rowGroup: 999, row: 1034 }, 512), null);
});

test('geometryRefRowRange: no geometry_ref at all -> null', () => {
  assert.equal(geometryRefRowRange(undefined, 512), null);
  assert.equal(geometryRefRowRange(null, 512), null);
});

test('geometryRefRowRange: no row_group_rows on the manifest entry -> null (older manifest, no fast path)', () => {
  assert.equal(geometryRefRowRange({ row: 10 }, undefined), null);
  assert.equal(geometryRefRowRange({ row: 10 }, 0), null);
  assert.equal(geometryRefRowRange({ row: 10 }, -1), null);
});

test('geometryRefRowRange: a negative or non-integer row is never trusted', () => {
  assert.equal(geometryRefRowRange({ row: -1 }, 512), null);
  assert.equal(geometryRefRowRange({ row: 1.5 }, 512), null);
});

// Regression: confirmed directly against the live geoboundaries-catalog
// index that hyparquet decodes geometry_ref.row (parquet INT64) as BigInt,
// not number (e.g. `{ row: 10992n }`). A naive Number.isInteger(row) check
// returns false for a BigInt, so without this handling the fast path would
// silently never fire on any real row -- exactly the measured-slow
// behaviour (5.6-28.2s live) this task exists to fix.
test('geometryRefRowRange: row and row_group arriving as BigInt (hyparquet\'s real INT64 decode) are still trusted', () => {
  assert.deepEqual(geometryRefRowRange({ rowGroup: 21, row: 10992n }, 512), { rowStart: 10992, rowEnd: 10993, rowGroup: 21 });
  assert.deepEqual(geometryRefRowRange({ rowGroup: 21n, row: 10992n }, 512), { rowStart: 10992, rowEnd: 10993, rowGroup: 21 });
});

test('geometryRefRowRange: refuses a BigInt row too large to convert to Number without losing precision', () => {
  assert.equal(geometryRefRowRange({ row: 2n ** 60n }, 512), null);
});

test('geometryRefRowRange: a BigInt row_group that disagrees with the computed one is still refused', () => {
  assert.equal(geometryRefRowRange({ rowGroup: 999n, row: 10992n }, 512), null);
});

// --- firstMatch: bounded-concurrency "stop on first match" ----------------

test('firstMatch: never runs more than `concurrency` tasks at once', async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  let active = 0;
  let maxActive = 0;
  const result = await firstMatch(items, 4, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(5);
    active--;
    return null; // never matches: forces a full scan of all 12 items
  });
  assert.equal(result, null);
  assert.equal(maxActive, 4, `expected the concurrency limit to bind at 4, got max ${maxActive}`);
});

test('firstMatch: stops dispatching further items once a match is found', async () => {
  const dispatched = [];
  const items = [0, 1, 2, 3, 4, 5];
  const result = await firstMatch(items, 2, async (i) => {
    dispatched.push(i);
    if (i === 0) {
      await delay(30); // still "in flight" when item 1 wins below
      return null;
    }
    if (i === 1) {
      await delay(5); // resolves well before item 0
      return { winner: i };
    }
    throw new Error(`item ${i} should never have been dispatched -- the race was already won`);
  });
  assert.deepEqual(result, { winner: 1 });
  assert.deepEqual([...dispatched].sort((a, b) => a - b), [0, 1]);
});

test('firstMatch: an empty item list resolves to null without calling task', async () => {
  let called = false;
  const result = await firstMatch([], 4, async () => {
    called = true;
    return 'x';
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test('firstMatch: a real failure (not a "no match") on one task propagates, matching the pre-existing sequential scan', async () => {
  await assert.rejects(
    () => firstMatch([1, 2, 3], 3, async (i) => {
      if (i === 2) throw new Error('network blew up');
      await delay(10);
      return null;
    }),
    /network blew up/,
  );
});

// --- resolveGeometry: the fast path wired end to end -----------------------

/** Minimal little-endian WKB for a one-ring Polygon (same recipe as
 * packages/spec/test/wkb.test.js's helper, duplicated here so this test
 * stays self-contained). */
function wkbPolygon(ring) {
  const numPoints = ring.length;
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + numPoints * 16);
  const view = new DataView(buf);
  let o = 0;
  view.setUint8(o, 1); o += 1;
  view.setUint32(o, 3, true); o += 4; // Polygon
  view.setUint32(o, 1, true); o += 4; // 1 ring
  view.setUint32(o, numPoints, true); o += 4;
  for (const [x, y] of ring) {
    view.setFloat64(o, x, true); o += 8;
    view.setFloat64(o, y, true); o += 8;
  }
  return new Uint8Array(buf);
}

const SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

/**
 * A fake hyparquet module backing one in-memory "boundary file": `rows` is
 * the ground truth, in row order; row groups are carved out every
 * `rowGroupRows` rows with min/max statistics computed from the actual
 * data (so a test that moves a shapeID to a different row automatically
 * gets correct, consistent statistics). Every `parquetReadObjects` call is
 * recorded in `.calls` so a test can assert how many (and which) reads
 * actually happened -- the whole point of the fast path is reading less.
 */
function fakeBoundary({ rows, rowGroupRows, joinColumn, countryColumn = 'country', catalogVersion = null }) {
  const rowGroups = [];
  for (let start = 0; start < rows.length; start += rowGroupRows) {
    const slice = rows.slice(start, start + rowGroupRows);
    const joinVals = slice.map((r) => r[joinColumn]).sort();
    const countryVals = slice.map((r) => r[countryColumn]).sort();
    const columns = [{ meta_data: { path_in_schema: [joinColumn], statistics: { min_value: joinVals[0], max_value: joinVals[joinVals.length - 1] } } }];
    if (countryColumn !== joinColumn) {
      columns.push({ meta_data: { path_in_schema: [countryColumn], statistics: { min_value: countryVals[0], max_value: countryVals[countryVals.length - 1] } } });
    }
    rowGroups.push({ num_rows: slice.length, columns });
  }
  const calls = [];
  const hyparquet = {
    asyncBufferFromUrl: async () => ({ __fake: true }),
    parquetMetadataAsync: async () => ({
      row_groups: rowGroups,
      key_value_metadata: catalogVersion ? [{ key: 'cng:catalog_version', value: catalogVersion }] : [],
    }),
    parquetReadObjects: async ({ columns, rowStart, rowEnd }) => {
      calls.push({ columns: [...columns], rowStart, rowEnd });
      return rows.slice(rowStart, rowEnd).map((r) => {
        const out = {};
        for (const c of columns) out[c] = r[c];
        return out;
      });
    },
  };
  return { hyparquet, compressors: {}, calls, rowGroupCount: rowGroups.length };
}

function makeRows(n, { joinColumn, decoyAt } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    [joinColumn]: i === decoyAt ? 'DECOY' : `A${String(i).padStart(2, '0')}`,
    country: 'ZZZ',
    bbox: { xmin: i, ymin: i, xmax: i + 1, ymax: i + 1 },
    geometry: wkbPolygon(SQUARE),
  }));
}

const BASE_ENTRY = { feature_id_column: 'shapeID', country_column: 'country', row_group_rows: 4 };

test('resolveGeometry: geometry_ref fast path resolves with no stats-pruning scan at all', async () => {
  const rows = makeRows(12, { joinColumn: 'shapeID' });
  const boundary = fakeBoundary({ rows, rowGroupRows: 4, joinColumn: 'shapeID' });
  setHyparquetModules({ hyparquet: boundary.hyparquet, compressors: boundary.compressors });

  const result = { featureId: 'A07', country: 'ZZZ', level: 2, geometryRef: { file: 'cgaz_adm2.parquet', rowGroup: 1, row: 7 } };
  const area = await resolveGeometry(result, 'https://example.test/adm2.parquet', null, async () => {}, 'error', null, { entry: BASE_ENTRY });

  assert.equal(area.geometry.type, 'Polygon');
  assert.deepEqual(area.bbox, [7, 7, 8, 8]);
  // Exactly two reads: the single-row join/bbox verification, then the
  // single-row geometry fetch. Nothing resembling a row-group scan (which
  // would read 4+ rows per call) ever happened.
  assert.equal(boundary.calls.length, 2, `expected 2 reads, got ${boundary.calls.length}: ${JSON.stringify(boundary.calls)}`);
  for (const call of boundary.calls) {
    assert.equal(call.rowEnd - call.rowStart, 1, 'every read on the fast path is exactly one row');
  }
});

test('resolveGeometry: fast path works with a BigInt geometryRef.row, matching hyparquet\'s real INT64 decode', async () => {
  const rows = makeRows(12, { joinColumn: 'shapeID' });
  const boundary = fakeBoundary({ rows, rowGroupRows: 4, joinColumn: 'shapeID' });
  setHyparquetModules({ hyparquet: boundary.hyparquet, compressors: boundary.compressors });

  const result = { featureId: 'A07', country: 'ZZZ', level: 2, geometryRef: { file: 'cgaz_adm2.parquet', rowGroup: 1, row: 7n } };
  const area = await resolveGeometry(result, 'https://example.test/adm2.parquet', null, async () => {}, 'error', null, { entry: BASE_ENTRY });

  assert.deepEqual(area.bbox, [7, 7, 8, 8]);
  assert.equal(boundary.calls.length, 2, 'the BigInt row must still take the 2-read fast path, not fall back');
});

test('resolveGeometry: a stale geometry_ref (wrong row) is never trusted -- falls back to the stats-pruning scan and still resolves correctly', async () => {
  // The boundary file has been rebuilt/resorted since the names index was
  // built: row 7 used to hold A07, but now holds a different unit, and A07
  // has moved to row 9. geometry_ref still says row 7 (stale).
  const rows = makeRows(12, { joinColumn: 'shapeID', decoyAt: 7 });
  rows[9].shapeID = 'A07'; // A07 now lives at row 9, not row 7
  const boundary = fakeBoundary({ rows, rowGroupRows: 4, joinColumn: 'shapeID' });
  setHyparquetModules({ hyparquet: boundary.hyparquet, compressors: boundary.compressors });

  const warnings = [];
  const result = { featureId: 'A07', country: 'ZZZ', level: 2, geometryRef: { file: 'cgaz_adm2.parquet', rowGroup: 1, row: 7 } };
  const area = await resolveGeometry(
    result, 'https://example.test/adm2.parquet', null, async () => {}, 'error',
    (w) => warnings.push(w), { entry: BASE_ENTRY },
  );

  assert.equal(area.geometry.type, 'Polygon');
  assert.deepEqual(area.bbox, [9, 9, 10, 10], 'must resolve to row 9, where A07 actually is -- never the stale row 7');

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'GEOMETRY_REF_MISMATCH');
  assert.equal(warnings[0].detail.joinValue, 'A07');

  // The fallback actually ran: more than the fast path's 2 single-row
  // reads happened (the mismatch check, then >=1 row-group scan read, then
  // the final geometry read).
  assert.ok(boundary.calls.length >= 3, `expected the fallback scan to add reads, got ${boundary.calls.length}`);
});

test('resolveGeometry: no row_group_rows on the manifest entry skips the fast path even with a geometry_ref present (older manifest)', async () => {
  const rows = makeRows(12, { joinColumn: 'shapeID' });
  const boundary = fakeBoundary({ rows, rowGroupRows: 4, joinColumn: 'shapeID' });
  setHyparquetModules({ hyparquet: boundary.hyparquet, compressors: boundary.compressors });

  const entryNoRowGroupRows = { feature_id_column: 'shapeID', country_column: 'country' };
  const result = { featureId: 'A07', country: 'ZZZ', level: 2, geometryRef: { file: 'cgaz_adm2.parquet', rowGroup: 1, row: 7 } };
  const area = await resolveGeometry(result, 'https://example.test/adm2.parquet', null, async () => {}, 'error', null, { entry: entryNoRowGroupRows });

  assert.deepEqual(area.bbox, [7, 7, 8, 8]);
  // Every read is a row-group-sized read (4 rows), never a single-row fast-path read.
  assert.ok(boundary.calls.some((c) => c.rowEnd - c.rowStart === 4), 'should have fallen back to row-group-granularity reads');
});

test('resolveGeometry: no geometry_ref on the result at all behaves exactly like the pre-fast-path scan', async () => {
  const rows = makeRows(12, { joinColumn: 'shapeID' });
  const boundary = fakeBoundary({ rows, rowGroupRows: 4, joinColumn: 'shapeID' });
  setHyparquetModules({ hyparquet: boundary.hyparquet, compressors: boundary.compressors });

  const result = { featureId: 'A11', country: 'ZZZ', level: 2 }; // no geometryRef
  const area = await resolveGeometry(result, 'https://example.test/adm2.parquet', null, async () => {}, 'error', null, { entry: BASE_ENTRY });

  assert.deepEqual(area.bbox, [11, 11, 12, 12]);
});

test('resolveGeometry: unmatched feature throws GEOMETRY_NOT_FOUND after exhausting the fallback scan', async () => {
  const rows = makeRows(8, { joinColumn: 'shapeID' });
  const boundary = fakeBoundary({ rows, rowGroupRows: 4, joinColumn: 'shapeID' });
  setHyparquetModules({ hyparquet: boundary.hyparquet, compressors: boundary.compressors });

  const result = { featureId: 'NOPE', country: 'ZZZ', level: 2 };
  await assert.rejects(
    () => resolveGeometry(result, 'https://example.test/adm2.parquet', null, async () => {}, 'error', null, { entry: BASE_ENTRY }),
    (err) => {
      assert.equal(err.code, 'GEOMETRY_NOT_FOUND');
      return true;
    },
  );
});

// --- openBoundaryFile: footer_bytes (manifest contract addition, task 1) --

test('openBoundaryFile: footer_bytes is threaded through as hyparquet\'s initialFetchSize', async () => {
  const seenOptions = [];
  const fakeHyparquet = {
    asyncBufferFromUrl: async () => ({ __fake: true }),
    parquetMetadataAsync: async (file, options) => {
      seenOptions.push(options);
      return { row_groups: [], key_value_metadata: [] };
    },
  };
  setHyparquetModules({ hyparquet: fakeHyparquet, compressors: {} });

  await openBoundaryFile('https://example.test/adm2.parquet', async () => {}, undefined, 24_576);
  assert.deepEqual(seenOptions[0], { geoparquet: false, initialFetchSize: 24_576 });
});

test('openBoundaryFile: no footer_bytes falls back to hyparquet\'s own default (an older manifest)', async () => {
  const seenOptions = [];
  const fakeHyparquet = {
    asyncBufferFromUrl: async () => ({ __fake: true }),
    parquetMetadataAsync: async (file, options) => {
      seenOptions.push(options);
      return { row_groups: [], key_value_metadata: [] };
    },
  };
  setHyparquetModules({ hyparquet: fakeHyparquet, compressors: {} });

  await openBoundaryFile('https://example.test/adm2.parquet', async () => {});
  assert.deepEqual(seenOptions[0], { geoparquet: false }, 'no initialFetchSize override: hyparquet uses its own 512KB default');
});

// --- resolveGeometry: handle caching (task 2) ------------------------------

test('resolveGeometry: with a handleCache, a second call for the same URL reuses the open handle instead of re-fetching the footer', async () => {
  const rows = makeRows(12, { joinColumn: 'shapeID' });
  const boundary = fakeBoundary({ rows, rowGroupRows: 4, joinColumn: 'shapeID' });
  let footerOpens = 0;
  const countingHyparquet = {
    ...boundary.hyparquet,
    asyncBufferFromUrl: async (...args) => {
      footerOpens++;
      return boundary.hyparquet.asyncBufferFromUrl(...args);
    },
  };
  setHyparquetModules({ hyparquet: countingHyparquet, compressors: boundary.compressors });

  const handleCache = new Map();
  const url = 'https://example.test/adm2.parquet';
  const resultA07 = { featureId: 'A07', country: 'ZZZ', level: 2, geometryRef: { file: 'x', rowGroup: 1, row: 7 } };
  const resultA03 = { featureId: 'A03', country: 'ZZZ', level: 2, geometryRef: { file: 'x', rowGroup: 0, row: 3 } };

  await resolveGeometry(resultA07, url, null, async () => {}, 'error', null, { entry: BASE_ENTRY, handleCache });
  assert.equal(footerOpens, 1);

  await resolveGeometry(resultA03, url, null, async () => {}, 'error', null, { entry: BASE_ENTRY, handleCache });
  assert.equal(footerOpens, 1, 'a second resolveGeometry() for the same URL must reuse the cached handle, not open the file again');
  assert.equal(handleCache.size, 1);
});

test('resolveGeometry: without a handleCache (the pre-existing direct-call path), every call opens its own handle', async () => {
  const rows = makeRows(12, { joinColumn: 'shapeID' });
  const boundary = fakeBoundary({ rows, rowGroupRows: 4, joinColumn: 'shapeID' });
  let footerOpens = 0;
  const countingHyparquet = {
    ...boundary.hyparquet,
    asyncBufferFromUrl: async (...args) => {
      footerOpens++;
      return boundary.hyparquet.asyncBufferFromUrl(...args);
    },
  };
  setHyparquetModules({ hyparquet: countingHyparquet, compressors: boundary.compressors });

  const url = 'https://example.test/adm2.parquet';
  const result = { featureId: 'A07', country: 'ZZZ', level: 2, geometryRef: { file: 'x', rowGroup: 1, row: 7 } };
  await resolveGeometry(result, url, null, async () => {}, 'error', null, { entry: BASE_ENTRY });
  await resolveGeometry(result, url, null, async () => {}, 'error', null, { entry: BASE_ENTRY });
  assert.equal(footerOpens, 2, 'no cache supplied: unchanged behaviour, one open per call');
});

test('resolveGeometry: a handle whose open fails is removed from the cache, so the next call gets a fresh attempt', async () => {
  let attempt = 0;
  const flakyHyparquet = {
    asyncBufferFromUrl: async () => {
      attempt++;
      if (attempt === 1) throw new Error('network blew up');
      return { __fake: true };
    },
    parquetMetadataAsync: async () => ({ row_groups: [], key_value_metadata: [] }),
  };
  setHyparquetModules({ hyparquet: flakyHyparquet, compressors: {} });

  const handleCache = new Map();
  const url = 'https://example.test/adm2.parquet';
  const result = { featureId: 'X', country: 'ZZZ', level: 2 };

  await assert.rejects(() => resolveGeometry(result, url, null, async () => {}, 'error', null, { entry: BASE_ENTRY, handleCache }));
  assert.equal(handleCache.size, 0, 'a failed open must not leave a permanently-broken cached rejection');

  // Second attempt succeeds (the fake only fails once) and throws
  // GEOMETRY_NOT_FOUND instead, for an entirely different reason (no
  // matching row) -- proving the cache gave this call a fresh handle open
  // rather than reusing the first (failed) one.
  await assert.rejects(
    () => resolveGeometry(result, url, null, async () => {}, 'error', null, { entry: BASE_ENTRY, handleCache }),
    (err) => {
      assert.equal(err.code, 'GEOMETRY_NOT_FOUND');
      return true;
    },
  );
});
