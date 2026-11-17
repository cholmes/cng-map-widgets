# E9 — geoBoundaries gbOpen ADM3/ADM4/ADM5 Survey

**Date:** 2026-11-12
**Scope:** survey only, no repo changes. Sizes adding ADM3+ to
`portolan-mirrors/geoboundaries-catalog` (another agent's active repo; read
only here) as new collections alongside its existing `adm0`/`adm1`/`adm2`
CGAZ mirror. Every claim is marked **[attested: URL]** or **[derived: method]**.

Tooling: `curl` against the geoBoundaries API
(`https://www.geoboundaries.org/api/current/gbOpen/ALL/ALL/`, 715 records,
1.27 MB JSON, fetched 2026-11-12) and spot-check downloads of real
GeoJSON/parquet files, converted with `ogr2ogr` (GDAL, `-f Parquet -lco
COMPRESSION=ZSTD`). Scratch data (downloaded GeoJSON/Parquet, the raw API
JSON) is in
`<scratchpad>/gbdata/`.
Reference numbers for the *existing* catalog (`adm0`/`adm1`/`adm2`/`names`)
are from `/Users/cholmes/repos/geoboundaries-catalog/README.md` (read-only).

**Headline: the task's licensing assumption is wrong.** gbOpen ADM3+ is
**not** uniformly CC-BY 4.0 — see §3. That, not file size, is the real
blocker.

---

## 1. Coverage

**[derived: group the 715-record API response by `boundaryType`, count
distinct `boundaryISO`, sum `admUnitCount`]**

| level | countries | % of 230 | total units (admUnitCount sum) |
|---|---|---|---|
| ADM0 | 230 | 100% | 230 |
| ADM1 | 199 | 87% | 3,281 |
| ADM2 | 180 | 78% | 49,363 |
| **ADM3** | **81** | **35%** | **105,170** |
| **ADM4** | **21** | **9%** | **94,251** |
| **ADM5** | **4** | **2%** | **699,798** |

(Existing catalog counts are CGAZ, a separately-built composite, not this
gbOpen sum — `adm1`=3,224 rows, `adm2`=49,349 rows **[attested:
geoboundaries-catalog README.md]** — close but not identical to the gbOpen
per-country totals above, as expected since CGAZ and gbOpen are different
products.)

ADM4 is present in only 21 countries; **ADM5 in exactly 4**: CAF, RWA, FRA,
IND — and IND alone is 649,771 of the 699,798 ADM5 units (93%). ADM5 is not
a "level," it's basically an India dataset with three small add-ons.

Major-country presence/absence **[derived: same API data, filtered to a
~40-country major-population/major-economy list]**:

| present at ADM3 | absent at ADM3 (sample of major countries) |
|---|---|
| China, India, Pakistan, Bangladesh, Ethiopia, Philippines, Germany, Iran, France, UK, South Africa, Korea, Kenya, Spain, Uganda, Algeria, Ukraine, Poland, Canada, Malaysia, Angola, Italy | **USA, Brazil, Indonesia, Nigeria, Russia, Mexico, Japan, Egypt, Vietnam, Turkey, Thailand, Colombia, Argentina, Sudan, Iraq, Afghanistan, Morocco, Saudi Arabia, Uzbekistan, Peru, Australia** |

ADM4 drops to just: IND, BGD, FRA, IRN, ZAF, UGA, ITA + a handful of small
territories (MYT, MTQ, REU, GLP — French overseas depts). ADM5: IND, RWA,
FRA, CAF only.

**Implication for "city-level" search:** a global ADM3 composite would cover
roughly a third of countries, and is missing most of the highest-population
countries outright (US, Brazil, Indonesia, Nigeria, Russia, Mexico, Japan —
all absent). It is a patchwork, not a global city layer.

---

## 2. Size

### Method
No file-size field exists in the API; sizes were derived from `admUnitCount
× meanVertices` (both API fields) calibrated against a 15-country ADM3
sample + 3 ADM4 + 1 ADM5 sample spanning the size range (smallest to
largest by total-vertex estimate), with real downloads converted to
GeoParquet. **[derived: see table below]**

