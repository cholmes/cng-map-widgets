// @cnmw/format-extras -- the `esrijson` FormatPlugin: an Esri REST
// FeatureSet JSON document (`{ geometryType, spatialReference, fields,
// features: [{ attributes, geometry }] }`), the format ArcGIS Online, the
// ArcGIS REST API, and ArcGIS Pro/Field Maps' "Add Data" accept directly.
// Zero dependencies -- a trivial writer, per Chris's "cheap extras if
// nearly free" scope note. NOT streaming: a FeatureSet is one JSON
// document (ArcGIS's own REST API returns it as a single object, never
// newline-delimited), so this plugin buffers and emits once in `close()`,
// the same shape as `@cnmw/format-flatgeobuf`.

import { toGeoJsonGeometry, esriRingsOf } from './geometry.js';

const ESRI_GEOMETRY_TYPE = {
  Point: 'esriGeometryPoint',
  MultiPoint: 'esriGeometryMultipoint',
  LineString: 'esriGeometryPolyline',
  MultiLineString: 'esriGeometryPolyline',
  Polygon: 'esriGeometryPolygon',
  MultiPolygon: 'esriGeometryPolygon',
};

function esriFieldType(schemaType) {
  if (schemaType === 'boolean') return 'esriFieldTypeSmallInteger';
  if (schemaType === 'timestamp') return 'esriFieldTypeDate';
  if (typeof schemaType === 'string' && schemaType.startsWith('float')) return 'esriFieldTypeDouble';
  if (typeof schemaType === 'string' && (schemaType.startsWith('int') || schemaType.startsWith('uint'))) {
    return schemaType === 'int64' || schemaType === 'uint64' ? 'esriFieldTypeDouble' : 'esriFieldTypeInteger'; // esriFieldTypeInteger is 32-bit; widen 64-bit sources rather than risk overflow
  }
  return 'esriFieldTypeString';
}

function sanitizeAttr(v) {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.getTime(); // Esri JSON dates are epoch milliseconds, not ISO text
  return v;
}

function esriGeometryOf(geometry) {
  if (!geometry) return null;
  switch (geometry.type) {
    case 'Point':
      return { x: geometry.coordinates[0], y: geometry.coordinates[1] };
    case 'MultiPoint':
      return { points: geometry.coordinates };
    case 'LineString':
      return { paths: [geometry.coordinates] };
    case 'MultiLineString':
      return { paths: geometry.coordinates };
    case 'Polygon':
    case 'MultiPolygon':
      return { rings: esriRingsOf(geometry) };
    default:
      throw new Error(`@cnmw/format-extras: unsupported geometry type "${geometry.type}" for EsriJSON`);
  }
}

/** @returns {import('./types.js').FormatPlugin} */
export function createEsriJsonFormat() {
  return {
    id: 'esrijson',
    extension: 'json',
    mediaType: 'application/json',
    streaming: false,
    capabilities: { nestedColumns: false, mixedGeometryTypes: false, crs: ['OGC:CRS84', 'EPSG:4326'] },
    estimateBytes(schema, rows) {
      const perRow = schema.length * 28 + 180; // verbose JSON keys per feature, plus Esri's ring/path nesting
      return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
    },
    async open(ctx) {
      if (ctx.crs !== 'EPSG:4326' && ctx.crs !== 'OGC:CRS84' && ctx.crs) {
        const { CnmwError } = await import('@cnmw/spec');
        throw new CnmwError(`@cnmw/format-extras's esrijson writer only writes EPSG:4326; got crs "${ctx.crs}".`, 'FORMAT_CAPABILITY', { context: { crs: ctx.crs } });
      }
      const attrColumns = ctx.schema.filter((c) => c.name !== ctx.geometryColumn);
      const features = [];
      let geometryType = null; // Esri FeatureSets require one geometryType for the whole set, same restriction as Shapefile's one-shape-type-per-file

      return {
        async writeBatch(batch) {
          for (let i = 0; i < batch.rows; i++) {
            const attributes = {};
            for (const c of attrColumns) attributes[c.name] = sanitizeAttr(batch.columns[c.name]?.[i]);
            const geom = toGeoJsonGeometry(batch.geometry[i]);
            if (geom) {
              const esriType = ESRI_GEOMETRY_TYPE[geom.type];
              if (geometryType === null) geometryType = esriType;
              else if (esriType !== geometryType) {
                const { CnmwError } = await import('@cnmw/spec');
                throw new CnmwError(
                  `@cnmw/format-extras's esrijson writer: an Esri FeatureSet has one geometryType for the whole set; this result mixes ${geometryType} with ${esriType}.`,
                  'FORMAT_CAPABILITY',
                  { context: { first: geometryType, conflicting: esriType } },
                );
              }
            }
            features.push({ attributes, geometry: esriGeometryOf(geom) });
          }
        },
        async close() {
          const doc = {
            geometryType: geometryType ?? 'esriGeometryPoint',
            spatialReference: { wkid: 4326 },
            fields: attrColumns.map((c) => ({ name: c.name, type: esriFieldType(c.type), alias: c.name })),
            features,
          };
          const text = JSON.stringify(doc);
          const bytes = new TextEncoder().encode(text);
          await ctx.writer.write(bytes);
          return { rows: features.length, bytes: bytes.byteLength };
        },
        async abort() {
          features.length = 0;
        },
      };
    },
  };
}
