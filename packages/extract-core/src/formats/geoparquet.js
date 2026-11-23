// @cngeo/extract-core -- the `geoparquet` format plugin (design doc §2.3,
// §3.4). Hand-builds GeoParquet 1.1 `geo` file metadata + a bbox covering,
// writing with `hyparquet-writer` (see cdn.js's loader).
//
// STREAMING (`streaming: true`, GitHub issue #4). Rows are buffered only up
// to one row group; each full group is encoded by `hyparquet-writer`'s
// incremental `ParquetWriter` and its bytes handed to the sink before the
// next group is read. A group is full at `options.rowGroupSize` rows
// (default 50,000) OR `options.rowGroupBytes` of buffered geometry (default
// 64 MiB), whichever comes first -- the byte bound is what makes "peak
// memory is one row group" true for large geometries, where 50,000 rows can
// be gigabytes. Peak memory is one row group, not the file. Until 0.3.0 this used the buffer-only
// `parquetWriteBuffer`, held every row until `close()`, and so was capped
// by the buffering ceiling while the same download as GeoJSON streamed.
//
// NESTED COLUMNS stay nested. `ctx.sourceSchema` (the hyparquet
// `SchemaElement[]` the engine already read from the source footers) is
// used verbatim for every struct/list/map column, so a STAC-GeoParquet
// `assets`/`links`/`bbox`/`stac_extensions` round-trips as native Parquet
// groups. Without it `hyparquet-writer` can only infer, and its inference
// for an object or array is a JSON string -- the output read back, but as
// VARCHAR, which is not STAC-GeoParquet any more. Inference remains the
// fallback when no source schema is supplied.

