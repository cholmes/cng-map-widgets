// @cng/format-flatgeobuf -- the `flatgeobuf` FormatPlugin (download-core's
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
 * `FormatPlugin.estimateBytes` for `flatgeobuf` (design doc §3.4's
 * optional third `ctx` argument, added for the item-7 geometry term; pure
 * JS, so the lazy descriptor shares it without loading the flatgeobuf
 * module).
 *
 * FlatBuffers stores coordinates as the same raw float64 pairs WKB does,
 * with no general compression, so the geometry term is
 * `ctx.avgGeometryBytes` at 1.0 -- the closest fit of any format here.
 * Measured against the written file: 862 B/row for 795 FTW Liechtenstein
 * field boundaries whose WKB is 745 B/row, 11,018 against 10,895 for 400
 * geoBoundaries CGAZ ADM1, 37,277 against 37,052 for 218 CGAZ ADM0 --
 * within 2.5%, 1.1% and 0.2% of this model respectively. Before item 7
 * this modelled geometry as a flat 50 bytes/row and reported 75,525
 * against 684,920 written (FTW), 23,980 against 8,126,336 (ADM0).
 *
 * @param {readonly { name: string, type?: string }[]} schema
 * @param {{ min: number, max: number, estimate: number, exact: boolean }} rows
 * @param {{ avgGeometryBytes?: number|null }} [ctx]
 */
export function estimateFlatGeobufBytes(schema, rows, ctx) {
  // ~15 bytes/column (typed, not text) + 50 bytes/row of per-feature
  // FlatBuffers structure (vtable, offsets, the properties blob header).
  const perRowProps = schema.length * 15 + 50;
  const perRowGeometry = typeof ctx?.avgGeometryBytes === 'number' ? ctx.avgGeometryBytes * 1.0 : 50;
  const perRow = perRowProps + perRowGeometry;
  return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
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
    estimateBytes: estimateFlatGeobufBytes,
    async open(ctx) {
      if (ctx.crs !== 'EPSG:4326' && ctx.crs !== 'OGC:CRS84' && ctx.crs) {
        const { CngError } = await import('@cng/spec');
        throw new CngError(
          `@cng/format-flatgeobuf writes EPSG:4326 only; got crs "${ctx.crs}".`,
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
