// Time filters on INTERVAL data: rows that carry `start_datetime` /
// `end_datetime` and, often, a null `datetime`. OpenAerialMap's item table is
// exactly this, and before this work a time filter on it matched nothing: the
// single-time-column test rejects a null.
//
// The rule (design call 3): a row's span is `start ?? instant` … `end ??
// instant`, and it matches when that span OVERLAPS the window -- STAC API's
// datetime semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/hyparquet-setup.js';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { timeSpanPredicate, timeRowPredicate, pruneRowGroupsByTime } from '../src/prune.js';
import { inferTableFromSchema } from '../src/estimate.js';
import { descriptorFromCollection } from '../src/dataset-resolve.js';
import { openParquetFile } from '../src/parquet-io.js';
import { createHyparquetEngine } from '../src/engine-hyparquet.js';
import { rangeFetch, squareWkb } from './helpers/fake-parquet-host.js';

const COLS = { instant: 'datetime', start: 'start_datetime', end: 'end_datetime' };
const WINDOW = { start: '2025-06-11T00:00:00Z', end: '2025-06-20T00:00:00Z', closed: '[)' };
const row = (start, end, datetime = null) => ({ datetime, start_datetime: start, end_datetime: end });

test('a row with only start/end is matched when its span overlaps the window', () => {
  const ok = timeSpanPredicate(WINDOW, COLS);
  assert.equal(ok(row('2025-06-10T00:00:00Z', '2025-06-12T00:00:00Z')), true); // straddles the start
  assert.equal(ok(row('2025-06-15T00:00:00Z', '2025-06-16T00:00:00Z')), true); // inside
  assert.equal(ok(row('2025-06-19T00:00:00Z', '2025-07-01T00:00:00Z')), true); // straddles the end
  assert.equal(ok(row('2025-01-01T00:00:00Z', '2025-12-31T00:00:00Z')), true); // contains the window
});

test('a row that ends before the window, or starts at or after its open end, is rejected', () => {
  const ok = timeSpanPredicate(WINDOW, COLS);
  assert.equal(ok(row('2025-06-01T00:00:00Z', '2025-06-10T23:59:59Z')), false);
  assert.equal(ok(row('2025-06-20T00:00:00Z', '2025-06-25T00:00:00Z')), false); // `[)`: the end is excluded
  assert.equal(ok(row('2025-06-21T00:00:00Z', '2025-06-25T00:00:00Z')), false);
});

test("closed '[]' includes a row starting exactly at the window's end", () => {
  const ok = timeSpanPredicate({ ...WINDOW, closed: '[]' }, COLS);
  assert.equal(ok(row('2025-06-20T00:00:00Z', '2025-06-25T00:00:00Z')), true);
});

test('a row with no time at all is rejected', () => {
  const ok = timeSpanPredicate(WINDOW, COLS);
  assert.equal(ok(row(null, null, null)), false);
  assert.equal(ok({}), false);
});

test('start and end each fall back to datetime, independently', () => {
  const ok = timeSpanPredicate(WINDOW, COLS);
  assert.equal(ok(row(null, null, '2025-06-15T00:00:00Z')), true); // an instant inside
  assert.equal(ok(row(null, null, '2025-06-25T00:00:00Z')), false); // an instant outside
  assert.equal(ok(row('2025-06-01T00:00:00Z', null, '2025-06-15T00:00:00Z')), true); // end falls back
  assert.equal(ok(row(null, '2025-06-30T00:00:00Z', '2025-06-25T00:00:00Z')), false); // start falls back, after the window
});

// Review Focus 2.
test('an open-ended window keeps a row that has only start/end', () => {
  const after = timeSpanPredicate({ start: '2025-06-11T00:00:00Z' }, COLS);
  assert.equal(after(row('2025-06-15T00:00:00Z', '2025-06-16T00:00:00Z')), true);
  assert.equal(after(row('2025-06-01T00:00:00Z', '2025-06-05T00:00:00Z')), false);
  const before = timeSpanPredicate({ end: '2025-06-11T00:00:00Z' }, COLS);
  assert.equal(before(row('2025-06-01T00:00:00Z', '2025-06-05T00:00:00Z')), true);
});

