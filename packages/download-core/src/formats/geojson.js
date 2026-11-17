// @cng/download-core -- the `geojson` format plugin (design doc §2.3's
// format-options table, §3.4 FormatPlugin). Streaming: writes bytes as
// batches arrive, never buffers the whole result.

import { decodeWkbGeometry } from '../wkb-geometry.js';

const RS = '\u001e'; // RFC 8142 GeoJSON Text Sequences record separator

function roundCoords(coords, precision) {
  if (typeof coords[0] === 'number') {
    return coords.map((c) => Math.round(c * 10 ** precision) / 10 ** precision);
  }
  return coords.map((c) => roundCoords(c, precision));
}

function roundGeometry(geometry, precision) {
  if (!geometry) return geometry;
  return { ...geometry, coordinates: roundCoords(geometry.coordinates, precision) };
}

/**
 * `FormatPlugin.estimateBytes` for `geojson` (design doc §3.4, item-7
 * amendment: the optional third `ctx` argument).
 *
 * The geometry term is the honest half of this. Before item 7 this
 * function modelled geometry as a flat 220 bytes/row, so it under-read
 * every real dataset: 234,525 modelled against 963,287 written for the
 * 795 FTW Liechtenstein fields, and 69,760 against 12,379,597 for 218
 * geoBoundaries CGAZ ADM0 boundaries. `ctx.avgGeometryBytes` is the
 * dataset's own average WKB bytes per row, read out of the footer (see
 * `prune.js`'s `avgColumnBytesPerRow`), and the 1.55 factor is measured
 * against it: summing `JSON.stringify(feature.geometry)` over the
 * *written* output gives 1.50x the source WKB for FTW Liechtenstein, 1.53x
 * for CGAZ ADM0 and 1.56x for CGAZ ADM1. The arithmetic behind it: a 2D
 * coordinate is 16 bytes of WKB and, at this plugin's default
 * `precision: 7`, about 25 bytes of JSON text (`[-9.1234568,47.1234568]`),
 * i.e. 1.56x. A caller passing a lower `precision` makes this model
 * conservative rather than wrong, which is the direction a ceiling check
 * wants. The flat 40 bytes is the `{"type":"Polygon","coordinates":…}`
 * wrapper, which only matters for tiny geometries.
 *
 * @param {readonly { name: string, type?: string }[]} schema
 * @param {import('../bounded.js').Bounded} rows
 * @param {{ avgGeometryBytes?: number|null, geometryColumn?: string }} [ctx]
 * @returns {import('../bounded.js').Bounded}
 */
export function estimateGeoJsonBytes(schema, rows, ctx) {
  // ~25 bytes of punctuation/keys per property + per-column value width.
  // Measured: 91 B/row of non-geometry text for FTW's 3-column schema,
  // 108 for CGAZ ADM0's 4.
  const perRowProps = schema.length * 25;
  // `filter.columns.dropGeometry`: `download.js`'s `schemaFor` already
  // drops the geometry column from `schema` in that case (via
  // `resolveOutputColumns`), so its absence -- checked only when `ctx`
  // names a `geometryColumn` at all, which a direct unit-test call may not
  // -- means the geometry term should be 0, not the generic fallback: a
  // dropped GeoJSON geometry writes `"geometry":null`, not 220 bytes of
  // coordinates. See `columns.js`'s `geometryNeededForFilter` for why this
  // never makes the *read* skip geometry outright when a spatial filter is
  // still evaluating it.
  const geometryKept = !ctx?.geometryColumn || schema.some((c) => c.name === ctx.geometryColumn);
  const perRowGeometry = !geometryKept ? 0 : typeof ctx?.avgGeometryBytes === 'number' ? ctx.avgGeometryBytes * 1.55 + 40 : 220;
  const perRow = perRowProps + perRowGeometry;
  return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
}

/** @returns {import('../types.js').FormatPlugin} */
export function createGeoJsonFormat() {
  return {
    id: 'geojson',
    extension: 'geojson',
    mediaType: 'application/geo+json',
    streaming: true,
    capabilities: { nestedColumns: true, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
    estimateBytes: estimateGeoJsonBytes,
    async open(ctx) {
      const precision = ctx.options.precision ?? 7;
      const newlineDelimited = ctx.options.newlineDelimited ?? false;
      const featureIdColumn = ctx.options.featureIdColumn;
      const encoder = new TextEncoder();
      let rows = 0;
      let bytes = 0;
      let wroteFirst = false;

      async function write(text) {
        const buf = encoder.encode(text);
        bytes += buf.byteLength;
        await ctx.writer.write(buf);
      }

      if (!newlineDelimited) {
        const shareAlike = ctx.attribution.filter((a) => a.shareAlike);
        const header =
          ctx.attribution.length > 0
            ? { type: 'FeatureCollection', license: shareAlike.map((a) => a.license).join(', ') || undefined, attribution: ctx.attribution, features: [] }
            : { type: 'FeatureCollection', features: [] };
        const headerText = JSON.stringify(header).replace(/\]\}$/, '');
        await write(headerText);
      }

      return {
        async writeBatch(batch) {
          const colNames = Object.keys(batch.columns);
          for (let i = 0; i < batch.rows; i++) {
            const properties = {};
            for (const name of colNames) {
              if (name === ctx.geometryColumn) continue;
              let v = batch.columns[name][i];
              if (typeof v === 'bigint') v = Number(v);
              if (v instanceof Date) v = v.toISOString();
              properties[name] = v ?? null;
            }
            const geomBytes = batch.geometry[i];
            const geometry = geomBytes ? roundGeometry(decodeWkbGeometry(geomBytes), precision) : null;
            const feature = { type: 'Feature', properties, geometry };
            if (featureIdColumn && properties[featureIdColumn] !== undefined) feature.id = properties[featureIdColumn];

            if (newlineDelimited) {
              await write(`${RS}${JSON.stringify(feature)}\n`);
            } else {
              await write(`${wroteFirst ? ',' : ''}${JSON.stringify(feature)}`);
              wroteFirst = true;
            }
            rows += 1;
          }
        },
        async close() {
          if (!newlineDelimited) await write(']}');
          return { rows, bytes };
        },
        async abort() {
          // Nothing buffered here beyond the sink's own writer, which the
          // caller (download.js) aborts separately.
        },
      };
    },
  };
}
