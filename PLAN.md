# Cloud-Native Map Widgets — Experiment Plan

> **Overnight ledger (2026-11-12 → 13).** Everything below landed, each
> verified by its agent AND re-verified at integration (suite 584/584,
> verify:docs 60/60, three local servers live):
> E10 heavy formats (terrio: works, 6.1MB gz — rejected on weight; shipped
> format-gpkg 339KB / shapefile ~5KB / flatgeobuf 10KB / csv+esrijson ~2KB,
> all ogrinfo/duckdb-validated, lazy-loaded with weight notices, proven in a
> real browser via network capture) · E11 raster (COG window+band-subset →
> valid GeoTIFF in-browser, 0 mismatched pixels of 8.4M vs GDAL; geotiff.js
> writer unusable — replaced; shipped raster-core ~27KB + demo) ·
> whosonfirst-catalog built+pushed (9.5M-row gazetteer, license:"other" with
> per-source evidence, 4 data defects fixed, upstream layout measured as the
> mirror justification; awaiting source.coop repo) · library docs (README,
> per-package APIs, AGENTS.md for AI consumers, 58→60 verified snippet
> groups, examples gallery, MIT placeholder) · search UX (highlighting incl.
> alt matches, two-wave merge — which had never reached the DOM, IME gating,
> friendly labels, dark mode, error/retry; OL control leaks fixed) ·
> ranking (alt-demotion: Deutschland/中国 exact-alt #1; then
> population promotion ≥100K after finding WOF's INT64 population was
> silently dropped as BigInt: Brooklyn borough #1, Baghdad city #7→#1) ·
> range latency ("a" 34–44s → ~1.8s first results, streamed, truncation
> flagged) · download perf (parallel reads 11× on 825-request S2 query;
> predicate pushdown 77.6% fewer bytes where stats allow — 4 of 6 real
> predicates prune nothing, upstream-advocacy material) · API hardening
> (blocked handle rejects + acceptCeiling continuation, honest CANCELLED,
> BigInt-safe JSON, observable format loads, geometry-aware output
> estimates 0.006×→1.01×, DEFAULT_INDEX_URL → published manifest, doc-drift
> §8) · portolan-browser card (multi-asset picker, time filters: FIRMS
> 10.2GB→962MB, pause/resume/cancel/success, 7 formats in-app, mobile,
> en+es; 912 unit/253 e2e) · finisher in flight: AreaDownload new-contract
> update + 2 download-core API lies.
> **Upstream-report queue (not filed):** hyparquet ×3 + geoparquet-2.0
> unconditional decode · geotiff.js writer truncation/geokey corruption ·
> gpq null-geometry panic · geoBoundaries mojibake/invalid-geoms/ADM1-drift
> · FIRMS extent vs newest partition + row-group stats · fieldmaps STAC
> license field · sort-on-filtered-column advocacy.
> **Chris's queue:** @cnmw scope · gbOpen ADM3/4 (rec: skip) · browser-card
> decisions (date-window ≥2yr default, "More formats" grouping, CDN writers)
> · tge-labs deletion after cutover. (WOF source.coop repo + MIT: done —
> catalog LIVE 2026-11-13 with prominent index; demo ?index=wof points at
> the published manifest.)

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
- **MEASURED tonight (live, over the public path):** index load
  **3.8s from Node; 5.3s in a browser genuinely cold, 1.9s with a warm CDN**
  for the 3.9MB geoBoundaries index
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

## Status snapshot (2026-11-13 afternoon, simplifier fix + demo consistency + attribution/gear UX)

Chris's Poland screenshot ("is the full vertice download really
happening?") exposed three things; all fixed this session, verified
locally only (he was on a phone connection — no live-catalog fetches, no
pushes):

- **Tolerance-search objective bug (spec)**: `simplifyToVertexCeiling`/
  `Async` searched for the *largest* acceptable tolerance, so the
  post-upgrade `filterGeometry` was the coarsest shape the 5% area guard
  allowed — Poland 68,026 → **17** vertices. Fixed to smallest fitting
  tolerance + geometric bisection: Poland now 68,026 → **9,994** of the
  10,000 budget, area delta 7e-7, unchanged wall time. Design doc §1.3
  amendment (2026-11-13) is normative. Regression tests pin the
  budget-use semantics in both sync and async suites.
- **Example-page inconsistency**: only geocoder-demo opted into
  `upgradeDisplay: true` — Chris was on another page, where the visible
  outline deliberately stayed at display resolution. All example pages
  (quickstart, download-demo, upload-demo, s2-footprints, firms-explorer,
  raster-demo) now use `geometry: { resolution: 'both', upgradeDisplay:
  true }`, and pages that capture `area` for estimates refresh it on
  `area:upgraded`. download-demo also accepts `?index=<manifest URL>`
  like the geocoder-demo. Verified in-browser (local :8787 + :8790
  staging catalog): download-demo outline 1,085 → 68,026 vertices.
- **Attribution UX + gazetteer picker**: see the control changes in this
  session's commits (compact bottom-left ⓘ replacing the full-width
  citation line; ⚙ gazetteer picker on demo pages).

