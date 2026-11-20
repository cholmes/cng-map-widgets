// @cng/format-gpkg -- the `gpkg` FormatPlugin (download-core's registry
// contract, design doc §3.4/§2.3). Hand-writes the GeoPackage "vector
// features" profile's required tables with sql.js (a SQLite-to-wasm
// build), rather than driving a full GDAL build -- the O5 decision this
// package resolves. See README.md for the measured weight and what a
// consumer gives up versus the gdal3.js path.
//
// NOT streaming (`streaming: false`, same reason as download-core's own
// `geoparquet` plugin): every row is buffered in plain JS arrays during
// `writeBatch`, and the whole SQLite database is built and serialized in
// `close()`. Two reasons this can't be incremental: (1) `gpkg_contents`'
// bbox and `gpkg_geometry_columns`' `geometry_type_name` are only known
// once every row has been seen (exactly geoparquet.js's `overall`/
// `geometryTypes` pattern); (2) sql.js has no "append to an existing file
// on disk" mode -- `Database.export()` serializes the entire in-memory
// database every time, so there is nothing to gain from writing earlier.
// Memory ceiling, stated honestly (design doc §3.4 FormatPlugin.streaming
// doc comment: "the estimate also checks ceiling.blobBytes for this
// reason"): peak memory is roughly the buffered JS row arrays (comparable
// to the row count times its data), PLUS sql.js's in-memory SQLite
// database (comparable to the final .gpkg file size, held in the wasm
// heap), PLUS the exported `Uint8Array` copy `close()` hands to the sink.
// For an output in the tens-of-MB range (this project's realistic
// per-download ceiling) that is tens of MB total, not hundreds -- but it
// is three copies of the data alive at once, not one.
//
// R-tree spatial index: NOT implemented. Measured, not assumed: sql.js
// 1.13.0's published wasm build throws "no such module: rtree" on
// `CREATE VIRTUAL TABLE ... USING rtree(...)` -- it is not compiled with
// `SQLITE_ENABLE_RTREE`. The GeoPackage spec's R-tree spatial index
// extension is RECOMMENDED, not REQUIRED, for the base feature profile;
// every table this plugin writes is still a fully spec-valid GeoPackage
// without it (validated: `ogrinfo -al -so` and DuckDB's `ST_Read` both
// read it cleanly -- see experiments/e10-heavy-formats/RESULTS.md). The
// practical cost is QGIS/GDAL falling back to a full table scan for a
// spatial `WHERE` on this file, which does not matter for the "download a
// bbox-pruned slice" sizes this system targets.

import { geojsonToWkb, peekWkbType, wkbTypeName, isDecodedGeometry, bboxOf, bboxOfWkb, gpkgGeometryBlob } from './wkb.js';

const SQLITE_TYPE_MAP = {
  string: 'TEXT',
  int8: 'TINYINT',
  int16: 'SMALLINT',
  int32: 'MEDIUMINT',
  int64: 'INTEGER', // GeoPackage's "INTEGER" affinity is 64-bit, per the spec's data type list
  uint8: 'SMALLINT', // widened by one step, same reasoning as download-core's geoparquet.js TYPE_MAP: hold the full unsigned range in the next signed affinity up
  uint16: 'MEDIUMINT',
  uint32: 'INTEGER',
  uint64: 'INTEGER', // best-effort: a uint64 > 2^63-1 would still overflow; no real dataset here carries one
  float32: 'FLOAT',
  float64: 'DOUBLE',
  boolean: 'BOOLEAN',
  timestamp: 'DATETIME',
};