import { CngError } from '@cngeo/spec';
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
    streaming: true,
    // memoryFactor: 0 -- at most one row group of rows plus its encoded
    // bytes is ever held (see module doc); nothing scales with the output.
    capabilities: { nestedColumns: true, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'], memoryFactor: 0 },
    estimateBytes: estimateGeoParquetBytes,
    async open(ctx) {
      const { geojsonToWkb, ParquetWriter, ByteWriter, schemaFromColumnData } = await loadHyparquetWriter();

      // Refused here, before a byte is written, rather than at `close()`
      // once the whole read has been paid for. DEVIATION (documented): the
      // design doc defaults to zstd, but hyparquet-writer only *compresses*
      // with SNAPPY out of the box and the pinned hyparquet-compressors
      // package is decompress-only, so there is no pure-JS zstd compressor
      // among this project's dependencies. `none` is honored; `zstd` is
      // refused rather than silently falling back.
      const compressionOption = ctx.options.compression ?? 'snappy';
      if (compressionOption === 'zstd') {
        throw new CngError(
          'geoparquet zstd compression is unavailable: hyparquet-writer has no pure-JS zstd compressor among this package\'s dependencies (only a decompressor, for reading). Use { compression: "snappy" } (default) or "none".',
          'FORMAT_CAPABILITY',
          { context: { requested: 'zstd' } },
        );
      }
      const codec = compressionOption === 'none' ? 'UNCOMPRESSED' : 'SNAPPY';
      // Validated, not coerced: `Math.trunc` of an array or a non-numeric
      // string is NaN, and NaN in the slicing arithmetic below appends no
      // rows at all -- an empty file reported as a success.
      const rowGroupSize = positiveIntegerOption(ctx.options.rowGroupSize, 'rowGroupSize', 50_000);
      const rowGroupBytes = positiveIntegerOption(ctx.options.rowGroupBytes, 'rowGroupBytes', DEFAULT_ROW_GROUP_BYTES);
      const writeCovering = ctx.options.writeCovering ?? true;

      // `filter.columns.dropGeometry` (design doc §2.2): `ctx.schema` is
      // built from `plan.outputColumns` (`download.js`'s `schemaFor`), which
      // `resolveOutputColumns` already excludes the geometry column from
      // when `dropGeometry` is set -- so its absence here is the one
      // signal this writer needs. The output is then an honest plain
      // Parquet file: no geometry column, no covering, no `geo` metadata.
      const dropGeometry = !ctx.schema.some((c) => c.name === ctx.geometryColumn);

      // Native subtrees for the nested columns, from the source footer.
      const nested = nestedSubtrees(ctx.sourceSchema);
      // Flat columns' source elements, for typing a column `table.columns`
      // declares no usable type for (see `flatTypeFor`).
      const sourceFlat = flatSourceElements(ctx.sourceSchema);
      const outputNames = new Set(ctx.schema.map((c) => c.name));

      // The covering. Three cases, in order:
      //  1. The dataset's DECLARED covering struct (`ctx.covering`, from
      //     `table.bbox`) is in the output and is being written natively:
      //     it IS a GeoParquet 1.1 covering, so point at it. Only the
      //     declared one -- a struct that merely has xmin/ymin/xmax/ymax
      //     leaves (a projected extent, say) is not the geometry's bbox,
      //     and a covering that points at it makes readers prune wrongly.
      //  2. The output already carries all four `bbox_*` columns (a file
      //     this writer produced, extracted again): reuse them rather than
      //     writing four more columns with the same names.
      //  3. Otherwise compute the four columns from the written geometry.
      //     Skipped when only SOME of those names are taken: adding the
      //     rest would duplicate a column name.
      const wantCovering = !dropGeometry && writeCovering;
      const coveringStruct = wantCovering ? declaredCoveringStruct(ctx.covering, outputNames, nested) : null;
      const takenCoveringNames = COVERING_COLUMNS.filter((n) => outputNames.has(n));
      const reuseCoveringColumns = wantCovering && !coveringStruct && takenCoveringNames.length === COVERING_COLUMNS.length;
      const addCoveringColumns = wantCovering && !coveringStruct && takenCoveringNames.length === 0;

      // --- the sink bridge -------------------------------------------
      // `ByteWriter` keeps `offset` (total bytes written, what every
      // parquet offset is computed from) apart from `index` (position in
      // its buffer) precisely so the buffer can be drained mid-file. Each
      // drain copies the bytes out, because the buffer is reused.
      const byteWriter = new ByteWriter();
      const drain = async () => {
        if (byteWriter.index === 0) return;
        const chunk = new Uint8Array(byteWriter.buffer, 0, byteWriter.index).slice();
        byteWriter.index = 0;
        await ctx.writer.write(chunk);
      };
      byteWriter.flush = drain; // ParquetWriter calls this after each row group, and awaits it
      byteWriter.finish = drain; // ...and this after the footer
      byteWriter.getBuffer = byteWriter.getBytes = () => {
        throw new Error('geoparquet: the streaming writer holds no whole-file buffer');
      };

      /** @type {InstanceType<typeof ParquetWriter>|null} created with the first row group, once the schema is known */
      let parquet = null;
      /** @type {string[]|null} property column order, fixed by the first batch */
      let colNames = null;
      /** @type {Record<string, unknown[]>} */
      let columnData = {};
      /** @type {(Uint8Array|null)[]} */
      let geometryData = [];
      let bboxCols = { xmin: [], ymin: [], xmax: [], ymax: [] };
      let pending = 0; // rows buffered, not yet written as a row group
      let pendingBytes = 0; // geometry bytes buffered with them
      const geometryTypes = new Set();
      let overall = null;
      let rows = 0;

      const declaredType = (name) => ctx.schema.find((c) => c.name === name)?.type;
      /**
       * The hyparquet-writer type for a flat column: the declared
       * `table.columns` type when `TYPE_MAP` knows it, else the source
       * footer's own physical type when that is one of the plain ones.
       * `undefined` -- "infer from the first row group" -- is the last
       * resort, because an inference is fixed for the whole file: a column
       * that is all null in the first group would be typed as raw bytes.
       */
      const flatTypeFor = (name) => TYPE_MAP[declaredType(name)] ?? plainSourceType(sourceFlat.get(name));

      /** The buffered rows as hyparquet-writer `ColumnSource`s, in schema order. */
      function columnSources() {
        /** @type {{ name: string, data: unknown[], type?: string, nullable?: boolean }[]} */
        const sources = [];
        for (const name of colNames) {
          // A nested column carries no `type`: its schema is the source
          // subtree, spliced in by `buildSchema` below.
          sources.push(nested.has(name) ? { name, data: columnData[name] } : { name, data: columnData[name], type: flatTypeFor(name), nullable: true });
        }
        if (!dropGeometry) {
          sources.push({ name: ctx.geometryColumn, data: geometryData, type: 'BYTE_ARRAY', nullable: true });
          if (addCoveringColumns) {
            sources.push({ name: 'bbox_xmin', data: bboxCols.xmin, type: 'DOUBLE', nullable: true });
            sources.push({ name: 'bbox_ymin', data: bboxCols.ymin, type: 'DOUBLE', nullable: true });
            sources.push({ name: 'bbox_xmax', data: bboxCols.xmax, type: 'DOUBLE', nullable: true });
            sources.push({ name: 'bbox_ymax', data: bboxCols.ymax, type: 'DOUBLE', nullable: true });
          }
        }
        return sources;
      }

      /**
       * The file schema, fixed when the first row group is written. Flat
       * columns go through hyparquet-writer's own `schemaFromColumnData`
       * (declared type when `TYPE_MAP` knows it, else inferred from this
       * first group -- the same first-values inference the buffered writer
       * did). Nested columns get their source subtree.
       */
      function buildSchema(sources) {
        const flat = schemaFromColumnData({ columnData: sources.filter((s) => !nested.has(s.name)) });
        // An inferred element is REQUIRED whenever its sample held no null,
        // and the schema is fixed for the file: a null in a later row group
        // would then throw mid-stream, after earlier groups had reached the
        // sink. Every column this writer emits is nullable.
        const flatByName = new Map(flat.slice(1).map((el) => [el.name, { ...el, repetition_type: 'OPTIONAL' }]));
        const schema = [{ name: 'root', num_children: sources.length }];
        for (const s of sources) {
          if (nested.has(s.name)) schema.push(...nested.get(s.name));
          else schema.push(flatByName.get(s.name));
        }
        return schema;
      }

      /** Write everything buffered as one row group, and hand its bytes to the sink. */
      async function writeRowGroup() {
        if (pending === 0) return;
        const sources = columnSources();
        if (!parquet) {
          parquet = new ParquetWriter({ writer: byteWriter, schema: buildSchema(sources), codec, createdBy: '@cngeo/extract-core' });
        }
        // `pending` is the group size, so this is exactly one row group.
        await parquet.write({ columnData: sources, rowGroupSize: pending });
        columnData = Object.fromEntries(colNames.map((n) => [n, []]));
        geometryData = [];
        bboxCols = { xmin: [], ymin: [], xmax: [], ymax: [] };
        pending = 0;
        pendingBytes = 0;
      }

      return {
        async writeBatch(batch) {
          if (!colNames) {
            colNames = Object.keys(batch.columns);
            for (const name of colNames) columnData[name] = [];
          }
          // A batch can be larger than a row group (one decoded source row
          // group, say), so it is fed in slices that each top the buffer up
          // to exactly `rowGroupSize` -- and no more than `BYTE_CHECK_ROWS`
          // at a time, so the byte bound is checked often enough to mean
          // something when single geometries are large.
          let from = 0;
          while (from < batch.rows) {
            const to = Math.min(batch.rows, from + Math.min(rowGroupSize - pending, BYTE_CHECK_ROWS));
            pendingBytes += appendRows(batch, from, to);
            pending += to - from;
            rows += to - from;
            from = to;
            if (pending >= rowGroupSize || pendingBytes >= rowGroupBytes) await writeRowGroup();
          }
        },
        async close() {
          if (!colNames) colNames = ctx.schema.map((c) => c.name).filter((n) => n !== ctx.geometryColumn);
          await writeRowGroup();
          if (!parquet) {
            // No rows at all: still a valid, readable file with the right
            // columns. There is no data to infer from, so an undeclared
            // flat column falls back to STRING.
            for (const name of colNames) columnData[name] ??= [];
            const sources = columnSources().map((s) => (nested.has(s.name) || s.type ? s : { ...s, type: 'STRING' }));
            parquet = new ParquetWriter({ writer: byteWriter, schema: buildSchema(sources), codec, createdBy: '@cngeo/extract-core' });
          }
          if (!dropGeometry) {
            const covering = coveringStruct
              ? { bbox: { xmin: [coveringStruct, 'xmin'], ymin: [coveringStruct, 'ymin'], xmax: [coveringStruct, 'xmax'], ymax: [coveringStruct, 'ymax'] } }
              : addCoveringColumns || reuseCoveringColumns
                ? { bbox: { xmin: ['bbox_xmin'], ymin: ['bbox_ymin'], xmax: ['bbox_xmax'], ymax: ['bbox_ymax'] } }
                : null;
            const geoMeta = {
              version: '1.1.0',
              primary_column: ctx.geometryColumn,
              columns: {
                [ctx.geometryColumn]: {
                  encoding: 'WKB',
                  geometry_types: [...geometryTypes],
                  ...(overall ? { bbox: overall } : {}),
                  ...(covering ? { covering } : {}),
                },
              },
            };
            // Only known once every row has been seen, and only read by
            // `finish()` when it writes the footer -- which is what lets
            // the row groups go out first.
            parquet.kvMetadata = [{ key: 'geo', value: JSON.stringify(geoMeta) }];
          }
          await parquet.finish();
          return { rows, bytes: byteWriter.offset };
        },
        async abort() {},
      };

      /** Append rows `[from, to)` of `batch` to the row-group buffer. Returns the geometry bytes added. */
      function appendRows(batch, from, to) {
        let geometryBytes = 0;
        for (const name of colNames) {
          // hyparquet-writer's INT64 physical type demands a real BigInt,
          // not a Number -- it throws "parquet expected bigint value"
          // otherwise. A genuine `int64` column already arrives as
          // BigInt from hyparquet's own reader; `uint32`/`uint64` (widened
          // to INT64 above specifically to avoid signed-overflow on
          // write) arrive as plain Numbers, since their *source* physical
          // type was never INT64 to begin with. Found writing
          // s2-stac-geoparquet's `_hilbert` (uint32) column during this
          // package's E6 stress test.
          const needsBigInt = !nested.has(name) && flatTypeFor(name) === 'INT64';
          const source = batch.columns[name];
          const target = columnData[name];
          for (let i = from; i < to; i++) {
            let v = source[i]; // hyparquet-writer's TIMESTAMP type accepts a Date directly
            if (needsBigInt && typeof v === 'number') v = BigInt(v);
            target.push(v ?? null);
          }
        }
        if (dropGeometry) return geometryBytes;
        for (let i = from; i < to; i++) {
          const wkb = batch.geometry[i];
          if (wkb) {
            // `batch.geometry[i]` is raw WKB bytes for a GeoParquet-1.x
            // source (CGAZ, FTW: a plain BYTE_ARRAY column + `geo`
            // kv-metadata), but is already a *decoded* GeoJSON object for
            // a GeoParquet-2.0 source with the native Parquet GEOMETRY
            // logical type (FIRMS, s2-stac-geoparquet -- see
            // `../wkb-geometry.js`'s module doc). `decodeWkbGeometry`
            // normalizes either input to a GeoJSON geometry; this format
            // writes its own geometry column as raw WKB bytes, so
            // round-trip through `geojsonToWkb` to get real bytes out
            // either way -- writing a decoded object straight into a byte
            // column crashed hyparquet-writer with "expected Uint8Array
            // value, got object", found running this package's E6 stress
            // test against the real FIRMS catalog.
            const geom = decodeWkbGeometry(wkb);
            const encoded = geojsonToWkb(geom);
            geometryBytes += encoded.byteLength;
            geometryData.push(encoded);
            geometryTypes.add(geom.type);
            const box = bboxOfAnyGeometry(geom);
            if (addCoveringColumns) {
              bboxCols.xmin.push(box[0]);
              bboxCols.ymin.push(box[1]);
              bboxCols.xmax.push(box[2]);
              bboxCols.ymax.push(box[3]);
            }
            overall = overall ? unionBox(overall, box) : [box[0], box[1], box[2], box[3]];
          } else {
            geometryData.push(null);
            if (addCoveringColumns) {
              bboxCols.xmin.push(null);
              bboxCols.ymin.push(null);
              bboxCols.xmax.push(null);
              bboxCols.ymax.push(null);
            }
          }
        }
        return geometryBytes;
      }
    },
  };
}

