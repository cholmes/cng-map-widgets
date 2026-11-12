# Cloud-Native Map Widgets — Experiment Plan

> **Naming decision (2026-11-12, Chris):** the DATA products are **cloud-native
> gazetteers** — the names indexes and the catalogs that publish them
> (geoboundaries-catalog, cn-gazetteer-overture — renamed from
> cn-geocoder-overture — whosonfirst-catalog). The client widget keeps
> **geocoder** naming (@cnmw/geocoder-core etc.) because that's the term
> developers search for; docs state it's place-name/boundary lookup over
> gazetteer data, not address geocoding. A future public umbrella repo name
> should prefer "gazetteer" over "geocoding".

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

## Data-source decisions (2026-11-12, post-E0)

- **Primary (decided by Chris):** pure geoBoundaries CGAZ — cleanest license
  (CC-BY). Evaluated fieldmaps.io edge-matched geoparquets directly: rich
  multilingual schema and good hosting (CORS, ranges), but **ODbL** even for
  the geoBoundaries-only "open" variant (OSM in the edge-matching chain), plus
  poor layout (ADM2: 4,868 row groups of 1–10 rows; 1.4–2.6 GB full-res
  files; no ADM0 file). Decision: our catalog mirrors geoBoundaries itself.
- **E0 verdicts** (details in `experiments/e0-data-recon/RESULTS.md`):
  #2 source = fieldmaps COD-AB (CC-BY-3.0-IGO, real multilingual names),
  conditional on its global build landing + a 6-point checklist; fallback =
  World Bank Official Boundaries (CC-BY 4.0, ADM0–2, ready today). E8
  multilingual = Overture divisions (country avg ~202 translated names) as a
  separate ODbL opt-in artifact only. GAUL/GISCO/ERM excluded (non-commercial
  licenses).

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

> **DONE 2026-11-12** — see `experiments/e1-search-index/RESULTS.md`. Verdict:
> **full-load wins at current scale** (2.5MB index, ~200ms cold, ~0ms warm;
> budgets were 1s/150ms). Range-request implemented as the >5MB fallback
> (5.6–25ms per query at 2048-row groups). DuckDB-WASM baseline re-downloads
> the entire 97MB source file per keystroke (up to 10.9s) — measured
> confirmation of design call #2 and upstream-advocacy ammunition. Official
> sidecar recipe: sort by name_norm, ~100–150KB row groups by bytes, zstd.

### E2 — Fast geometry retrieval + optimized mirror *(sonnet)*
On selection, get the outline fast. Build an **optimized mirror** of the
boundary files: sorted (hilbert or country+name), row groups ~1–2K rows,
bbox covering metadata, zstd. Compare fetch-on-select latency (hyparquet row
range vs DuckDB-WASM) against the source files. Experiment with
**pre-simplified display geometry** (e.g. a `geometry_simplified` column or
low-res sidecar) vs full-res for clipping. Output: mirror-builder script,
numbers, recommended file recipe (this doubles as the upstream advocacy doc).

> **Update (2026-11-12, from Chris):** the optimized mirror and the E1 search
> sidecar are built in a structured way as a new **git-backed Portolan
> catalog**: `portolan-mirrors/geoboundaries` on GitHub, published to
> source.coop. It pulls from geoBoundaries' published releases via a
> reproducible script, and is an exemplar catalog (full column descriptions,
> sources linked, great docs). The index/mirror parquet files are data
> products of that catalog; cn-geocoding consumes their published URLs. The
> E1/E2 *benchmarks* still live here; the *builders* live in the catalog repo.
> This also resolves mirror hosting (open question below) and index/mirror
> version coupling: one pipeline builds both, keyed by `shapeID`.

### E3 — Geocoder widget *(opus design, sonnet implement)*

> **Design DONE 2026-11-12** — `docs/design/widgets-architecture.md`: Area
> contract (display vs filter geometry, antimeridian via bboxes[]),
> declarative DownloadRequest spec shared with the Python QGIS plugin,
> `@cnmw/*` package design, zero-build CDN packaging (geocoder ~139KB min+gz
> incl. hyparquet), index interface (plain parquet, byte-wise UTF-8 sort,
> catalog_version pinning). 13 open items each with a shipping default; two
> flagged for Chris: (1) one pinned hyparquet version per release train must
> be CI-enforced (portolan-browser pins 1.26.0, E1 used 1.33.0); (2) if
> sql.js can't produce valid GeoPackage, gpkg via gdal3.js is 2–8MB and
> stops being a sane default — E5 must measure before committing.
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

## Status snapshot (2026-11-12, end of day)

- **DONE:** E0 recon · E1 benchmarks · E3 design + implementation (spec,
  geocoder-core, maplibre; demo verified) · E4 (upload-core, openlayers; demo
  verified) · E5 (download-core, geojson+geoparquet formats; demo verified,
  in-browser GeoParquet writing works via hyparquet-writer @ 28.5KB gz core)
  · progressive display/full geometry (UK outline 86ms, Canada 1.1s; display
  files outward-buffered) · E9 ADM3/4 survey · geoboundaries-catalog built,
  fixed (38 names, 1,275 geometries), display products, changes-from-upstream
  doc, pushed — bucket publish blocked only on source-coop login.
- **DONE (late add):** cn-geocoder-overture catalog — built and pushed. 6
  subtypes (272 countries+deps → 556K locality polygons; 2.95M point-only
  localities carried in the index), names index 5.6M rows / 408MB (full
  multilingual, no language cap; median 1 row group per prefix, footer
  2.05MB), display files outward-buffered with 0 features below 99%
  containment at every level, 24 measured styles, ODbL attribution carried
  verbatim + share_alike flags. §6 contract amended from its measurements
  (row-group size scales with row count; float32 bbox OK; point-geometry
  GeoParquet OK). Publish pending: unlisted source.coop repo + login +
  4.7GB upload. Notable data finding: Overture name_lang keys include 47
  non-BCP-47 OSM annotations ('genitive' outranks French). gpq nil-pointer
  bug on null-geometry GeoParquet — repro written, not filed.
- **DECIDED (Chris):** pure geoBoundaries CC-BY primary; Overture ODbL
  opt-in sibling catalog; widget configurable to either; tge-labs mirror to
  be deleted after cutover; simplified geometries buffered outward.
- **PENDING Chris:** gbOpen ADM3/4 (survey says: license-mixed — only
  17–25% strict CC-BY, 25% ODbL incl. CAN/CHN/IND — and 35% country
  coverage; recommendation: skip, let Overture carry cities) · source-coop
  login · npm scope (@cnmw?).
- **NEXT:** E6 example explorers (firms, s2) · E7 portolan-browser branch ·
  demo index-source toggle (geoBoundaries ↔ Overture) once both publish.

## Status snapshot (2026-11-12, overnight — E10 documentation pass)

Both gazetteers are **live and serving**: `geoboundaries-catalog`
(52,398 names, ADM0/1/2, CC-BY-4.0, 3.9MB index) and `cn-gazetteer-overture`
(5,604,413 names, 5 levels, ODbL-1.0, 409MB index + an 8.62MiB eager
`prominent_index`) both answer from `data.source.coop` — so every demo and
every documented snippet now runs against real published data, not fixtures.

- **DONE tonight — the library is documented and presentable:**
  - **Root `README.md`** — what it is, a copy-paste quickstart that is
    `examples/quickstart/index.html` verbatim (Playwright-verified live), the
    architecture picture, the package table with measured sizes against the
    §4.5 budgets, both catalogs with their licenses, honest status, a measured
    known-issues table, and the licensing story.
  - **`AGENTS.md`** — recipes for agents: setup, geocoder → `Area`, consuming
    an `Area`, a `DownloadRequest` per dataset kind (parquet / hive /
    stac-geoparquet / parquet-set), download with estimate+ceiling handling,
    the manifest contract as a field table, 12 ranked pitfalls.
  - **Six package READMEs** (spec, geocoder-core, upload-core, download-core,
    maplibre, openlayers) — API reference read off the actual exports, sizes,
    runnable minimal examples, error tables, gotchas from this repo's own fix
    history.
  - **`docs/verify-snippets.mjs`** — every Node-runnable snippet in all eight
    documents, executed against live data with the documented outcome
    asserted. **58/58 groups green.** `npm run verify:docs`.
  - **`examples/index.html`** — zero-build gallery: six cards, committed
    screenshots, package badges, fetch-into-`<pre>` "View source", verifier
    commands.
  - **`examples/quickstart/`** — the single-file example the README quotes,
    plus its verifier. **New `examples/download-demo/verify.mjs`** (the one
    demo that had none).
  - **Every demo works from a fresh clone.** Four of six pointed at
    `examples/geocoder-demo/data/index.json`, which `.gitignore`'s `data/`
    rule excludes; they now default to the live geoBoundaries manifest with
    `?index=local` preserved. Side benefit: the live index has ADM1, so
    firms-explorer's own suggested query ("california") resolves at all.
  - **Consistency pass:** `0.1.0` everywhere (package.json, dependency pins,
    exported `VERSION`), MIT `LICENSE` in the root and every package,
    real `description`/`keywords`/`license`/`files`, `exports["./package.json"]`.
    `npm install` relinked the workspace, picking up `@cnmw/upload-core` and
    `@cnmw/openlayers`, which had never been symlinked into `node_modules`.
