// @cnmw/download-core -- the `geoparquet` format plugin (design doc §2.3,
// §3.4). Hand-builds GeoParquet 1.1 `geo` file metadata + an optional bbox
// covering, writing with `hyparquet-writer` (see cdn.js's loader).
//
// NOT streaming (`streaming: false`): `hyparquet-writer`'s buffer-oriented
// API (`parquetWriteBuffer`) wants the whole column-oriented dataset up
// front, so this plugin accumulates every batch in memory and writes one
// parquet file on `close()`. The estimate/ceiling path checks
// `ceiling.blobBytes` for non-streaming formats for exactly this reason
// (design doc §3.4 FormatPlugin.streaming doc comment).

import { CnmwError } from '@cnmw/spec';
import { loadHyparquetWriter } from '../cdn.js';
import { decodeWkbGeometry, bboxOfAnyGeometry } from '../wkb-geometry.js';

// Regression note (found running this package's E6 stress test, writing
// real s2-stac-geoparquet columns to GeoParquet output): a declared type
// this map doesn't recognize becomes `type: undefined` on the
// hyparquet-writer columnData entry, which falls back to *inferring* a
// physical type from the sampled values instead of being told one. For an
// unsigned 32-bit column (s2-stac-geoparquet's `_hilbert`, declared
// `uint32`; values run the full 0..2^32-1 range), that inference can land
// on signed INT32 from early small values and then throw
// ("parquet expected int32 value, got 2164471400") the moment a later
// value exceeds the signed INT32 range -- hyparquet-writer has no bare
// unsigned-32 physical type, so `uint8`/`uint16`/`uint32` are all widened
// to the next physical type guaranteed to hold their full range without
// overflow (INT32 safely holds every uint8/uint16 value; INT64 safely
// holds every uint32 value). `int8`/`int16` have no narrower Parquet
// physical type than INT32 either, so they map there directly.
const TYPE_MAP = {
  string: 'STRING',
  int8: 'INT32',
  int16: 'INT32',
  int32: 'INT32',
  int64: 'INT64',
  uint8: 'INT32',
  uint16: 'INT32',
  uint32: 'INT64',
  uint64: 'INT64', // best-effort: a uint64 > 2^63-1 would still overflow signed INT64, but none of this project's real datasets carry one
  float32: 'FLOAT',
  float64: 'DOUBLE',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMP',
};

/**
 * `FormatPlugin.estimateBytes` for `geoparquet` (design doc §3.4, item-7
 * amendment: the optional third `ctx` argument).
 *
 * GeoParquet writes the geometry back out as WKB, so its geometry term is
 * `1.0 x ctx.avgGeometryBytes` -- the same bytes in, the same bytes out,
 * before this plugin's SNAPPY codec gets at them. That factor is
 * deliberately the *upper* end of what was measured, because how much
 * snappy shaves off WKB depends entirely on the data and cannot be read
 * off the source footer: reading the written file's own geometry column
 * chunk back gives 36,849 B/row compressed against 37,052 uncompressed
 * for geoBoundaries CGAZ ADM0 boundaries (0.99x -- irregular coastlines
 * barely compress), but 220 against 781 for FTW Liechtenstein field
 * boundaries (0.30x -- those are traced on a 10 m raster grid, so the
 * high bytes of every coordinate repeat). Modelling 1.0 therefore lands
 * within 1% on the first and about 3x high on the second, which is the
 * safe direction for a ceiling check: the alternative under-reports a
 * file that will not compress.
 *
 * @param {readonly { name: string, type?: string }[]} schema
 * @param {import('../bounded.js').Bounded} rows
 * @param {{ avgGeometryBytes?: number|null, geometryColumn?: string }} [ctx]
 * @returns {import('../bounded.js').Bounded}
 */
export function estimateGeoParquetBytes(schema, rows, ctx) {
  // Columnar + snappy: attribute columns are much denser than GeoJSON
  // text. Measured 31 B/row of non-geometry bytes for FTW's 3-column
  // schema plus its four covering columns, 54 for CGAZ ADM0's 4.
  const perRowProps = schema.length * 10;
  // `filter.columns.dropGeometry`: see `geojson.js`'s `estimateGeoJsonBytes`
  // for why this checks `schema` rather than always adding the geometry
  // term. This format's writer (`close()`, below) omits the geometry
  // column and the `geo` metadata entirely in that case, so 0 is the
  // honest number, not even the 60-byte flat fallback.
  const geometryKept = !ctx?.geometryColumn || schema.some((c) => c.name === ctx.geometryColumn);
  const perRowGeometry = !geometryKept ? 0 : typeof ctx?.avgGeometryBytes === 'number' ? ctx.avgGeometryBytes * 1.0 : 60;
  const perRow = perRowProps + perRowGeometry;
  return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
}

