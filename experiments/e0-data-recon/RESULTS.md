# E0 — Data Recon Results

**Date:** 2026-11-12
**Scope:** admin-boundary sources *other than* geoBoundaries CGAZ (that mirror is being
built separately in `~/repos/geoboundaries`; its key facts are already captured in
`PLAN.md` and are not re-derived here). Covers: fieldmaps (international +
subnational), Overture Maps divisions theme, and the remaining tge-labs
admin-boundaries files (GAUL, GISCO, World Bank). Every factual claim below is
marked **[attested: URL]** (read from a page/doc) or **[derived: query N]**
(computed with DuckDB against the live remote file; query N refers to the
Appendix). Anything I could not pin down is marked **unknown**.

Tooling: local DuckDB v1.4.1, `INSTALL/LOAD httpfs`, remote parquet via
`https://` and `s3://overturemaps-us-west-2/...` (`SET s3_region='us-west-2'`).
No full-file downloads were needed; all facts came from `DESCRIBE`,
`parquet_metadata()`, and aggregate `SELECT`/`COUNT`/`GROUP BY` queries that
DuckDB satisfies with range requests. Scratch files (STAC JSON/README copies)
are in `/private/tmp/claude-501/-Users-cholmes-repos-cn-geocoding/152f1dd6-107d-474c-9cda-c4f20995e7c6/scratchpad/e0/`.

---

## 1. fieldmaps on source.coop

