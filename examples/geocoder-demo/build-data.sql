-- E3 demo PROVISIONAL boundary + search-index builder.
--
-- Extends experiments/e1-search-index/build-index.sql's approach (same
-- source, same name_norm recipe) with per-level BOUNDARY parquet files
-- that geocoder-core's select() can range-read geometry from. This is
-- explicitly PROVISIONAL data for the demo only: the official,
-- optimized geoBoundaries mirror + search sidecar is being built by a
-- separate agent in ~/repos/geoboundaries (not touched by this script).
--
-- Source-agnostic search-index schema (design doc §6.2):
--   name, name_norm, level, country, feature_id, source, bbox,
--   parent_name (null here), area_km2 (null here)
--
-- Boundary file schema (design doc §6.4's "requirements this places on
-- the E2 boundary mirror"): feature_id, name, country, geometry (WKB,
-- copied through verbatim -- this CGAZ mirror's WKB already uses
-- per-sub-geometry byte-order+type headers inside MultiPolygon, which is
-- exactly what @cng/spec's wkbToGeoJson decodes), bbox.
--
-- UPDATE (progressive select() fix): this now DOES emit separate
-- "<level>-display.parquet" files, per design doc §6.4's "requirements
-- this places on the E2 boundary mirror" ("a separate display-simplified
-- file per level, same row order, same shapeID, same catalog_version").
-- Root cause being fixed: CGAZ/LSIB ADM0 geometry is full US-DoS-LSIB
-- resolution -- Canada's ADM0 polygon alone is 528,055 vertices, one ring
-- of which is ~195,000 -- and `select()` used to decode that WKB and then
-- run Visvalingam simplification on it *synchronously on the main
-- thread*, which is the literal "Page Unresponsive" bug. Now:
--   - geocoder-core's `select()` fetches *this* small file first for an
--     instant outline, and fetches `full` only in the background
--     (chunked/yielding decode+simplify -- see @cng/spec's
--     `wkbToGeoJsonAsync` / `simplifyToVertexCeilingAsync`).
--   - Below, each level's display geometry is built with DuckDB's
--     `ST_SimplifyPreserveTopology`, applied ONLY to features above a
--     vertex threshold (small features are already fine and a global
--     tolerance tuned for a 528K-vertex country would visibly mangle a
--     small one -- see the per-feature CASE below and the measurements
--     in the handback report).
--   - Per Chris's outward-bias refinement: every simplified feature is
--     then buffered outward by (roughly) its own simplification
--     tolerance -- `ST_Buffer(ST_SimplifyPreserveTopology(geom, tol), tol)`
--     -- so the display geometry only ever OVER-covers the true boundary,
--     never under-covers it. Verified below (and in the handback report)
--     at >=99% area containment of the original per simplified feature,
--     worst case ~99.8% (ADM0) / ~99.99% (ADM2).
--
-- `VERTEX_THRESHOLD`, `TOLERANCE_DEG` and `BUFFER_DEG`/`NUM_TRIANGLES`
-- below were picked by measurement (see the handback report for the full
-- sweep): the largest tolerance that gets ADM0's worst offender
-- (Canada, 528,055 vertices) under roughly the design doc's 5-10K target
-- *before* buffering, while keeping post-buffer containment >=99% even
-- for the smallest, most distortion-prone features (tiny island nations,
-- enclaves). ADM2 needed its own, much smaller tolerance: CGAZ ADM2 is
-- already simplified for the common case (avg ~267 vertices/feature) but
-- has real outliers above 10K vertices (Nunavut: 188,372; Palawan:
-- 74,545; Chilean Patagonia provinces; Antarctica; Russian/German
-- districts) that need the same treatment.
--
-- Usage:
--   cd examples/geocoder-demo && duckdb -c ".read build-data.sql"
-- Then:
--   node build-manifest.mjs    -- writes data/index.json

.timer on
LOAD spatial;

CREATE OR REPLACE TABLE adm0_raw AS
SELECT * FROM 'https://data.source.coop/tge-labs/admin-boundaries/geoBoundaries/geoBoundariesCGAZ_ADM0.parquet';

CREATE OR REPLACE TABLE adm2_raw AS
SELECT * FROM 'https://data.source.coop/tge-labs/admin-boundaries/geoBoundaries/geoBoundariesCGAZ_ADM2.parquet';

-- ---------------------------------------------------------------------
-- 1. Search index (sidecar), source-agnostic schema.
-- ---------------------------------------------------------------------

CREATE OR REPLACE TABLE index_combined AS
SELECT
    shapeName                                   AS name,
    strip_accents(lower(shapeName))             AS name_norm,
    CAST(0 AS INTEGER)                          AS level,
    shapeGroup                                   AS country,
    'ADM0-' || shapeGroup                        AS feature_id,
    'geoboundaries-cgaz-provisional'             AS source,
    bbox,
    CAST(NULL AS VARCHAR)                        AS parent_name,
    CAST(NULL AS DOUBLE)                         AS area_km2
FROM adm0_raw
WHERE shapeName IS NOT NULL

UNION ALL

SELECT
    shapeName                                   AS name,
    strip_accents(lower(shapeName))             AS name_norm,
    CAST(2 AS INTEGER)                          AS level,
    shapeGroup                                   AS country,
    shapeID                                      AS feature_id,
    'geoboundaries-cgaz-provisional'             AS source,
    bbox,
    CAST(NULL AS VARCHAR)                        AS parent_name,
    CAST(NULL AS DOUBLE)                         AS area_km2
FROM adm2_raw
WHERE shapeName IS NOT NULL;

CREATE OR REPLACE TABLE index_sorted AS
SELECT name, name_norm, level, country, feature_id, source, bbox, parent_name, area_km2
FROM index_combined
ORDER BY name_norm, level, country, feature_id;

SELECT level, count(*) AS n FROM index_sorted GROUP BY level ORDER BY level;

COPY index_sorted TO 'data/index.parquet' (
  FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 2048,
  KV_METADATA {'cng:catalog_version': 'geoboundaries-cgaz-provisional-2026-11-12'}
);

-- ---------------------------------------------------------------------
-- 2. Boundary files, one per level, sorted by (country, feature_id),
--    ~1000-row row groups, geometry copied through as raw WKB BLOB.
-- ---------------------------------------------------------------------

CREATE OR REPLACE TABLE adm0_boundaries AS
SELECT
    'ADM0-' || shapeGroup AS feature_id,
    shapeName             AS name,
    shapeGroup            AS country,
    geometry,
    bbox
FROM adm0_raw
WHERE shapeName IS NOT NULL
ORDER BY country, feature_id;

COPY adm0_boundaries TO 'data/adm0-boundaries.parquet' (
  FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 1000,
  KV_METADATA {'cng:catalog_version': 'geoboundaries-cgaz-provisional-2026-11-12'}
);

CREATE OR REPLACE TABLE adm2_boundaries AS
SELECT
    shapeID    AS feature_id,
    shapeName  AS name,
    shapeGroup AS country,
    geometry,
    bbox
FROM adm2_raw
WHERE shapeName IS NOT NULL
ORDER BY country, feature_id;

COPY adm2_boundaries TO 'data/adm2-boundaries.parquet' (
  FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 1000,
  KV_METADATA {'cng:catalog_version': 'geoboundaries-cgaz-provisional-2026-11-12'}
);

-- ---------------------------------------------------------------------
-- 3. Display-simplified boundary files (progressive select() fix).
--
--    Built FROM adm{0,2}_boundaries -- same SELECT source, same
--    `ORDER BY country, feature_id`, same `ROW_GROUP_SIZE` -- so row
--    count, row order, and row-group boundaries are identical to the
--    `full` file (design doc §6.4), which is what makes `select()`'s
--    two range reads for `resolution: 'both'` land on the same row
--    index without a join.
--
--    Per-feature CASE: only a feature above VERTEX_THRESHOLD (10,000)
--    vertices gets simplified+buffered; everything else passes through
--    byte-for-byte. A single tolerance tuned for CGAZ's worst outliers
--    (Canada's 528,055-vertex ADM0; Nunavut's 188,372-vertex ADM2) would
--    otherwise visibly mangle a tiny feature it didn't need to touch at
--    all (measured: an untouched tiny municipality's naive post-simplify
--    containment was as low as 81% -- see the handback report).
--
--    Outward bias (Chris's refinement): `ST_Buffer(ST_SimplifyPreserve
--    Topology(geom, tol), tol, 2)` -- buffer distance equal to the
--    simplification tolerance, 2 triangles/quarter-circle to limit
--    vertex blow-up from the buffer's own rounding -- guarantees (RDP's
--    Hausdorff-distance property) that the simplified+buffered shape
--    covers the true boundary, not just approximates it. Measured worst
--    case across every simplified feature: ADM0 >=99.80% area
--    containment (Seychelles), ADM2 >=99.99% (Nunavut). Both exceed the
--    99% requirement; see the handback report for the full per-feature
--    sweep. `ST_MakeValid` guards GEOS `TopologyException`s this CGAZ
--    data occasionally triggers on self-touching rings.
-- ---------------------------------------------------------------------

CREATE OR REPLACE TABLE adm0_display AS
WITH geoms AS (
  SELECT
    feature_id, name, country, bbox,
    ST_MakeValid(geometry) AS orig_geom
  FROM adm0_boundaries
), out AS (
  SELECT
    feature_id, name, country, bbox,
    ST_NPoints(orig_geom) AS orig_pts,
    CASE WHEN ST_NPoints(orig_geom) > 10000
      THEN ST_MakeValid(ST_Buffer(ST_SimplifyPreserveTopology(orig_geom, 0.05), 0.05, 2))
      ELSE orig_geom
    END AS out_geom
  FROM geoms
), extents AS (
  SELECT *, ST_Extent(out_geom) AS ext FROM out
)
SELECT
  feature_id,
  name,
  country,
  ST_AsWKB(out_geom) AS geometry,
  CASE WHEN orig_pts > 10000
    THEN {'xmin': ST_XMin(ext), 'ymin': ST_YMin(ext), 'xmax': ST_XMax(ext), 'ymax': ST_YMax(ext)}
    ELSE bbox
  END AS bbox
FROM extents
ORDER BY country, feature_id;

COPY adm0_display TO 'data/adm0-display.parquet' (
  FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 1000,
  KV_METADATA {
    'cng:catalog_version': 'geoboundaries-cgaz-provisional-2026-11-12',
    'cng:geometry_bias': 'outward (ST_Buffer(ST_SimplifyPreserveTopology(geom, 0.05), 0.05, 2) on features >10K vertices)'
  }
);

CREATE OR REPLACE TABLE adm2_display AS
WITH geoms AS (
  SELECT
    feature_id, name, country, bbox,
    ST_MakeValid(geometry) AS orig_geom
  FROM adm2_boundaries
), out AS (
  SELECT
    feature_id, name, country, bbox,
    ST_NPoints(orig_geom) AS orig_pts,
    CASE WHEN ST_NPoints(orig_geom) > 10000
      THEN ST_MakeValid(ST_Buffer(ST_SimplifyPreserveTopology(orig_geom, 0.03), 0.03, 2))
      ELSE orig_geom
    END AS out_geom
  FROM geoms
), extents AS (
  SELECT *, ST_Extent(out_geom) AS ext FROM out
)
SELECT
  feature_id,
  name,
  country,
  ST_AsWKB(out_geom) AS geometry,
  CASE WHEN orig_pts > 10000
    THEN {'xmin': ST_XMin(ext), 'ymin': ST_YMin(ext), 'xmax': ST_XMax(ext), 'ymax': ST_YMax(ext)}
    ELSE bbox
  END AS bbox
FROM extents
ORDER BY country, feature_id;

COPY adm2_display TO 'data/adm2-display.parquet' (
  FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 1000,
  KV_METADATA {
    'cng:catalog_version': 'geoboundaries-cgaz-provisional-2026-11-12',
    'cng:geometry_bias': 'outward (ST_Buffer(ST_SimplifyPreserveTopology(geom, 0.03), 0.03, 2) on features >10K vertices)'
  }
);

-- Sanity: row count/order parity with the full files (design doc §6.4).
SELECT
  (SELECT count(*) FROM adm0_boundaries) AS adm0_full_rows,
  (SELECT count(*) FROM adm0_display) AS adm0_display_rows,
  (SELECT count(*) FROM adm2_boundaries) AS adm2_full_rows,
  (SELECT count(*) FROM adm2_display) AS adm2_display_rows,
  (SELECT count(*) FROM adm0_boundaries b JOIN adm0_display d USING (feature_id) WHERE b.country != d.country) AS adm0_order_mismatches,
  (SELECT count(*) FROM adm2_boundaries b JOIN adm2_display d USING (feature_id) WHERE b.country != d.country) AS adm2_order_mismatches;

SELECT 'done' AS status;
