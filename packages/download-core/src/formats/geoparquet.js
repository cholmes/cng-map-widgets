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

import { bboxOfGeometry, wkbToGeoJson, CnmwError } from '@cnmw/spec';
import { loadHyparquetWriter } from '../cdn.js';

const TYPE_MAP = {
  string: 'STRING',
  int32: 'INT32',
  int64: 'INT64',
  float32: 'FLOAT',
  float64: 'DOUBLE',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMP',
};

/** @returns {import('../types.js').FormatPlugin} */
export function createGeoParquetFormat() {
  return {
    id: 'geoparquet',
    extension: 'parquet',
    mediaType: 'application/vnd.apache.parquet',
    streaming: false,
    capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
    estimateBytes(schema, rows) {
      // Columnar + zstd: much denser than GeoJSON text. ~40 bytes/row
      // properties + ~60 bytes/row compressed WKB polygon, both rough.
      const perRow = schema.length * 10 + 60;
      return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
    },
    async open(ctx) {
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
            for (let i = 0; i < batch.rows; i++) {
              const v = batch.columns[name][i]; // hyparquet-writer's TIMESTAMP type accepts a Date directly
              columnData[name].push(v ?? null);
            }
          }
          for (let i = 0; i < batch.rows; i++) {
            const wkb = batch.geometry[i];
            geometryData.push(wkb ?? null);
            if (wkb) {
              const geom = wkbToGeoJson(wkb);
              geometryTypes.add(geom.type);
              const [xmin, ymin, xmax, ymax] = bboxOfGeometry(geom);
              bboxCols.xmin.push(xmin);
              bboxCols.ymin.push(ymin);
              bboxCols.xmax.push(xmax);
              bboxCols.ymax.push(ymax);
              overall = overall ? unionBox(overall, [xmin, ymin, xmax, ymax]) : [xmin, ymin, xmax, ymax];
            } else {
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
          columnSources.push({ name: ctx.geometryColumn, data: geometryData, type: 'BYTE_ARRAY', nullable: true });
          if (writeCovering) {
            columnSources.push({ name: 'bbox_xmin', data: bboxCols.xmin, type: 'DOUBLE', nullable: true });
            columnSources.push({ name: 'bbox_ymin', data: bboxCols.ymin, type: 'DOUBLE', nullable: true });
            columnSources.push({ name: 'bbox_xmax', data: bboxCols.xmax, type: 'DOUBLE', nullable: true });
            columnSources.push({ name: 'bbox_ymax', data: bboxCols.ymax, type: 'DOUBLE', nullable: true });
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
            kvMetadata: [{ key: 'geo', value: JSON.stringify(geoMeta) }],
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