- **MEASURED tonight (live, over the public path):** cold index load
  **3.8s from Node / 5.3s in a browser** for the 3.9MB geoBoundaries index
  (30 jsdelivr requests ≈324KB on first load, 27 of them hyparquet's own
  unbundled modules) — the design doc's budget was <1s on broadband, so
  **that budget is not met**; warm keystroke ~1ms (well inside the 150ms
  budget). `select()` 0.36–2.7s by level. FTW Liechtenstein: estimate
  795 rows / 204,945 exact read bytes / 2 requests; GeoJSON 769 rows /
  938,135B; GeoParquet 769 rows / 193,541B with a valid 1.1 covering.
  FIRMS: 27 `year=` partitions → 1 on a one-week time filter. Sentinel-2:
  12 → 1 partitions but **838 planned requests**, because reads are
  sequential and the collection declares no bbox covering.
- **API-vs-design drift found by reading src against the design doc**,
  documented in the READMEs rather than silently fixed (all are in the root
  README's known-issues table):
  1. A `blocked` `DownloadHandle`'s `result` **waits forever** rather than
     rejecting with `CeilingExceededError` as §3.4 says. Callers must
     `acceptCeiling()` or `cancel()`. **The most dangerous one for an
     automated caller.**
  2. **Attribution key casing is inconsistent:** a geocoder `Area` carries
     the manifest's `snake_case` (`share_alike`), download-core's derived
     attribution uses `shareAlike`. Checking only `shareAlike` **silently
     reports no share-alike obligation on ODbL data.** Wants one
     normalization in `@cnmw/spec`.
  3. `indexUrl` as an array (multi-source) is unimplemented and *silently*
     falls back to `DEFAULT_INDEX_URL`, which is itself the relative dev path
     `'./data/index.json'`, not the published URL §10 specifies.
  4. Specified but not honored: `load:progress` (never emitted),
     `createDrawTool`, `GeocoderControlOptions.geocoderOptions`,
     `GeocoderControlOptions.geocoder`'s `new Geocoder()` default,
     `DownloadCoreOptions.maxConcurrentRequests`,
     `GeocoderOptions.initialFetchSize`,
     `GeometryResolverOptions.boundaryUrls`.
  5. `SearchResult.rank` has `viewportRank`, not §3.2's `viewport`.
  6. Cancelling a download *during planning* surfaces `NETWORK` and state
     `'failed'` rather than `CANCELLED`/`'cancelled'`.
  7. Two error codes exist beyond §3.5's table
     (`UPLOAD_UNSUPPORTED_FORMAT`, `UPLOAD_PARSE_ERROR`) and one repair kind
     beyond §1.2's union (`deduped-points`) — all three are real things a
     user can cause.
- **PENDING Chris (new):** **confirm the code license.** MIT is in place as a
  placeholder in the root and all six packages; Apache-2.0 (patent grant) or
  BSD-3-Clause are the plausible alternatives and it is a one-line change in
  seven files. Also still open from before: source.coop login · npm scope
  (`@cnmw`) · gbOpen ADM3/4.
- **NEXT (recommended order before any npm publish):** (1) one normalization
  of attribution casing in `@cnmw/spec`; (2) make a blocked handle's `result`
  reject as specified, or rename the promise; (3) parallel row-group reads —
  838 requests for one S2 query is the biggest remaining performance lever;
  (4) a prebundled hyparquet to collapse the 27-file cold-load waterfall;
  (5) a `prominent_index` on the geoBoundaries catalog, to get first
  suggestions inside the 1s budget; (6) a build step producing the §4.1
  three artifacts (`.js` / `.cdn.js` / `.bundle.js`) with `.d.ts` — nothing
  below needs it, but npm consumers will.

### hyparquet findings (upstream-feedback candidates)
1. GeoParquet auto-decode: files with `geo` kv-metadata get geometry
   silently replaced by decoded GeoJSON; `utf8: false` is ignored for that
   path. Need `geoparquet: false` to get WKB.
2. With `geoparquet: false`, an untyped BYTE_ARRAY geometry column then hits
   the `utf8: true` DEFAULT and is mangled to string — both flags required
   together for raw bytes. Typed UTF8 columns are unaffected by `utf8:false`.
3. `parquetMetadataAsync(file, N)` with a bare number silently ignores the
   options (signature takes an object) — easy dormant-bug shape.
Also measured: per-keystroke full-file re-download behavior of DuckDB-WASM
on single-row-group files (E1), and the `cache: 'no-store'` range-read fix.

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

## Design calls from builder review (2026-11-12)

A fresh-eyes builder review raised 12 questions; resolutions (all my calls,
marked for Chris to override):

1. **Clip vs intersect:** three-stage default — bbox prune → `ST_Intersects`
   (the download default) → exact clip as an opt-in post-process. Keeps the
   core light; clipping never mutates features silently.
2. **DuckDB-WASM:** *not* in the shipped core. sentinel-2-catalog already
   measured it (74–123 GETs, 6.6–49s for app-shaped queries) and moved to
   hyparquet; we follow. hyparquet(+writer) is the core engine; DuckDB-WASM
   is an opt-in heavy plugin and a benchmark baseline only. GeoParquet
   output = hyparquet-writer + hand-built geo metadata (scoped into E5).
3. **Download bounds:** `download-core` takes `Area` **plus** first-class
   filters (time window, column predicates, column projection), gives a
   pre-download row/byte estimate from parquet metadata, and streams via
   File System Access API; refusal path above a configurable ceiling.
4. **`Area` contract:** GeoJSON geometry, EPSG:4326 only, with `bbox` +
   provenance metadata. Multi-feature upload → union by default. Documented
   vertex ceiling with auto-simplify for the filter geometry. Antimeridian
   handled by bbox splitting (CGAZ has RUS/FJI).
5. **Index↔geometry coupling:** stable key is `shapeID` (logical), not row
   offsets; index + mirror built by one pipeline (now: the geoboundaries
   catalog repo) and versioned together.
6. **Multi-source:** index schema is source-agnostic
   (`name, name_norm, level:int, country, feature_id, source`); one index
   per source, config picks; merging/dedupe across sources is explicitly
   out of scope for now.
7. **QGIS reuse:** the shared artifact is the *declarative* dataset
   descriptor + filter spec (data, not code) and documented SQL recipes —
   consumable from the existing Python qgis_plugin_gpq_downloader. No
   TS-in-QGIS ambitions.
8. **E7 scope:** v1 handles single-file vector GeoParquet, hive-partitioned
   (Portolan partition extension, client-side pruning), and STAC-GeoParquet
   footprint rows. Raster/zarr → graceful "not supported". Dataset
   descriptor = the collection JSON itself.
9. **"Near-instant" budgets (falsifiable):** warm per-keystroke < 150 ms;
   cold focus → first usable suggestions < 1 s on broadband; index fetch is
   lazy (on focus, not page load) and default index ≤ ~3 MB; range-request
   path becomes mandatory once an index exceeds ~5 MB (fieldmaps ADM3/4).
10. **Default index URL:** the published portolan-mirrors/geoboundaries
    source.coop URLs; `indexUrl` overridable.
11. **Licensing of index:** default shipped index stays clean CC-BY
    (geoBoundaries-only). Any Overture-names-enriched index (E8) is a
    separate opt-in artifact carrying ODbL obligations + required
    attribution in the widget UI. *(Flagged for Chris.)*
12. **Stats & E6 shape:** v1 "stats" = pre-download estimates only; real
    aggregations follow the firms precomputed-sidecar pattern, out of scope.
    E6 builds fresh minimal example pages first; retrofitting the live
    firms/s2 apps is follow-on work. Consequence adopted: packages must be
    **zero-build CDN-consumable ESM** (those apps import from jsdelivr with
    no bundler).

## Open questions (non-blocking, will make calls and mark them)

- Where does the optimized mirror get hosted for real use? (Experiments can
  serve locally / from a scratch bucket; source.coop account needed for a
  public mirror.)
- Monorepo tooling: plain npm workspaces + vite (default, boring) vs anything
  fancier. Starting with npm workspaces.
- deck.gl: user said "maplibre (or maplibre/deck.gl)" — starting with plain
  MapLibre adapter; deck.gl layer can be added as a third adapter if needed.
