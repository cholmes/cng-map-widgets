// Behavioral tests for the per-batch-insert restructure (bigger-downloads
// task 9): `writeBatch` must insert rows into the open sql.js database
// immediately, retaining no row data of its own, and `close()` must only
// patch the two metadata values (`gpkg_geometry_columns.geometry_type_name`,
// `gpkg_contents`' bbox) that are not knowable until every batch has been
// seen. `writer._db` is a test-only probe (not part of the FormatPlugin
// contract) exposing the live sql.js `Database` so these tests can inspect
// state between `writeBatch` calls, before `close()` runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializedSqlJs } from './helpers/sqljs-setup.js';
import { createGpkgFormat } from '../src/gpkg-writer.js';
import { geojsonToWkb } from '../src/wkb.js';

function makeCtx(schema, options = {}) {
  let written;
  return {
    ctx: {
      writer: { write: async (buf) => { written = buf; }, close: async () => {} },
      schema,
      geometryColumn: 'geometry',
      crs: options.crs ?? 'EPSG:4326',
      options: { layerName: options.layerName ?? 'features' },
      attribution: [],
    },
    get written() { return written; },
  };
}

function pointBatch(ids) {
  return {
    rows: ids.length,
    columns: { id: ids },
    geometry: ids.map((_, i) => geojsonToWkb({ type: 'Point', coordinates: [i, i] })),
  };
}

function polygonBatch(count) {
  const ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  return {
    rows: count,
    columns: { id: Array.from({ length: count }, (_, i) => `p${i}`) },
    geometry: Array.from({ length: count }, () => geojsonToWkb({ type: 'Polygon', coordinates: [ring] })),
  };
}

function lineBatch(count) {
  return {
    rows: count,
    columns: { id: Array.from({ length: count }, (_, i) => `l${i}`) },
    geometry: Array.from({ length: count }, () => geojsonToWkb({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })),
  };
}

async function openDbFromBytes(SQL, bytes) {
  return new SQL.Database(bytes);
}

const schema = [{ name: 'id', type: 'string' }, { name: 'geometry', type: 'geometry' }];

test('rows are inserted during writeBatch, not held until close', async () => {
  const SQL = await initializedSqlJs;
  const format = createGpkgFormat(SQL);
  const { ctx } = makeCtx(schema);
  const writer = await format.open(ctx);

  await writer.writeBatch(pointBatch(['a']));
  await writer.writeBatch(pointBatch(['b']));

  // The two rows are already in the open database, before close() ever runs.
  const [{ values }] = writer._db.exec('SELECT COUNT(*) FROM features');
  assert.equal(values[0][0], 2);

  await writer.close();
});

test('geometry_type_name is corrected at close from the geometries seen', async () => {
  const SQL = await initializedSqlJs;

  // All polygons -> the GeoPackage-spec upper-case name, 'POLYGON'.
  {
    const format = createGpkgFormat(SQL);
    const session = makeCtx([{ name: 'id', type: 'string' }, { name: 'geometry', type: 'geometry' }], { layerName: 'polys' });
    const writer = await format.open(session.ctx);
    await writer.writeBatch(polygonBatch(2));
    await writer.writeBatch(polygonBatch(1));
    await writer.close();
    const db = await openDbFromBytes(SQL, session.written);
    const [{ values }] = db.exec('SELECT geometry_type_name FROM gpkg_geometry_columns');
    assert.equal(values[0][0], 'POLYGON');
    db.close();
  }

  // Mixed polygon + line -> 'GEOMETRY'.
  {
    const format = createGpkgFormat(SQL);
    const session = makeCtx([{ name: 'id', type: 'string' }, { name: 'geometry', type: 'geometry' }], { layerName: 'mixed' });
    const writer = await format.open(session.ctx);
    await writer.writeBatch(polygonBatch(1));
    await writer.writeBatch(lineBatch(1));
    await writer.close();
    const db = await openDbFromBytes(SQL, session.written);
    const [{ values }] = db.exec('SELECT geometry_type_name FROM gpkg_geometry_columns');
    assert.equal(values[0][0], 'GEOMETRY');
    db.close();
  }
});

test('gpkg_contents bounds are the union of all batches', async () => {
  const SQL = await initializedSqlJs;
  const format = createGpkgFormat(SQL);
  const session = makeCtx(schema, { layerName: 'pts' });
  const writer = await format.open(session.ctx);

  // open() must write null bounds; a close before any batch still has to
  // produce a valid (if degenerate) gpkg_contents row, but here we check
  // the batches' union once close() has run.
  await writer.writeBatch({ rows: 1, columns: { id: ['a'] }, geometry: [geojsonToWkb({ type: 'Point', coordinates: [-10, 5] })] });
  await writer.writeBatch({ rows: 1, columns: { id: ['b'] }, geometry: [geojsonToWkb({ type: 'Point', coordinates: [20, -3] })] });
  await writer.close();

  const db = await openDbFromBytes(SQL, session.written);
  const [{ values }] = db.exec('SELECT min_x, min_y, max_x, max_y FROM gpkg_contents');
  assert.deepEqual(values[0], [-10, -3, 20, 5]);
  db.close();
});

test('abort() after open() closes the database and leaves nothing behind', async () => {
  const SQL = await initializedSqlJs;
  const format = createGpkgFormat(SQL);
  const { ctx } = makeCtx(schema);
  const writer = await format.open(ctx);
  await writer.writeBatch(pointBatch(['a']));

  await writer.abort();

  // The underlying sql.js Database is closed; any further use throws.
  assert.throws(() => writer._db.exec('SELECT 1'));
});

// Whole-branch review item 9 (one-liners, format-gpkg abort guard): since
// bigger-downloads task 9, `db`/`insertStmt` exist from `open()` onward
// (not just inside `close()`), so a SECOND release call -- `abort()` after
// a successful `close()`, or `abort()` called twice -- would otherwise
// call sql.js's `free()`/`close()` on an already-freed statement/database.
// Both must be a no-op, not a throw.
test('abort() after a successful close() is a no-op, not a double-free', async () => {
  const SQL = await initializedSqlJs;
  const format = createGpkgFormat(SQL);
  const { ctx } = makeCtx(schema);
  const writer = await format.open(ctx);
  await writer.writeBatch(pointBatch(['a']));
  await writer.close();

  await assert.doesNotReject(() => writer.abort());
});

test('abort() called twice is a no-op the second time', async () => {
  const SQL = await initializedSqlJs;
  const format = createGpkgFormat(SQL);
  const { ctx } = makeCtx(schema);
  const writer = await format.open(ctx);
  await writer.writeBatch(pointBatch(['a']));
  await writer.abort();

  await assert.doesNotReject(() => writer.abort());
});