/** The four flat covering columns this writer adds when nothing else serves. */
const COVERING_COLUMNS = ['bbox_xmin', 'bbox_ymin', 'bbox_xmax', 'bbox_ymax'];

/** Default `rowGroupBytes`: flush a row group once this much geometry is buffered. */
const DEFAULT_ROW_GROUP_BYTES = 64 * 1024 ** 2;

/** Rows appended between checks of the byte bound. */
const BYTE_CHECK_ROWS = 1024;

/**
 * A positive-integer format option, or its default when absent. Anything
 * else is refused by name: a silently coerced NaN here wrote an empty file.
 */
function positiveIntegerOption(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new CngError(`geoparquet option "${name}" must be a positive number, got ${JSON.stringify(value) ?? String(value)}.`, 'FORMAT_CAPABILITY', {
      context: { option: name, value: Array.isArray(value) ? 'array' : typeof value },
    });
  }
  return Math.trunc(value);
}

/**
 * The flat (childless) top-level columns of a hyparquet footer schema, by name.
 * @param {import('hyparquet').SchemaElement[]|undefined} sourceSchema
 * @returns {Map<string, import('hyparquet').SchemaElement>}
 */
function flatSourceElements(sourceSchema) {
  /** @type {Map<string, import('hyparquet').SchemaElement>} */
  const out = new Map();
  if (!Array.isArray(sourceSchema)) return out;
  let i = 1;
  while (i < sourceSchema.length) {
    const start = i;
    i = subtreeEnd(sourceSchema, i);
    if (!sourceSchema[start].num_children) out.set(sourceSchema[start].name, sourceSchema[start]);
  }
  return out;
}

/**
 * A hyparquet-writer type for a flat source element, but only for the plain
 * cases whose decoded values are exactly what that type accepts back: a
 * UTF-8 string, a boolean, a float/double, or a bare INT32/INT64 with no
 * logical or converted type on top. Anything annotated (a decimal, a date,
 * an unsigned or narrow integer, a UUID) is left to inference -- guessing
 * its round-trip from the physical type alone would write wrong values.
 * @param {import('hyparquet').SchemaElement|undefined} el
 * @returns {string|undefined}
 */
function plainSourceType(el) {
  if (!el) return undefined;
  if (el.type === 'BYTE_ARRAY' && (el.converted_type === 'UTF8' || el.logical_type?.type === 'STRING')) return 'STRING';
  if (el.converted_type || el.logical_type) return undefined;
  if (el.type === 'BOOLEAN' || el.type === 'DOUBLE' || el.type === 'FLOAT' || el.type === 'INT32' || el.type === 'INT64') return el.type;
  return undefined;
}

/**
 * The nested top-level columns of a hyparquet footer schema, each as its
 * own flat subtree (the element and all its descendants, in schema order).
 * A flat column is not included: those keep going through `TYPE_MAP`.
 *
 * The column's own element is made OPTIONAL -- this writer nulls freely
 * (a column missing from one source part, a row with no value) and the
 * source may have declared it REQUIRED. Descendants are left exactly as
 * the source declared them, since changing those would change what the
 * file says its lists and maps are.
 * @param {import('hyparquet').SchemaElement[]|undefined} sourceSchema
 * @returns {Map<string, import('hyparquet').SchemaElement[]>}
 */
function nestedSubtrees(sourceSchema) {
  /** @type {Map<string, import('hyparquet').SchemaElement[]>} */
  const out = new Map();
  if (!Array.isArray(sourceSchema) || sourceSchema.length === 0) return out;
  let i = 1; // [0] is the root
  while (i < sourceSchema.length) {
    const start = i;
    i = subtreeEnd(sourceSchema, i);
    const el = sourceSchema[start];
    if (el.num_children) {
      const subtree = sourceSchema.slice(start, i).map((e) => ({ ...e }));
      // Only shapes hyparquet-writer can re-encode. Anything else stays
      // out of the map and takes the old path -- written as JSON text --
      // rather than failing the whole download.
      if (!isWritableSubtree(subtree)) continue;
      subtree[0].repetition_type = 'OPTIONAL';
      out.set(el.name, subtree);
    }
  }
  return out;
}

/**
 * Whether hyparquet-writer can write this nested column as declared, given
 * the values hyparquet's reader hands back for it. Three shapes it cannot,
 * each measured to throw:
 *  - a top-level REPEATED group (relabelling it OPTIONAL changes its
 *    meaning: the reader returns an array, the writer then expects a struct)
 *  - a REPEATED leaf -- the legacy two-level list (`optional group l (LIST)
 *    { repeated int32 array }`, the parquet-avro, Hive and old Spark default)
 *  - a MAP whose key is not a string: hyparquet decodes a map as an object,
 *    so its keys come back as strings whatever they were
 * @param {import('hyparquet').SchemaElement[]} subtree
 * @returns {boolean}
 */
