// @cng/format-shapefile -- the `shapefile` FormatPlugin (download-core's
// registry contract, design doc §3.4/§2.3). Zero dependencies: pure
// JS (no wasm) writing of .shp/.shx/.dbf/.prj/.cpg, bundled into one
// `.shp.zip` (download-core's Sink is one file per download; see
// zip.js's module doc). README.md has the measured ~0KB weight -- this is
// the "near-free" end of the format spectrum the heavy GeoPackage/GDAL
// paths sit at the other end of.
//
// NOT streaming, for the same reason as @cng/format-gpkg: Shapefile's
// shape type is fixed for the whole file, and a null-geometry row can't
// be written correctly until the file's shape type is known, which (for
// an all-null-geometry result) isn't knowable until every row has been
// seen. Buffers all rows in JS arrays; see README.md for the honest
// memory-ceiling statement.
//
// Shapefile's real limits are surfaced as warnings (not silent mangling),
// per the design doc's error taxonomy, collected during the write and
// attached to this plugin's `close()` result (`{ rows, bytes, warnings
// }`) -- download-core's `download()` re-emits each one through the
// existing `'warning'` event (see download-core/src/download.js).
// Mismatched incompatible geometry families (e.g. Point rows mixed with
// Polygon rows -- Shapefile allows exactly one shape type per file) is a
// hard refusal (`FORMAT_CAPABILITY`), not a warning: there's no way to
// write it that isn't actively wrong.

import { writeDbf } from './dbf.js';
import { SHAPE_TYPE, shapeFamilyOf, buildShapeRecordContent } from './shp.js';
import { assembleShpShx } from './shp.js';
import { writeZipStored } from './zip.js';
import { wkbToGeoJson, isDecodedGeometry } from './wkb-decode.js';

const WGS84_ESRI_WKT =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

// Conventionally-cited Shapefile practical size ceiling (the .shx file's
// big-endian int32 word-offset field; many real-world readers, including
// older ArcGIS versions, misbehave well before the theoretical ~4GB
// signed-word-offset limit). Warned, not refused: GDAL itself writes
// past this with only a warning, and this project's own download ceiling
// (design doc §3.4, 2 GiB output default) makes hitting it unlikely.
const SHAPEFILE_SIZE_WARN_BYTES = 2 * 1024 ** 3;

function unionBbox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function geometryBbox(geometry) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  (function walk(c) {
    if (typeof c[0] === 'number') {
      if (c[0] < xmin) xmin = c[0];
      if (c[0] > xmax) xmax = c[0];
      if (c[1] < ymin) ymin = c[1];
      if (c[1] > ymax) ymax = c[1];
      return;
    }
    for (const sub of c) walk(sub);
  })(geometry.coordinates);
  return [xmin, ymin, xmax, ymax];
}

/**
 * `FormatPlugin.estimateBytes` for `shapefile` (design doc §3.4's optional
 * third `ctx` argument, added for the item-7 geometry term; pure JS, so
 * the lazy descriptor shares it).
 *
 * A shapefile shape record stores the same float64 coordinate pairs WKB
 * does, so the geometry term is `ctx.avgGeometryBytes` at 1.0, plus 60
 * bytes/row of fixed structure: the 8-byte .shp record header, the
 * polygon record's own header (type + bbox + part counts), and the 8-byte
 * .shx index entry. The .zip this plugin writes is *stored*, not
 * deflated, so none of that is compressed away. Measured against the
 * written archive: 942 B/row for 795 FTW Liechtenstein field boundaries
 * whose WKB is 745 B/row, 11,165 against 10,895 for 400 geoBoundaries
 * CGAZ ADM1, 37,228 against 37,052 for 218 CGAZ ADM0 -- 1.00-1.02x
 * all-in once the dBase record is accounted for. Before item 7 this
 * modelled geometry as a flat 90 bytes/row and reported 166,950 against
 * 748,985 written (FTW), 54,500 against 8,115,740 (ADM0).
 *
 * @param {readonly { name: string, type?: string }[]} schema
 * @param {{ min: number, max: number, estimate: number, exact: boolean }} rows
 * @param {{ avgGeometryBytes?: number|null }} [ctx]
 */
