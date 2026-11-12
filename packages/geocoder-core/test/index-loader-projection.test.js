import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadFullIndex, openRangeIndex } from '../src/index-loader.js';
import { setHyparquetModules, clearHyparquetModules } from '../src/cdn.js';

// loadFullIndex's manifest-driven column projection (index-loader.js's
// projectRow/assertSchema): geoboundaries-catalog's real names index calls
// its stable id column `shape_id`, not `feature_id`, and carries no
// `source` column at all, so a client has to alias/synthesize those rather
// than require the literal column names design doc §6.2 lists.
//
// Uses the host-injection seam (setHyparquetModules, design doc §4.2 "host
// may hand its own hyparquet in") to fake hyparquet entirely, the same
// reason select.test.js fakes `__deps.resolveGeometry`: a real `import()`
// of hyparquet's pinned CDN URL is unsupported under `node --test`. Here
// the fake IS hyparquet, so this exercises the real loadFullIndex/
// assertSchema/projectRow code, just not real parquet bytes.

function fakeHyparquet(rows) {
  return {
    hyparquet: { parquetReadObjects: async () => rows },
    compressors: {},
  };
}

function fakeFetch() {
  return async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
}

afterEach(() => clearHyparquetModules());

test('loadFullIndex: unaliased schema (feature_id + source present) passes through unchanged', async () => {
  const rows = [{ name: 'Kenya', name_norm: 'kenya', level: 0, country: 'KEN', feature_id: 'ADM0-KEN', source: 'test-source', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } }];
  setHyparquetModules(fakeHyparquet(rows));
  const result = await loadFullIndex('https://example.test/index.parquet', fakeFetch());
  assert.equal(result.rows[0].feature_id, 'ADM0-KEN');
  assert.equal(result.rows[0].source, 'test-source');
});

test('loadFullIndex: geoboundaries-catalog shape -- shape_id aliased to feature_id, source synthesized from the manifest', async () => {
  const rows = [
    { name: 'Kenya', name_norm: 'kenya', level: 0, country: 'KEN', shape_id: null, bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } },
    { name: 'Kisumu', name_norm: 'kisumu', level: 2, country: 'KEN', shape_id: '19177384B123', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } },
  ];
  setHyparquetModules(fakeHyparquet(rows));
  const result = await loadFullIndex('https://example.test/index.parquet', fakeFetch(), {
    featureIdColumn: 'shape_id',
    defaultSource: 'geoboundaries-cgaz',
  });
  assert.equal(result.rows[0].feature_id, null, 'ADM0 row: shape_id is null, aliased straight through as feature_id');
  assert.equal(result.rows[0].source, 'geoboundaries-cgaz', 'synthesized from defaultSource since no source column exists');
  assert.equal(result.rows[1].feature_id, '19177384B123');
  assert.equal(result.rows[1].source, 'geoboundaries-cgaz');
  // The raw column name must not survive the projection under its own name.
  assert.equal('shape_id' in result.rows[0], false);
});

test('loadFullIndex: geometry_ref (the select() fast-path pointer) survives column projection untouched', async () => {
  // design doc §6.2/§6.4: geometry_ref is a new optional column, projected
  // through unchanged by both load paths -- this is loadFullIndex's half
  // of that contract (searchRangeIndex shares the same projectRow()).
  const rows = [
    {
      name: 'Kisumu', name_norm: 'kisumu', level: 2, country: 'KEN',
      shape_id: '19177384B123', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      geometry_ref: { file: 'cgaz_adm2.parquet', row_group: 12, row: 6177 },
    },
  ];
  setHyparquetModules(fakeHyparquet(rows));
  const result = await loadFullIndex('https://example.test/index.parquet', fakeFetch(), {
    featureIdColumn: 'shape_id',
    defaultSource: 'geoboundaries-cgaz',
  });
  assert.deepEqual(result.rows[0].geometry_ref, { file: 'cgaz_adm2.parquet', row_group: 12, row: 6177 });
});

test('loadFullIndex: a row that already has its own "source" column is never overwritten by defaultSource', async () => {
  const rows = [{ name: 'X', name_norm: 'x', level: 0, country: 'ZZZ', shape_id: 'id1', source: 'row-level-source', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } }];
  setHyparquetModules(fakeHyparquet(rows));
  const result = await loadFullIndex('https://example.test/index.parquet', fakeFetch(), {
    featureIdColumn: 'shape_id',
    defaultSource: 'geoboundaries-cgaz',
  });
  assert.equal(result.rows[0].source, 'row-level-source');
});

test('loadFullIndex: missing the declared feature-id column throws INDEX_SCHEMA_MISMATCH naming it', async () => {
  const rows = [{ name: 'X', name_norm: 'x', level: 0, country: 'ZZZ', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } }];
  setHyparquetModules(fakeHyparquet(rows));
  await assert.rejects(
    () => loadFullIndex('https://example.test/index.parquet', fakeFetch(), { featureIdColumn: 'shape_id' }),
    (err) => {
      assert.equal(err.code, 'INDEX_SCHEMA_MISMATCH');
      assert.match(err.message, /shape_id/);
      return true;
    },
  );
});

test('loadFullIndex: no source column and no defaultSource throws INDEX_SCHEMA_MISMATCH', async () => {
  const rows = [{ name: 'X', name_norm: 'x', level: 0, country: 'ZZZ', feature_id: 'id1', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } }];
  setHyparquetModules(fakeHyparquet(rows));
  await assert.rejects(
    () => loadFullIndex('https://example.test/index.parquet', fakeFetch()),
    (err) => {
      assert.equal(err.code, 'INDEX_SCHEMA_MISMATCH');
      assert.match(err.message, /source/);
      return true;
    },
  );
});

// --- openRangeIndex: footer_bytes (manifest contract addition, task 1) ----

test('openRangeIndex: a declared footer_bytes is passed through as hyparquet\'s initialFetchSize', async () => {
  const seenOptions = [];
  setHyparquetModules({
    hyparquet: {
      asyncBufferFromUrl: async () => ({ __fake: true }),
      parquetMetadataAsync: async (file, options) => {
        seenOptions.push(options);
        return { row_groups: [{ num_rows: 1, columns: [] }] };
      },
    },
    compressors: {},
  });

  await openRangeIndex('https://example.test/index.parquet', fakeFetch(), 8_192);
  assert.equal(seenOptions[0].initialFetchSize, 8_192);
});

test('openRangeIndex: with no footer_bytes given, falls back to the pre-existing 64KB tuned default', async () => {
  const seenOptions = [];
  setHyparquetModules({
    hyparquet: {
      asyncBufferFromUrl: async () => ({ __fake: true }),
      parquetMetadataAsync: async (file, options) => {
        seenOptions.push(options);
        return { row_groups: [{ num_rows: 1, columns: [] }] };
      },
    },
    compressors: {},
  });

  await openRangeIndex('https://example.test/index.parquet', fakeFetch());
  assert.equal(seenOptions[0].initialFetchSize, 65_536, 'unchanged default when the manifest declares no footer_bytes');
});