/** @returns {import('../types.js').FormatPlugin} */
export function createGeoParquetFormat() {
  return {
    id: 'geoparquet',
    extension: 'parquet',
    mediaType: 'application/vnd.apache.parquet',
    streaming: false,
    capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
    estimateBytes: estimateGeoParquetBytes,
    async open(ctx) {
      // Loaded once, up front: `writeBatch` needs `geojsonToWkb` on every
      // row with geometry, not just at `close()` (which already awaited
      // `loadHyparquetWriter()` for `parquetWriteBuffer`).
      const { geojsonToWkb } = await loadHyparquetWriter();

      // `filter.columns.dropGeometry` (design doc §2.2): `ctx.schema` is
      // built from `plan.outputColumns` (`download.js`'s `schemaFor`), which
      // `resolveOutputColumns` already excludes the geometry column from
      // when `dropGeometry` is set -- so its absence here is the one
      // signal this writer needs, with no separate flag threaded through
      // `FormatContext`. `batch.geometry[i]` arrives all-`null` in that
      // case regardless (`engine-hyparquet.js`'s `buildBatch`), but a
      // GeoParquet file can do better than GeoJSON's "the member is `null`"
      // compromise: omit the physical column, and the `geo` GeoParquet
      // metadata that describes it, entirely, so the output is an honest
      // plain Parquet file with no trace of geometry at all.
      const dropGeometry = !ctx.schema.some((c) => c.name === ctx.geometryColumn);

      /** @type {Record<string, unknown[]>} */
      const columnData = {};
      /** @type {Uint8Array[]} */
      const geometryData = [];
      const bboxCols = { xmin: [], ymin: [], xmax: [], ymax: [] };
      const geometryTypes = new Set();
      let overall = null;
      let rows = 0;

      return {
        async writeBatch(batch) {
          const colNames = Object.keys(batch.columns);
          for (const name of colNames) {
            if (!columnData[name]) columnData[name] = [];
            // hyparquet-writer's INT64 physical type demands a real BigInt,
            // not a Number -- it throws "parquet expected bigint value"
            // otherwise. A genuine `int64` column already arrives as
            // BigInt from hyparquet's own reader; `uint32`/`uint64` (widened
            // to INT64 above specifically to avoid signed-overflow on
            // write) arrive as plain Numbers, since their *source* physical
            // type was never INT64 to begin with. Found writing
            // s2-stac-geoparquet's `_hilbert` (uint32) column during this
            // package's E6 stress test.
            const declared = ctx.schema.find((c) => c.name === name)?.type;
            const needsBigInt = TYPE_MAP[declared] === 'INT64';
            for (let i = 0; i < batch.rows; i++) {
              let v = batch.columns[name][i]; // hyparquet-writer's TIMESTAMP type accepts a Date directly
              if (needsBigInt && typeof v === 'number') v = BigInt(v);
              columnData[name].push(v ?? null);
            }
          }
          if (dropGeometry) {
            rows += batch.rows;
            return;
          }
          for (let i = 0; i < batch.rows; i++) {
            const wkb = batch.geometry[i];
            if (wkb) {
              // `batch.geometry[i]` is raw WKB bytes for a GeoParquet-1.x
              // source (CGAZ, FTW: a plain BYTE_ARRAY column + `geo`
              // kv-metadata), but is already a *decoded* GeoJSON object for
              // a GeoParquet-2.0 source with the native Parquet GEOMETRY
              // logical type (FIRMS, s2-stac-geoparquet -- see
              // `../wkb-geometry.js`'s module doc). `decodeWkbGeometry`
              // normalizes either input to a GeoJSON geometry; this format
              // writes its own geometry column as raw WKB bytes
              // (`TYPE_MAP`-independent BYTE_ARRAY, below), so round-trip
              // through `geojsonToWkb` to get real bytes out either way --
              // writing a decoded object straight into a byte column
              // crashed hyparquet-writer with "expected Uint8Array value,
              // got object", found running this package's E6 stress test
              // against the real FIRMS catalog.
              const geom = decodeWkbGeometry(wkb);
              geometryData.push(geojsonToWkb(geom));
              geometryTypes.add(geom.type);
              const [xmin, ymin, xmax, ymax] = bboxOfAnyGeometry(geom);
              bboxCols.xmin.push(xmin);
              bboxCols.ymin.push(ymin);
              bboxCols.xmax.push(xmax);
              bboxCols.ymax.push(ymax);
              overall = overall ? unionBox(overall, [xmin, ymin, xmax, ymax]) : [xmin, ymin, xmax, ymax];
            } else {
              geometryData.push(null);
              bboxCols.xmin.push(null);
              bboxCols.ymin.push(null);
              bboxCols.xmax.push(null);
              bboxCols.ymax.push(null);
            }
          }
          rows += batch.rows;
        },
        async close() {
          const { parquetWriteBuffer } = await loadHyparquetWriter();
          const writeCovering = ctx.options.writeCovering ?? true;

          /** @type {{ name: string, data: unknown[], type?: string, nullable?: boolean }[]} */
          const columnSources = [];
          for (const [name, data] of Object.entries(columnData)) {
            const declared = ctx.schema.find((c) => c.name === name)?.type;
            columnSources.push({ name, data, type: TYPE_MAP[declared], nullable: true });
          }
          // `filter.columns.dropGeometry`: write a plain Parquet file --
          // no geometry column, no covering columns, no `geo` GeoParquet
          // metadata at all -- rather than a geometry column that exists
          // but is entirely `null` plus a `geo` key-value entry describing
          // a covering with nothing in it. That half-measure was
          // considered and rejected: it still names a `primary_column`
          // that carries no data, which is a worse lie than the one this
          // fix closes.
          if (!dropGeometry) {
            columnSources.push({ name: ctx.geometryColumn, data: geometryData, type: 'BYTE_ARRAY', nullable: true });
            if (writeCovering) {
              columnSources.push({ name: 'bbox_xmin', data: bboxCols.xmin, type: 'DOUBLE', nullable: true });
              columnSources.push({ name: 'bbox_ymin', data: bboxCols.ymin, type: 'DOUBLE', nullable: true });
              columnSources.push({ name: 'bbox_xmax', data: bboxCols.xmax, type: 'DOUBLE', nullable: true });
              columnSources.push({ name: 'bbox_ymax', data: bboxCols.ymax, type: 'DOUBLE', nullable: true });
            }
          }

          const geoMeta = {
            version: '1.1.0',
            primary_column: ctx.geometryColumn,
            columns: {
              [ctx.geometryColumn]: {
                encoding: 'WKB',
                geometry_types: [...geometryTypes],
                ...(overall ? { bbox: overall } : {}),
                ...(writeCovering
                  ? { covering: { bbox: { xmin: ['bbox_xmin'], ymin: ['bbox_ymin'], xmax: ['bbox_xmax'], ymax: ['bbox_ymax'] } } }
                  : {}),
              },
            },
          };
          // DEVIATION (documented, see module doc comment): the design doc
          // defaults to zstd, but hyparquet-writer only *compresses* with
          // SNAPPY out of the box (its bundled src/snappy.js); the pinned
          // hyparquet-compressors package is decompress-only (reading), so
          // there is no pure-JS zstd *compressor* among this project's
          // dependencies. Default here is SNAPPY; `none` is honored;
          // `zstd` is refused with a clear, honest error rather than
          // silently falling back.
          const compressionOption = ctx.options.compression ?? 'snappy';
          if (compressionOption === 'zstd') {
            throw new CnmwError(
              'geoparquet zstd compression is unavailable: hyparquet-writer has no pure-JS zstd compressor among this package\'s dependencies (only a decompressor, for reading). Use { compression: "snappy" } (default) or "none".',
              'FORMAT_CAPABILITY',
              { context: { requested: 'zstd' } },
            );
          }
          const codec = compressionOption === 'none' ? 'UNCOMPRESSED' : 'SNAPPY';
          const rowGroupSize = ctx.options.rowGroupSize ?? 50_000;

          const buffer = parquetWriteBuffer({
            columnData: columnSources,
            codec,
            rowGroupSize,
            kvMetadata: dropGeometry ? [] : [{ key: 'geo', value: JSON.stringify(geoMeta) }],
            createdBy: '@cnmw/download-core',
          });
          const bytes = new Uint8Array(buffer);
          await ctx.writer.write(bytes);
          return { rows, bytes: bytes.byteLength };
        },
        async abort() {},
      };
    },
  };
}

function unionBox(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