| iso | level | units | geojson MB | parquet(zstd) MB | geojson/parquet ratio | parquet bytes/vertex |
|---|---|---|---|---|---|---|
| ASM | ADM3 | 16 | 0.04 | 0.02 | 1.98 | 16.4 |
| UGA | ADM3 | 137 | 0.55 | 0.13 | 4.37 | 11.2 |
| FJI | ADM3 | 86 | 4.93 | 1.50 | 3.29 | 14.1 |
| ITA | ADM3 | 107 | 40.60 | 13.39 | 3.03 | 14.4 |
| CAN | ADM3 | 5,162 | 42.65 | 12.82 | 3.33 | 14.4 |
| IND | ADM3 | 6,836 | 106.29 | 32.73 | 3.25 | 13.7 |
| CHN | ADM3 | 2,867 | 88.78 | 28.27 | 3.14 | 14.4 |
| BGD | ADM3 | 544 | 124.74 | 40.01 | 3.12 | 14.1 |
| UKR | ADM3 | 10,375 | 121.25 | 41.98 | 2.89 | 14.5 |
| ESP | ADM3 | 8,205 | 149.11 | 48.30 | 3.09 | 14.1 |
| CZE | ADM3 | 6,257 | 108.23 | 53.91 | 2.01 | 14.2 |
| NZL | ADM3 | 245 | 181.15 | 56.13 | 3.23 | 13.0 |
| CHL | ADM3 | 345 | 171.78 | 52.53 | 3.27 | 13.3 |
| PAN | ADM3 | 633 | 227.80 | 74.27 | 3.07 | 12.8 |
| **PHL** | ADM3 | 1,647 | **532.13** | **161.78** | 3.29 | 11.7 |
| UGA | ADM4 | 1,521 | 47.67 | 15.36 | — | 13.8 |
| IND | ADM4 | 7,152 | 110.36 | 34.89 | — | 14.0 |
| BGD | ADM4 | 5,160 | 341.27 | 109.82 | — | 14.1 |
| **IND** | **ADM5** | **649,771** | **1,082.20** | **308.05** | — | 13.9 |

Bytes/vertex (zstd parquet, WKB geometry) is a tight band — **13–14.4
bytes/vertex** — across 19 countries, 3 levels, tiny-to-huge files. Used
13.9 as the extrapolation constant.

### Extrapolated full-resolution totals
**[derived: Σ(admUnitCount × meanVertices) per level × 13.9 bytes/vertex]**

| level | total vertices | est. full-res parquet | est. raw GeoJSON download (×~43 B/vertex) |
|---|---|---|---|
| ADM3 | 87,511,052 | **~1.22 GB** | ~3.8 GB |
| ADM4 | 50,234,461 | **~698 MB** | ~2.2 GB |
| ADM5 | 32,286,937 | **~449 MB** (93% is India) | ~1.4 GB |

For scale: a single country's raw file can be huge at full resolution —
PHL ADM3 GeoJSON is 532 MB, India's ADM5 GeoJSON is **1.08 GB**, for one
country at one level. These numbers are the actual per-country release
files, confirming the task's framing: there is no pre-built global
composite, only per-country full-resolution releases.

### Simplified-to-CGAZ-comparable size
geoBoundaries already ships a pre-simplified file per country+level — the
API's `simplifiedGeometryGeoJSON` field, present for 100% of ADM3/4/5
records checked (0 missing across 81+21+4). **[attested: field values in
API JSON]** Measured reduction on an 8-country spot check (ADM3, full vs.
simplified, both converted to zstd parquet):

| iso | full parquet MB | simplified parquet MB | reduction |
|---|---|---|---|
| PHL | 161.78 | 2.213 | 73.1× |
| NZL | 56.13 | 0.860 | 65.3× |
| CZE | 53.91 | 3.044 | 17.7× |
| ITA | 13.39 | 0.791 | 16.9× |
| ESP | 48.30 | 4.660 | 10.4× |
| FJI | 1.50 | 0.138 | 10.8× |
| CAN | 12.82 | 8.505 | 1.5× |
| UGA | 0.13 | 0.108 | 1.2× |