Catalog root: `https://data.source.coop/fieldmaps/` — two sibling catalogs,
`international` (ADM0 only) and `subnational` (ADM1+). Both are
Portolan-generated STAC catalogs (catalog.json/collection.json/README.md/
AGENTS.md per folder) **[attested: https://data.source.coop/fieldmaps/international/catalog.json,
https://data.source.coop/fieldmaps/subnational/catalog.json]**.

### 1.1 `fieldmaps/international` — ADM0 boundaries

Built from the **U.S. Department of State LSIB** boundary lines, combined with
either State Dept World Polygons (public-domain coastlines) or OSM land
polygons, in two "views": `disaggregated` (disputed/autonomous areas as
separate features) and `humanitarian` (grouped with a neighbour)
**[attested: https://data.source.coop/fieldmaps/international/AGENTS.md]**.

Layout: `{license}/{view}/adm0-{polygons,lines,points}/` →
`cc0/disaggregated/`, `cc0/humanitarian/`, `odbl/disaggregated/`,
`odbl/humanitarian/` × `adm0-polygons` / `adm0-lines` / `adm0-points`
**[derived: query 1]**.

| folder | license | coastline source | adm0_polygons.parquet size |
|---|---|---|---|
| `cc0/disaggregated` | CC0-1.0 | State Dept World Polygons | 696 MB |
| `cc0/humanitarian` | CC0-1.0 | State Dept World Polygons | 695 MB |
| `odbl/disaggregated` | ODbL-1.0 | OSM land polygons | 767 MB |
| `odbl/humanitarian` | ODbL-1.0 | OSM land polygons | 766 MB |

**[derived: query 1]**. Each `adm0-polygons` file is **"one feature per row
group"** by design, so filtering on `iso_3`/`adm0_id` reads only the matching
rows **[attested: https://data.source.coop/fieldmaps/international/cc0/disaggregated/adm0-polygons/README.md]**
— i.e. the *opposite* of the CGAZ single-row-group problem noted in PLAN.md.
`adm0_id` = `{adm0_src}-{sourcedateYYYYMMDD}`; "never combine files from
`cc0/` and `odbl/` in one query/output — the result falls under ODbL"
**[attested: …/international/AGENTS.md]**.

This collection is ADM0-only; not useful on its own for the multi-level
sidecar index, but it's the humanitarian ADM0 polygon layer that `subnational`
is clipped to (see 1.2).

### 1.2 `fieldmaps/subnational` — ADM1+ boundaries

> **Status today (2026-11-12): the global build has not landed.** The
> catalog's `AGENTS.md`/`README.md` templates are still unfilled placeholders
> **[attested: https://data.source.coop/fieldmaps/subnational/AGENTS.md]**, and
> the catalog lists **four per-country sub-catalogs**, not a single global
> file **[derived: query 2]**:

| sub-catalog | license | # country/territory collections | role |
|---|---|---|---|
| `cod-ab` | **CC-BY-3.0-IGO** | 112 | live mirror of `source.coop/hdx/cod-ab` (OCHA COD-AB), refreshed every pipeline run |
| `cod-ab-legacy` | **CC-BY-3.0-IGO** | 155 | legacy FieldMaps copy of COD-AB, used for iso3/extents not yet on the live HDX mirror |
| `geoboundaries` | **"other"** (see below) | 209 | legacy FieldMaps copy of geoBoundaries, "used where no COD-AB layer exists" |
| `erm` (EuroGeographics EuroRegionalMap) | **"other"**, non-commercial | 42 | fills in parts of Europe |

**[derived: queries 3–6; attested per-collection license fields in query 7]**.
README description: "Edge-matched admin level 1+ boundaries for every country
and territory, always in the humanitarian world view… Built from OCHA COD-AB
…, filled with legacy COD and geoBoundaries layers, … clipped to the
OSM-based humanitarian admin 0 polygons" **[attested:
https://data.source.coop/fieldmaps/subnational/README.md]**. Each country
collection ships `{iso3}_original.parquet` (source geometry) and
`{iso3}_extended.parquet` (extended past the coastline to match the ADM0
clip), both in a common `cod-ab`-style schema, plus PMTiles + thumbnails
**[derived: query 7]**.

**The "geoBoundaries-derived subset" referenced in PLAN.md is
`fieldmaps/subnational/geoboundaries/*`** — 209 per-country
`{iso3}_extended.parquet` / `{iso3}_original.parquet` files. **Licensing
caveat:** FieldMaps' own STAC metadata records this subset's license as
`"other"`, linking to `https://www.geoboundaries.org/api/current/gbOpen/{ISO3}/ALL/`
rather than to CC-BY **[derived: query 8, attested license link in that
collection.json]** — even though geoBoundaries' own site states its data is
CC-BY per PLAN.md and general geoBoundaries documentation. This looks like an
artifact of FieldMaps' STAC generator defaulting to `"other"` for anything
that isn't CC0/ODbL/CC-BY-3.0-IGO, not a deliberate re-license — but it means
**an agent or pipeline reading only the STAC `license` field will not see
"CC-BY" for this subset**, which is worth flagging back to FieldMaps and
worth re-verifying once the global build's own licensing metadata lands.

**COD-AB (`cod-ab` + `cod-ab-legacy`) is CC-BY-3.0-IGO** — a real open
license (attribution required; the "IGO" variant adds a UN non-endorsement
clause but is otherwise compatible with normal CC-BY attribution handling)
**[attested: license link in https://data.source.coop/fieldmaps/subnational/cod-ab/afg/collection.json]**.
This is, today, the *best-licensed, highest-quality* layer in the subnational
catalog — it's official government/UN-sourced per-country data, not a
crowd-sourced mirror.

**`erm` (EuroGeographics) is explicitly non-commercial / internal-business-use
only** per EuroGeographics' own open-data license terms (original data
generalized to ≤1:1,000,000 for open use; full-resolution/commercial use
requires a separate signed license) **[attested:
https://eurogeographics.org/app/uploads/2025/03/D3.2-Open-Data-License-v2.1.pdf
and https://geoservices.ign.fr/sites/default/files/2021-07/ERM_v10_UserGuide.pdf,
via web search]**. **Not usable for a redistributable search index.**

#### Schema (same across `cod-ab` / `cod-ab-legacy` / `geoboundaries` / `erm`)

One flattened "cod-ab schema" per admin level present in the file — e.g. for
a level-2 country file: `adm2_name, adm2_name1, adm2_name2, adm2_name3,
adm2_pcode, adm1_name, adm1_name1..3, adm1_pcode, adm0_name, adm0_name1..3,
adm0_pcode, valid_on, valid_to, version, lang, lang1, lang2, lang3, iso2,
iso3, geometry` **[derived: query 9]**. `lang`/`lang1..3` are language codes
telling you what `*_name`/`*_name1..3` actually contain — this *is* the
"multiple name languages" PLAN.md flagged:

- `cod-ab/afg`: `adm2_name`="Char Burjak" (lang=`en`), `adm2_name1`="چاربرجک"
  (lang1=`prs`, Dari) — **two languages present per row**
  **[derived: query 10]**.
- `geoboundaries/afg` (legacy geoBoundaries copy): `adm2_name1..3` and
  `lang1..3` are all **NULL** — only one name/language, same as the raw
  geoBoundaries data **[derived: query 10]**.
- `erm/aut`: `adm3_name`="Imst" etc., `lang`=`de`, `adm3_name1..3` NULL — one
  language (German, with full diacritics) **[derived: query 10]**.

**Implication for E8:** of the four subnational sources, **only COD-AB
(`cod-ab`/`cod-ab-legacy`) actually carries multiple name languages today**;
the geoBoundaries-legacy and ERM copies are single-language despite having the
same column layout. Any alt-name sidecar strategy built against today's
per-country files should branch on whether `lang1`/`lang2`/`lang3` are
non-null, not assume the schema implies multilingual data.

#### File layout / row counts (sampled)

Per-country files are tiny (hundreds to low-thousands of features) and are
not row-grouped for query performance in any special way — they're small
enough it doesn't matter. Example: `cod-ab/afg/afg_extended.parquet` = 401
features / 802 rows (extended has 2 geometry variants per unit?), 3.6 MB
**[attested file:size in collection.json, query 7]**; `erm/aut` = 2,093
features / 4,186 rows, 2.7 MB.

**Scale, today:** there is no single global parquet to count rows in — the
catalog is ~112+155+209+42 = **518 per-country/territory collection.json
files**, each a separate HTTP fetch. I did not enumerate every collection's
row count (expensive for low marginal value); sampled countries are
consistent with the ~53K-ADM0+1+2 scale already established for CGAZ in
PLAN.md. **The practical finding is architectural, not row-count:** a global
per-keystroke search today would require fetching (or pre-aggregating)
hundreds of small files — this is *why* "the subnational global build" is the
thing to wait for, not a row-count problem.

#### What to check when the global build lands (~2026-11-13)

1. Is it a **single parquet** (or a small, documented set) under
   `fieldmaps/subnational/`, or still per-country? Check
   `https://data.source.coop/fieldmaps/subnational/` listing for a new
   top-level file/catalog (e.g. `global/` sibling to `cod-ab/`).
2. **Row group layout**: row count, number of row groups, whether sorted
   (by name, country, or quadkey/hilbert) — this is the #1 lesson from the
   CGAZ single-row-group problem in PLAN.md. Run
   `parquet_metadata()` and check `stats_min_value`/`stats_max_value` spread
   per row group on the name/iso3 columns.
2. **Schema continuity**: does it keep the `adm{N}_name`, `adm{N}_name1..3`,
   `lang`, `lang1..3`, `*_pcode` columns from the per-country files, or
   something new (e.g. a `names` map like Overture's)?
3. **Multilingual coverage**: what fraction of features actually have
   `name1`/`lang1` populated globally (today it's COD-AB-only; legacy
   geoBoundaries/ERM rows are single-language) — re-run query 10-style checks
   against a `GROUP BY lang1 IS NOT NULL`.
4. **Licensing metadata**: does the global build carry a single catalog-level
   license, or per-source-provenance licensing (COD-AB CC-BY-3.0-IGO vs.
   ERM non-commercial vs. geoBoundaries CC-BY)? If it blends ERM rows into a
   "global" file without carrying per-row license/provenance, that's a
   **license-contamination risk** — the mixed-source rows could make the
   whole file non-commercial. Check for a `sources`/`provider`/`license`
   column per row (Overture does this with its `sources[]` struct; FieldMaps
   does not currently).
5. **Stable IDs**: does it keep `{iso3}_pcode`-style codes (good, stable,
   human-legible) as the join key, or something else?
6. **bbox column**: none of the sampled per-country files were checked for a
   `bbox` struct (unlike GAUL/GISCO/World Bank, which all have one) — check
   whether the global build adds one; if not, bbox must be derived from
   `ST_Extent(geometry)` or kept out of the sidecar join key.

---

## 2. Overture Maps — Divisions theme (release 2026-10-21.0)

Latest release confirmed via Overture's own release notes
**[attested: https://docs.overturemaps.org/blog/2026/10/ (2026-10-21.0 release)]**.
Divisions theme is GA **[attested: https://docs.overturemaps.org/guides/divisions]**.

### 2.1 Access pattern

- S3: `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type={type}/*.parquet`
  (region `us-west-2`) **[derived: query 11]**.
- Azure: `https://overturemapswestus2.blob.core.windows.net/release/2026-10-21.0/theme=divisions/type={type}/*.parquet`
  **[attested: web search of docs.overturemaps.org/getting-data/cloud-sources/]**.

Three `type=` partitions under `theme=divisions` **[derived: query 11]**:

| type | # files | purpose |
|---|---|---|
| `division` | 1 | one row per division: names, hierarchy, population, admin_level, no full polygon |
| `division_area` | 8 | the polygon geometry, one row per division (per perspective) |
| `division_boundary` | 1 | shared boundary line geometries between adjacent divisions |

### 2.2 Schema — `type=division`

23 columns incl. `id, geometry (BLOB/WKB), country, sources (STRUCT[] with
property/dataset/license/record_id/confidence/provider/version per field),
subtype, admin_level (INT), class, names, wikidata, perspectives, local_type,
region, hierarchies (STRUCT[][] of division_id/subtype/name), parent_division_id,
norms, population, capital_division_ids, capital_of_divisions, cartography,
version, bbox (STRUCT xmin/xmax/ymin/ymax), theme, type`
**[derived: query 12]**.

**`names` structure** (this is the multilingual payload):
```
names STRUCT(
  primary   VARCHAR,
  common    MAP(VARCHAR lang_code, VARCHAR name),
  rules     STRUCT(variant, language, perspectives, value, between, side)[]
)
```
**[derived: query 12]** — i.e. one `primary` display name plus an open-ended
`common` map keyed by language code (observed keys look like BCP-47/ISO
639-ish short codes, e.g. `en`, `fr`, `zh`, `ar`, `ja`, and many minority-
language codes like `ab`, `ace`, `af`…), plus a `rules[]` array for
contextual/perspective-dependent name variants (e.g. disputed-territory
naming per `perspectives.countries`).

Example: `country='FR'` → `names.primary`="France", 276 distinct languages in
`names.common`, incl. `ar`→"فرنسا", `zh`→"法国;法國" (simplified;traditional
packed together), `ja`→"フランス" **[derived: query 13]**.

### 2.3 Row counts by subtype

`type=division` (point/metadata row per division) **[derived: query 14]**:

| subtype | rows |
|---|---|
| locality | 3,508,156 |
| neighborhood | 732,094 |
| microhood | 239,113 |
| macrohood | 156,996 |
| county | 38,937 |
| localadmin | 21,502 |
| region | 3,929 |
| country | 219 |
| dependency | 53 |
| **total** | **~4.70M** |

`type=division_area` (polygon rows; counts differ slightly — more per-country
rows than `division` because disputed/perspective variants get separate area
rows) **[derived: query 15]**: locality 556,094; neighborhood 325,055;
microhood 89,205; macrohood 47,293; county 39,900; localadmin 21,502; region
4,727; country 378; dependency 105 (**total ≈ 1.08M polygons**).

Coverage note from Overture's own docs: country/dependency/region/county
"generally aligns with the `admin_level` tags in OSM and geoBoundaries"
globally; `locality`/`borough`/`neighborhood`/`microhood` exist globally but
coverage is "spotty" **[attested: https://docs.overturemaps.org/guides/divisions]**.
For our use case (ADM0–ADM2-ish search), `country` + `region` + `county` +
`localadmin` (≈ 64,587 rows) is the comparable tier to geoBoundaries
ADM0+1+2 (~53K, per PLAN.md) — a similar order of magnitude, confirming
Overture is a credible fallback/companion source at the levels we care about.

### 2.4 Multilingual coverage (quantitative)

Average `cardinality(names.common)` (# of language translations) and
`len(names.rules)` per subtype, plus % of rows with ≥1 translation
**[derived: query 16]**:

| subtype | n | avg # common-name langs | avg # rules | % with ≥1 common name |
|---|---|---|---|---|
| country | 219 | **201.8** | 73.7 | 100% |
| dependency | 53 | 103.7 | 19.9 | 100% |
| region | 3,929 | 37.4 | 15.1 | 89.8% |
| county | 38,937 | 7.7 | 3.0 | 67.5% |
| localadmin | 21,502 | 6.3 | 3.4 | 55.0% |

This is dramatically richer multilingual coverage than anything in fieldmaps
today (which tops out at ~2–4 simultaneous language variants per feature via
`name`/`name1`/`name2`/`name3`). Countries average 200+ language names;
even at the county/localadmin tier, most features have *some* translation.

### 2.5 File layout quality

`type=division` file: 256 row groups, ~18.4K rows/group average (4.7M rows /
256) **[derived: query 17]**. `type=division_area/part-00000`: 139,406 rows,
64 row groups, ~2,178 rows/group **[derived: query 18]**. **Not sorted** by
`country` or `subtype` in a way predicate pushdown can exploit: `stats_min_value`/
`stats_max_value` on the `country` column per row group overlap heavily
across groups (e.g. row group 0 spans `AS`→`WS`, row group 6 spans `CO`→`VE`
— alphabetically overlapping ranges, not partitioned) **[derived: query 19]**.
This means, like CGAZ, **naive per-keystroke filtering against the raw
Overture divisions files would scan most of the file** — Overture's own
global ordering (likely a spatial/Hilbert or GERS-ID sort) doesn't help an
alphabetical name search either. Same conclusion as PLAN.md's CGAZ finding:
a purpose-built, name-sorted sidecar is needed regardless of source.

### 2.6 License

**Divisions theme = ODbL-1.0** (OpenStreetMap-derived, conflated with
geoBoundaries CC-BY-4.0, Esri Community Maps CC-BY-4.0, and LINZ CC-BY-4.0
inputs) **[attested: https://docs.overturemaps.org/guides/divisions and
https://docs.overturemaps.org/attribution/]**. Confirmed empirically: the
`sources[].license` values observed on `country`-level divisions are exactly
`ODbL-1.0` and `CC-BY-4.0` **[derived: query 20]**. Because OSM content is
present, **ODbL's share-alike applies to the conflated whole** — a derived
database built from Overture divisions must itself be made available under
ODbL (or a compatible license), with attribution to OSM contributors and the
other named providers **[attested: https://docs.overturemaps.org/attribution/]**.
This matches PLAN.md's design call #11 (Overture-enriched index is a
separate, ODbL-tainted opt-in artifact).

---

## 3. tge-labs/admin-boundaries — the other files (not geoBoundaries)

All five non-geoBoundaries files are single-row-group, like the CGAZ files
PLAN.md already flagged — **this is a systemic property of the tge-labs
mirror pipeline, not specific to geoBoundaries** **[derived: query 21]**.
All ship a `bbox STRUCT(xmin,ymin,xmax,ymax)` column (GAUL/GISCO) or
`STRUCT(xmin,xmax,ymin,ymax)` (World Bank) — useful for viewport-boost ranking
regardless of row-group pruning.

### 3.1 GAUL (`gaul/gaul0_asap.parquet`) — FAO, ADM0 only

Schema: `asap0_id, name0, name0_shr, asap_cntry, an_crop, an_range, km2_tot,
km2_crop, km2_rang2, g1_units, isocode, geometry, bbox` — **221 rows**
(country-level only; "ASAP" = FAO's crop-monitoring country layer, not a
general ADM0/1/2 product) **[derived: query 22]**. No multi-language name
columns. One row group **[derived: query 21]**.

**License: FAO GAUL data license is non-commercial-only**, with
redistribution to non-authorized users "strictly prohibited... without the
prior written consent of FAO," plus mandatory FAO attribution
**[attested: https://developers.google.com/earth-engine/datasets/catalog/DataLicenseGAUL2015.pdf,
via web search]**. **Disqualifying for a redistributable search index** —
both the non-commercial clause and the no-redistribution clause conflict with
shipping it in an openly-licensed sidecar.

### 3.2 GISCO (`gisco/CNTR_RG_01M_2024_4326.parquet`) — Eurostat, ADM0 (countries) only

Schema: `CNTR_ID, CNTR_NAME, NAME_ENGL, NAME_FREN, NAME_GERM, ISO3_CODE,
SVRG_UN, CAPT, EU_STAT, EFTA_STAT, CC_STAT, geometry, bbox` — **263 rows**
**[derived: query 22]**. Three parallel name columns
(`CNTR_NAME`/local, `NAME_ENGL`, `NAME_FREN`, `NAME_GERM`) — a *small* but
real multilingual set (English/French/German + native name), country-level
only. One row group.

**License: EuroGeographics-restricted, non-commercial**, requiring the
notice "© EuroGeographics for the administrative boundaries"; commercial use
requires contacting EuroGeographics directly
**[attested: https://ec.europa.eu/eurostat/web/gisco/geodata/administrative-units,
via WebFetch]**. **Same disqualification as GAUL/ERM** for a general-purpose,
redistributable index — usable only for non-commercial internal exploration.

### 3.3 World Bank Official Boundaries — `world-bank/*`

Four relevant files **[derived: query 23]**:

| file | rows | levels |
|---|---|---|
| `Admin_0.parquet` | 264 | country |
| `Admin_0_all_layers.parquet` | 288 | country (+ extra disputed/claim layers) |
| `Admin_1.parquet` | 3,591 | ADM1 |
| `Admin_2.parquet` | 39,370 | ADM2 |
| `NDLSA.parquet` | 24 | "non-determined" land/sea areas (disputed, small) |

Schema, ADM2: `ISO_A3, ISO_A2, WB_A3, WB_REGION, WB_STATUS, NAM_0, NAM_1,
ADM1CD_c, GEOM_SRCE, NAM_2, ADM2CD_c, geometry, bbox` **[derived: query 22]**.
Single English name per level (`NAM_0`/`NAM_1`/`NAM_2`), no built-in
multi-language columns, but clean stable codes (`ADM1CD_c`, `ADM2CD_c`) and a
`bbox` struct on every row. One row group per file **[derived: query 21]**.

**License: CC-BY 4.0** — "free to use with attribution for any purpose
including commercial work," per the World Bank's dataset terms of use
**[attested: https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets,
via web search]**. **This is the best-licensed source in the tge-labs
mirror after geoBoundaries itself** — ADM0+1+2 ≈ 264+3,591+39,370 ≈
**43,225 named features**, comparable in scale to CGAZ's ~53K and covering
ADM0–ADM2 with official, government-sourced boundaries.

**Caveat vs. geoBoundaries:** World Bank ADM2 (39,370 rows) is *fewer* rows
than CGAZ ADM2 (49,349, per PLAN.md) and single-language, so it doesn't beat
geoBoundaries on coverage or multilingual names — but its license is
unambiguous CC-BY 4.0 (no IGO non-endorsement clause, no "other" STAC-field
ambiguity like the fieldmaps/geoboundaries subset), and it's already present
in the tge-labs mirror with a `bbox` column and clean codes. Good second
candidate for cross-checking/backfilling geoBoundaries gaps, not an index
powering source by itself.

---

## 4. Licensing comparison table

| source | license | attribution required | commercial use | redistribution of derivative | share-alike risk for a search-index sidecar |
|---|---|---|---|---|---|
| **geoBoundaries CGAZ** *(for reference, from PLAN.md)* | CC-BY | yes | yes | yes | none — pure attribution |
| fieldmaps `international` `cc0/*` | CC0-1.0 | no (but given anyway) | yes | yes | none |
| fieldmaps `international` `odbl/*` | ODbL-1.0 | yes | yes | yes, **but share-alike** | **yes** — derivative DB must stay ODbL |
| fieldmaps `subnational/cod-ab` + `cod-ab-legacy` | CC-BY-3.0-IGO | yes (+ UN non-endorsement clause) | yes | yes | low — attribution-only, IGO clause is about endorsement not sharing |
| fieldmaps `subnational/geoboundaries` | STAC field says `"other"`, links to geoboundaries.org API (actually CC-BY upstream) | yes (geoBoundaries + FieldMaps + US State/USGS per geoBoundaries terms) | yes (per geoBoundaries upstream) | yes | none upstream, but **metadata ambiguity risk** — don't trust the STAC `license` field as-is |
| fieldmaps `subnational/erm` (EuroGeographics) | "other" — EuroGeographics open license | yes ("© EuroGeographics…") | **no** (non-commercial / internal business use only; full commercial needs separate contract) | not for commercial redistribution | **disqualifying** for a general-purpose index |
| Overture Maps `divisions` | **ODbL-1.0** (conflated OSM + CC-BY-4.0 geoBoundaries/Esri/LINZ) | yes | yes | yes, **but share-alike** | **yes** — any derived database must be released under ODbL too |
| FAO GAUL | non-commercial, custom FAO license | yes | **no** | **no** (redistribution to non-authorized users prohibited without FAO consent) | **disqualifying** |
| GISCO (Eurostat/EuroGeographics) | EuroGeographics-restricted | yes ("© EuroGeographics…") | **no** (commercial needs direct EuroGeographics contract) | not for commercial redistribution | **disqualifying** |
| World Bank Official Boundaries | **CC-BY 4.0** | yes | yes | yes | none — pure attribution |

**Bottom line:** of everything surveyed here, **World Bank Official
Boundaries (CC-BY 4.0) and fieldmaps COD-AB (CC-BY-3.0-IGO) are the only
other-than-geoBoundaries sources with unambiguous, redistribution-friendly
open licenses.** Overture divisions and the fieldmaps `odbl`/`geoboundaries`-
labeled subsets carry real or metadata-level ODbL/ambiguity risk and should
stay in the "separate opt-in artifact" bucket PLAN.md already designed for
(#11). GAUL, GISCO, and ERM are non-commercial/non-redistributable and should
not feed the shipped index at all — at most, local/offline exploration.

---

## 5. Name-search suitability verdict, per source

| source | names? | levels | stable IDs | license OK for shipped index? | verdict |
|---|---|---|---|---|---|
| fieldmaps `cod-ab`/`cod-ab-legacy` | yes, incl. multilingual (`name`+`name1-3`, `lang`+`lang1-3`) where populated | ADM1+ (per-country) | `{adm_n}_pcode` | yes (CC-BY-3.0-IGO) | **Best candidate for #2-after-geoBoundaries today**, but blocked on the *global build landing* — today it's 518 separate per-country fetches, not an index-ready single source. Re-evaluate the moment the 2026-11-13 global build appears (see checklist in §1.2). |
| fieldmaps `geoboundaries` (legacy copy) | single-language only | ADM1+ (per-country) | pcode | metadata says "other" (verify against upstream CC-BY before shipping) | Redundant with the geoBoundaries CGAZ mirror already being built elsewhere; skip. |
| fieldmaps `erm` | single-language | ADM1-3, Europe only | pcode | **no** (non-commercial) | Exclude from shipped index entirely. |
| Overture Maps `divisions` | yes, **rich** multilingual (`names.common` map, avg 200+ langs at country level) | country/dependency/region/county/localadmin + locality tiers | `id` (GERS ID, stable) | **ODbL share-alike** — ok only as a clearly-labeled opt-in artifact | **This is the #1 candidate for E8** (multilingual search), not for the default shipped index. Confirms PLAN.md design call #11: keep it a separate, ODbL-flagged artifact with required attribution surfaced in the widget UI. |
| GAUL | single-language, ADM0 only | — | — | **no** | Exclude. |
| GISCO | small multilingual set (EN/FR/DE + local), ADM0 only | — | — | **no** (non-commercial) | Exclude. |
| World Bank Official Boundaries | single-language | ADM0-2 | `ADM1CD_c`/`ADM2CD_c` | **yes** (CC-BY 4.0) | Good **fallback/cross-check** source (fewer rows than CGAZ, same license family); not better than geoBoundaries for levels/coverage, but a clean second opinion with a `bbox` column already in place. |

### Recommended sequencing for cn-geocoding

1. **Ship:** geoBoundaries CGAZ (already the plan).
2. **#2 after geoBoundaries:** fieldmaps COD-AB/subnational, *once the global
   build lands* and passes the row-group/schema/licensing checklist in
   §1.2 — it's the only other source with (a) sub-country levels, (b) some
   real multilingual names today, and (c) a clean CC-BY-family license. If
   the global build slips or turns out to be per-country again, World Bank
   Official Boundaries (CC-BY 4.0, ADM0-2) is the fallback "second source" —
   lower row counts and single-language, but zero licensing risk and ready
   today.
3. **E8 (multilingual search):** Overture Maps `divisions` is the clear
   choice — by far the richest `names.common` language-tag coverage of
   anything surveyed (avg 200+ languages/country, 37/region, 6-8/county). Ship
   it only as the explicitly separate, ODbL-labeled, attribution-surfacing
   artifact PLAN.md already calls for (#11); never merge its rows into the
   default CC-BY-only index.
4. **Do not use** GAUL, GISCO, or fieldmaps `erm` for anything that gets
   redistributed — non-commercial/no-redistribution clauses conflict with a
   publicly shipped sidecar. They remain fine as local reference data to
   spot-check geometry, if ever needed.
5. **Check the geoBoundaries-labeled subset of fieldmaps** (`subnational/
   geoboundaries/*`) against upstream geoBoundaries licensing before citing
   its STAC `license: "other"` field anywhere — it's almost certainly CC-BY
   in substance (same as the CGAZ mirror) but the metadata as published
   doesn't say so.

---

## Appendix — queries run

All against remote files with DuckDB v1.4.1 (`INSTALL/LOAD httpfs`; Overture
queries additionally `SET s3_region='us-west-2'`). Numbered to match
citations above.

```sql
-- 1. fieldmaps/international layout + sizes (via S3-style bucket listing, not SQL)
-- curl -s "https://data.source.coop/fieldmaps/international/"  → XML ListBucketResult

-- 2. fieldmaps/subnational top-level catalog children
-- curl -s "https://data.source.coop/fieldmaps/subnational/catalog.json"

-- 3-6. per-sub-catalog collection counts
-- curl -s "https://data.source.coop/fieldmaps/subnational/cod-ab/README.md"        (112 collections)
-- curl -s "https://data.source.coop/fieldmaps/subnational/cod-ab-legacy/README.md" (155 collections)
-- curl -s "https://data.source.coop/fieldmaps/subnational/geoboundaries/README.md" (209 collections)
-- curl -s "https://data.source.coop/fieldmaps/subnational/erm/README.md"           (42 collections)

-- 7. example per-country collection.json (schema, file sizes, license link)
-- curl -s "https://data.source.coop/fieldmaps/subnational/cod-ab/afg/collection.json"

-- 8. geoBoundaries-legacy subset license field
-- curl -s "https://data.source.coop/fieldmaps/subnational/geoboundaries/afg/collection.json"
--   → "license": "other", license link → geoboundaries.org/api/current/gbOpen/AFG/ALL/

-- 9/10. name/lang columns, actual values
SELECT adm2_name, adm2_name1, adm2_name2, adm2_name3, adm1_name, adm0_name,
       lang, lang1, lang2, lang3, iso3
FROM 'https://data.source.coop/fieldmaps/subnational/cod-ab/afg/afg_extended.parquet'
LIMIT 5;

SELECT adm2_name, adm2_name1, adm2_name2, adm2_name3, adm1_name, adm0_name,
       lang, lang1, lang2, lang3, iso3
FROM 'https://data.source.coop/fieldmaps/subnational/geoboundaries/afg/afg_extended.parquet'
LIMIT 5;

SELECT adm3_name, adm3_name1, adm2_name, adm1_name, adm0_name,
       lang, lang1, lang2, lang3, iso3
FROM 'https://data.source.coop/fieldmaps/subnational/erm/aut/aut_extended.parquet'
LIMIT 5;

-- 11. Overture divisions theme file listing (latest release)
SET s3_region='us-west-2';
SELECT * FROM glob('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/**');

-- 12. schema of type=division
DESCRIBE SELECT * FROM
  's3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division/part-00000-fc5242dc-0596-5fd7-b815-8ff9633b67f3-c000.zstd.parquet';

-- 13. multilingual example (France)
SELECT country, names.primary as primary_name,
       list_sort(map_keys(names.common))[:8] as sample_langs,
       cardinality(names.common) n_langs,
       map_extract(names.common,'ar')[1] as ar_name,
       map_extract(names.common,'zh')[1] as zh_name,
       map_extract(names.common,'ja')[1] as ja_name
FROM 's3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division/part-00000-fc5242dc-0596-5fd7-b815-8ff9633b67f3-c000.zstd.parquet'
WHERE subtype='country' AND country='FR'
LIMIT 1;

-- 14. row counts by subtype, type=division
SELECT subtype, count(*) AS n
FROM 's3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division/part-00000-fc5242dc-0596-5fd7-b815-8ff9633b67f3-c000.zstd.parquet'
GROUP BY subtype ORDER BY n DESC;

-- 15. row counts by subtype, type=division_area (all 8 files)
SELECT subtype, count(*) n
FROM 's3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division_area/*.parquet'
GROUP BY subtype ORDER BY n DESC;

-- 16. multilingual coverage stats by subtype
SELECT subtype, count(*) n,
       avg(cardinality(names.common)) avg_common_names,
       avg(len(names.rules)) avg_rules,
       sum(CASE WHEN cardinality(names.common) > 0 THEN 1 ELSE 0 END)::double / count(*) pct_with_common_name
FROM 's3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division/part-00000-fc5242dc-0596-5fd7-b815-8ff9633b67f3-c000.zstd.parquet'
WHERE subtype IN ('country','region','county','dependency','localadmin')
GROUP BY subtype ORDER BY n DESC;

-- 17. row group count, type=division
SELECT count(DISTINCT row_group_id)
FROM parquet_metadata('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division/part-00000-fc5242dc-0596-5fd7-b815-8ff9633b67f3-c000.zstd.parquet');

-- 18. row count + row groups, one division_area file
SELECT count(*) FROM
  's3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division_area/part-00000-d97cde63-9be2-55c6-8b16-c60d627c9ab7-c000.zstd.parquet';
SELECT count(DISTINCT row_group_id) n_rowgroups
FROM parquet_metadata('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division_area/part-00000-d97cde63-9be2-55c6-8b16-c60d627c9ab7-c000.zstd.parquet')
WHERE path_in_schema='id';

-- 19. sort-order check on `country` column per row group
SELECT row_group_id, num_values, stats_min_value, stats_max_value
FROM parquet_metadata('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division/part-00000-fc5242dc-0596-5fd7-b815-8ff9633b67f3-c000.zstd.parquet')
WHERE path_in_schema='country'
ORDER BY row_group_id LIMIT 10;

-- 20. distinct per-row licenses in sources[] struct, country-level divisions
SELECT DISTINCT unnest(sources).license as lic
FROM 's3://overturemaps-us-west-2/release/2026-10-21.0/theme=divisions/type=division/part-00000-fc5242dc-0596-5fd7-b815-8ff9633b67f3-c000.zstd.parquet'
WHERE subtype='country';

-- 21. row-group count for each tge-labs non-geoBoundaries file
SELECT count(DISTINCT row_group_id) FROM parquet_metadata(
  'https://data.source.coop/tge-labs/admin-boundaries/<file>.parquet')
WHERE path_in_schema LIKE '%ISO%' OR path_in_schema LIKE '%isocode%' OR path_in_schema LIKE '%CNTR_ID%';
-- run for: gaul/gaul0_asap.parquet, gisco/CNTR_RG_01M_2024_4326.parquet,
--          world-bank/World_Bank_Official_Boundaries_-_Admin_{0,1,2}.parquet  → all return 1

-- 22. schema + row counts, GAUL / GISCO / World Bank Admin 0/1/2 / NDLSA
DESCRIBE SELECT * FROM 'https://data.source.coop/tge-labs/admin-boundaries/gaul/gaul0_asap.parquet';
SELECT count(*) FROM 'https://data.source.coop/tge-labs/admin-boundaries/gaul/gaul0_asap.parquet';
DESCRIBE SELECT * FROM 'https://data.source.coop/tge-labs/admin-boundaries/gisco/CNTR_RG_01M_2024_4326.parquet';
SELECT count(*) FROM 'https://data.source.coop/tge-labs/admin-boundaries/gisco/CNTR_RG_01M_2024_4326.parquet';
DESCRIBE SELECT * FROM 'https://data.source.coop/tge-labs/admin-boundaries/world-bank/World_Bank_Official_Boundaries_-_Admin_0.parquet';
SELECT count(*) FROM 'https://data.source.coop/tge-labs/admin-boundaries/world-bank/World_Bank_Official_Boundaries_-_Admin_0.parquet';
DESCRIBE SELECT * FROM 'https://data.source.coop/tge-labs/admin-boundaries/world-bank/World_Bank_Official_Boundaries_-_Admin_1.parquet';
SELECT count(*) FROM 'https://data.source.coop/tge-labs/admin-boundaries/world-bank/World_Bank_Official_Boundaries_-_Admin_1.parquet';
DESCRIBE SELECT * FROM 'https://data.source.coop/tge-labs/admin-boundaries/world-bank/World_Bank_Official_Boundaries_-_Admin_2.parquet';
SELECT count(*) FROM 'https://data.source.coop/tge-labs/admin-boundaries/world-bank/World_Bank_Official_Boundaries_-_Admin_2.parquet';
DESCRIBE SELECT * FROM 'https://data.source.coop/tge-labs/admin-boundaries/world-bank/World_Bank_Official_Boundaries_-_NDLSA.parquet';
SELECT count(*) FROM 'https://data.source.coop/tge-labs/admin-boundaries/world-bank/World_Bank_Official_Boundaries_-_NDLSA.parquet';

-- 23. World Bank Admin_0_all_layers row count
SELECT count(*) FROM 'https://data.source.coop/tge-labs/admin-boundaries/world-bank/World_Bank_Official_Boundaries_-_Admin_0_all_layers.parquet';
```

### Web research sources (attested facts, non-SQL)

- fieldmaps STAC/README/AGENTS.md pages under `data.source.coop/fieldmaps/{international,subnational}/...`
- Overture divisions guide: https://docs.overturemaps.org/guides/divisions
- Overture attribution page: https://docs.overturemaps.org/attribution/
- Overture release notes (confirming 2026-10-21.0 as latest): https://docs.overturemaps.org/blog/
- Overture cloud-sources getting-data page (Azure blob path pattern)
- FAO GAUL license PDF (via Google Earth Engine catalog mirror): https://developers.google.com/earth-engine/datasets/catalog/DataLicenseGAUL2015.pdf
- Eurostat GISCO administrative units page: https://ec.europa.eu/eurostat/web/gisco/geodata/administrative-units
- EuroGeographics open data license v2.1: https://eurogeographics.org/app/uploads/2025/03/D3.2-Open-Data-License-v2.1.pdf
- World Bank dataset terms of use: https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets
