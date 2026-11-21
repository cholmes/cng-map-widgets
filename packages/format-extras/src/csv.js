// @cngeo/format-extras -- the `csv` FormatPlugin (design doc §2.3's format
// options table: `{ geometry?: 'wkt'|'drop' ('wkt'), delimiter?: string
// (',') }`). Zero dependencies, streaming: a row is text the moment it
// arrives, same as the `geojson` plugin in download-core itself.

import { toGeoJsonGeometry, geometryToWkt } from './geometry.js';

function csvEscape(value, delimiter) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function sanitizeValue(v) {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  return v;
}

/**
 * `FormatPlugin.estimateBytes` for `csv` (design doc §3.4's optional third
 * `ctx` argument, added for the item-7 geometry term; a plugin that
 * ignores it keeps working).
 *
 * WKT geometry is most of a CSV row, and before item 7 this model counted
 * none of it -- 84,270 bytes modelled against 1,423,923 written for the
 * 795 FTW Liechtenstein field boundaries, 25,724 against 19,217,657 for
 * 218 geoBoundaries CGAZ ADM0 boundaries. `ctx.avgGeometryBytes` is the
 * dataset's own average WKB bytes per row, read out of the parquet footer,
 * and 2.4 is measured against it by summing the WKT cell of every written
 * row: 2.37x the source WKB for FTW Liechtenstein, 2.38x for CGAZ ADM0,
 * 2.40x for CGAZ ADM1. It is higher than GeoJSON's 1.55x for one concrete
 * reason -- `geometryToWkt` writes coordinates at full JS double precision
 * (`-9.521234567890123 47.123456789012345`, ~37 bytes a pair) where the
 * geojson plugin rounds to `precision` (7 by default, ~25 bytes a pair),
 * against 16 bytes of WKB. The flat 16 bytes covers `POLYGON ((` … `))`
 * and the two quote characters the writer adds because WKT contains
 * commas.
 *
 * @param {readonly { name: string, type?: string }[]} schema
 * @param {{ min: number, max: number, estimate: number, exact: boolean }} rows
 * @param {{ avgGeometryBytes?: number|null }} [ctx]
 */
export function estimateCsvBytes(schema, rows, ctx) {
  // Plain ASCII text, no escaping overhead in the common case: ~12
  // bytes/column of attribute value + delimiter. Measured 26 B/row of
  // non-geometry text for FTW's 3-column schema, 20 for CGAZ ADM0's 4.
  const perRowProps = schema.length * 12;
  const perRowGeometry = typeof ctx?.avgGeometryBytes === 'number' ? ctx.avgGeometryBytes * 2.4 + 16 : 70;
  const perRow = perRowProps + perRowGeometry;
  return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
}

/** @returns {import('./types.js').FormatPlugin} */
export function createCsvFormat() {
  return {
    id: 'csv',
    extension: 'csv',
    mediaType: 'text/csv',
    streaming: true,
    capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
    estimateBytes: estimateCsvBytes,
    async open(ctx) {
      const delimiter = ctx.options?.delimiter ?? ',';
      const geometryMode = ctx.options?.geometry ?? 'wkt';
      const encoder = new TextEncoder();
      let rows = 0;
      let bytes = 0;
      const attrColumns = ctx.schema.filter((c) => c.name !== ctx.geometryColumn).map((c) => c.name);

      async function write(text) {
        const buf = encoder.encode(text);
        bytes += buf.byteLength;
        await ctx.writer.write(buf);
      }

      const headerCols = geometryMode === 'drop' ? attrColumns : [...attrColumns, 'wkt'];
      await write(headerCols.map((c) => csvEscape(c, delimiter)).join(delimiter) + '\r\n');

      return {
        async writeBatch(batch) {
          for (let i = 0; i < batch.rows; i++) {
            const cells = attrColumns.map((name) => csvEscape(sanitizeValue(batch.columns[name][i]), delimiter));
            if (geometryMode !== 'drop') {
              const geom = toGeoJsonGeometry(batch.geometry[i]);
              cells.push(csvEscape(geom ? geometryToWkt(geom) : '', delimiter));
            }
            await write(cells.join(delimiter) + '\r\n');
            rows += 1;
          }
        },
        async close() {
          return { rows, bytes };
        },
        async abort() {},
      };
    },
  };
}