**TODO when off the phone connection**: run `node
docs/verify-snippets.mjs` (hits live catalogs; deliberately skipped this
session) and re-verify one upgraded-outline select against the LIVE
geoBoundaries manifest.

## Status snapshot (2026-11-13, fuzzy fallback — gazet adaptation)

Chris asked whether Development Seed's
[gazet](https://github.com/developmentseed/gazet) could serve the
geocoding; investigation found its *fuzzy matching is pure
DuckDB Jaro-Winkler SQL* (no LLM — the LLM is a separate fine-tuned
Qwen3.5-0.8B for NL place extraction + text-to-SQL). Chris's call: adopt
the fuzzy fallback on our stack (no DuckDB), skip the NL mode, credit
gazet in code and READMEs.

**Shipped** (`packages/geocoder-core/src/fuzzy.js` + `ranking.js`/
`geocoder.js` wiring; design doc §3.2 amendment 2026-11-13 is normative):

- Prefix search returns nothing + query ≥ 3 chars → Jaro-Winkler scan of
  the in-memory rows (full index, or the prominent index in range mode —
  never range reads; WOF has no prominent index so no fallback there until
  its catalog adds one). Non-empty results are never touched.
- Threshold `minSimilarity: 0.9` measured, not guessed (targets ≥ 0.9526,
  noise ≤ 0.8944 — table in the amendment). Substring containment
  one-directional (name ⊇ query), per gazet; the reverse direction was
  tried and rejected ("bagdhad" ⊇ "bag" would bury Baghdad).
- Results are normal `SearchResult`s with `rank.matchClass: 'fuzzy'` +
  `rank.similarity`/`substring`; ordering substring → similarity →
  existing comparator (population promotion verified live: "brookln" →
  Brooklyn first on Overture). `fuzzy: false` disables.
- Perf measured: 52K rows 11–23 ms sync; async path yields every 16K rows.
- Suite 709/709 (23 new tests incl. classic JW vectors, supersede-mid-scan,
  range/prominent paths); `verify-fuzzy.mjs` browser-verified live on
  geoBoundaries + Overture, screenshot committed; verify-snippets 60/60.

**Catalog follow-up — both closed 2026-11-13:** (1) Overture's
`prominent_index` was missing Baghdad-the-locality (level-4 alt rows were
dropped; a non-Latin-primary city is reachable in English *only* through an
alt row) — fixed in cn-gazetteer-overture 47a6a06 with a two-cut policy
(primary ≥ 50, alt ≥ 70 prominence), published live, "bagdhad" verified in
the browser. (2) WOF now ships `names/wof_names_prominent.parquet` (285,735
rows, 21.2 MB, criteria in the manifest): all primaries at levels 0–2,
localadmins at `mz≤12 OR pop≥25k`, localities at `mz≤10 OR pop≥50k`, alt
spellings per level, plus an **english_guarantee** — English alt rows follow
each level's primary rule, because this WOF build's primary names are in no
particular language (Contra Costa County's primary row is Arabic; 328 of 353
country primaries carry no Latin letter). Two-wave + fuzzy verified against
the live catalog. Side discovery for the upstream-report queue:
geocode.earth's language columns mislabel some English forms (e.g. "Contra
Costa County" filed under `deu`), so the guarantee can only be as good as
the `eng` column.

## Status snapshot (2026-11-13, pre-publish hardening pass)

The consolidated follow-up to the overnight audits above. Every numbered
drift item from the 2026-11-12 snapshot is now either fixed or demoted to a
clearly-marked "specified, not implemented" section of the design doc
(**new §8**), so the doc no longer describes behaviour that does not
exist.

**API correctness**

1. **A `blocked` handle's `result` now rejects** with `CeilingExceededError`
   (`context.breaches`/`limits`/`estimate`) instead of never settling, and
   **`acceptCeiling()` returns the continued run's promise** — `result`
   became a getter over a per-run deferred, since a promise settles once
   but the run does not end. Drift #1, the worst one for an automated
   caller, is gone; `AGENTS.md`'s rule telling callers to work around it is
   replaced by the real contract. Consumers updated: all three download
   demos (a `CEILING_EXCEEDED` rejection is no longer rendered as a
   failure; the `state` event reports a decline), `docs/verify-snippets.mjs`.
   **portolan-browser's `AreaDownload.vue` needs a one-line change — see
   "Needs Chris" below.**
2. **Cancellation reports `CANCELLED`.** `parquet-io.js` now checks
   `signal.aborted` when a footer or row read throws, so an abort no longer
   surfaces as `NETWORK` (planning) or `DATASET_UNRESOLVED` (row read).
   It tests the *signal*, not the error type, because a caller-supplied
   `fetch` may reject with anything. Drift #6.
3. **`SearchResult` survives `JSON.stringify`.** `geometry_ref.row` is
   parquet `INT64` → `BigInt`, which made `JSON.stringify(result)` throw;
   both `INT64` columns are now coerced at the result boundary. **This
   turned up a second, worse bug of the same shape:** WOF types
   `population` as `INT64` too, so the `typeof === 'number'` guard read it
   as absent on *every* row — silently reducing the ranking comparator's
   whole prominence component to a measured no-op on the index that
   populates it most widely. Drift #5.
4. **Format load state is observable.** `onFormatState(handler) =>
   unsubscribe` on the download-core registry, fired on registration and on
   every lazy `load()` transition. Replaces portolan-browser's polling
   (it was bumping a reactivity counter to re-read `formats()`).

**Ranking (geocoder-core)**

5. **The Brooklyn case: fixed, measured, and it needed two fixes.** With
   the decode bug above fixed but the comparator untouched, "brooklyn" was
   *unchanged in kind* — the borough still absent from the top 8, because
   components (1)/(2) decide on level before prominence is reached. So:
   a **bounded one-level population promotion** (threshold **100,000**,
   `DEFAULT_POPULATION_PROMOTION_THRESHOLD`, overridable; `Infinity` opts
   out), mirroring the existing exact-match promotion and alt demotion, and
   **prominence moved ahead of raw `level`** — necessary for the same
   structural reason `isAlt` moved in the previous amendment: *any
   adjustment whose purpose is to manufacture a tie must have that tie
   resolved before raw `level`*, or raw level re-opens the gap.
   Brooklyn-the-borough: absent → **#1**. Baghdad-the-city on Overture:
   #7 → **#1**, closing half of the residual the previous two amendments
   documented as unreachable. No regression on bag / paris / london /
   san francisco / springfield; the threshold is a measured trade (every
   neighbouring value is worse in a named way — full sweep in the
   amendment), not a round number. One gate found by measurement: a row
   that took the alt demotion does not also take the population promotion,
   or Bagraain returns to #1 on "bag".
6. **`DEFAULT_INDEX_URL` is the published geoBoundaries manifest**
   (design call #10), not the relative dev path `'./data/index.json'` that
   404'd for every consumer. geoBoundaries rather than Overture so a
   default nobody chose cannot impose ODbL share-alike terms. A two-element
   `indexUrl` array now refuses with **`INDEX_MULTI_SOURCE_UNSUPPORTED`**
   instead of *silently* loading the default — drift #3's real hazard was
   the silence, not the missing feature.

**Performance (download-core)**

10. **Parallel row-group reads: 11x, measured end to end.**
    `maxConcurrentRequests` was documented with a default of 12 and read by
    nothing. Row groups are now fetched by that many workers over one
    shared cursor (the 8c1308c worker-pool shape), with `onBatch` still
    delivered in strict row-group order by a single loop, read-ahead
    bounded so one slow group cannot pull the plan into memory, `pause()`
    gating the *workers* and not just delivery, and worker errors captured
    rather than rethrown. Measured on the real s2 Kenya query (825
    row-group reads, no covering so nothing prunes): **736.9 s sequential
    → 65.5 / 67.1 / 73.9 s at the default**, with *identical* requests
    (825), read bytes (208,463,067), rows (6,822) and batch count (8) —
    the speedup changed nothing about the answer. Sweep: 1 → 106 s,
    4 → 23 s, 12 → 9.5 s, 24 → 5.0 s on a fixed 96-group slice, and 24 was
    still scaling. `maxConcurrentRequests: 1` through the new code matches
    the old engine (106.1 s vs 106.5 s mean), so the pool is free when off.
    Isolated: 8 reads serial 10.07 s vs concurrent 1.59 s, against a
    per-row filter loop costing 14 ms per 6,144-row group — on this path
    latency really is round trip, which is what the sentinel-2 precedent
    claimed and this confirms.
11. **Predicate pushdown** (`where[]` against row-group min/max) as a new
    `row-group-where` stage, always reported. Sound-only: the 11 ops
    statistics can decide prune (`=`, `!=`, `<`, `<=`, `>`, `>=`, `in`,
    `not_in`, `between`, `is_null`, `is_not_null`); `like`/`ilike`, any
    leaf under a `not`, and list/struct subscripts never do, and every
    unknown — missing stats, type mismatch, non-ASCII strings (parquet
    orders BYTE_ARRAY by byte, JS by UTF-16 code unit) — keeps the row
    group. Measured on FIRMS Africa 2024-01 with `brightness >= 500`:
    **649 → 147 row groups, 82.2 s → 18.0 s, 77.6% fewer bytes, identical
    59 rows out.** And the honest other half: four of six real predicates
    tried pruned *nothing* (FIRMS `confidence_pct >= 95`, FIRMS
    `satellite = 'N'`, s2 `eo:cloud_cover <= 1`, s2 `tile_id like`), one
    pruned 2%. Pushdown pays when the predicate column correlates with row
    order; on hilbert-sorted or unsorted files it does not. Good
    upstream-advocacy material: a mirror sorted on a commonly filtered
    column would convert those no-ops.
12. **Honest output-size estimates.** `estimateBytes` gains an additive
    third `ctx` argument carrying `avgGeometryBytes` — average
    *uncompressed* geometry bytes per row, from footer statistics only, so
    the estimate stays metadata-only. All 12 implementations across 6
    packages updated, each with a measured per-format expansion factor, and
    each package now shares one estimator between its plugin and its lazy
    descriptor so the two cannot drift. On 218 CGAZ ADM0 boundaries,
    modelled ÷ written went from **0.006 → 1.01 (GeoJSON)** and
    **0.001 → 1.01 (CSV)**; FTW Liechtenstein 0.24 → 1.05 and 0.06 → 1.03.
    Before this, a 19 MB CSV modelled as 26 kB could never breach an
    `outputBytes` ceiling — the ceiling was decorative on exactly the data
    it exists for. Two residuals documented rather than hidden: a
    per-file average under-models a non-representative slice (0.41x on
    CGAZ ADM1's biggest-first rows — the unsafe direction), and GeoParquet
    over-models compressible geometry up to 3x (the safe direction).
13. **A real row-level bug found in passing and fixed:** `predicate.js`'s
    `compareScalar` coerced a float to `BigInt` via `Math.trunc` when the
    other side was a `BigInt`, so **`0n < 0.5` evaluated `false`** — every
    `INT64` column compared against a fractional threshold filtered
    wrongly — and a `BigInt` vs a non-numeric string *threw*. Found only
    because the new pruner's soundness test requires the pruner and the
    row evaluator to agree.
14. `limit: 0` used to emit one row (the old loop pushed, then tested).
    It now emits none. Judged a bug fix; flagged in case Chris disagrees.

**Documentation (design doc + 8 READMEs)**

15. **New §8, "Specified here, not implemented"**, with each entry also
   marked at its own declaration: `indexUrl`-as-array, `createDrawTool`,
   `load:progress`, `GeocoderControlOptions.geocoder`'s default and
   `geocoderOptions` (deliberate — honoring them would make the adapters
   import a parquet reader), `boundaryUrls`, `initialFetchSize`. Decided
   per item on evidence; `createDrawTool` is the clearest demote (it is
   pointer-interaction UI, and a half-working draw tool is worse than the
   documented escape hatch).
16. Corrected: `rank.viewportRank` (the doc said `viewport`; nothing ever
   produced that field), the two `UPLOAD_*` error codes and the
   `deduped-points` repair kind added to §3.5/§1.2, and standalone
   `estimate()`'s `outputBytes` marked model-only (`download()` recomputes
   it from the real format plugin, and *that* is what the ceiling uses).
17. **Found while verifying, not in the brief:** the attribution
   `share_alike`/`shareAlike` casing wart (drift #2) was already fixed in
   code by commit 3ef699d — an `Area` carries both keys, in agreement —
   while the README, `AGENTS.md` and a `verify-snippets.mjs` assertion all
   still pinned the old broken behaviour. Docs corrected to match.

**Needs Chris**

- **portolan-browser's `AreaDownload.vue` needs a change before it works
  against this build.** It does `const result = await requestHandle.result`
  inside a `try`, so a ceiling breach now lands in the `catch`, shows a
  download error, and the `finally` nulls `this.handle` — after which the
  "Download anyway" button calls `acceptCeiling()` on nothing. The fix is
  to catch `CEILING_EXCEEDED` specifically, wait for the user's decision,
  and resume from `handle.acceptCeiling()`'s returned promise (the three
  demos in this repo now do exactly that, and are worth copying). While in
  there: its `formatsVersion` counter can be driven by the new
  `onFormatState` subscription instead of only being bumped in `finally`,
  which is also what makes a *failed* format load show up in the picker.
  Branch is local and unpushed, so nothing is broken for anyone yet.
- **Two API lies found, and now fixed** (were in the root README's
  known-issues table; both entries removed now that they're closed):
  `inferTableFromSchema` no longer flattens a struct's children into the
  top-level column list — it walks the schema's `num_children` nesting and
  keeps a struct (e.g. `bbox`) as one column, so a dataset with a struct
  `bbox` and no declared `table` reads correctly. `filter.columns.dropGeometry`
  now actually drops geometry from the output: `buildBatch`
  (`engine-hyparquet.js`) only populates `batch.geometry` when
  `outputColumns` still carries the geometry column, and the GeoParquet
  writer omits the physical column and the `geo` metadata entirely. The
  design decision behind the combination of `dropGeometry` with a spatial
  filter — never a refusal, because `dropGeometry` is an output-only
  instruction; geometry is still read internally whenever row-level
  filtering needs it (`columns.js`'s `geometryNeededForFilter`) — is
  documented there and in the design doc's §3.4 amendment below. Tests:
  `packages/download-core/test/infer-table.test.js`,
  `columns.test.js`, `drop-geometry.test.js`.
- **`limit: 0`** now returns zero rows instead of one. Called it a bug fix.
- The **measurement discrepancy I thought I had found is not real** —
  worth recording because it nearly went into the doc as a finding. A
  `before-seq-full825` row in the raw measurement log is labelled
  "seq" but was recorded with `conc: "default"`, i.e. 12 workers; reading
  it as the sequential baseline made the full-query speedup look like
  1.11x. The genuine sequential run (`full825-seq`, `conc: 1`) is 736.9 s,
  and everything reconciles at 11x. Measurement labels are load-bearing.

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