export function estimateShapefileBytes(schema, rows, ctx) {
  // dBase fixed-width records are plain-text digits/chars, no
  // compression: typically *heavier* per row than GeoParquet or even
  // GeoJSON for numeric-heavy schemas. ~40 bytes/column (the generous
  // field widths this plugin declares) + 90 bytes/row of .dbf/.shx/zip
  // structure.
  const perRowProps = schema.length * 40 + 90;
  const perRowGeometry = typeof ctx?.avgGeometryBytes === 'number' ? ctx.avgGeometryBytes * 1.0 + 60 : 0;
  const perRow = perRowProps + perRowGeometry;
  return { min: rows.min * perRow, max: rows.max * perRow, estimate: rows.estimate * perRow, exact: false };
}

/** @returns {import('./types.js').FormatPlugin} */
export function createShapefileFormat() {
  return {
    id: 'shapefile',
    extension: 'shp.zip',
    mediaType: 'application/zip',
    streaming: false,
    capabilities: { nestedColumns: false, mixedGeometryTypes: false, crs: ['OGC:CRS84', 'EPSG:4326'] },
    estimateBytes: estimateShapefileBytes,
    async open(ctx) {
      if (ctx.crs !== 'EPSG:4326' && ctx.crs !== 'OGC:CRS84' && ctx.crs) {
        const { CnmwError } = await import('@cng/spec');
        throw new CnmwError(
          `@cng/format-shapefile only writes EPSG:4326/OGC:CRS84 (the .prj this plugin writes is fixed WGS84 WKT); got crs "${ctx.crs}".`,
          'FORMAT_CAPABILITY',
          { context: { crs: ctx.crs } },
        );
      }

      const attrColumns = ctx.schema.filter((c) => c.name !== ctx.geometryColumn).map((c) => ({ name: c.name, schemaType: c.type }));

      /** @type {unknown[][]} */
      const attrRows = [];
      /** @type {(GeoJSON.Geometry|null)[]} */
      const geometries = [];
      let shapeFamily = null; // set from the first non-null geometry
      let overallBbox = null;

      return {
        async writeBatch(batch) {
          for (let i = 0; i < batch.rows; i++) {
            attrRows.push(attrColumns.map((c) => batch.columns[c.name]?.[i]));
            const raw = batch.geometry[i];
            if (raw == null) {
              geometries.push(null);
              continue;
            }
            const geom = isDecodedGeometry(raw) ? raw : wkbToGeoJson(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
            const family = shapeFamilyOf(geom.type);
            if (shapeFamily === null) shapeFamily = family;
            else if (family !== shapeFamily) {
              const { CnmwError } = await import('@cng/spec');
              throw new CnmwError(
                `@cng/format-shapefile: a Shapefile has exactly one shape type per file; this result mixes ${shapeFamily} with ${family} geometry, which cannot be written as a single .shp.`,
                'FORMAT_CAPABILITY',
                { context: { first: shapeFamily, conflicting: family } },
              );
            }
            geometries.push(geom);
            overallBbox = unionBbox(overallBbox, geometryBbox(geom));
          }
        },
        async close() {
          const shapeType = shapeFamily ? SHAPE_TYPE[shapeFamily] : SHAPE_TYPE.Point; // an all-null-geometry result still needs *a* shape type; Point is the spec's own minimal default
          const recordContents = geometries.map((g) => buildShapeRecordContent(shapeType, g));
          const { shp, shx } = assembleShpShx(shapeType, recordContents, overallBbox);
          const { bytes: dbf, warnings: dbfWarnings } = writeDbf(attrColumns, attrRows);

          const warnings = [...dbfWarnings];
          const totalBytes = shp.length + shx.length + dbf.length;
          if (totalBytes > SHAPEFILE_SIZE_WARN_BYTES) {
            warnings.push({
              code: 'shapefile-size-ceiling',
              message: `This Shapefile is ${(totalBytes / 1024 ** 3).toFixed(2)} GiB, past the ~2GiB size many Shapefile readers (including older ArcGIS versions) handle reliably. Consider GeoParquet or GeoPackage for this download instead.`,
              context: { bytes: totalBytes },
            });
          }

          const layerName = ctx.options?.layerName || 'features';
          const zip = writeZipStored([
            { name: `${layerName}.shp`, data: shp },
            { name: `${layerName}.shx`, data: shx },
            { name: `${layerName}.dbf`, data: dbf },
            { name: `${layerName}.prj`, data: new TextEncoder().encode(WGS84_ESRI_WKT) },
            { name: `${layerName}.cpg`, data: new TextEncoder().encode('UTF-8') },
          ]);

          await ctx.writer.write(zip);
          return { rows: attrRows.length, bytes: zip.byteLength, warnings };
        },
        async abort() {
          attrRows.length = 0;
          geometries.length = 0;
        },
      };
    },
  };
}