const RESERVED_COLUMN_NAMES = new Set(['fid', 'geom']);

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqliteValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return Number(v); // precision above 2^53 is not exact; no real dataset here carries one
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function unionBbox(a, b) {
  if (!a) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/**
 * `FormatPlugin.estimateBytes` for `gpkg` (design doc §3.4's optional
 * third `ctx` argument, added for the item-7 geometry term; a plugin that
 * ignores it keeps working, and this stays pure JS so the lazy
 * descriptor can share it without loading sql.js).
 *
 * A GeoPackage geometry BLOB is the same WKB the source held plus an
 * 8-byte GP header (this writer emits no envelope), so the geometry term
 * is `ctx.avgGeometryBytes` nearly 1:1 -- 1.05 covers SQLite's own
 * record/overflow-page overhead around a big BLOB. Measured against the
 * written file: 11,725 B/row for 400 geoBoundaries CGAZ ADM1 boundaries
 * whose WKB is 10,895 B/row (1.08x all-in), 37,897 against 37,052 for 218
 * CGAZ ADM0 (1.02x), and 1,020 against 745 for 795 FTW Liechtenstein
 * field boundaries -- that last one is where SQLite's per-row fixed cost
 * shows, hence the 120 bytes/row constant. Before item 7 this modelled
 * geometry as a flat 70 bytes/row: 84,270 against 811,008 written (FTW)
 * and 25,724 against 8,261,632 (ADM0).
 *
 * @param {readonly { name: string, type?: string }[]} schema
 * @param {{ min: number, max: number, estimate: number, exact: boolean }} rows
 * @param {{ avgGeometryBytes?: number|null }} [ctx]
 */
export function estimateGpkgBytes(schema, rows, ctx) {
  // ~12 bytes/column of SQLite record overhead + value width, plus a
  // per-row fixed cost (record header, page padding, the rtree index row).
  const perRowProps = schema.length * 12 + 120;
  const perRowGeometry = typeof ctx?.avgGeometryBytes === 'number' ? ctx.avgGeometryBytes * 1.05 + 8 : 70;
  const perRow = perRowProps + perRowGeometry;
  return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
}

/**
 * @param {{ Database: new () => any }} SQL - sql.js's `initSqlJs()` result.
 * @returns {import('./types.js').FormatPlugin}
 */
export function createGpkgFormat(SQL) {
  return {
    id: 'gpkg',
    extension: 'gpkg',
    mediaType: 'application/geopackage+sqlite3',
    streaming: false,
    // memoryFactor: 3.5 -- measured, see the module doc above. Kept in
    // agreement with index.js's `gpkgFormatDescriptor.capabilities`.
    capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'], memoryFactor: 3.5 },
    estimateBytes: estimateGpkgBytes,
    async open(ctx) {
      const layerName = ctx.options?.layerName || 'features';
      const srsId = (ctx.crs === 'EPSG:4326' || ctx.crs === 'OGC:CRS84' || !ctx.crs) ? 4326 : null;
      if (srsId === null) {
        const { CngError } = await import('@cng/spec');
        throw new CngError(
          `@cng/format-gpkg only writes EPSG:4326/OGC:CRS84 geometry (GeoPackage's gpkg_spatial_ref_sys is written with that single row); got crs "${ctx.crs}".`,
          'FORMAT_CAPABILITY',
          { context: { crs: ctx.crs } },
        );
      }

      /** @type {{ name: string, sqliteType: string, declared?: string }[]} */
      const attrColumns = [];
      const usedNames = new Set(['fid', 'geom']);
      for (const col of ctx.schema) {
        if (col.name === ctx.geometryColumn) continue;
        let name = col.name;
        if (RESERVED_COLUMN_NAMES.has(name) || usedNames.has(name)) name = `${name}_1`; // GeoPackage reserves fid/geom; a rare source-schema collision just gets suffixed
        usedNames.add(name);
        attrColumns.push({ name, sourceName: col.name, sqliteType: SQLITE_TYPE_MAP[col.type] ?? 'TEXT' });
      }

      /** @type {unknown[][]} */
      const bufferedRows = [];
      const geometryTypeCodes = new Set();
      let overallBbox = null;
      let rows = 0;

      return {
        async writeBatch(batch) {
          for (let i = 0; i < batch.rows; i++) {
            const row = attrColumns.map((c) => sqliteValue(batch.columns[c.sourceName]?.[i]));
            const geomValue = batch.geometry[i];
            let blob = null;
            if (geomValue != null) {
              let wkbBytes;
              if (isDecodedGeometry(geomValue)) {
                wkbBytes = geojsonToWkb(geomValue);
                overallBbox = unionBbox(overallBbox, bboxOf(geomValue));
              } else {
                // Already WKB (the common case: a GeoParquet-1.x/CGAZ/FTW
                // source's bytes pass straight through, no decode+re-encode).
                wkbBytes = geomValue instanceof Uint8Array ? geomValue : new Uint8Array(geomValue);
              }
              geometryTypeCodes.add(peekWkbType(wkbBytes));
              blob = gpkgGeometryBlob(wkbBytes, srsId);
              if (!isDecodedGeometry(geomValue)) {
                // Still need a bbox for gpkg_contents; `bboxOfWkb` walks
                // the raw bytes directly (no decode to GeoJSON objects).
                overallBbox = unionBbox(overallBbox, bboxOfWkb(wkbBytes));
              }
            }
            bufferedRows.push([blob, ...row]);
          }
          rows += batch.rows;
        },
        async close() {
          const db = new SQL.Database();
          db.run(`
            CREATE TABLE gpkg_spatial_ref_sys (
              srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
              organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
              definition TEXT NOT NULL, description TEXT
            );
            INSERT INTO gpkg_spatial_ref_sys VALUES
              ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system'),
              ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system'),
              ('WGS 84 geodetic', 4326, 'EPSG', 4326, 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]', 'longitude/latitude WGS84');

            CREATE TABLE gpkg_contents (
              table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
              identifier TEXT UNIQUE, description TEXT DEFAULT '',
              last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
              srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
            );

            CREATE TABLE gpkg_geometry_columns (
              table_name TEXT NOT NULL, column_name TEXT NOT NULL,
              geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
              z TINYINT NOT NULL, m TINYINT NOT NULL,
              CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
              CONSTRAINT uk_gc_table_name UNIQUE (table_name),
              CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
              CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
            );
          `);

          const geomTypeName = geometryTypeCodes.size === 1 ? wkbTypeName([...geometryTypeCodes][0]) : 'GEOMETRY';
          const featureColsSql = attrColumns.map((c) => `${quoteIdent(c.name)} ${c.sqliteType}`).join(', ');
          db.run(`CREATE TABLE ${quoteIdent(layerName)} (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB${featureColsSql ? ', ' + featureColsSql : ''})`);

          const [minX, minY, maxX, maxY] = overallBbox ?? [null, null, null, null];
          db.run(
            'INSERT INTO gpkg_contents (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [layerName, 'features', layerName, minX, minY, maxX, maxY, srsId],
          );
          db.run('INSERT INTO gpkg_geometry_columns VALUES (?, ?, ?, ?, 0, 0)', [layerName, 'geom', geomTypeName, srsId]);

          if (bufferedRows.length > 0) {
            const placeholders = ['?', ...attrColumns.map(() => '?')].join(', ');
            const stmt = db.prepare(`INSERT INTO ${quoteIdent(layerName)} (geom${attrColumns.length ? ', ' + attrColumns.map((c) => quoteIdent(c.name)).join(', ') : ''}) VALUES (${placeholders})`);
            try {
              for (const row of bufferedRows) stmt.run(row);
            } finally {
              stmt.free();
            }
          }

          try {
            db.run('PRAGMA application_id = 1196444487'); // 'GPKG' as a big-endian uint32, per spec
            db.run('PRAGMA user_version = 10300'); // GeoPackage 1.3
          } catch {
            // A sql.js build that refuses these pragmas still produces a
            // readable SQLite/GeoPackage file (GDAL checks the
            // gpkg_* tables, not just the header magic) -- not worth
            // failing the whole write over.
          }

          const bytes = db.export();
          db.close();
          await ctx.writer.write(bytes);
          return { rows, bytes: bytes.byteLength };
        },
        async abort() {
          bufferedRows.length = 0;
        },
      };
    },
  };
}