test('a value that cannot be read as a time is kept, not dropped', () => {
  const ok = timeSpanPredicate(WINDOW, COLS);
  assert.equal(ok(row('not a date', 'also not')), true);
});

test('no window, or no columns to test, means nothing to test', () => {
  assert.equal(timeSpanPredicate(undefined, COLS), null);
  assert.equal(timeSpanPredicate({}, COLS), null);
  assert.equal(timeSpanPredicate(WINDOW, {}), null);
});

test('with only an instant column it agrees with timeRowPredicate', () => {
  const span = timeSpanPredicate(WINDOW, { instant: 'datetime' });
  const instant = timeRowPredicate(WINDOW);
  for (const v of ['2025-06-10T23:59:59Z', '2025-06-11T00:00:00Z', '2025-06-19T23:59:59Z', '2025-06-20T00:00:00Z', null]) {
    assert.equal(span({ datetime: v }), instant(v), String(v));
  }
});

// --- row groups ---------------------------------------------------------------

const stat = (min, max) => ({ statistics: { min_value: min, max_value: max } });
const group = (index, columns) => ({ index, numRows: 10, rowStart: index * 10, rowEnd: index * 10 + 10, columns: new Map(Object.entries(columns)) });

// OpenAerialMap's shape: the instant column exists and is entirely null.
const allNull = { statistics: { null_count: 10n } };

test('row groups are dropped only when every row must end before the window or start at/after its end', () => {
  const groups = [
    group(0, { datetime: allNull, start_datetime: stat('2025-05-01T00:00:00Z', '2025-05-10T00:00:00Z'), end_datetime: stat('2025-05-02T00:00:00Z', '2025-05-11T00:00:00Z') }), // all before
    group(1, { datetime: allNull, start_datetime: stat('2025-06-01T00:00:00Z', '2025-06-10T00:00:00Z'), end_datetime: stat('2025-06-02T00:00:00Z', '2025-06-12T00:00:00Z') }), // an end reaches in
    group(2, { datetime: allNull, start_datetime: stat('2025-06-20T00:00:00Z', '2025-06-30T00:00:00Z'), end_datetime: stat('2025-06-21T00:00:00Z', '2025-07-01T00:00:00Z') }), // all at/after the end
    group(3, { datetime: allNull, start_datetime: stat('2025-06-12T00:00:00Z', '2025-06-13T00:00:00Z'), end_datetime: stat('2025-06-12T00:00:00Z', '2025-06-14T00:00:00Z') }), // inside
  ];
  const out = pruneRowGroupsByTime(groups, 'datetime', WINDOW, { start: 'start_datetime', end: 'end_datetime' });
  assert.deepEqual(out.selected.map((g) => g.index), [1, 3]);
  assert.equal(out.stage.before, 4);
  assert.equal(out.stage.after, 2);
  assert.match(out.stage.basis, /start_datetime/);
});

test('a row group with rows that fall back to datetime is judged on both', () => {
  // start/end statistics say "all in May", but some rows have null start/end
  // and a June datetime: the group must be kept.
  const mixed = group(0, {
    start_datetime: stat('2025-05-01T00:00:00Z', '2025-05-10T00:00:00Z'),
    end_datetime: stat('2025-05-02T00:00:00Z', '2025-05-11T00:00:00Z'),
    datetime: stat('2025-06-15T00:00:00Z', '2025-06-16T00:00:00Z'),
  });
  assert.equal(pruneRowGroupsByTime([mixed], 'datetime', WINDOW, { start: 'start_datetime', end: 'end_datetime' }).selected.length, 1);
});

test('missing statistics on a column it needs keep the row group', () => {
  const noStats = group(0, { start_datetime: {}, end_datetime: {} });
  const onlyStart = group(1, { start_datetime: stat('2025-05-01T00:00:00Z', '2025-05-10T00:00:00Z') });
  const out = pruneRowGroupsByTime([noStats, onlyStart], 'datetime', WINDOW, { start: 'start_datetime', end: 'end_datetime' });
  assert.deepEqual(out.selected.map((g) => g.index), [0, 1]);
});

