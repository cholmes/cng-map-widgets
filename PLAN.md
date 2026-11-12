# Cloud-Native Map Widgets — Experiment Plan

**Date:** 2026-11-12
**Status:** Draft for review

## Intent

Enable a composable "download widget" for any Portolan dataset, built from two
independent, reusable parts:

1. **Get an area** — a cloud-native geocoder (type "contra costa county", get an
   outline, near-instantly) and/or upload your own geometry (GeoJSON first).
2. **Act on the area** — download any cloud-native dataset (Overture buildings,
   FTW fields, STAC image footprints like s2-stac-geoparquet, FIRMS fires)
   clipped to that area, in the user's choice of format; same area can also
   power stats display.

Target consumers: custom web apps, portolan-browser (branch here), eventually a
stac-browser widget, and the core logic reusable from QGIS plugins. The end
state is a `cloud-native-map-widgets`-style repo with framework-agnostic cores
plus MapLibre and OpenLayers adapters, documented well enough that an agent can
wire them up unaided.

## Hard constraints & decisions (from Chris)

- **Pure static. No API, no server.** Everything runs in the browser against
  object storage. (A server-side conversion service is explicitly deferred;
  note options but don't build.)
- **Near-instant autocomplete** is the goal for search.
- **Pure parquet/GeoParquet wherever possible** — including any index/sidecar
  files we generate. Non-parquet index formats may appear in benchmarks as
  comparison points only.
- **Download formats:** GeoJSON, GeoParquet, GeoPackage — architected as
  **pluggable format modules** so devs pick what they want, with documented
  bundle-weight cost per format (GeoPackage/gdal-wasm is heavy; core stays light).
- **Data:** start with geoBoundaries CGAZ at
  `s3://tge-labs/admin-boundaries/geoBoundaries/` (CC-BY, good licensing).
  Swap in fieldmaps subnational global build when it lands (~2026-11-13);
  Overture divisions as fallback and for multilingual names.
- **Search UX (from Chris):** global, all admin levels indexed; a reasonably
  ordered list of everything — ADM0 matches first, then ADM1, then ADM2, etc. —
  plus a rank boost for features in/near the current map viewport (the sidecar's
  bbox column makes this cheap).
- **Branches in portolan-browser / firms-catalog:** local only, Chris reviews
  before push.
- **Workspace:** this repo (`cn-geocoding`), git-initialized; graduates/renames
  to a public widgets repo when it gels.
- **Subagents:** use opus (design-heavy) and sonnet (implementation/benchmarks)
  throughout.

## Recon findings so far (2026-11-12)

`https://data.source.coop/tge-labs/admin-boundaries/`:

| file | size | notes |
|---|---|---|
| geoBoundaries/geoBoundariesCGAZ_ADM0.parquet | 89 MB | |
| geoBoundaries/geoBoundariesCGAZ_ADM1.parquet | 89 MB | **BAD DATA: contains ADM0** (218 rows, shapeType=ADM0/DISP) |
| geoBoundaries/geoBoundariesCGAZ_ADM2.parquet | 97 MB | 49,349 rows, 218 countries |
| gaul/gaul0_asap.parquet | 3 MB | |
| gisco/CNTR_RG_01M_2024_4326.parquet | 18 MB | |
| world-bank/* Admin 0/1/2 | 52–108 MB | |

Schema (ADM2): `id, shapeName, shapeID, shapeGroup, shapeType, geometry, bbox(struct)`.

**Key finding:** ADM2 is a **single row group** (49,349 rows); shapeName stats
span `"Evje og Hornnes"` → `Ｚuichangxian`, so predicate pushdown prunes
nothing. Any per-keystroke query reads huge column chunks, and fetching one
selected boundary's geometry ≈ reading the whole geometry chunk. The source
files as published cannot give near-instant search. This motivates both the
sidecar index and an optimized mirror — and gives us concrete numbers to
advocate upstream (source.coop mirror and/or geoBoundaries themselves).

**Second finding:** the tge-labs ADM1 file is a mislabeled copy of ADM0 — real
CGAZ ADM1 (~3,600 units) is absent. E0/E1 will pull ADM1 from geoBoundaries
upstream (CGAZ release) and convert to GeoParquet ourselves; report the bad
file to tge-labs after Chris reviews.

Scale insight: ADM0+1+2 ≈ ~53K named features globally. A names+bbox+ids
sidecar GeoParquet should be low single-digit MB — small enough to load fully
into memory on first focus of the search box, giving truly instant typeahead
with zero further network per keystroke.

## Experiments

Each experiment produces working code + a short RESULTS.md with numbers.
Experiments live in `experiments/`, reusable code graduates to `packages/`.

### E0 — Data recon report *(sonnet)*
Finish the survey: ADM0/ADM1 layout + row counts; verify ADM1 file; GAUL/GISCO/
World Bank comparison; fieldmaps international (ADM0 now, subnational when
published); Overture divisions schema + multilingual name coverage; licensing
table. Output: `experiments/e0-data-recon/RESULTS.md`.

### E1 — Static autocomplete index *(core experiment; sonnet build, opus review)*
Build a **sidecar GeoParquet name index**: one row per feature across all
levels — `name, name_norm (lowercase/unaccent), level, country, shapeID,
bbox, source_file, source_row` — sorted by `name_norm`, small row groups,
zstd. Benchmark in-browser approaches:

- **(a) full-load:** fetch entire sidecar once (hyparquet), in-memory prefix
  search. Expected winner at ~53K rows.
- **(b) range-request:** sorted row groups + page index, binary-search via
  HTTP ranges (hyparquet). Matters when fieldmaps ADM3/4 takes rows to 300K+.
- **(c) baseline:** DuckDB-WASM `ILIKE 'x%'` direct against source files
  (shows why optimization is needed; also measures DuckDB-WASM cold-start).

Metrics: cold start, per-keystroke latency, bytes transferred, index size.
Output: index-builder script (DuckDB SQL/Python), benchmark page + table,
recommendation, upstream-advocacy notes.

### E2 — Fast geometry retrieval + optimized mirror *(sonnet)*
On selection, get the outline fast. Build an **optimized mirror** of the
boundary files: sorted (hilbert or country+name), row groups ~1–2K rows,
bbox covering metadata, zstd. Compare fetch-on-select latency (hyparquet row
range vs DuckDB-WASM) against the source files. Experiment with
**pre-simplified display geometry** (e.g. a `geometry_simplified` column or
low-res sidecar) vs full-res for clipping. Output: mirror-builder script,
numbers, recommended file recipe (this doubles as the upstream advocacy doc).

### E3 — Geocoder widget *(opus design, sonnet implement)*
`packages/geocoder-core`: framework-agnostic TS — input handling, index
loading, search, ranking; emits an `Area` (geometry + bbox + metadata).
`packages/maplibre` + `packages/openlayers`: thin adapters (control +
outline layer). Demo pages for both. Designed so portolan-browser and QGIS
(core logic portable) can consume.

### E4 — Upload widget *(sonnet)*
Drag/drop or file-pick GeoJSON → same `Area` interface the geocoder emits
(the composability seam). Validate/repair, reproject note. Investigate
optional heavier plugin for more formats (gdal3.js, shapefile-js) with
bundle-weight documentation; implement GeoJSON only for now.

### E5 — Download widget *(opus design, sonnet implement)*
`packages/download-core`: given `Area` + dataset descriptor (GeoParquet URL /
STAC item-collection), run spatial filter in-browser (DuckDB-WASM spatial;
compare hyparquet+manual bbox filter for lighter core), stream to file.
Format plugins: **geojson** (light, core), **geoparquet** (DuckDB-WASM COPY),
**gpkg** (optional plugin — evaluate gdal3.js vs sql.js-based writer vs
terrio; measure wasm payload sizes). Progress UI, row/size estimates before
download (parquet metadata only). Server-side conversion: documented as
future option only.

### E6 — Example explorers *(sonnet)*
- `examples/firms-explorer`: FIRMS fires (~/repos/firms-catalog data) —
  search area → stats → download.
- `examples/s2-footprints`: s2-stac-geoparquet — type a country, download
  all Sentinel-2 footprints over it.

### E7 — portolan-browser integration *(opus)*
Local branch in `~/repos/portolan-browser`: download widget on any dataset in
a portolan catalog, consuming the packages from this repo. Architecture notes
for eventual stac-browser widget extraction (keep portolan-specific glue
thin).

### E8 — Multilingual search *(sonnet, after E1)*
Assess name-language coverage: geoBoundaries (mostly single names, mixed
scripts) vs Overture divisions (rich `names` with language tags). Prototype:
alt-name rows in the same sidecar parquet (one row per name variant pointing
at same feature), plus unicode normalization/transliteration in `name_norm`.

## Sequencing

```
E0 ──► E1 ──► E2 ──► E3 ──► E5 ──► E6 ──► E7
              (E4 parallel w/ E3)   (E8 after E1, anytime)
```

E0+E1 start immediately after plan approval (parallelizable). E1/E2 findings
lock the data layer before widget APIs in E3/E5 are finalized.

## Repo layout (target)

```
cn-geocoding/
  PLAN.md
  experiments/        # e0-data-recon/ e1-search-index/ e2-geometry/ ...
  packages/           # geocoder-core/ download-core/ upload-core/
                      # maplibre/ openlayers/
  tools/              # index-builder/ mirror-builder/
  examples/           # firms-explorer/ s2-footprints/
  docs/
```

## Open questions (non-blocking, will make calls and mark them)

- Where does the optimized mirror get hosted for real use? (Experiments can
  serve locally / from a scratch bucket; source.coop account needed for a
  public mirror.)
- Monorepo tooling: plain npm workspaces + vite (default, boring) vs anything
  fancier. Starting with npm workspaces.
- deck.gl: user said "maplibre (or maplibre/deck.gl)" — starting with plain
  MapLibre adapter; deck.gl layer can be added as a third adapter if needed.
