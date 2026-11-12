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
-- exactly what @cnmw/spec's wkbToGeoJson decodes), bbox.
--
-- DEVIATION from design doc §6.4: no separate "display-simplified"
-- boundary file. Simplification of *display* geometry is E2/catalog-repo
-- scope; this demo ships full-resolution geometry for both `full` and
-- `display` manifest entries (same file, same URL) and relies on
-- @cnmw/spec's client-side Visvalingam simplification for
-- `Area.filterGeometry` only. Documented in the handback report.
--
-- Usage:
--   cd examples/geocoder-demo && duckdb -c ".read build-data.sql"
-- Then:
--   node build-manifest.mjs    -- writes data/index.json

.timer on

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
  KV_METADATA {'cnmw:catalog_version': 'geoboundaries-cgaz-provisional-2026-11-12'}
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
  KV_METADATA {'cnmw:catalog_version': 'geoboundaries-cgaz-provisional-2026-11-12'}
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
  KV_METADATA {'cnmw:catalog_version': 'geoboundaries-cgaz-provisional-2026-11-12'}
);

SELECT 'done' AS status;