Reduction is huge for complex-coastline/archipelago countries (PHL, NZL,
ITA, ESP) and nearly nothing for continental/already-simple geometry (CAN,
UGA) — it's geometry-dependent, not a flat ratio. Sample-weighted overall
reduction here is ~17×; applying a conservative **15×** to the full-res
estimates:

| level | full-res | ≈15× simplified estimate |
|---|---|---|
| ADM3 | 1.22 GB | **~80 MB** |
| ADM4 | 698 MB | **~47 MB** (unvalidated at ADM4 — extrapolated from ADM3 ratio) |
| ADM5 | 449 MB | **~30 MB** (unvalidated, dominated by India) |

**Caveat / cross-check:** extrapolating instead from the *existing* CGAZ
ADM2 density (97 MB / 49,349 units = 1,966 bytes/unit **[attested:
geoboundaries-catalog README.md]**) gives a different ADM3 estimate: 105,170
units × 1,966 B ≈ **207 MB** — ~2.5× higher than the 80 MB figure above.
The two methods use different simplification tolerances (geoBoundaries'
own per-country `simplified` file vs. CGAZ's own, almost certainly more
aggressive, tolerance built for global-thumbnail use) and both are
estimates, not a chosen build target. A real composite build must pick and
measure one, not average these.

---

## 3. Licensing — the actual blocker

**[derived: aggregate `boundaryLicense` field across the 81/21/4 ADM3/4/5
records]**

| level | total | strict "CC BY 4.0" | non-CC-BY-4.0 | of which ODbL 1.0 |
|---|---|---|---|---|
| ADM3 | 81 | 14 (17%) | **67 (83%)** | 20 (25%) |
| ADM4 | 21 | 4 (19%) | **17 (81%)** | 3 (14%) |
| ADM5 | 4 | 1 (25%) | **3 (75%)** | 1 (25%) |

The 17% that *are* strict CC BY 4.0 at ADM3: Comoros, Spain, Gambia, Haiti,
Kenya, Cambodia, Mali, Myanmar, Malaysia, New Zealand, Panama, Rwanda,
Sierra Leone, Seychelles.

The other 83% carry whatever license the underlying national source used,
honestly disclosed per-record by geoBoundaries' own `boundaryLicense` /
`licenseSource` fields:

- **ODbL 1.0 (20 countries at ADM3)** — Albania, Benin, **Canada**, **China**,
  Cameroon, Costa Rica, Czechia, Estonia, Ethiopia, Finland, Fiji, Hungary,
  **India**, Iran, Jamaica, Malawi, Pakistan, Slovakia, Tunisia, Tanzania.
  This is the **same share-alike/copyleft license** that PLAN.md already
  flagged as a disqualifier for fieldmaps.io ("ODbL even for the
  geoBoundaries-only 'open' variant"). It affects three of the biggest
  countries that *do* have ADM3 (Canada, China, India).
- **CC BY 3.0 IGO** (14 countries, e.g. Philippines, South Africa, Sri
  Lanka, Chile) — compatible attribution family but a different version,
  needs its own attribution line.
- **CC BY-SA 2.0/4.0** (Austria, Algeria, Poland, Ukraine, Nepal) —
  share-alike, same genre of problem as ODbL for anyone redistributing a
  derived/merged product.
- **Public Domain / CC0** (14 countries, e.g. Belgium, Sweden, Portugal,
  Uganda, US territories) — actually *cleaner* than CC-BY (no attribution
  requirement at all).
- **National government licenses** with their own terms: UK OGL v3,
  France's Etalab 2.0, Germany's "Data license Germany — Attribution v2.0",
  Switzerland's swisstopo license, Korea's OGL Type 1. Each is
  attribution-compatible in spirit but is not literally "CC BY 4.0" and
  carries its own wording.
- **"Other – Direct Permission"** (Solomon Islands, Tuvalu, Vanuatu) — terms
  not expressed as a standard license at all.

For context, geoBoundaries' own homepage markets the whole database as
"open license (CC BY 4.0)" **[attested:
https://www.geoboundaries.org/index.html, text near the CC BY 4.0 link]**,
and CGAZ (the composite the catalog currently mirrors) explicitly performs
"extensive simplification" and removes disputed areas, consistent with it
being a distinct, uniformly-licensed product **[attested:
https://www.geoboundaries.org/globalDownloads.html, CGAZ description]**.
But that blanket framing does not match the authoritative, source-level
`boundaryLicense` field the API itself publishes per gbOpen record — which
is the field that actually governs redistribution terms. US confirms this:
USA ADM0/1/2 is tagged `Public Domain` (TIGER), not CC-BY, in the same API
**[attested: `https://www.geoboundaries.org/api/current/gbOpen/USA/ADM0/`]**.

**Bottom line: "every gbOpen ADM3+ release is CC-BY 4.0" is false.** Only
17–25% of ADM3+ entries are. A composite spanning all 81/21/4 countries
under one blanket CC-BY-4.0 label would misrepresent licensing for roughly
4 in 5 of the countries included, and would in particular inherit ODbL
obligations for Canada, China and India — the exact problem that already
ruled out fieldmaps.io for this catalog.

---

## 4. Name quality

**[derived: load each sampled country's full-resolution ADM3 GeoJSON,
inspect `properties.shapeName`/`shapeISO`]**, 10 countries: ASM, UGA, FJI,
ITA, CAN, IND, CHN, BGD, UKR, ESP.

- **`shapeName` null rate: 0% in all 10 countries** (16 to 10,375 rows each).
- Schema is fixed and minimal: `shapeName, shapeISO, shapeID, shapeGroup,
  shapeType` — no alt-names, no language tags, single name per feature.
- **`shapeISO` null rate: 100% in all 10 countries at ADM3.** Sub-national
  ISO 3166-2 codes aren't populated at this level; `shapeID` (an opaque
  geoBoundaries-internal id) is the only stable join key below ADM1,
  consistent with the design-call-5 decision already made in PLAN.md.
- Scripts: names are consistently single, Latin-transliterated strings even
  for non-Latin-script countries — CHN shows county/district names like
  "Luzhai County", "Fengnan District" (romanized, not Han characters); IND,
  BGD, UKR are fully ASCII romanizations. Non-ASCII counts reflect Latin
  diacritics, not alternate scripts: CAN 326/5,162 (French-Canadian
  apostrophes/accents, e.g. "St. Joseph's"), ESP 2,105/8,205 (Spanish/
  Catalan diacritics), CHN 54/2,864 (stray marks in a handful of
  transliterations). No native-script or multilingual name field exists —
  confirms PLAN.md/E8's framing that geoBoundaries has "mostly single
  names, mixed scripts" and multilingual coverage would have to come from
  Overture divisions as a separate opt-in artifact.

---

## 5. Search-index impact

Using the catalog's real `names` collection (52,398 rows, 3.6 MB → **69
compressed bytes/row**, 3.6 MB / 52,398 **[attested:
geoboundaries-catalog README.md]**) and the ADM3/ADM4 unit counts from §1:

| scenario | rows | est. compressed size (× 69 B/row) | vs. the 5 MB mandatory-range-request line |
|---|---|---|---|
| current (ADM0–2) | 52,398 | 3.6 MB | under — full-load is fine (measured in E1) |
| **+ADM3** | 157,568 | **~10.9 MB** | **3× over** — range-request becomes mandatory |
| **+ADM3+ADM4** | 251,819 | **~17.4 MB** | ~3.5× further over |
| (+ADM5, for completeness) | 951,617 | ~65.7 MB | an order of magnitude over; not requested but shown for scale |

PLAN.md design call #9 already set the rule: range-request becomes
mandatory once the index exceeds ~5 MB ("fieldmaps ADM3/4"). **This survey
shows the same threshold is crossed by geoBoundaries' own ADM3, with no
fieldmaps involved** — adding ADM3 alone is enough to force the
range-request path (already prototyped in E1: 5.6–25 ms/query at
2048-row groups) from optional fallback to load-bearing default.

---

## 6. US specifically

**[attested: `https://www.geoboundaries.org/api/current/gbOpen/ALL/ALL/`,
filtered to `boundaryISO=="USA"`]** gbOpen USA has exactly ADM0 (1 unit),
ADM1 (56 units — states + territories), ADM2 (3,233 units — TIGER
counties/county-equivalents). **No ADM3, ADM4, or ADM5 for the US.** All
three US levels present are licensed `Public Domain` (US Census
MAF/TIGER). This confirms the expectation in the task: "US cities" are not
reachable through gbOpen at any admin level; they would need Census TIGER
Places (or a similar place-level source) as a separate, out-of-scope data
source, as PLAN.md already anticipates.

---

## 7. Recommendation

**Wait, don't build a full composite now — the blocker is licensing, not
size.**

1. **Licensing makes a blanket ADM3+ collection non-viable as scoped.**
   83% of ADM3 countries (67/81) are not CC-BY-4.0, including ODbL for
   Canada, China, and India — the same copyleft problem that already
   disqualified fieldmaps.io for this catalog (PLAN.md §"Data-source
   decisions"). Shipping one `adm3` collection badged "CC-BY-4.0, mirrors
   geoBoundaries" the way `adm0`/`adm1`/`adm2` are today would misstate the
   license for most of its rows. Any ADM3+ build needs either (a) a
   per-country/per-row license column plus a correct, non-uniform
   attribution story, or (b) scoping down to just the CC-BY-4.0 (14
   countries) and Public-Domain/CC0 (14 countries) tiers for a ~28-country
   "clean" pilot. Flag this for Chris explicitly before any build — it
   changes the shape of the deliverable, not just its size.
2. **Coverage is too patchy for "city-level search" as a goal.** 35% of
   countries at ADM3, missing the US, Brazil, Indonesia, Nigeria, Russia,
   Mexico, Japan outright. Even a fully-clean-license build would be a
   partial-world layer, not a global one — worth setting that expectation
   with Chris regardless of the licensing question.
3. **If/when built, use geoBoundaries' own pre-simplified geometry
   (`simplifiedGeometryGeoJSON`), not full resolution.** Full-res per-country
   files are enormous for no search/display benefit (PHL ADM3 alone is 532
   MB raw; India's ADM5 alone is 1.08 GB raw) and the pre-simplified file
   is already published for 100% of ADM3/4/5 records. Confirm the actual
   visual tolerance against CGAZ before committing to a number — §2 shows
   two plausible methods disagree by ~2.5× (80 MB vs 207 MB for a
   simplified ADM3), and that gap should be resolved with one real build,
   not left as an estimate.
4. **One collection per level, matching the existing `adm0/adm1/adm2`
   pattern — except ADM5.** ADM5 is 4 countries and 93% India by row count;
   it isn't a "level" in any global sense and would be better skipped for
   now, revisited only if geoBoundaries' country coverage at ADM5 grows.
5. **Search-index work is a hard dependency, not an add-on.** Adding ADM3
   alone pushes the sidecar from 3.6 MB to ~10.9 MB, past the 5 MB
   mandatory-range-request line from PLAN.md design call #9. Budget time
   to harden the E1 range-request path (already prototyped) before/with any
   ADM3 rollout.
6. **Estimated pipeline runtime** — scaling from the catalog's own
   `build_boundaries.py` rate (547 MB of GeoPackages → 3 GeoParquet files in
   ~70 s **[attested: geoboundaries-catalog README.md]**): fetching is the
   dominant cost either way, since there is no single composite endpoint —
   it's 81+21+4 = 106 separate per-country GitHub downloads.
   - **Full resolution:** ~3.8 GB (ADM3) + ~2.2 GB (ADM4) to fetch ≈
     10–20 min at typical bandwidth, plus ~10 min conversion (roughly 10×
     the 547 MB/70s reference), plus proportionally more for PMTiles/style/
     thumbnail regen (current ADM0-2 PMTiles build is ~12 min) → **ballpark
     45–90 min total**, not counting build-script changes.
   - **Pre-simplified source files:** total download drops to roughly
     ~80–150 MB (ADM3+ADM4 combined, per the 15× reduction in §2),
     conversion and PMTiles regen scale down correspondingly → **ballpark
     15–25 min total**. This is also the much safer default given how
     large the full-res per-country outliers are.

**US "cities":** out of scope per the task — confirmed gbOpen has no
US ADM3+ (§6); needs TIGER Places or equivalent, a separate data source
decision already noted in PLAN.md.
