// @cnmw/download-core -- the `geojson` format plugin (design doc §2.3's
// format-options table, §3.4 FormatPlugin). Streaming: writes bytes as
// batches arrive, never buffers the whole result.

import { wkbToGeoJson } from '@cnmw/spec';

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

/** @returns {import('../types.js').FormatPlugin} */
export function createGeoJsonFormat() {
  return {
    id: 'geojson',
    extension: 'geojson',
    mediaType: 'application/geo+json',
    streaming: true,
    capabilities: { nestedColumns: true, mixedGeometryTypes: true, crs: ['OGC:CRS84', 'EPSG:4326'] },
    estimateBytes(schema, rows) {
      // Rough JSON text-size model: ~25 bytes of punctuation/keys per
      // property + per-column value width, plus geometry text (WKB bytes
      // decoded to coordinate text run noticeably larger -- ~3x is a
      // common rule of thumb for small polygons).
      const perRowProps = schema.length * 25;
      const perRowGeometry = 220; // small polygon text, documented estimate
      const perRow = perRowProps + perRowGeometry;
      return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
    },
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
            const geometry = geomBytes ? roundGeometry(wkbToGeoJson(geomBytes), precision) : null;
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
