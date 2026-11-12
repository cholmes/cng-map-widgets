// @cnmw/format-flatgeobuf -- the `flatgeobuf` FormatPlugin (download-core's
// registry contract, design doc §3.4/§2.3/§4.5: originally budgeted
// "~25KB (est.)"; measured at ~10KB min+gz for the `geojson` submodule
// this plugin actually loads -- see README.md).
//
// NOT streaming: the `flatgeobuf` package's `geojson.serialize(fc,
// crsCode)` API takes a whole FeatureCollection, not a batch-at-a-time
// writer (FlatGeobuf's own file format *is* streamable -- a header with a
// packed R-tree index, then features -- but this package's JS binding
// doesn't expose an incremental encoder, and building one by hand is out
// of scope for what was meant to be this project's cheapest format
// after GeoJSON/GeoParquet). Buffers the batch as a plain GeoJSON
// FeatureCollection in memory, same honesty obligation as the other
// non-streaming plugins here.

import { wkbToGeoJson, isDecodedGeometry } from './wkb-decode.js';

function sanitizeValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  return v;
}

/**
 * @param {{ serialize: (fc: object, crsCode?: number) => Uint8Array }} flatgeobufGeojson
 * @returns {import('./types.js').FormatPlugin}
 */
export function createFlatGeobufFormat(flatgeobufGeojson) {
  return {
    id: 'flatgeobuf',
    extension: 'fgb',
    mediaType: 'application/octet-stream',
    streaming: false,
    capabilities: { nestedColumns: true, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
    estimateBytes(schema, rows) {
      // FlatBuffers' own layout is denser than GeoJSON text but has no
      // general compression; ~15 bytes/column (typed, not text) + ~50
      // bytes/row for a small polygon's geometry, close to GeoParquet's
      // model but without GeoParquet's columnar dictionary/RLE wins.
      const perRow = schema.length * 15 + 50;
      return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
    },
    async open(ctx) {
      if (ctx.crs !== 'EPSG:4326' && ctx.crs !== 'OGC:CRS84' && ctx.crs) {
        const { CnmwError } = await import('@cnmw/spec');
        throw new CnmwError(
          `@cnmw/format-flatgeobuf writes EPSG:4326 only; got crs "${ctx.crs}".`,
          'FORMAT_CAPABILITY',
          { context: { crs: ctx.crs } },
        );
      }
      const features = [];
      return {
        async writeBatch(batch) {
          const colNames = Object.keys(batch.columns);
          for (let i = 0; i < batch.rows; i++) {
            const properties = {};
            for (const name of colNames) {
              if (name === ctx.geometryColumn) continue;
              properties[name] = sanitizeValue(batch.columns[name][i]);
            }
            const raw = batch.geometry[i];
            const geometry = raw == null ? null : (isDecodedGeometry(raw) ? raw : wkbToGeoJson(raw instanceof Uint8Array ? raw : new Uint8Array(raw)));
            features.push({ type: 'Feature', properties, geometry });
          }
        },
        async close() {
          const fc = { type: 'FeatureCollection', features };
          const bytes = flatgeobufGeojson.serialize(fc, 4326);
          await ctx.writer.write(bytes);
          return { rows: features.length, bytes: bytes.length };
        },
        async abort() {
          features.length = 0;
        },
      };
    },
  };
}