test('with no interval, row-group pruning is exactly what it was', () => {
  const groups = [group(0, { datetime: stat('2025-05-01T00:00:00Z', '2025-05-10T00:00:00Z') }), group(1, { datetime: stat('2025-06-12T00:00:00Z', '2025-06-13T00:00:00Z') })];
  const out = pruneRowGroupsByTime(groups, 'datetime', WINDOW);
  assert.deepEqual(out.selected.map((g) => g.index), [1]);
  assert.equal(out.stage.basis, 'time datetime ∈ [2025-06-11T00:00:00Z, 2025-06-20T00:00:00Z)');
});

// --- discovery -----------------------------------------------------------------

// Time columns here are timestamps, as STAC-GeoParquet writes them; anything else is a string.
const TIMESTAMP = { type: 'INT64', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' } };
const STRING = { type: 'BYTE_ARRAY', converted_type: 'UTF8' };
const schemaOf = (columns) => ({ schema: [{ name: 'root', num_children: columns.length }, ...columns] });
const schema = (...names) => schemaOf(names.map((name) => ({ name, ...(name.endsWith('datetime') ? TIMESTAMP : STRING) })));

// Phase 2 review, M1: the name alone is not enough. A bare file whose
// `datetime` is epoch SECONDS in an INT64 was given a time column, compared
// as milliseconds, and returned nothing -- where before its filter was at
// least skipped with a warning.
test('inferTableFromSchema takes a time column by name only when its type can hold a time', () => {
  const timeColumnOf = (el) => inferTableFromSchema(schemaOf([{ name: 'id', ...STRING }, { name: 'datetime', ...el }, { name: 'geometry', type: 'BYTE_ARRAY' }])).timeColumn;
  assert.equal(timeColumnOf(TIMESTAMP), 'datetime');
  assert.equal(timeColumnOf(STRING), 'datetime', 'ISO strings');
  assert.equal(timeColumnOf({ type: 'BYTE_ARRAY', logical_type: { type: 'STRING' } }), 'datetime');
  assert.equal(timeColumnOf({ type: 'INT64', converted_type: 'TIMESTAMP_MILLIS' }), 'datetime');
  assert.equal(timeColumnOf({ type: 'INT32', logical_type: { type: 'DATE' } }), 'datetime');
  assert.equal(timeColumnOf({ type: 'INT96' }), 'datetime', 'the legacy timestamp');
  assert.equal(timeColumnOf({ type: 'INT64' }), undefined, 'a bare integer: seconds? milliseconds? not ours to guess');
  assert.equal(timeColumnOf({ type: 'DOUBLE' }), undefined);
  // The pair needs both to qualify.
  const pair = (endType) => inferTableFromSchema(schemaOf([{ name: 'start_datetime', ...TIMESTAMP }, { name: 'end_datetime', ...endType }, { name: 'geometry', type: 'BYTE_ARRAY' }])).timeInterval;
  assert.deepEqual(pair(TIMESTAMP), { start: 'start_datetime', end: 'end_datetime' });
  assert.equal(pair({ type: 'INT64' }), undefined);
});

test('inferTableFromSchema finds datetime, and the interval pair, by their STAC names', () => {
  assert.equal(inferTableFromSchema(schema('id', 'datetime', 'geometry')).timeColumn, 'datetime');
  assert.equal(inferTableFromSchema(schema('id', 'datetime', 'geometry')).timeInterval, undefined);
  const both = inferTableFromSchema(schema('id', 'datetime', 'start_datetime', 'end_datetime', 'geometry'));
  assert.equal(both.timeColumn, 'datetime');
  assert.deepEqual(both.timeInterval, { start: 'start_datetime', end: 'end_datetime' });
  const plain = inferTableFromSchema(schema('id', 'geometry'));
  assert.equal(plain.timeColumn, undefined);
  assert.equal(plain.timeInterval, undefined);
  // Only one of the pair is not an interval.
  assert.equal(inferTableFromSchema(schema('id', 'start_datetime', 'geometry')).timeInterval, undefined);
});

test('a collection that declares start/end columns resolves with a timeInterval', () => {
  const descriptor = descriptorFromCollection(
    {
      type: 'Collection',
      id: 'intervals',
      'table:columns': [
        { name: 'id', type: 'string' },
        { name: 'datetime', type: 'timestamp' },
        { name: 'start_datetime', type: 'timestamp' },
        { name: 'end_datetime', type: 'timestamp' },
        { name: 'geometry', type: 'binary' },
      ],
      assets: { data: { href: './items.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] } },
    },
    { baseUrl: 'https://example.org/c/collection.json' },
  );
  assert.equal(descriptor.table.timeColumn, 'datetime');
  assert.deepEqual(descriptor.table.timeInterval, { start: 'start_datetime', end: 'end_datetime' });
});

// The other reason an item table could not be read: OpenAerialMap publishes
// it as a single `collection-mirror` asset, which resolved to nothing.
test('a non-partitioned collection-mirror asset resolves to that one parquet file', () => {
  const descriptor = descriptorFromCollection(
    {
      type: 'Collection',
      id: 'oam-like',
      item_assets: { visual: { type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] } },
      assets: { 'geoparquet-items': { href: './items.parquet', type: 'application/vnd.apache.parquet', roles: ['collection-mirror'] } },
    },
    { baseUrl: 'https://example.org/oam/collection.json' },
  );
  assert.deepEqual(descriptor.source, { kind: 'parquet', url: 'https://example.org/oam/items.parquet' });
});

// Phase 2 review, I2: the first version tested the mirror BEFORE the data
// asset, so a collection publishing both had its downloads silently switched
// from its data to its STAC item index.
test('a data parquet still wins over a collection-mirror; the mirror is only the fallback', () => {
  const descriptor = descriptorFromCollection(
    {
      type: 'Collection',
      id: 'both',
      assets: {
        'geoparquet-items': { href: './items.parquet', type: 'application/vnd.apache.parquet', roles: ['collection-mirror'] },
        data: { href: './buildings.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] },
      },
    },
    { baseUrl: 'https://example.org/c/collection.json' },
  );
  assert.deepEqual(descriptor.source, { kind: 'parquet', url: 'https://example.org/c/buildings.parquet' });
});

test('with no data parquet and no mirror, a raster collection is still unsupported', () => {
  assert.throws(
    () =>
      descriptorFromCollection(
        { type: 'Collection', id: 'raster', assets: { data: { href: './dem.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] } } },
        { baseUrl: 'https://example.org/c/collection.json' },
      ),
    (e) => e.code === 'DATASET_UNSUPPORTED',
  );
});

// --- end to end, through the real reader ----------------------------------------

/** An OpenAerialMap-shaped item table: start/end as strings, `datetime` always null. */
function intervalItems() {
  const days = [1, 5, 10, 15, 19, 25];
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: 'id', data: days.map((d) => `scene-${d}`), type: 'STRING', nullable: true },
      { name: 'datetime', data: days.map(() => null), type: 'STRING', nullable: true },
      { name: 'start_datetime', data: days.map((d) => `2025-06-${String(d).padStart(2, '0')}T00:00:00Z`), type: 'STRING', nullable: true },
      { name: 'end_datetime', data: days.map((d) => `2025-06-${String(d + 2).padStart(2, '0')}T00:00:00Z`), type: 'STRING', nullable: true },
      { name: 'geometry', data: days.map((d) => squareWkb(d, 0.5)), type: 'BYTE_ARRAY', nullable: true },
    ],
    rowGroupSize: 2,
  });
  return new Uint8Array(buffer);
}

test('the engine returns interval rows that overlap the window (it returned none before)', async () => {
  const handle = await openParquetFile('https://example.invalid/items.parquet', rangeFetch(intervalItems()));
  const table = inferTableFromSchema(handle.metadata);
  const filter = { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' }, time: WINDOW };
  const readColumns = ['id', 'datetime', 'start_datetime', 'end_datetime', 'geometry'];
  const ids = [];
  await createHyparquetEngine().run(
    {
      dataset: { id: 'test' },
      area: null,
      filter,
      plan: {
        table,
        readColumns,
        outputColumns: ['id', 'geometry'],
        geometryColumn: 'geometry',
        covering: { kind: 'none' },
        perPart: [{ part: { url: handle.url }, handle, selectedRowGroups: handle.rowGroups }],
      },
    },
    async (batch) => ids.push(...batch.columns.id),
    {},
  );
  // Spans: 1-3, 5-7, 10-12, 15-17, 19-21, 25-27. Window [11, 20).
  assert.deepEqual(ids, ['scene-10', 'scene-15', 'scene-19']);
});