function isWritableSubtree(subtree) {
  if (subtree[0].repetition_type === 'REPEATED') return false;
  for (let i = 0; i < subtree.length; i++) {
    const el = subtree[i];
    if (!el.num_children && el.repetition_type === 'REPEATED') return false;
    const isMap = el.converted_type === 'MAP' || el.converted_type === 'MAP_KEY_VALUE' || el.logical_type?.type === 'MAP';
    if (isMap && el.num_children === 1) {
      // map group -> key_value (repeated) -> key, value
      const key = subtree[i + 2];
      const stringKey = key && key.type === 'BYTE_ARRAY' && (key.converted_type === 'UTF8' || key.logical_type?.type === 'STRING');
      if (!stringKey) return false;
    }
  }
  return true;
}

/** Index one past the subtree rooted at `i` in a flat, depth-first schema. */
function subtreeEnd(schema, i) {
  let next = i + 1;
  for (let c = 0; c < (schema[i].num_children ?? 0); c++) next = subtreeEnd(schema, next);
  return next;
}

/**
 * The dataset's declared covering struct, when it is in the output and is
 * being written as a native struct with the four covering leaves. `null`
 * otherwise -- including for any OTHER struct that happens to have
 * xmin/ymin/xmax/ymax fields, which is not the geometry's bbox.
 * @param {{ kind?: string, column?: string }|undefined} covering `plan.covering` (`table.bbox`)
 * @param {Set<string>} outputNames
 * @param {Map<string, import('hyparquet').SchemaElement[]>} nested
 * @returns {string|null}
 */
function declaredCoveringStruct(covering, outputNames, nested) {
  if (covering?.kind !== 'struct' || !covering.column) return null;
  const name = covering.column;
  if (!outputNames.has(name) || !nested.has(name)) return null;
  const [group, ...children] = nested.get(name);
  if (group.num_children !== children.length) return null; // deeper than one level
  const fields = new Map(children.map((c) => [c.name, c]));
  const ok = ['xmin', 'ymin', 'xmax', 'ymax'].every((f) => {
    const c = fields.get(f);
    return c && (c.type === 'DOUBLE' || c.type === 'FLOAT') && c.repetition_type !== 'REPEATED';
  });
  return ok ? name : null;
}

function unionBox(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
