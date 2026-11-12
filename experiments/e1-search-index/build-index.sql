-- E1 provisional search index builder
--
-- Builds a source-agnostic name-autocomplete sidecar index from the
-- tge-labs geoBoundaries CGAZ mirror (ADM0 + ADM2; ADM1 at this mirror is
-- bad data per PLAN.md recon and is skipped).
--
-- Schema (source-agnostic per PLAN.md "Design calls" item 6):
--   name        VARCHAR   -- display name
--   name_norm   VARCHAR   -- lower(name), accents stripped, sort/search key
--   level       TINYINT   -- 0 = country, 2 = ADM2 (ADM1 skipped, bad data)
--   country     VARCHAR   -- ISO3-ish country/group code (shapeGroup)
--   feature_id  VARCHAR   -- stable key (shapeID for ADM2; synthesized for
--                            ADM0, which has no shapeID in this mirror)
--   bbox        STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)
--   source      VARCHAR   -- provenance tag, 'geoboundaries-cgaz'
--
-- This is explicitly PROVISIONAL: a separate effort is building the official
-- geoBoundaries catalog + search sidecar in ~/repos/geoboundaries. This
-- index exists only so the E1 benchmark harness has real data to run
-- against today. The harness takes the index URL as a parameter so it can
-- be re-pointed at the official sidecar later with no code changes.
--
-- Usage:
--   duckdb -c ".read build-index.sql"
-- or:
--   duckdb < build-index.sql
--
-- Writes three row-group variants into data/ (gitignored) so the benchmark
-- can compare range-request behavior across row-group sizes. All use zstd.

.timer on

CREATE OR REPLACE TABLE combined AS
SELECT
    shapeName                                   AS name,
    strip_accents(lower(shapeName))             AS name_norm,
    CAST(0 AS TINYINT)                          AS level,
    shapeGroup                                   AS country,
    'ADM0-' || shapeGroup                        AS feature_id,
    bbox,
    'geoboundaries-cgaz'                         AS source
FROM 'https://data.source.coop/tge-labs/admin-boundaries/geoBoundaries/geoBoundariesCGAZ_ADM0.parquet'
WHERE shapeName IS NOT NULL

UNION ALL

SELECT
    shapeName                                   AS name,
    strip_accents(lower(shapeName))             AS name_norm,
    CAST(2 AS TINYINT)                          AS level,
    shapeGroup                                   AS country,
    shapeID                                      AS feature_id,
    bbox,
    'geoboundaries-cgaz'                         AS source
FROM 'https://data.source.coop/tge-labs/admin-boundaries/geoBoundaries/geoBoundariesCGAZ_ADM2.parquet'
WHERE shapeName IS NOT NULL;
-- Data-quality finding (worth reporting upstream, per PLAN.md "upstream
-- advocacy"): 37 of 49349 ADM2 rows in this mirror have a NULL shapeName
-- (mostly Turkmenistan + a few Japan units). An unnamed feature can't be
-- searched by name, so we drop it from the index rather than emit a row
-- with a null/empty search key. This also matters mechanically: a row
-- with NULL name_norm breaks string min/max row-group pruning and the
-- in-memory binary search, which both assume a fully-populated sort key.

-- sanity check: expect ~49.5K rows (218 ADM0 + 49312 ADM2, after dropping
-- the 37 null-name rows)
SELECT level, count(*) AS n FROM combined GROUP BY level ORDER BY level;

CREATE OR REPLACE TABLE sorted AS
SELECT name, name_norm, level, country, feature_id, bbox, source
FROM combined
ORDER BY name_norm;

-- Variant A: row group size 2048 (fine-grained range-request pruning)
COPY sorted TO 'data/index-provisional-rg2048.parquet'
  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 2048);

-- Variant B: row group size 8192 (DuckDB/parquet default-ish, coarser)
COPY sorted TO 'data/index-provisional-rg8192.parquet'
  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 8192);

-- Variant C: single row group (no pruning possible at all -- the
-- "source file as published" failure mode from the recon findings,
-- reproduced at index scale for comparison)
COPY sorted TO 'data/index-provisional-single.parquet'
  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000);

SELECT 'done' AS status;
