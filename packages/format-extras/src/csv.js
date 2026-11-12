// @cnmw/format-extras -- the `csv` FormatPlugin (design doc §2.3's format
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

/** @returns {import('./types.js').FormatPlugin} */
export function createCsvFormat() {
  return {
    id: 'csv',
    extension: 'csv',
    mediaType: 'text/csv',
    streaming: true,
    capabilities: { nestedColumns: false, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
    estimateBytes(schema, rows) {
      // Plain ASCII text, no escaping overhead in the common case: ~12
      // bytes/column + ~70 bytes/row for a WKT-encoded small polygon
      // (WKT is noticeably more verbose than WKB -- every coordinate is
      // decimal text, not 8 raw bytes).
      const perRow = schema.length * 12 + 70;
      return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
    },
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
