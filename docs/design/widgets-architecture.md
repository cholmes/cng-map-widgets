# Cloud-Native Map Widgets — Architecture & API Design

**Experiment:** E3 (design phase)
**Date:** 2026-11-12
**Status:** Design for review. No implementation beyond type definitions and
illustrative snippets.
**Binding inputs:** `PLAN.md` "Design calls from builder review" (all 12),
`PLAN.md` "Data-source decisions", `experiments/e0-data-recon/RESULTS.md`.

This document specifies the contracts that E3/E4/E5/E7 implement. Where a
number cannot be known until E1/E2 land, the default is stated inline and
repeated in [§7 Open items](#7-open-items).

Everything here obeys the standing constraints: **pure static, no server;
hyparquet-first with DuckDB-WASM as an opt-in plugin only; downloads are bbox
prune → `intersects` default → opt-in exact clip; pre-download estimates with
a ceiling and an explicit refusal path; File System Access API streaming with
a Blob fallback; zero-build CDN-consumable ESM.**

---

## Table of contents

1. [The `Area` contract](#1-the-area-contract)
2. [Dataset descriptor + filter spec](#2-dataset-descriptor--filter-spec)
3. [Package design and public APIs](#3-package-design-and-public-apis)
4. [Zero-build ESM packaging](#4-zero-build-esm-packaging)
5. [Adapter contracts](#5-adapter-contracts)
6. [Index file interface](#6-index-file-interface)
7. [Open items](#7-open-items)
8. [Specified here, not implemented](#8-specified-here-not-implemented)

---

## 0. Shape of the system

```
        ┌──────────────────┐   ┌────────────────┐   ┌─────────────┐
        │ @cngeo/geocoder-   │   │ @cngeo/upload-   │   │ (adapter    │
        │ core             │   │ core           │   │  draw tool) │
        │ names index →    │   │ GeoJSON file → │   │ map draw →  │
        └────────┬─────────┘   └───────┬────────┘   └──────┬──────┘
                 │                     │                   │
                 └──────────► A r e a ◄┴───────────────────┘        ← the seam
                                 │
                                 ▼
                      ┌─────────────────────┐
                      │ @cngeo/extract-core │  ◄── DatasetDescriptor + FilterSpec
                      │ estimate / download │      (declarative JSON — also the
                      └──────────┬──────────┘       QGIS-shared artifact)
                                 │
                 ┌───────────────┼────────────────┐
                 ▼               ▼                ▼
          geojson writer   geoparquet writer   @cngeo/format-gpkg
            (in core)        (in core)           (opt-in plugin)
```

Three contracts carry the whole system, and all three are **plain JSON, versioned,
and serializable**: `Area`, `DatasetDescriptor`, `FilterSpec`. TypeScript
interfaces are the convenient form; JSON Schema (published in `@cngeo/spec`) is
the normative form, because the Python QGIS plugin consumes the schemas, not
the TypeScript (design call #7).

---

## 1. The `Area` contract

Baseline is design call #4: GeoJSON geometry, EPSG:4326 only, `bbox` +
provenance metadata, union-by-default for multi-feature, documented vertex
ceiling with auto-simplify for the filter geometry, antimeridian handled by
bbox splitting.

### 1.1 Why there are two geometries

An `Area` carries **display geometry** and **filter geometry** as separate
fields, because the two have opposite requirements:

- *Display* wants the geometry the user recognizes — ideally the pre-simplified
  display variant E2 is building, because a 90 MB CGAZ ADM2 polygon is not
  something to push through a map style on every selection.
- *Filter* wants the smallest geometry that still answers "does this feature
  fall in my area?" honestly. A 200,000-vertex coastline makes every
  point-in-polygon test expensive and, under `clip`, produces output nobody
  asked for.

Collapsing them into one field forces a choice between a slow map and a
dishonest download. Keeping them separate makes the simplification *visible*
in provenance, which is the point: a user can see that their filter geometry
was simplified, by how much, and with what area delta.

### 1.2 TypeScript

```ts
// @cngeo/spec — area.ts

/** [west, south, east, north] in EPSG:4326 degrees. `west > east` means the
 *  box crosses the antimeridian; see `Area.bboxes` for the split form. */
export type BBox = [number, number, number, number];

/** The only geometry types an Area may carry. Points and lines are rejected:
 *  an area is an area. */
export type AreaGeometry =
  | GeoJSON.Polygon
  | GeoJSON.MultiPolygon;

export type AreaSourceKind = 'geocoder' | 'upload' | 'draw' | 'edited';

export interface Area {
  /** Discriminator for structural checks; always the literal. */
  readonly type: 'Area';
  /** Spec version of this object. Bumped only on a breaking change. */
  readonly version: 1;

  /** Stable within a session; not a global identifier. Use for React keys,
   *  download job correlation, and estimate/download pairing. */
  readonly id: string;

  /** Human label for the UI: "Contra Costa County", "my-fields.geojson",
   *  "Drawn area". Never used for filtering. */
  readonly name: string;

  /** The only legal value. Present so a consumer can assert rather than
   *  assume, and so the JSON form is self-describing. */
  readonly crs: 'EPSG:4326';

  /** Signed bbox of the display geometry. May have west > east. */
  readonly bbox: BBox;

  /** The bbox, split at the antimeridian into 1 or 2 normalized boxes, each
   *  with west <= east. **All bbox arithmetic — row-group pruning, partition
   *  pruning, viewport ranking — uses this field, never `bbox`.** */
  readonly bboxes: BBox[];

  /** True when `bboxes.length > 1`. Convenience for UI warnings. */
  readonly crossesAntimeridian: boolean;

  /** What to draw. Full resolution as fetched, or the publisher's
   *  display-simplified variant — `provenance.geometryVariant` says which. */
  readonly geometry: AreaGeometry;

  /** **Added by the 2026-11-13 "upgradeDisplay" amendment below.** Present
   *  only right after a `resolution: 'both', upgradeDisplay: true` select()
   *  has upgraded `geometry` to the full-resolution fetch: holds the
   *  pre-upgrade, display-simplified geometry that `geometry` held before
   *  the swap, so a consumer that wants to revert ("keep the simplified
   *  outline") doesn't have to re-fetch or re-simplify anything. Absent in
   *  every other case — including the default `upgradeDisplay: false`,
   *  where `geometry` never changes in the first place and there is
   *  nothing to keep a copy of. */
  readonly displayGeometry?: AreaGeometry;

  /** What to filter with. `null` means "no usable polygon" — filtering falls
   *  back to `bboxes` alone, and extract-core emits a
   *  `spatial.degradedToBbox` warning in every estimate. */
  readonly filterGeometry: AreaGeometry | null;

  readonly vertexCount: {
    readonly display: number;
    readonly filter: number;
  };

  readonly provenance: AreaProvenance;
}

export interface AreaProvenance {
  readonly source: AreaSourceKind;
  /** ISO 8601 UTC. */
  readonly createdAt: string;

  /** One entry per feature that contributed to this Area, in input order.
   *  Length 1 for a geocoder selection or a single-feature upload. */
  readonly features: AreaFeatureRef[];

  /** How `features` became one geometry. See §1.4. */
  readonly combine: 'single' | 'collect' | 'dissolve';

  /** Which geometry variant `Area.geometry` holds. */
  readonly geometryVariant: 'full' | 'display-simplified' | 'unknown';

  /** Present iff `filterGeometry` differs from `geometry`. */
  readonly simplification?: AreaSimplification;

  /** Attribution the hosting UI MUST surface while this Area is in use.
   *  Populated from the index sidecar for geocoder Areas (design call #11:
   *  an ODbL-tainted index carries its obligations here). Empty for upload
   *  and draw. */
  readonly attribution: AreaAttribution[];

  /** Source-specific blocks. Exactly one is present, matching `source`. */
  readonly geocoder?: GeocoderProvenance;
  readonly upload?: UploadProvenance;
  readonly draw?: DrawProvenance;
  readonly edited?: EditedProvenance;
}

export interface AreaFeatureRef {
  /** The publisher's stable logical id — `shapeID` for geoBoundaries
   *  (design call #5). `null` for upload/draw features, or for an uploaded
   *  feature with no id. Never a row offset. */
  readonly featureId: string | null;
  readonly name?: string;
  /** Admin level, 0-based, when the source knows one. */
  readonly level?: number;
  /** ISO 3166-1 alpha-3, when the source knows one. */
  readonly country?: string;
  readonly bbox?: BBox;
  /** Verbatim source properties, for a consumer that wants to label output.
   *  Never interpreted by any @cngeo package. */
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface AreaSimplification {
  readonly method: 'visvalingam' | 'douglas-peucker' | 'bbox' | 'none';
  /** Degrees. The tolerance actually used after the search described in §1.3. */
  readonly toleranceDeg: number;
  readonly inputVertices: number;
  readonly outputVertices: number;
  /** |simplified area − original area| / original area, on the planar
   *  degree-space shoelace area. A cheap, crs-free honesty metric: a value
   *  over `areaDeltaWarnRatio` (default 0.01) raises a warning. */
  readonly areaDeltaRatio: number;
  /** True when the ceiling could not be met without exceeding
   *  `areaDeltaMaxRatio`, so filtering fell back to bboxes. */
  readonly degradedToBbox: boolean;
}

export interface AreaAttribution {
  readonly text: string;
  /** SPDX identifier where one exists, else a short token. */
  readonly license: string;
  readonly url?: string;
  /** True when the license imposes share-alike on derived output (ODbL).
   *  extract-core stamps this into GeoParquet/GeoPackage output metadata.
   *
   *  **Normalization note, added by the geocoder-core follow-up "attribution
   *  normalization" task.** Every manifest shipped so far declares this field
   *  `share_alike` (snake_case, matching the rest of the manifest's field
   *  naming) -- this interface has always documented the camelCase spelling
   *  above, which `@cngeo/geocoder-core`'s manifest ingestion now actually
   *  produces (`Geocoder#attribution` / `IndexInfo.attribution` / every
   *  `Area.provenance.attribution` it builds), accepting either spelling on
   *  the way in and always emitting this one, with the original raw entry
   *  (its `share_alike` key included) kept alongside it. Before this, every
   *  adapter had to separately defend against the raw snake_case spelling
   *  at the point it read the field; see §5 for where that defense still
   *  lives (harmlessly redundant now, not removed). */
  readonly shareAlike: boolean;
}

export interface GeocoderProvenance {
  /** Index the result came from. */
  readonly indexUrl: string;
  readonly indexSource: string;        // e.g. "geoboundaries-cgaz"
  readonly indexVersion: string;
  /** Ties this Area to a boundary-file generation; see §6.4. */
  readonly catalogVersion: string;
  /** The boundary file the geometry was read from. */
  readonly boundaryUrl: string;
  /** The user's query, for analytics and for "search again". */
  readonly query?: string;
  readonly matchedName?: string;
}

export interface UploadProvenance {
  readonly filename: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly featureCount: number;
  /** What the file *claimed*, verbatim: a GeoJSON `crs` member, a `.prj`
   *  sibling, etc. `null` when the file said nothing (RFC 7946 default). */
  readonly declaredCrs: string | null;
  /** Repairs applied, in order. Each is reportable to the user. */
  readonly repairs: AreaRepair[];
}

export type AreaRepair =
  | { kind: 'dropped-non-areal'; count: number; types: string[] }
  | { kind: 'closed-ring'; count: number }
  | { kind: 'rewound-ring'; count: number }
  | { kind: 'dropped-empty'; count: number }
  | { kind: 'dropped-z'; count: number }
  | { kind: 'clamped-coordinate'; count: number; axis: 'lon' | 'lat' }
  /** **Added to this union 2026-11-12.** Produced by
   *  `@cngeo/upload-core`'s repair.js ("removed N duplicate consecutive
   *  points") since that package shipped; the union had no slot for it, so
   *  it was a documented deviation in the code rather than a kind here.
   *  Folding it into an unrelated kind would have been the dishonest fix. */
  | { kind: 'deduped-points'; count: number }
  | { kind: 'dropped-feature'; count: number; reason: string };

export interface DrawProvenance {
  readonly tool: 'polygon' | 'rectangle' | 'circle' | 'viewport';
  /** The map's projection at draw time, for the record. The Area itself is
   *  always already reprojected to EPSG:4326 by the adapter. */
  readonly mapCrs: string;
  /** Circle tools only: the circle before it was polygonized. */
  readonly circle?: { center: [number, number]; radiusMeters: number; segments: number };
}

/** Added by the 2026-11-13 amendment below. */
export interface EditedProvenance {
  /** The `Area.id` this one was edited from. Never the same as the edited
   *  Area's own `id` — editing always produces a new Area, not a mutation. */
  readonly parentAreaId: string;
  /** The parent's own `provenance.source` — so "edited from a drawn
   *  rectangle" and "edited from a geocoder selection" stay distinguishable
   *  after the edit, not collapsed into one undifferentiated `'edited'`. */
  readonly parentSource: AreaSourceKind;
  readonly parentCreatedAt: string;
  readonly tool: 'vertex-editor';
  /** Counts, not a diff log — "how much was changed", not "exactly what".
   *  A host that needs the latter keeps its own undo stack; this is the
   *  honest summary `buildEditedArea` can produce without one. */
  readonly edits: { moved: number; inserted: number; deleted: number };
}
```

### Amendment, 2026-11-13 — reason: an edited boundary needs its own provenance

Editing a displayed outline's vertices (`createEditTool`, §5.2) produces a
new `Area`, not a mutation of the one being edited — the pre-edit `Area`
stays exactly as valid as it always was, which matters for anything already
holding a reference to it (a download in flight, a different tab of the
same demo). `source: 'edited'` is additive to `AreaSourceKind`; nothing
that reads `Area.provenance.source` today can see a value it did not
already have to handle as "some string", and `validateArea` has never
enforced an enum on this field, so no existing caller breaks. `features` on
the edited Area is **copied verbatim from the parent**, deliberately: the
original `featureId` lineage (what geocoder/upload/draw feature(s) this
boundary ultimately traces to) must survive an edit, even though the
geometry itself no longer matches that feature exactly. `filterGeometry` is
not touched by hand anywhere in this amendment — `buildEditedArea`
(`packages/maplibre/src/edit-tool.js`) calls the ordinary `buildArea`, which
re-derives it through §1.3's existing simplify path from the edited
geometry, same as any other Area construction.

### 1.3 Limits and defaults

| knob | default | rationale |
|---|---|---|
| `filterVertexCeiling` | **10,000** vertices total | A 10k-vertex ring is ~160 KB of WKB and gives a usable edge index for per-row point-in-polygon. Above that, per-row cost starts to dominate the download. E5 measures; this is the number to tune, not the mechanism. |
| `displayVertexCeiling` | **200,000** vertices | Above this, hand the map the bbox outline and warn. A MapLibre GeoJSON source at 200k vertices is already a visible hitch. |
| `simplifyMethod` | `visvalingam` | Preserves area better than Douglas-Peucker at equal vertex budget, which matters because the metric we report is an area delta. |
| `areaDeltaWarnRatio` | `0.01` | 1% area change is reportable but acceptable. |
| `areaDeltaMaxRatio` | `0.05` | Above 5% we refuse to call it the same area: `degradedToBbox: true`, filter falls back to `bboxes`, and every estimate carries the warning. |
| `unionMode` | `collect` | See §1.4. |
| `coordinatePrecision` | 7 decimal places | ~1 cm. Trimmed on serialization only; in-memory geometry is untouched. |

Tolerance search: binary search `toleranceDeg` over `[1e-7, 1]` for at most 20
iterations, taking the **smallest** tolerance whose output fits under the
ceiling; `areaDeltaMaxRatio` is a failure guard (degrade to bbox when even the
gentlest ceiling-fitting tolerance breaches it), not an objective.
Deterministic, no dependency on a geometry library, ~20 passes over the ring
at worst, which for a 200k-vertex input is milliseconds.

> **Amendment (2026-11-13, tolerance-search objective + bisection scale).**
> As originally written (and implemented), the search took the **largest**
> acceptable tolerance — maximizing simplification subject to the area
> guard. That inverted the ceiling's meaning: a vertex ceiling is a detail
> *budget*, and the caller wants as much detail as fits it. Measured
> consequence: Poland ADM0 (68,026 full-resolution vertices, ceiling
> 10,000) produced a **17-vertex** `filterGeometry` after the background
> upgrade — coarser than the 1,085-vertex display geometry it replaced, so
> the upgrade made `intersects` filtering *worse*, over-selecting near
> boundaries while staying inside the 5% area budget. Both
> `simplifyToVertexCeiling` and `simplifyToVertexCeilingAsync` now search
> for the smallest ceiling-fitting tolerance, and bisect **geometrically**
> (`mid = sqrt(lo*hi)`), since useful tolerances span orders of magnitude
> within `[1e-7, 1]` and arithmetic bisection cannot reach the right decade
> in the iteration budget (it stalled at 695 output vertices on the same
> input; geometric reaches 9,994 of the 10,000 budget, area delta 7e-7, at
> unchanged wall time). `degradedToBbox` semantics, outward-buffered
> catalog display files, and the result shape are unchanged.

### 1.4 Multi-feature: union by default, `collect` not `dissolve`

Design call #4 says union by default. Implemented as:

- **`collect` (default):** the contributing polygons are concatenated into one
  `MultiPolygon`. No boolean operation, no dependency, no failure mode on
  invalid input. Semantically "the area is the set of these features."
- **`dissolve` (opt-in):** a real boolean union, requiring a polygon-clipping
  dependency. Offered as a flag on `upload-core`
  (`{ unionMode: 'dissolve' }`), which lazily registers the clipper the host
  app supplies. Not in the default core.

The honest consequence of `collect`, which the docs state plainly: **if the
input features overlap, a feature of the downloaded dataset lying in the
overlap matches more than one part of the MultiPolygon.** Under
`spatial.mode = 'intersects'` this is harmless — a row either matches or does
not, and extract-core deduplicates by row identity within a file. Under
`spatial.mode = 'clip'` it produces overlapping output fragments. So:
`upload-core` detects overlapping input bboxes and sets
`warnings: ['overlapping-features']`; `extract-core` refuses `clip` on an
Area with `combine: 'collect'` and overlapping parts unless
`allowOverlappingClip: true`. That is the whole cost of not shipping a boolean
union in core, and it is a cost we can state in one sentence.

### 1.5 Antimeridian

Rules, in order of precedence:

1. **Coordinates stay as published.** Longitudes are in `[-180, 180]`, per
   RFC 7946. No `+360` unwrapping. This keeps an `Area` droppable into
   geojson.io, GDAL, or QGIS unchanged.
2. **`Area.bbox` is signed and may wrap** (`west > east`). It exists for
   display ("your area spans 172°E to 171°W") and for round-tripping.
3. **`Area.bboxes` is the computational form**: 1 or 2 boxes, each with
   `west <= east`, together covering the same extent. Every consumer that does
   arithmetic uses `bboxes`.
4. **Detection, not guessing.** A geometry is treated as antimeridian-crossing
   when the naive bbox spans more than 180° of longitude *and* the geometry has
   no vertex in a ±20° band around longitude 0. CGAZ RUS and FJI both satisfy
   this; a genuinely global polygon (an ADM0 for a country spanning the
   Greenwich meridian) does not. Ambiguous cases keep the naive bbox and set
   `crossesAntimeridian: false` — a too-wide bbox over-fetches, which is a
   performance bug; a wrongly-split bbox under-fetches, which is a correctness
   bug. We take the performance bug.
5. **Pruning is per-box and unioned.** `extract-core` runs partition and
   row-group pruning once per entry in `bboxes` and unions the selected sets.
   Point-in-polygon runs against the unsplit `filterGeometry`, which is correct
   because the geometry's own coordinates never wrapped.
6. **Exact clip across the antimeridian is refused** (`AREA_ANTIMERIDIAN_CLIP`).
   Clipping requires a boolean operation on a geometry whose coordinates wrap;
   doing it correctly means projecting, and projecting is out of core's scope.
   `intersects` works fine, so the refusal costs the user a checkbox, not the
   download.

### 1.6 The JSON shape

The wire form of an `Area` is **a GeoJSON `Feature`** whose extras live under
namespaced `properties` keys. This is deliberate: an `Area` saved to disk opens
in geojson.io, QGIS, and `ogr2ogr` with zero translation, and the extras
survive a round-trip through anything that preserves properties.

```json
{
  "type": "Feature",
  "bbox": [-122.4267, 37.7177, -121.5347, 38.0994],
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[-122.4267, 37.9048], [-122.3707, 37.8899], "…"]]
  },
  "properties": {
    "area:version": 1,
    "area:id": "area_01JCQ8Z7K3F2M",
    "area:name": "Contra Costa County",
    "area:crs": "EPSG:4326",
    "area:bboxes": [[-122.4267, 37.7177, -121.5347, 38.0994]],
    "area:crosses_antimeridian": false,
    "area:filter_geometry": {
      "type": "Polygon",
      "coordinates": [[[-122.4267, 37.9048], "…"]]
    },
    "area:vertex_count": { "display": 4812, "filter": 4812 },
    "area:provenance": {
      "source": "geocoder",
      "created_at": "2026-11-12T19:04:11Z",
      "combine": "single",
      "geometry_variant": "display-simplified",
      "features": [
        {
          "feature_id": "USA-ADM2-3160769234B82345678",
          "name": "Contra Costa",
          "level": 2,
          "country": "USA",
          "bbox": [-122.4267, 37.7177, -121.5347, 38.0994]
        }
      ],
      "attribution": [
        {
          "text": "Boundaries: geoBoundaries CGAZ",
          "license": "CC-BY-4.0",
          "url": "https://www.geoboundaries.org/",
          "share_alike": false
        }
      ],
      "geocoder": {
        "index_url": "https://data.source.coop/portolan-mirrors/geoboundaries/index/names.parquet",
        "index_source": "geoboundaries-cgaz",
        "index_version": "2026-11-12T00:00:00Z",
        "catalog_version": "geoboundaries-cgaz-2025-09-30",
        "boundary_url": "https://data.source.coop/portolan-mirrors/geoboundaries/adm2/display.parquet",
        "query": "contra costa",
        "matched_name": "Contra Costa"
      }
    }
  }
}
```

A multi-feature upload example, abbreviated, showing `collect` and simplification:

```json
{
  "type": "Feature",
  "bbox": [172.1, -19.2, -176.8, -12.4],
  "geometry": { "type": "MultiPolygon", "coordinates": ["…"] },
  "properties": {
    "area:version": 1,
    "area:id": "area_01JCQ91TTW4V8",
    "area:name": "fiji-districts.geojson",
    "area:crs": "EPSG:4326",
    "area:bboxes": [[172.1, -19.2, 180.0, -12.4], [-180.0, -19.2, -176.8, -12.4]],
    "area:crosses_antimeridian": true,
    "area:filter_geometry": { "type": "MultiPolygon", "coordinates": ["…"] },
    "area:vertex_count": { "display": 41288, "filter": 9947 },
    "area:provenance": {
      "source": "upload",
      "created_at": "2026-11-12T19:11:40Z",
      "combine": "collect",
      "geometry_variant": "full",
      "features": [
        { "feature_id": null, "name": "Ba", "bbox": [177.3, -17.8, 177.9, -17.2] },
        { "feature_id": null, "name": "Lau", "bbox": [-179.9, -19.2, -178.2, -16.1] }
      ],
      "simplification": {
        "method": "visvalingam",
        "tolerance_deg": 0.000381,
        "input_vertices": 41288,
        "output_vertices": 9947,
        "area_delta_ratio": 0.0023,
        "degraded_to_bbox": false
      },
      "attribution": [],
      "upload": {
        "filename": "fiji-districts.geojson",
        "bytes": 1884213,
        "media_type": "application/geo+json",
        "feature_count": 14,
        "declared_crs": null,
        "repairs": [
          { "kind": "closed-ring", "count": 3 },
          { "kind": "dropped-z", "count": 14 }
        ]
      }
    }
  }
}
```

Mapping rule between the TS and the JSON: `camelCase` in TS,
`snake_case` under the `area:` prefix in JSON; `Area.geometry` ↔ the Feature's
`geometry`; `Area.bbox` ↔ the Feature's `bbox`. `@cngeo/spec` exports
`toAreaDocument(area): AreaDocument` and `fromAreaDocument(doc): Area`, and
`validateAreaDocument(doc)` against the published JSON Schema.

---

## 2. Dataset descriptor + filter spec

This is the artifact design call #7 names: **data, not code**, shared between
the TS packages and the Python QGIS plugin. It is three nested documents, each
independently versioned:

- **`DatasetDescriptor`** — *where* the data is and *what shape* it has.
- **`FilterSpec`** — *which rows and columns* are wanted.
- **`OutputRequest`** — *what file* to write.

Together they form a **`DownloadRequest`**, which is the copy-pasteable unit: a
user can paste one into the QGIS plugin, a Python notebook, or a web app and
get the same rows out. `portolan-browser`'s `codeGenerators.config.js` is the
natural place to emit it (see §5.3).

### 2.1 DatasetDescriptor

```ts
// @cngeo/spec — dataset.ts

export interface DatasetDescriptor {
  readonly spec: 'cng-dataset/1.0';
  /** Stable id for caching resolved descriptors and correlating estimates. */
  readonly id?: string;
  readonly title?: string;
  readonly source: DatasetSource;
  /** Table shape. Omitted in a hand-written descriptor; filled by the
   *  resolver from the collection JSON, GeoParquet metadata, or the parquet
   *  footer. An explicit value always wins over a derived one. */
  readonly table?: DatasetTable;
  /** Licensing to stamp into output and surface in the UI. */
  readonly attribution?: AreaAttribution[];
  /** Free-form, never interpreted. A place for a host app to stash its own
   *  identifiers (a STAC collection id, a portolan catalog path). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export type DatasetSource =
  | ParquetSource
  | ParquetSetSource
  | HivePartitionedSource
  | StacGeoparquetSource
  | PortolanCollectionSource;

/** One GeoParquet file. */
export interface ParquetSource {
  readonly kind: 'parquet';
  readonly url: string;
}

/** An explicit list of GeoParquet files making up one logical table.
 *  Used when a catalog enumerates its parts (STAC `item` links) rather than
 *  describing them with a glob. */
export interface ParquetSetSource {
  readonly kind: 'parquet-set';
  readonly urls: readonly string[];
  /** Per-file bbox/row-count/time-extent, when the catalog published it.
   *  Lets extract-core prune whole files with zero HTTP requests. */
  readonly parts?: readonly DatasetPart[];
}

/** Hive-partitioned, described with the Portolan partition extension. */
export interface HivePartitionedSource {
  readonly kind: 'hive';
  readonly scheme: 'hive';
  /** `partition:glob`. One `*` per partition segment; `*` never crosses `/`. */
  readonly glob: string;
  /** `partition:keys`. Order matters: it is the directory order in the glob. */
  readonly keys: readonly PartitionKey[];
  /** `partition:strategy`, advisory: "temporal", "spatial", "admin", … */
  readonly strategy?: string;
  /** `partition:file_count`, advisory, for estimate sanity checks. */
  readonly fileCount?: number;
  /** How the browser learns the actual partition values, since it cannot list
   *  an object-storage prefix over HTTP. See §2.4. */
  readonly enumeration: PartitionEnumeration;
  readonly parts?: readonly DatasetPart[];
}

/** STAC-GeoParquet: every row is a STAC Item, the geometry is a footprint. */
export interface StacGeoparquetSource {
  readonly kind: 'stac-geoparquet';
  /** Either one file, a glob (with `keys`/`enumeration` as for `hive`), or a
   *  list. The discriminator is which of these is present. */
  readonly url?: string;
  readonly glob?: string;
  readonly urls?: readonly string[];
  readonly keys?: readonly PartitionKey[];
  readonly enumeration?: PartitionEnumeration;
  readonly parts?: readonly DatasetPart[];
  /** Defaults that make the "footprints over a country" query work without
   *  the user naming columns: `datetime` for time, `geometry` for space. */
  readonly stac?: {
    readonly datetimeColumn?: string;      // default 'datetime'
    readonly idColumn?: string;            // default 'id'
    readonly collectionColumn?: string;    // default 'collection'
  };
}

/** The minimal form: name a Portolan/STAC collection JSON and derive the
 *  rest. Design call #8: "Dataset descriptor = the collection JSON itself." */
export interface PortolanCollectionSource {
  readonly kind: 'portolan-collection';
  readonly url: string;
  /** Which data asset to use, when a collection has more than one. Omitted
   *  means "the parquet asset with role `data`, else the `partition:glob`". */
  readonly asset?: string;
}

export interface PartitionKey {
  readonly name: string;
  /** Parquet logical type name, as the partition extension writes it. */
  readonly type: 'string' | 'int32' | 'int64' | 'date' | 'float64' | 'bool';
  readonly description?: string;
  /** Known values, when the catalog enumerates them. Lets the client prune
   *  without any discovery request. */
  readonly values?: readonly (string | number)[];
}

export type PartitionEnumeration =
  /** A STAC-GeoParquet mirror of the collection's items (role
   *  `collection-mirror`): one row per partition with its bbox, row count and
   *  temporal extent. **The preferred form** — one small fetch prunes
   *  everything. */
  | { readonly kind: 'collection-mirror'; readonly url: string }
  /** The collection's `item` links. N requests, N = partition count; cached. */
  | { readonly kind: 'stac-items'; readonly collectionUrl: string }
  /** A plain JSON array of partition-value tuples published beside the data. */
  | { readonly kind: 'values'; readonly url: string }
  /** Values are declared inline on `PartitionKey.values`; the glob is filled
   *  in by cross product. */
  | { readonly kind: 'declared' }
  /** An S3-style `?list-type=2&prefix=` listing, where the bucket allows it
   *  (source.coop does). Opt-in, because many hosts do not. */
  | { readonly kind: 'bucket-listing'; readonly endpoint: string; readonly prefix: string };

export interface DatasetPart {
  readonly url: string;
  /** Partition key values for this part, when it came from a partitioned set. */
  readonly keys?: Readonly<Record<string, string | number>>;
  readonly bbox?: BBox;
  readonly rowCount?: number;
  readonly bytes?: number;
  /** [start, end] ISO 8601; either may be null for an open interval. */
  readonly interval?: readonly [string | null, string | null];
}

export interface DatasetTable {
  /** `table:primary_geometry`, else the GeoParquet `primary_column`. */
  readonly geometryColumn: string;
  readonly geometryEncoding: 'WKB' | 'WKT' | 'geoarrow.point' | 'geoarrow.multipolygon' | string;
  /** EPSG:4326 / OGC:CRS84 is the only value extract-core filters against.
   *  Anything else → `DATASET_CRS_UNSUPPORTED` (see open item O6). */
  readonly crs: string;
  /** GeoParquet 1.1 `covering.bbox`, or an explicit struct/column set. The
   *  single most valuable field in this whole descriptor: it is what makes
   *  row-group pruning possible without decoding geometry. */
  readonly bbox?: BboxCovering;
  /** Preferred time column for `FilterSpec.time`. */
  readonly timeColumn?: string;
  readonly rowCount?: number;
  /** `table:columns`, verbatim. Powers the column picker and predicate
   *  validation. */
  readonly columns?: readonly ColumnDescriptor[];
}

export type BboxCovering =
  /** A struct column, as CGAZ/GAUL/World Bank publish and GeoParquet 1.1
   *  specifies: `bbox: {xmin, ymin, xmax, ymax}`. */
  | { readonly kind: 'struct'; readonly column: string;
      readonly fields?: { xmin: string; ymin: string; xmax: string; ymax: string } }
  /** Four separate top-level columns. */
  | { readonly kind: 'columns'; readonly xmin: string; readonly ymin: string;
      readonly xmax: string; readonly ymax: string }
  /** No covering: pruning uses only the geometry column's own row-group
   *  statistics, which for WKB is useless. Honest "none" so the estimate can
   *  say why it has to read everything. */
  | { readonly kind: 'none' };

export interface ColumnDescriptor {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly nullable?: boolean;
}
```

### 2.2 FilterSpec

```ts
// @cngeo/spec — filter.ts

export interface FilterSpec {
  readonly spec: 'cng-filter/1.0';

  /** The area. Inline `AreaDocument` keeps a DownloadRequest self-contained;
   *  `{ ref: 'area' }` means the runtime supplies it (the common case in a
   *  live widget, where the Area is a live object). */
  readonly area?: AreaDocument | { readonly ref: 'area' };

  readonly spatial: SpatialFilter;
  readonly time?: TimeFilter;

  /** ANDed. An empty array and `undefined` both mean "no attribute filter". */
  readonly where?: readonly Predicate[];

  /** Escape hatch for what structured predicates cannot say. Declared with a
   *  dialect so a consumer that cannot run it refuses loudly instead of
   *  silently dropping it. See §2.5. */
  readonly whereSql?: { readonly dialect: 'duckdb'; readonly fragment: string };

  readonly columns?: ColumnProjection;

  /** Hard row cap applied after filtering. Distinct from the ceiling, which
   *  is a *refusal*; `limit` is a *request*. */
  readonly limit?: number;

  /** Explicit partition pruning, overriding what the spatial/time filters
   *  would infer. For the case where a user wants "just year=2024" regardless
   *  of what the time filter implies. */
  readonly partitions?: Readonly<Record<string, PartitionValueFilter>>;

  /** Capabilities this filter needs. A consumer that lacks one refuses with
   *  `FILTER_REQUIRES_ENGINE` before fetching a byte. Derived automatically by
   *  `@cngeo/spec`'s `requirementsOf(filter)`, and written into a serialized
   *  FilterSpec so a Python reader does not have to re-derive it. */
  readonly requires?: readonly FilterRequirement[];
}

export type FilterRequirement =
  | 'sql'            // whereSql is present
  | 'exact-clip'     // spatial.mode === 'clip'
  | 'dissolve';      // area combine === 'dissolve'

export interface SpatialFilter {
  /** The three-stage default of design call #1.
   *  - `bbox`:       bbox prune only. Fastest, over-selects at the edges.
   *  - `intersects`: bbox prune → point-in-polygon/edge test. **The default.**
   *  - `clip`:       `intersects`, then cut geometries at the area boundary.
   *                  Opt-in post-process; mutates features, so never implicit. */
  readonly mode: 'bbox' | 'intersects' | 'clip';
  /** Include a feature whose bbox touches the area bbox only at an edge.
   *  Default false, matching `ST_Intersects` on closed geometries being true
   *  for a shared boundary but bbox-touch not implying geometry-touch. */
  readonly includeBboxTouch?: boolean;
  /** `clip` only: drop clipped fragments smaller than this fraction of the
   *  original feature's area. Guards against slivers. Default 0. */
  readonly minFragmentRatio?: number;
}

export interface TimeFilter {
  /** Defaults to `DatasetTable.timeColumn`, else `datetime`. */
  readonly column?: string;
  /** ISO 8601. `null` = open. */
  readonly start: string | null;
  readonly end: string | null;
  /** Interval closure. Default `[)` — half-open, so adjacent windows tile
   *  without double-counting. */
  readonly closed?: '[)' | '[]' | '(]' | '()';
}

export type Predicate =
  | { readonly col: string; readonly op: '=' | '!=' | '<' | '<=' | '>' | '>='; readonly value: ScalarValue }
  | { readonly col: string; readonly op: 'in' | 'not_in'; readonly values: readonly ScalarValue[] }
  | { readonly col: string; readonly op: 'between'; readonly low: ScalarValue; readonly high: ScalarValue }
  | { readonly col: string; readonly op: 'is_null' | 'is_not_null' }
  | { readonly col: string; readonly op: 'like' | 'ilike' | 'not_like'; readonly value: string }
  | { readonly op: 'and' | 'or'; readonly args: readonly Predicate[] }
  | { readonly op: 'not'; readonly arg: Predicate };

/** `col` may be a dotted path into a struct (`names.primary`) — the same
 *  path syntax the QGIS plugin's `core/schema.py` already resolves. A `[n]`
 *  subscript indexes a list. A MAP's keys are not in the schema, so a path
 *  through a MAP is unvalidatable and is passed through unchecked. */

export type ScalarValue = string | number | boolean | null;

export type PartitionValueFilter =
  | { readonly op: 'in'; readonly values: readonly (string | number)[] }
  | { readonly op: 'between'; readonly low: string | number; readonly high: string | number }
  | { readonly op: 'all' };

export interface ColumnProjection {
  /** Mutually exclusive with `exclude`. The geometry column is always added
   *  back unless `dropGeometry` is set, because a download without geometry
   *  is a different product. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly dropGeometry?: boolean;
  /** Add the bbox covering columns to the output. Default: true for
   *  geoparquet output (so the download is itself prunable), false otherwise. */
  readonly includeBbox?: boolean;
}
```

### 2.3 OutputRequest and DownloadRequest

```ts
export interface OutputRequest {
  readonly spec: 'cng-output/1.0';
  /** Format plugin id. `geojson` and `geoparquet` are in core; `gpkg`,
   *  `flatgeobuf`, `csv`, `duckdb` come from plugins. */
  readonly format: string;
  readonly filename?: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface DownloadRequest {
  readonly spec: 'cng-request/1.0';
  readonly dataset: DatasetDescriptor;
  readonly filter: FilterSpec;
  readonly output: OutputRequest;
  /** Who/what produced this request, for reproducibility. */
  readonly generator?: { readonly name: string; readonly version: string; readonly at: string };
}
```

Format options, normative per format:

| format | options | notes |
|---|---|---|
| `geojson` | `{ precision?: number (7), newlineDelimited?: boolean (false), featureIdColumn?: string }` | Streaming; `newlineDelimited` emits GeoJSONSeq, which streams without holding the array. |
| `geoparquet` | `{ compression?: 'zstd'\|'snappy'\|'none' ('zstd'), compressionLevel?: number (9), rowGroupSize?: number (50000), version?: '1.0'\|'1.1' ('1.1'), writeCovering?: boolean (true), spatialSort?: boolean (false) }` | `writeCovering` emits the `bbox` struct + GeoParquet 1.1 `covering`, so the output is itself prunable. |
| `gpkg` | `{ layerName?: string }` | Plugin (`@cngeo/format-gpkg`, **shipped E10**). Non-streaming, sql.js path, lazy-loadable (~339 KB measured). No R-tree (`spatialIndex` option dropped — sql.js's published wasm build has no `rtree` module; see §4.5 and the package README). |
| `shapefile` | `{ layerName?: string }` | Plugin (`@cngeo/format-shapefile`, **shipped E10**). Zero deps, non-streaming, eager-registrable. Writes a `.shp.zip` (five sibling files bundled, since `Sink` is one file). Limits surfaced as `FormatWriter.close()`'s `warnings` (10-char field names, one shape type per file, ~2GiB ceiling — see package README). |
| `flatgeobuf` | — | Plugin (`@cngeo/format-flatgeobuf`, **shipped E10**, ~10 KB measured, lazy-loadable). Non-streaming (the wrapped `flatgeobuf` package's JS binding has no incremental encoder). |
| `csv` | `{ geometry?: 'wkt'\|'drop' ('wkt'), delimiter?: string (',') }` | Plugin (`@cngeo/format-extras`, **shipped E10**, zero deps, streaming, eager-registrable). |
| `esrijson` | — | Plugin (`@cngeo/format-extras`, **shipped E10**, zero deps, non-streaming — a FeatureSet is one JSON document). Esri REST `FeatureSet` shape; one `geometryType` per file (mixed types refused, same restriction as Shapefile). |

### 2.4 Resolution: collection JSON → descriptor

A `portolan-collection` source is resolved by `@cngeo/extract-core`'s
`resolveDataset(descriptor)`. The mapping is fixed and documented so the Python
side can implement the same derivation:

| descriptor field | from the collection JSON |
|---|---|
| `source.kind = 'hive'` | `partition:scheme === 'hive'` present |
| `source.glob` | `partition:glob` |
| `source.keys` | `partition:keys` (`{name, type, description}`) |
| `source.strategy` | `partition:strategy` |
| `source.fileCount` | `partition:file_count` |
| `source.enumeration` | asset with role `collection-mirror` → `{kind:'collection-mirror'}`; else `item` links → `{kind:'stac-items'}` |
| `source.kind = 'parquet'` | no `partition:*`; a single asset of media type `application/vnd.apache.parquet` with role `data` |
| `source.kind = 'stac-geoparquet'` | the asset or collection declares role `collection-mirror`, or `table:columns` contains STAC Item columns (`stac_version`, `assets`) |
| `table.geometryColumn` | `table:primary_geometry`, else GeoParquet metadata `primary_column`, else `geometry` |
| `table.columns` | `table:columns` |
| `table.rowCount` | `table:row_count` |
| `table.bbox` | GeoParquet 1.1 `covering.bbox`; else a `table:columns` entry named `bbox` of type struct; else `{kind:'none'}` |
| `table.timeColumn` | the first `table:columns` entry of type `timestamp`/`date`; `datetime` wins if present |
| `table.crs` | GeoParquet metadata `crs` of the primary column; absent means `OGC:CRS84` |
| `attribution` | `license` + the `provider` with role `producer`/`licensor` |
| **not supported** | a collection whose only data assets are COG/zarr/pmtiles → `DATASET_UNSUPPORTED` with a message naming the asset types found (design call #8's graceful refusal) |

Fields in `table` are filled from the collection JSON *without reading the
parquet*. Anything still missing is filled from the first part's parquet footer
on the first `estimate()` call, and cached on the resolved descriptor.
`resolveDataset` returns a fully-concrete descriptor — a plain JSON object with
no `portolan-collection` source left in it — which is what gets embedded in a
shareable `DownloadRequest`.

### 2.5 The SQL escape hatch, and why it is declared

The QGIS plugin's existing attribute filter is a raw DuckDB `WHERE` fragment
(`gpq_downloader/core/filters.py` validates it against the schema and scans it
for identifiers). We keep that capability, because structured predicates will
never cover everything a DuckDB user wants. But a raw fragment is unusable by a
hyparquet engine, so:

- `whereSql` is a **separate field** from `where`. A consumer never has to parse
  SQL to find out whether it can honour a filter.
- `requires` lists `'sql'` whenever `whereSql` is present. `extract-core`'s
  default (hyparquet) engine refuses with `FILTER_REQUIRES_ENGINE` and names the
  capability; registering `@cngeo/engine-duckdb` makes it work.
- Both may be present; they are ANDed. A UI can therefore offer structured
  predicates for the common cases (which then prune row groups via statistics)
  and a raw fragment for the rest.
- `whereSql.fragment` is **untrusted text that becomes SQL**. The plugin's
  existing warning applies verbatim and is restated in our docs: treat a pasted
  filter like a small script. No `@cngeo` package ever puts a `whereSql` into a
  URL, a saved preference, or a generated code snippet without the user having
  typed it in this session.

### 2.6 Worked example 1 — single-file FTW GeoParquet

Fields of The World field boundaries for one country, high-confidence fields
only, as GeoPackage.

```json
{
  "spec": "cng-request/1.0",
  "dataset": {
    "spec": "cng-dataset/1.0",
    "id": "ftw-fields-nl",
    "title": "Fields of The World — field boundaries (Netherlands)",
    "source": {
      "kind": "parquet",
      "url": "https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=NL/Netherlands.parquet"
    },
    "table": {
      "geometryColumn": "geometry",
      "geometryEncoding": "WKB",
      "crs": "OGC:CRS84",
      "bbox": { "kind": "struct", "column": "bbox" },
      "columns": [
        { "name": "id", "type": "string" },
        { "name": "geometry", "type": "geometry" },
        { "name": "confidence", "type": "float32" },
        { "name": "area_ha", "type": "float64" },
        { "name": "determination_datetime", "type": "timestamp" }
      ]
    },
    "attribution": [
      { "text": "Fields of The World", "license": "CC-BY-4.0",
        "url": "https://fieldsofthe.world/", "share_alike": false }
    ]
  },
  "filter": {
    "spec": "cng-filter/1.0",
    "area": { "ref": "area" },
    "spatial": { "mode": "intersects" },
    "where": [
      { "col": "confidence", "op": ">=", "value": 0.9 },
      { "col": "area_ha", "op": "between", "low": 0.1, "high": 500 }
    ],
    "columns": { "include": ["id", "confidence", "area_ha"] },
    "requires": []
  },
  "output": {
    "spec": "cng-output/1.0",
    "format": "gpkg",
    "filename": "ftw-fields-contra-costa.gpkg",
    "options": { "layerName": "fields", "spatialIndex": true }
  }
}
```

What the engine does: one footer read; row groups pruned by the `bbox` struct
statistics against `area.bboxes` and by `confidence` statistics against the
`>= 0.9` predicate; `geometry`, `id`, `confidence`, `area_ha` chunks fetched for
surviving groups in parallel; per-row bbox test, then point-in-polygon against
`filterGeometry`; rows streamed to the `gpkg` plugin. Pruning is *statistics
only* — no index, no spatial tree.

### 2.7 Worked example 2 — FIRMS, hive-partitioned

Fire detections in the area for one month, science-quality only, as GeoParquet.
This is the real `firms-catalog` collection: 631M rows across
`year=*` partitions, declared with the Portolan partition extension.

```json
{
  "spec": "cng-request/1.0",
  "dataset": {
    "spec": "cng-dataset/1.0",
    "id": "firms-detections",
    "title": "FIRMS active fire detections",
    "source": {
      "kind": "hive",
      "scheme": "hive",
      "glob": "https://data.source.coop/portolan-mirrors/firms-catalog/detections/year=*/*.parquet",
      "keys": [
        { "name": "year", "type": "int32",
          "description": "Year of acquisition (UTC)." }
      ],
      "strategy": "temporal",
      "fileCount": 28,
      "enumeration": {
        "kind": "stac-items",
        "collectionUrl": "https://data.source.coop/portolan-mirrors/firms-catalog/detections/collection.json"
      }
    },
    "table": {
      "geometryColumn": "geometry",
      "geometryEncoding": "WKB",
      "crs": "OGC:CRS84",
      "bbox": { "kind": "struct", "column": "bbox" },
      "timeColumn": "acq_datetime",
      "rowCount": 631316915
    },
    "attribution": [
      { "text": "NASA FIRMS", "license": "CC0-1.0", "share_alike": false }
    ]
  },
  "filter": {
    "spec": "cng-filter/1.0",
    "area": { "ref": "area" },
    "spatial": { "mode": "intersects" },
    "time": {
      "column": "acq_datetime",
      "start": "2026-08-01T00:00:00Z",
      "end": "2026-09-01T00:00:00Z",
      "closed": "[)"
    },
    "where": [
      { "col": "quality", "op": "=", "value": "sp" },
      { "col": "sensor", "op": "in", "values": ["VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21"] }
    ],
    "columns": { "exclude": ["instrument", "satellite"] },
    "requires": []
  },
  "output": {
    "spec": "cng-output/1.0",
    "format": "geoparquet",
    "filename": "firms-aug-2026.parquet",
    "options": { "compression": "zstd", "compressionLevel": 9, "writeCovering": true }
  }
}
```

Pruning cascade, in order, each stage reported in the estimate:

1. **Partition prune from the time filter.** `strategy: 'temporal'` with key
   `year: int32` → `[2026-08-01, 2026-09-01)` selects `year=2026` alone. 28
   files → 1, with zero HTTP requests to the data. This is why
   `partition:strategy` is worth carrying.
2. **Partition prune from the area.** Not applicable here (temporal strategy).
   For `admin:country_code=*` (the FTW vectors collection) the area's
   `features[].country` prunes directly when the key is an ISO code, and
   otherwise the `collection-mirror`/`stac-items` bboxes do.
3. **Row-group prune** on the surviving file using the `bbox` struct statistics
   against each of `area.bboxes`, and the `acq_datetime` statistics against the
   window.
4. **Row filter**: per-row bbox, then point-in-polygon.

### 2.8 Worked example 3 — Sentinel-2 STAC-GeoParquet footprints

"Type a country, download all Sentinel-2 footprints over it." The real
`sentinel-2-c1-l2a` collection: 30.4M item rows, `year=*` hive partitions.

```json
{
  "spec": "cng-request/1.0",
  "dataset": {
    "spec": "cng-dataset/1.0",
    "id": "sentinel-2-c1-l2a",
    "title": "Sentinel-2 C1 L2A — STAC item footprints",
    "source": {
      "kind": "stac-geoparquet",
      "glob": "https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=*/*.parquet",
      "keys": [{ "name": "year", "type": "int32" }],
      "enumeration": {
        "kind": "stac-items",
        "collectionUrl": "https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json"
      },
      "stac": {
        "datetimeColumn": "datetime",
        "idColumn": "id",
        "collectionColumn": "collection"
      }
    },
    "table": {
      "geometryColumn": "geometry",
      "geometryEncoding": "WKB",
      "crs": "OGC:CRS84",
      "bbox": { "kind": "struct", "column": "bbox" },
      "timeColumn": "datetime",
      "rowCount": 30396466
    },
    "attribution": [
      { "text": "Copernicus Sentinel-2, Element 84 Earth Search",
        "license": "CC-BY-SA-3.0-IGO", "share_alike": true }
    ]
  },
  "filter": {
    "spec": "cng-filter/1.0",
    "area": { "ref": "area" },
    "spatial": { "mode": "intersects" },
    "time": { "start": "2025-06-01T00:00:00Z", "end": "2025-09-01T00:00:00Z", "closed": "[)" },
    "where": [{ "col": "eo:cloud_cover", "op": "<=", "value": 20 }],
    "columns": {
      "include": ["id", "datetime", "eo:cloud_cover", "s2:mgrs_tile", "thumbnail_url"],
      "includeBbox": true
    },
    "limit": 5000,
    "requires": []
  },
  "output": {
    "spec": "cng-output/1.0",
    "format": "geojson",
    "filename": "s2-footprints-kenya-summer-2025.geojson",
    "options": { "precision": 6, "featureIdColumn": "id" }
  }
}
```

Two things this example pins down:

- `kind: 'stac-geoparquet'` is **not** a different engine path — it is
  `parquet`/`hive` plus STAC column defaults. The only behavioural difference:
  the `assets` column (half the bytes of an S2 part) is excluded by default
  unless explicitly included, because a footprint download almost never wants
  it. Documented as `stac` descriptor sugar, not magic.
- `share_alike: true` on the attribution means `extract-core` stamps the
  license into the GeoJSON `properties`-level metadata (a top-level
  `"license"`/`"attribution"` member on the FeatureCollection, which is
  non-standard but harmless and preserved by most tools) and the host UI must
  show it.

### 2.9 Implementability in Python (design call #7)

The spec is implementable by the existing QGIS plugin without TypeScript. The
mapping onto what `gpq_downloader` already has:

| spec | QGIS plugin today | work needed |
|---|---|---|
| `DatasetDescriptor.source.url` / `.glob` | the preset `url` / `url_template` in `data/presets.json`, or a custom URL | a `descriptor.py` that reads a `DownloadRequest` JSON and yields the `read_parquet()` argument |
| `source.kind = 'portolan-collection'` | nothing | `resolve_dataset()` — the §2.4 table, ~120 lines of `json` traversal, no new dependency |
| `filter.area` | `DownloadJob.aoi_geometry` (a QGIS geometry) | `area_from_document()`: read the Feature, `QgsGeometry.fromWkt`/`fromJson`; `bboxes` for the `ST_Intersects` bbox pre-filter |
| `filter.spatial.mode` | `DownloadJob.clip_to_area` (bool) | a 3-value enum instead of a bool; `bbox`/`intersects`/`clip` → `ST_Intersects(bbox…)` / `ST_Intersects(geom…)` / `ST_Intersection` |
| `filter.where` (structured) | nothing | `predicate_to_sql()`, reusing `core/sql.py`'s `sql_str`/`sql_ident` for quoting — this is the only new SQL-generation code, ~60 lines |
| `filter.whereSql` | `DownloadJob.where_fragment` + `core/filters.validate_where_fragment` | direct: the existing validator is exactly the right gate |
| `filter.columns` | nothing (plugin downloads all columns) | a `SELECT` list instead of `*` |
| `filter.time` | nothing | one more `AND` term |
| `output.format` | `core/output_formats.FORMATS` + `data/formats.json` | add a `format id → OutputFormat` lookup keyed by our ids |
| `output.options.compression` etc. | `core/copy_options.py` already models codec/level/row-group/spatial-sort | direct |

**Direction of travel:** the plugin gains a "paste a download request" entry
point and a "copy this request" action; the web widget gains the same. The two
then demonstrably produce the same rows, which is the test that proves the
spec is real. `@cngeo/spec` publishes the JSON Schemas to npm *and* as plain
files in this repo under `spec/`, so the Python side vendors a copy and
validates with `jsonschema` (already an indirect QGIS dependency).

---

## 3. Package design and public APIs

### 3.1 Names

npm scope **`@cngeo`** (cloud-native geospatial). Short matters here: these
specifiers appear verbatim in CDN import URLs in every example, and
`@cloud-native-map-widgets/extract-core` makes a 90-character import line.

*Amended 2026-11-17 (was `@cngeo`):* [O1](#7-open-items) is resolved. `@cngeo`
is both short and expands to a term with currency in this community, where
`cng` expanded to nothing on sight. Deliberately **not** matched to the repo
name `cng-map-widgets`: `@cng-map-widgets/extract-core` is 31 characters, and
"map-widgets" is wrong for `spec`, `extract-core` and the `format-*`
packages, which are not map widgets.

| package | contents | depends on |
|---|---|---|
| `@cngeo/spec` | TypeScript types + JSON Schemas for `Area`, `DatasetDescriptor`, `FilterSpec`, `OutputRequest`, `DownloadRequest`; pure helpers: bbox math, antimeridian split/detect, Visvalingam simplify, normalize/validate `Area`, `requirementsOf(filter)`, `toAreaDocument`/`fromAreaDocument`. **No I/O, no dependencies.** | — |
| `@cngeo/geocoder-core` | index load (full + range), normalization, prefix search, ranking, geometry resolution → `Area`. Framework-agnostic, no DOM. | `@cngeo/spec`, `hyparquet`, `hyparquet-compressors` |
| `@cngeo/upload-core` | file/drop handling, GeoJSON parse, validate/repair, combine, → `Area`. GeoJSON only (E4). | `@cngeo/spec` |
| `@cngeo/extract-core` | dataset resolution, pruning cascade, estimate, streaming download, sinks, format registry, `geojson` + `geoparquet` writers. | `@cngeo/spec`, `hyparquet`, `hyparquet-compressors`, `hyparquet-writer` |
| `@cngeo/maplibre` | `GeocoderControl`, `AreaLayer`, `DrawTool` (thin), viewport provider. | `@cngeo/spec`; **peer**: `maplibre-gl` |
| `@cngeo/openlayers` | the same three, OpenLayers flavour. | `@cngeo/spec`; **peer**: `ol` |
| `@cngeo/format-gpkg` | GeoPackage writer plugin (sql.js path, ~339 KB min+gz — **shipped and measured, E10**). Opt-in, lazy-loadable. | `@cngeo/spec` |
| `@cngeo/format-shapefile` | Shapefile writer plugin (zero deps, ~5 KB — **shipped, E10**). Opt-in, eager-registrable. | `@cngeo/spec` |
| `@cngeo/format-flatgeobuf` | FlatGeobuf writer plugin (~10 KB min+gz — **shipped and measured, E10**). Opt-in, lazy-loadable. | `@cngeo/spec` |
| `@cngeo/format-extras` | CSV + Esri JSON writer plugins (zero deps — **shipped, E10**). Opt-in, eager-registrable. | `@cngeo/spec` |
| `@cngeo/format-gdal` | Future work (E10): a gdal3.js-backed plugin for drivers neither sql.js nor Shapefile's flat-file format reach (File Geodatabase, chiefly). Measured 9.07 MB gzip — not implemented. | `@cngeo/spec`; **peer**: `gdal3.js` |
| `@cngeo/engine-duckdb` | DuckDB-WASM engine plugin + benchmark harness. Opt-in, heavy. Design call #2: never in core. | `@cngeo/spec`; **peer**: `@duckdb/duckdb-wasm` |
| `@cngeo/stac` | `stacToDescriptor(stacObject)` — the §2.4 derivation as a standalone function over a plain STAC JSON. Extracted so `portolan-browser` and a future `stac-browser` widget share it. | `@cngeo/spec` |

Why `@cngeo/spec` exists as its own package rather than living in
`geocoder-core`: all five runtime packages need the `Area` contract, and a page
that loads `geocoder-core` and `extract-core` from a CDN must get **one**
`Area` implementation, not two. A shared, separately-versioned, zero-dependency
spec package is the only way to guarantee that across independent CDN imports.

Why `@cngeo/stac` is separate from `extract-core`: design call #8 wants
portolan glue thin, and E7's notes want a stac-browser extraction path. The
STAC→descriptor derivation is the *entire* portolan-specific surface. Isolating
it means the future stac-browser widget is "same packages, different host
component", not a fork.

### 3.2 `@cngeo/geocoder-core`

```ts
// @cngeo/geocoder-core

export interface GeocoderOptions {
  /** Default: `DEFAULT_INDEX_URL` — the published
   *  portolan-mirrors/geoboundaries-catalog names manifest (design call #10).
   *  **PLANNED, not implemented — §8:** the array form (several sources
   *  searched together, results carrying `source`, concatenated and ranked
   *  with duplicates included per design call #6). A one-element array is
   *  accepted as equivalent to the string; two or more now refuse with
   *  `INDEX_MULTI_SOURCE_UNSUPPORTED` rather than silently loading the
   *  default instead. */
  readonly indexUrl?: string | readonly string[];

  /** `full` fetches the whole index once (design call #9's default path);
   *  `range` binary-searches row groups over HTTP ranges; `auto` picks `full`
   *  when the index's declared size is <= `fullLoadMaxBytes`, else `range`. */
  readonly loadStrategy?: 'full' | 'range' | 'auto';   // default 'auto'
  readonly fullLoadMaxBytes?: number;                  // default 5_242_880 (design call #9)
  /** Range path only: footer tail read size. Default 65_536, widened once on
   *  a miss. Not hyparquet's 512 KB default, which E1 measured as ~20% of a
   *  2.5 MB index spent reading metadata.
   *  **PLANNED, not implemented — §8:** superseded in practice by the
   *  manifest contract. The footer read size comes from each file entry's
   *  declared `footer_metadata_bytes` (`initialFetchSizeOf` in geocoder.js),
   *  which is exact per file rather than one global guess; this option is
   *  accepted and ignored. */
  readonly initialFetchSize?: number;

  readonly limit?: number;              // default 10
  readonly minPrefixLength?: number;    // default 1
  /** Default: NFD → strip combining marks → lowercase → collapse whitespace.
   *  Must agree with the index builder's `name_norm` (§6.2). Overriding it
   *  without rebuilding the index breaks the sort guarantee, so an override
   *  forces `loadStrategy: 'full'`. */
  readonly normalize?: (input: string) => string;

  readonly ranking?: Partial<RankingOptions>;
  /** Pre-filters applied before ranking. */
  readonly levels?: readonly number[];
  readonly countries?: readonly string[];
  /** **Added 2026-11-12** (the ranking-order amendment below). Default
   *  result-diversity options for every `search()`/`searchSync()` call;
   *  overridable per call via `SearchOptions.diversity`. */
  readonly diversity?: DiversityOptions;

  readonly geometry?: GeometryResolverOptions;
  /** Behaviour when the boundary file's `catalog_version` does not match the
   *  index's. Default `error` (§6.4). */
  readonly onVersionSkew?: 'error' | 'warn' | 'ignore';

  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface RankingOptions {
  /** How many admin levels an in-viewport feature is promoted by. `0` makes
   *  the viewport a pure tiebreak within a level. Default `1`. */
  readonly viewportBoost: number;
  /** A feature whose bbox lies within this multiple of the viewport's size
   *  counts as "near". Default `2`. */
  readonly nearFactor: number;
  /** Match classes allowed. Default `['exact', 'prefix', 'word-prefix']` —
   *  substring matching is off, because it ruins the ordering and the sorted
   *  index cannot serve it on the range path. */
  readonly matchClasses: readonly MatchClass[];
  /** **Added 2026-11-12** (the ranking-order amendment below). How many
   *  admin levels an `exact` match is allowed to out-rank a
   *  `prefix`/`word-prefix`/`substring` match at a shallower (closer to
   *  ADM0) level. `0` disables the promotion entirely (pure level-first).
   *  Default `1`. */
  readonly exactLevelPromotion?: number;
  /** **Added 2026-11-12** (the "alt-demotion" follow-up amendment below).
   *  The mirror image of `exactLevelPromotion`: how many admin levels a
   *  `prefix`/`word-prefix`/`substring` match against an alt-name row
   *  (`alt_of` non-null) is pushed *down* -- farther from ADM0 -- before
   *  level order is decided. An `exact` match against an alt-name row is
   *  never demoted (see `rankRow`'s doc comment). `0` disables the
   *  demotion entirely. Default `1`. */
  readonly altLevelDemotion?: number;
}

export type MatchClass = 'exact' | 'prefix' | 'word-prefix' | 'substring';

export interface SearchOptions {
  /** Current map viewport, for the ranking boost. The adapters supply this
   *  automatically; a bare core caller may omit it. */
  readonly viewport?: BBox;
  readonly limit?: number;
  readonly levels?: readonly number[];
  readonly countries?: readonly string[];
  /** **Added 2026-11-12.** Result-diversity knobs; see `DiversityOptions`
   *  below. Merges over `GeocoderOptions.diversity`, which merges over the
   *  built-in defaults. */
  readonly diversity?: DiversityOptions;
  readonly signal?: AbortSignal;
}

/** **Added 2026-11-12** (the ranking-order amendment below, "Result
 *  diversity"). */
export interface DiversityOptions {
  /** Collapse results identical in `(nameNorm, country, level)` to the
   *  single best one (largest `area_km2`), annotating it with `moreCount`.
   *  Default `true`. */
  readonly dedupe?: boolean;
  /** Cap results per `(country, level)` group at this many, before filling
   *  the requested `limit` with the next-ranked *distinct* groups.
   *  `null`/`undefined` disables the cap. Default `3`. */
  readonly maxPerGroup?: number | null;
}

export interface SearchResult {
  /** `shapeID` for geoBoundaries. The stable key (design call #5). */
  readonly featureId: string;
  readonly name: string;
  /** **Added by the follow-up "primaryName on alt matches" task.** The
   *  primary row's display name, present only when this result matched via
   *  an alt-name row (`rank.isAlt`/the row's `alt_of` column non-null) --
   *  `undefined` for every primary-row match, for which this is simply
   *  inapplicable. An alt row's `alt_of` column holds its primary row's
   *  `feature_id`; this is resolved **honestly, from data already loaded
   *  for the query it answers -- never a dedicated network round trip per
   *  result**:
   *  - In full-load mode, the entire index is already resident in memory,
   *    so a lazily-built `feature_id -> name` map over all of it (built at
   *    most once per `load()`) can always answer.
   *  - In range mode, only the row group(s) this query's prefix itself
   *    fetched are consulted. This resolves when the primary's own
   *    `name_norm` happens to share the query's prefix with the alt
   *    spelling that matched (both land in the same fetched row group(s)),
   *    which is common for a short, generic prefix but **not** the common
   *    case for distinctively different alt spellings (e.g. "Zürech" for
   *    "Zürich") -- there, the primary is left `undefined`, by design,
   *    rather than paying for a second fetch.
   *  Adapters: render it when present (`combobox-helpers.js`'s alt badge
   *  does), and treat its absence as "can't say", not "this has no
   *  primary". */
  readonly primaryName?: string;
  readonly nameNorm: string;
  readonly level: number;
  readonly country: string;
  /** Overture's division-names index column: the containing admin unit's
   *  display name (e.g. `"Rajasthan"` for an Indian locality). `undefined`
   *  when the loaded index has no `parent_name` column. */
  readonly parentName?: string;
  /** **Added 2026-11-12.** geoBoundaries' CGAZ-names-index column: the ISO
   *  country's display name (e.g. `"Switzerland"` alongside `country:
   *  "CHE"`). `undefined` when the loaded index has no `country_name`
   *  column. Adapters prefer `parentName` over this when both are somehow
   *  present (never both in practice: the two source indexes are
   *  mutually exclusive on these columns). */
  readonly countryName?: string;
  /** **Added 2026-11-12.** Both known index flavours carry `area_km2`;
   *  `undefined` for a point-only locality with none. Used by the ranking
   *  comparator's importance tiebreak and by result-diversity's "keep the
   *  biggest" dedupe rule; exposed here so a UI can also use it directly
   *  (e.g. a size badge). */
  readonly areaKm2?: number;
  /** **Added, pending-data-columns follow-up** (ranking-residual
   *  amendment, below): Overture's place-prominence column, e.g.
   *  `"city"`/`"town"`/`"village"`/`"hamlet"`. `undefined` when the
   *  loaded index has no `class` column -- true for every index shipped
   *  so far; both this and `population` are reserved, not yet populated,
   *  columns (same status as O10's `name_lang`/`alt_of` were before E8). */
  readonly class?: string;
  /** **Added, pending-data-columns follow-up.** A population estimate for
   *  the feature, when the source has one. `undefined` when the loaded
   *  index has no `population` column (every index shipped so far). */
  readonly population?: number;
  readonly bbox: BBox;
  readonly source: string;

  readonly score: number;
  /** Why this ranked where it did. Exposed because an opaque score is
   *  untunable and untestable. */
  readonly rank: {
    readonly matchClass: MatchClass;
    readonly level: number;
    /** **Added 2026-11-12.** `level` after the bounded exact-match
     *  promotion (see the ranking-order amendment); equal to `level` for
     *  anything that isn't an `exact` match. */
    readonly effLevel: number;
    readonly levelAdjusted: number;
    /** Renamed in this doc 2026-11-12 to match the code, which has always
     *  called it `viewportRank` (`ranking.js`'s `rankRow`); this line said
     *  `viewport`, and nothing ever produced a field by that name. */
    readonly viewportRank: 'inside' | 'overlap' | 'near' | 'outside';
    readonly nameLength: number;
  };
  /** **Added 2026-11-12.** Present only when `applyDiversity`'s dedupe step
   *  collapsed more than one `(nameNorm, country, level)`-identical row
   *  into this one -- the count of rows folded in, not shown individually.
   *  The direct fix for the reported bug: eight villages literally named
   *  "Bag" in India, ADM4, become one row with `moreCount: 7`. */
  readonly moreCount?: number;
  /** **Added by the follow-up "expandable '+N more'" task.** Present
   *  exactly when `moreCount` is -- i.e. when the dedupe step above
   *  collapsed more than one row into this one -- carrying just enough
   *  per-collapsed-row info for a UI to render and select one directly:
   *  its own `name`/`featureId`/`level`. `country` and `nameNorm` are
   *  deliberately omitted: every row in the group shares this result's own
   *  `country`/`nameNorm` by construction (that's the dedupe key), so a UI
   *  reconstructing a selectable result from one of these gets them from
   *  the parent row it expanded, not duplicated here. Capped at
   *  `MAX_COLLAPSED_ROWS` (10) even when `moreCount` is larger -- `moreCount`
   *  itself is never capped, so an absurdly large group still reports its
   *  true size without forcing every one of its rows into memory/the DOM. */
  readonly collapsed?: readonly { readonly name: string; readonly featureId: string; readonly level: number }[];
  /** Advisory locator for the geometry fetch fast path (§6.3). Never
   *  authoritative: `select()` verifies `featureId` after reading.
   *  `row` is parquet `INT64`, which hyparquet decodes as a `BigInt`; it is
   *  converted to a plain `number` at the result boundary so that a
   *  `SearchResult` survives `JSON.stringify()` (it did not before
   *  2026-11-12 — one `BigInt` in the graph makes `JSON.stringify` throw).
   *  A value too large to be a safe integer keeps its `BigInt` precision
   *  and carries a `toJSON` instead. */
  readonly geometryRef?: { readonly file: string; readonly rowGroup?: number; readonly row?: number };
}

export interface GeometryResolverOptions {
  /** `display` fetches the pre-simplified variant (E2) and sets
   *  `geometryVariant: 'display-simplified'`; `full` fetches full resolution;
   *  `both` fetches display for `Area.geometry` and full for
   *  `Area.filterGeometry`. Default `display`. */
  readonly resolution?: 'display' | 'full' | 'both';
  /** **Added by the 2026-11-13 "upgradeDisplay" amendment below.**
   *  `resolution: 'both'` only: when the background full-resolution fetch
   *  finishes, also swap `Area.geometry` to it (keeping the pre-upgrade
   *  geometry on `Area.displayGeometry`) instead of only upgrading
   *  `filterGeometry`. Default `false` — the pre-amendment behavior,
   *  unchanged. Settable per `select()` call (`options.upgradeDisplay`) or
   *  as a `GeocoderOptions.geometry.upgradeDisplay` default for every call;
   *  the per-call value wins. No effect outside `resolution: 'both'`. */
  readonly upgradeDisplay?: boolean;
  /** Override the boundary file URLs the index sidecar declares.
   *  **PLANNED, not implemented — §8:** boundary URLs always come from the
   *  manifest (`resolveManifestUrl(manifestUrl, entry.full.url)`); this
   *  option is accepted and ignored. */
  readonly boundaryUrls?: Readonly<Record<number, string>>;
  readonly filterVertexCeiling?: number;   // default 10_000
  readonly displayVertexCeiling?: number;  // default 200_000
}

export interface IndexInfo {
  readonly url: string;
  readonly source: string;
  readonly indexVersion: string;
  readonly catalogVersion: string;
  readonly rows: number;
  readonly levels: readonly number[];
  readonly bytes: number;
  readonly strategy: 'full' | 'range';
  readonly attribution: readonly AreaAttribution[];
  /** Milliseconds from `load()` to ready. For the E1 budget check. */
  readonly loadMs: number;
  /** **Added, client-side speed pass** (manifest contract addition
   *  `prominent_index`, §6's "Further amendments"). Present only when the
   *  manifest declared one. `ready: false` is the (rare) case where the
   *  prominent index's own load failed -- `load()` still resolved, by
   *  falling back to waiting on the main index, exactly as if
   *  `prominent_index` had been absent. */
  readonly prominent?: { readonly rows: number; readonly bytes: number; readonly ready: boolean };
}

export type GeocoderState = 'idle' | 'loading' | 'ready' | 'error';

export declare class Geocoder {
  constructor(options?: GeocoderOptions);

  readonly state: GeocoderState;
  readonly info: IndexInfo | null;
  readonly attribution: readonly AreaAttribution[];

  /** Idempotent; concurrent calls share one promise. **Call on focus of the
   *  search box, not on page load** (design call #9). */
  load(signal?: AbortSignal): Promise<IndexInfo>;

  /** Ranked results. Calls `load()` if needed. Safe to call on every
   *  keystroke: a newer call supersedes an older one, whose promise resolves
   *  to `[]` rather than rejecting (so a UI never has to track staleness).
   *
   *  **Two-wave search** (manifest contract addition `prominent_index`):
   *  when a prominent index is declared and loaded but the main index
   *  isn't ready yet, this promise still resolves with the fast,
   *  possibly-incomplete answer from the prominent index alone (the
   *  `'results'` event for it is tagged `wave: 'prominent'`); once the
   *  main index finishes loading, the same query is re-run against it in
   *  the background and a **second** `'results'` event fires
   *  (`wave: 'final'`) -- but only if the final answer actually adds a
   *  row the first didn't have. A superseded query (a later `search()`
   *  call before the second wave lands) drops that wave silently. With no
   *  `prominent_index` declared, there is always exactly one wave,
   *  tagged `'final'` -- unchanged from before this existed.
   *
   *  **Range-mode progressive search, added by the follow-up "range-mode
   *  query latency" task.** Orthogonal to the two-wave mechanism above,
   *  and relevant once the main index itself is ready and range-strategy:
   *  a low-selectivity prefix spanning many candidate row groups
   *  (`searchRangeIndex`'s doc comment in geocoder-core has the measured
   *  numbers) resolves this promise as soon as the first small,
   *  bounded-concurrency batch of those groups has landed, continuing the
   *  rest in the background and emitting a **further** `'results'` event
   *  (also tagged `wave: 'final'` -- it *is* the main index answering,
   *  just not finished doing so yet) once every one of them is in, under
   *  the same grows-only re-emission rule as the two-wave mechanism. If a
   *  query's candidate row groups exceed the documented cap (24 by
   *  default), only the first `maxGroups` (by sort order -- a real,
   *  meaningful subset, not an arbitrary one) are ever fetched at all, and
   *  the returned array -- and every `'results'` event's `results` --
   *  carries an own `truncated: true` property (absent otherwise) so a UI
   *  can say the list is known-incomplete rather than show it as if it
   *  weren't. */
  search(prefix: string, options?: SearchOptions): Promise<SearchResult[]>;

  /** Zero-await typeahead. Available only when `state === 'ready'` and the
   *  index was fully loaded; throws `GEOCODER_NOT_LOADED` otherwise. Exists
   *  because the full-load path can genuinely answer a keystroke
   *  synchronously, and a promise per keystroke is a measurable chunk of a
   *  150 ms budget. */
  searchSync(prefix: string, options?: Omit<SearchOptions, 'signal'>): SearchResult[];

  /** Fetch the geometry and build the `Area`. One or two range reads against
   *  the boundary mirror. */
  select(result: SearchResult, options?: GeometryResolverOptions & { signal?: AbortSignal }): Promise<Area>;

  /** **Added by the 2026-11-13 "upgradeDisplay" amendment below.** Cancel
   *  the currently pending `resolution: 'both'` background upgrade, if one
   *  is in flight. The `Area` already returned by `select()` is left
   *  exactly as it is; `'area:upgrade-cancelled'` fires once the abort is
   *  actually observed. Returns `false` (no-op) when nothing is pending —
   *  never throws. */
  cancelUpgrade(): boolean;

  on<K extends keyof GeocoderEvents>(event: K, handler: (payload: GeocoderEvents[K]) => void): Unsubscribe;

  /** Drops the in-memory index and aborts in-flight work. */
  close(): void;
}

export interface GeocoderEvents {
  'state': { state: GeocoderState };
  /** **PLANNED, not implemented — §8.** Never emitted: nothing counts
   *  bytes against `content-length` on either the manifest or the index
   *  fetch. Subscribing succeeds (the emitter does not validate names) and
   *  the handler simply never fires. */
  'load:progress': { bytes: number; total: number | null };
  'load': IndexInfo;
  /** `wave` **added by two-wave search** (manifest contract addition
   *  `prominent_index`): `'final'` on every emission when there's no
   *  prominent index, or once the main index is ready; `'prominent'` for
   *  the fast, possibly-incomplete first answer while the main index is
   *  still loading behind it. See `search()`'s doc comment above for the
   *  full merge/supersede semantics, including the range-mode progressive
   *  wave the "range-mode query latency" follow-up added -- also tagged
   *  `'final'`, not a third `wave` value. `results` itself carries an own
   *  `truncated: true` property (absent otherwise) on that same follow-up:
   *  see `search()`'s doc comment for when. */
  'results': { query: string; results: SearchResult[]; elapsedMs: number; wave: 'prominent' | 'final' };
  'select': { result: SearchResult; area: Area; elapsedMs: number };
  /** Documented retroactively by the 2026-11-13 "upgradeDisplay" amendment
   *  below — this event has existed, unchanged, since progressive
   *  `select({ resolution: 'both' })` first shipped; this interface simply
   *  never listed it. Fires once the background fetch + simplify finishes:
   *  `area` is a copy of the `Area` `select()` already returned, with
   *  `filterGeometry`/`vertexCount.filter` upgraded to the full-resolution
   *  fetch (and, with `upgradeDisplay: true`, `geometry` upgraded too — see
   *  `GeometryResolverOptions.upgradeDisplay`). Never fires for a
   *  since-superseded or explicitly `cancelUpgrade()`-cancelled selection. */
  'area:upgraded': { result: SearchResult; area: Area; elapsedMs: number };
  /** **Added by the 2026-11-13 "upgradeDisplay" amendment below.** Fires
   *  synchronously, right after `'select'`, the moment a `resolution:
   *  'both'` background fetch starts — before any byte of it has actually
   *  arrived. `area` is the display `Area` `select()` is about to return.
   *  `estimate` is `{ bytes?, vertices? }`: a cheap, manifest-derived guess
   *  at the full-resolution fetch's size (`geocoder.js`'s
   *  `estimateUpgradeOf` — the *average* feature size in that boundary
   *  file, since this feature's own size is unknowable before fetching
   *  it), present only when the manifest declares enough to compute one. A
   *  UI uses this to show "loading full detail… ~69K vertices" with a
   *  cancel affordance that calls `cancelUpgrade()`. */
  'area:upgrading': { result: SearchResult; area: Area; estimate: { bytes?: number; vertices?: number } };
  /** **Added by the 2026-11-13 "upgradeDisplay" amendment below.** Fires
   *  once an explicit `cancelUpgrade()` call's abort is actually observed
   *  (at the upgrade's next `await` boundary) — never for a selection
   *  merely superseded by a later `select()`, which stays exactly as
   *  silent as it always was. `area` is the display `Area`, completely
   *  unchanged: cancelling never un-does anything, because nothing was
   *  ever done to it. */
  'area:upgrade-cancelled': { result: SearchResult; area: Area };
  /** **Added, client-side speed pass.** Fires once the main index finishes
   *  loading in the background after a `prominent_index`-driven `load()`
   *  already resolved early. Informational only -- `search()`'s own
   *  second-wave `'results'` emission is what a UI should actually react
   *  to for refreshing a results list; this event exists for anything
   *  that wants to know "the full index is in now" independent of any
   *  particular query (e.g. flipping an indicator off). */
  'index:upgraded': { strategy: 'full' | 'range'; loadMs: number };
  'error': CngError;
  /** Emitted when `onVersionSkew: 'warn'` and a skew was tolerated, or when
   *  a declared `prominent_index` fails to load (`code:
   *  'PROMINENT_INDEX_FAILED'`) -- the latter never fails `load()` itself,
   *  since falling back to the main index alone still leaves the geocoder
   *  fully usable. */
  'warning': { code: string; message: string; detail?: unknown };
}

export type Unsubscribe = () => void;

/** **Changed 2026-11-12.** The published geoBoundaries CGAZ names manifest,
 *  `https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json`
 *  (design call #10). It was `'./data/index.json'` — a relative development
 *  path that 404s for any consumer outside this repo's demo directory, and
 *  which `.gitignore`'s `data/` rule excludes even inside it. geoBoundaries
 *  (CC-BY-4.0) rather than the Overture index, deliberately: a default
 *  nobody chose must not impose ODbL share-alike terms (design call #11). */
export const DEFAULT_INDEX_URL: string;
export const VERSION: string;
```

### Amendment, 2026-11-13 — reason: the demo should show, and let the user cancel, the background full-res fetch

Progressive `select({ resolution: 'both' })` has returned the display `Area`
immediately and upgraded `filterGeometry` from a background full-resolution
fetch since the "fetch/attach the full-res geometry in the background" task
— but `Area.geometry` (the drawn outline) deliberately never changed, and
nothing told a UI the background fetch was even happening, let alone gave
the user a way to stop it. The geocoder demo's actual ask — "fetch the
higher-resolution vectors after the quick/low-res one, loading in the
background, with a notice the user can cancel to stick with the simplified
outline" — needed three additions, all opt-in, all defaulting to the
pre-amendment behavior:

1. **`GeometryResolverOptions.upgradeDisplay`** (default `false`). When
   `true` on a `resolution: 'both'` call, the Area `'area:upgraded'` carries
   has `geometry` itself swapped to the full-resolution fetch, not just
   `filterGeometry` — this is what actually makes the *visible* outline
   sharpen up, which is the point of a "load higher-res vectors" demo. The
   pre-upgrade display geometry survives on the new `Area.displayGeometry`
   field (§1.2) so a consumer that wants to revert has it without
   re-fetching or re-simplifying anything. `bbox`/`bboxes`/
   `crossesAntimeridian` are recomputed from the full geometry (not reused
   from the display variant) — a feature's real extent is defined by its
   full-resolution geometry — but this never moves the map's camera on its
   own: no adapter calls `fit()` in response to an upgrade, before or after
   this amendment. `provenance.geometryVariant` flips to `'full'` to match
   (it already said which variant `geometry` holds; this is what keeps that
   claim honest once `geometry` itself can be the full-res fetch).

2. **`'area:upgrading'`**, firing synchronously right after `'select'`, the
   moment the background fetch starts — so a UI can show a notice at
   exactly the point the fetch begins, not some arbitrary moment later. Its
   `estimate: { bytes?, vertices? }` is deliberately cheap and deliberately
   honest about what it is: `geocoder.js`'s `estimateUpgradeOf` divides the
   full-resolution boundary *file*'s manifest-declared total `size` by its
   declared `row_count` — the *average* bytes of one feature in that file,
   not this feature's own size (which is unknowable without fetching it;
   fetching it in the background is the whole point). `vertices` is that
   same average turned into a vertex count via the ~16-bytes-per-vertex
   ratio this doc's own §1.3 limits table already states. Absent entirely
   when the manifest doesn't declare both inputs — never a fabricated
   number. This is pure arithmetic over the manifest already in memory: no
   network request, no row-group read, no additional latency.

3. **`cancelUpgrade()`** / **`'area:upgrade-cancelled'`**. Scoped
   deliberately to the full-resolution upgrade only (not the pre-existing,
   unrelated filter-only vertex-ceiling-degrade upgrade `select()` already
   runs when its synchronous build hits `MAX_SYNC_SIMPLIFY_VERTICES`): that
   one never touches the visible outline, so there is nothing a
   user-facing "loading…/cancel" notice would be describing, and it keeps
   its pre-existing silent-drop-on-supersede behavior untouched.
   `cancelUpgrade()` aborts the pending upgrade's controller directly
   (reusing the existing generation-guard's `AbortController`, not bumping
   its generation) and records which generation asked for the abort, so the
   upgrade's own error handler can tell "the user explicitly cancelled
   this" apart from "a new `select()` superseded it" (same abort
   mechanism, still silent, unchanged) — only the former emits
   `'area:upgrade-cancelled'`. The Area the caller already has is left
   exactly as it is: cancelling stops work in flight, it does not undo
   anything, because with `upgradeDisplay` nothing is swapped until the
   upgrade actually finishes.

**Adapters.** `@cngeo/maplibre` and `@cngeo/openlayers`'s `GeocoderControl`s
both grew a small notice attached to the control: "Loading full detail…
~69K vertices" with a `×` Cancel button while `'area:upgrading'` is current,
"Full detail loaded." / "Keeping simplified outline." for a couple of
seconds once it settles. The state machine behind it
(`upgrade-notice.js`'s `upgradeNoticeReducer`/`describeUpgradeNotice`, in
each package) is pure and unit-tested without a DOM, same split as
`combobox-helpers.js`; strings are overridable via
`GeocoderControlOptions.upgradeNoticeStrings` for i18n. The outline swap
itself — `'area:upgraded'`'s handler calling the area layer's `setArea()` —
is deferred one idle slot (`requestIdleCallback`, falling back to
`setTimeout(fn, 0)`) rather than run synchronously inside the event
handler: with `upgradeDisplay: true`, `area.geometry` there can be the
full-resolution fetch (Canada ADM0 is ~500K vertices), and MapLibre's
`GeoJSONSource#setData()` has to structured-clone that object over to its
tiling worker, which is itself a measurable main-thread cost at that size.
Deferring cannot make the swap cheaper, only choose a moment for its cost
that isn't on top of whatever the user is doing right now; see the
`@cngeo/maplibre` README / the geocoder demo for the measured numbers.

**The ranking rule, normatively.** *(Amended 2026-11-12 — see the amendment
below for the bug report, the alternatives measured, and why this is the
order; amended again the same day by "Ranking-residual follow-up", which
added `isAlt`/prominence; amended a third time, also the same day, by
"alt-demotion", which folds a bounded alt-row demotion into `effLevel` and
moves `isAlt` earlier — see that amendment for why the ranking-residual
follow-up's placement of `isAlt` didn't reach the case it was built for;
amended a fourth time by "population-promotion / the Brooklyn case", which
folds a bounded population promotion into `effLevel` and moves prominence
ahead of raw `level` for the same structural reason `isAlt` moved.)*
Results are sorted by this tuple, ascending, with every component a total
order:

1. `levelAdjusted` = `effLevel − (viewportBoost if viewport is 'inside' or 'overlap' else 0)`.
2. `effLevel` = `max(0, level − promotion + demotion − populationPromotion)`,
   where `promotion` is `exactLevelPromotion` (default `1`) when
   `matchClass` is `'exact'`, else `0`; `demotion` is `altLevelDemotion`
   (default `1`) when the row is alt-named (`alt_of` non-null) **and**
   `matchClass` is *not* `'exact'`, else `0`; and `populationPromotion` is
   `populationLevelPromotion` (default `1`) when the row's `population` is
   at or above `populationPromotionThreshold` (default `100_000`) **and**
   the row did not take the alt demotion, else `0`. `promotion` and
   `demotion` are mutually exclusive per row (`promotion` only applies to
   `exact`, `demotion` only to non-`exact`), so those two never combine;
   `populationPromotion` composes with `promotion` (both can apply to a
   large-population exact match, which is what reaches Baghdad across a
   four-level gap) but is gated against `demotion`, since the two are the
   same magnitude and would exactly cancel. `promotion` is the *bounded
   promotion* the first amendment introduced (an exact match reads as up to
   one level shallower than it is); `demotion` is its mirror, added by
   "alt-demotion" (a non-exact alt-name match reads as up to one level
   *deeper*); `populationPromotion` is the third, added by
   "population-promotion" (a populous place reads as up to one level
   shallower). See each amendment for why all three are bounded to exactly
   one level, why an `exact` alt match is exempt from the demotion, why the
   threshold is 100,000 rather than any neighbouring value, and why the
   demotion gate exists.
3. `matchClassRank` — `exact` 0, `prefix` 1, `word-prefix` 2, `substring`
   3. Reached only once (1)/(2) have already tied — which is exactly when
   an `exact` match's promoted `effLevel` lands on the same rung as a
   shallower `prefix`/`word-prefix`/`substring` match's own level. That tie
   is where the bounded promotion actually resolves in the exact match's
   favour; `matchClassRank` never dominates the order on its own anymore.
4. **`isAlt`** — `false` (primary-name row) before `true` (alt-name row,
   `alt_of` non-null). **Moved here, ahead of raw `level`, by the
   "alt-demotion" amendment** (originally placed after `level` by the
   ranking-residual follow-up; see that amendment for why that placement
   never actually fired for the bug it was meant to catch). At equal
   `effLevel`/`matchClassRank` — which, after (2)'s demotion, now
   routinely includes a demoted alt-name match tying a primary match one
   level up — the primary wins. Checking `isAlt` *before* raw `level`
   matters: a demoted alt row's raw level is still shallower than the
   primary it was demoted to tie with, so checking `level` first would
   immediately re-open the gap the demotion just closed.
5. **Prominence** — added by the ranking-residual follow-up; **moved here,
   ahead of raw `level`, by the "population-promotion" amendment**, for the
   same structural reason `isAlt` moved in (4): once (2)'s population
   promotion ties a populous deep row with a shallower one, raw `level`
   would immediately re-open the gap the promotion just closed. The rule
   this makes explicit: *any adjustment whose purpose is to manufacture a
   tie must have that tie resolved before raw `level`.* Tier 0
   is `population` descending (a row with a real population always beats
   one without, regardless of the loser's `class`; `population: 0` is a
   real stored value on WOF and counts as tier 0, not as absent); tier 1 (no
   `population`) falls back to a fixed `class` ladder — `city` > `town` >
   `village` > `hamlet` > anything else or absent. Slots **ahead of**
   `areaKm2` (now component (7)), because population/class-of-place is a better
   importance signal *across* feature kinds (a capital city vs. a
   country) than area is — see "Known residual limitation" below for why
   `areaKm2` alone gets exactly that comparison backwards. **Live as of
   the "alt-demotion" amendment**: the published Overture catalog now
   populates both `population` and `class` on a real fraction of rows
   (confirmed live: Baghdad's city row carries `population: 7216040`,
   `class: 'city'`), so this step is no longer the no-op the
   ranking-residual follow-up shipped it as — see the measured tables
   below for concrete before/after examples (e.g. "London" now correctly
   favours Greater London's 8.9M population over a same-named small US
   town once both tie on level). **On WOF it stayed a no-op until the
   "population-promotion" amendment**, which found the `INT64`/`BigInt`
   decode bug that was dropping the column there entirely.
6. `level` — the true, unpromoted/undemoted admin level. Final level-based
   tiebreak for anything (1)–(5) left tied; normally redundant with
   (2)–(4), kept as the honest "ADM0 before ADM1" fallback the original
   spec asked for. Still decides whenever prominence ties (both rows
   missing a population, or carrying the same one), which is pinned by a
   test so the reorder above costs it nothing.
7. `areaKm2` descending, `null`/`undefined` sorted last — the importance
   signal added by the first amendment: among rows tied on (1)–(6), the
   bigger (or more completely attributed) feature wins. A point-only
   locality with no `area_km2` always sorts after one that has it.
8. `nameLength` ascending — "Contra Costa" before "Contra Costa Centre".
9. `nameNorm` ascending, then `featureId` ascending — so the order is
   deterministic and testable.

`viewportRank` (`inside`/`overlap`/`near`/`outside`) is still computed from
`bboxes` exactly as before (`inside` if the feature bbox's centre is in the
viewport, `overlap` if the boxes intersect, `near` if the feature bbox
intersects the viewport scaled by `nearFactor` about its centre, else
`outside`), and still drives the viewport boost folded into `levelAdjusted`
above — but this amendment drops it as a *separate* tiebreak component (it
used to sit between raw `level` and `nameLength`). Nothing in the measured
examples below needed it once `effLevel` and `areaKm2` were added, and a
7-component comparator the amendment already grew to didn't need an 8th.

`score` is a derived `0..1` number for display only; the sort never reads it.

### Amendment, 2026-11-12 — reason: user feedback on the Overture-scale index

**The bug.** A user ("Chris") typed "bag" against the 5.6M-name Overture
names index and got eight identical-looking "Bag · IND · ADM4" rows
(distinct but obscure Indian villages literally named "Bag") crowding out
Baghdad — the obvious intent — which only matches as a `prefix` ("bag" →
"baghdad"), buried below them. Two causes:

1. The pre-amendment comparator put `matchClassRank` *above* `levelAdjusted`:
   `exact` always beat `prefix`/`word-prefix`/`substring`, at any level gap.
   This inverted the original spec's intent ("first list the adm0, then
   adm1, …"): level was supposed to dominate, not match quality.
2. No result diversity: the index legitimately carries eight separate rows
   for eight distinct villages honestly named "Bag". With `matchClassRank`
   dominant, all eight sorted straight to the top, together, with nothing
   to collapse them.

**Why not just flip the order outright (pure level-first, no promotion).**
Tried first. It fixes "bag" (dedupe is what actually matters there, see
below) but breaks "paris": an exact ADM2/ADM3 "Paris, France" sorts *behind*
`prefix`/`word-prefix` noise one level up at ADM1 — "Päris-Soome" (Finnish
for "France"), "Saint Andrew/David/Joseph Parish" (the word "Parish" word-
prefix-matches "paris"). Measured below. Unbounded level-first just trades
one visible bug for another.

**The fix: a *bounded* promotion, one level, not more.** An `exact` match
is allowed to out-rank a `prefix`/`word-prefix`/`substring` match **one
admin level up, never two or more** (component (2) above,
`exactLevelPromotion: 1` by default). This fixes "paris" (a one-level gap)
without inventing a win for an exact ADM4 "Bag"/"Zurich"-style match
against ADM0/ADM1 matches three or four levels away — which is exactly what
*should* lose, per the original "ADM0 first" spec.

**Result diversity is what actually fixes "Bag".** Bounding the promotion
to one level does *not*, by itself, stop the eight India villages from
out-ranking Baghdad: they're all `exact` at the same ADM4 level Baghdad's
`prefix` match sits at, so `matchClassRank` still prefers them there,
correctly. What fixes it is `applyDiversity()`, now run inside `search()`
after sorting (see §3.2's `search()`/dedupe description): collapse rows
identical in `(nameNorm, country, level)` to the single best one (largest
`area_km2`) annotated with `moreCount`, then cap at `maxPerGroup` (default
`3`) rows per `(country, level)`, filling the rest of the requested `limit`
with the next-ranked *distinct* groups. The eight India rows become one
"Bag (+7 more)" row; that alone frees up enough of the result list for
Baghdad (and the Hungarian "Bag", also `exact`, with real `area_km2`) to
appear in it.

**Known residual limitation — measured, accepted, not fixed here.** The
Overture index's ~2.03M alternate-language-name rows (`name_lang`/`alt_of`)
can still crowd a short query's top results with translations of unrelated
countries: Uzbek/Tajik-looking transliterations of "Bahamas" ("Bagam
orollari", "Bagaman Sared") outrank Baghdad for "bag", and Spanish/Chadian/
Dominican country-name translations outrank "San Francisco"/"Santiago" for
"san" — both because they're genuinely shallower admin levels (ADM0) that
no *bounded, 1-level* promotion can reach across.

This was measured precisely, not just suspected: against the live index,
"Baghdad" (`name='Baghdad'`, `country='IRQ'`) sits at raw sorted position
1517 of 5159 "bag" candidates under the pre-amendment comparator, and at
position 579 under this amendment's comparator — a real, ~2.6× improvement
— but the Overture index has **54 distinct `(country, level)` groups at
levels 0–3** that out-rank it for this literal query, which is far more
than any reasonable dropdown shows (even `limit: 30` wouldn't surface it;
the live demo's default `limit: 8` is nowhere close). `area_km2` as the
importance signal actively works against a fix here, too: comparing a
*city* against a *country* by `area_km2` systematically favours the
country (Bahamas: 12,054 km²; the USA alt-name match: 314,927 km²) over
the city (Baghdad: 862 km²) regardless of which one a user actually means
— `area_km2` is a sound tiebreak *within* a level/feature-kind (two
villages, two regions) but a poor proxy for "importance" *across* kinds
(a capital city vs. a country). Properly fixing this would mean weighting
alternate-language names below primary names, or pulling in Overture's
`population`/`prominence` columns — neither the bug report nor this fix's
column-passthrough scope (`parent_name`, `area_km2`, `country_name`)
covers population/prominence — a materially larger change, left for
separate follow-up (**the mechanism for which has now landed — see the
"Ranking-residual follow-up" amendment after the measured-examples table
below; the Overture index itself has not populated `class`/`population`
yet, so "bag"/"san" above are not yet re-measured any differently**). It
does not reproduce against the geoBoundaries index
(no locality level, no alt-name rows at all — confirmed in the measured
table below, where "Baghdad"/"Baghdad Province" lands cleanly at #4) and
is orthogonal to the reported bug (eight *identical* rows for one
feature-shape), which the reordering + dedupe above do fix, verified live
(see §7's Playwright verification note and
`examples/geocoder-demo/screenshot-ranking.png`): the eight-row "Bag"/IND
pile is gone from the Overture demo's "bag" results — there is no longer
any duplicate row at all — even though Baghdad itself still doesn't clear
the ADM0/ADM1 noise within the demo's `limit: 8`. The screenshot shows
that real, measured state honestly rather than a cropped or cherry-picked
one.

**Measured examples.** No viewport; `limit: 8`; top 5 of the live result
shown; "—" = the index has no secondary-context column for that row
(`parentName` for Overture, `countryName` for geoBoundaries). Queried
directly against both running indexes (`http://localhost:8788/names/...`
for Overture, the published geoboundaries-catalog for geoBoundaries) on
2026-11-12.

*bag / Baghdad — Overture (5.6M names, has `parent_name`/`area_km2`)*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | Bagaman Sared | — | BHS · ADM0 | prefix | 12,054 |
| 2 | Bagam orollari | — | BHS · ADM0 | prefix | 12,054 |
| 3 | Bagama Adalary | — | BHS · ADM0 | prefix | 12,054 |
| 4 | Bagraain | — | BHR · ADM0 | prefix | 793 |
| 5 | Papua Bagong Ginea | — | PNG · ADM0 | word-prefix | 462,297 |

The deduped "Bag" row (HUN/IND/BIH/CHN, "+N more") and Baghdad (IRQ, ADM4,
area_km2 862) are both present in the full (undisplayed) result set — dedupe
and the bounded promotion did their job — but still sort below this ADM0
alt-name noise: the residual limitation above, measured honestly rather
than hidden.

*bag / Baghdad — geoBoundaries (CGAZ, ADM0–2 only, no localities, no alt names)*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | Bago | Burma | MMR · ADM1 | prefix | 38,647 |
| 2 | Bagmati | Nepal | NPL · ADM1 | prefix | 20,504 |
| 3 | Baghlan | Afghanistan | AFG · ADM1 | prefix | 17,475 |
| 4 | **Baghdad** | **Iraq** | **IRQ · ADM1** | **prefix** | **862** |
| 5 | Baguirmi | Chad | TCD · ADM2 | prefix | 27,108 |

No alt-name noise on this cleaner, administrative-only index: "Baghdad
Province" lands cleanly at #4 among its ADM1 peers, ordered by area_km2.

*paris — Overture*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | **Paris** | Île-de-France | **FRA · ADM2** | **exact** | **105** |
| 2 | Päris-Soome | Suomi / Finland | FIN · ADM1 | prefix | 10,568 |
| 3 | Saint Andrew Parish | Dominica | DMA · ADM1 | word-prefix | 186 |
| 4 | Saint David Parish | Dominica | DMA · ADM1 | word-prefix | 128 |
| 5 | Saint Joseph Parish | Dominica | DMA · ADM1 | word-prefix | 124 |

Exact "Paris, France" lands at #1, ahead of every ADM1 noise match — the
bounded promotion working exactly as intended (a one-level gap). Under the
unbounded-level-first alternative measured above but not shipped, Paris
drops out of the top 5 entirely in favour of rows 2–5 (plus a 6th: "Fatima
Parish", Macao).

*paris — geoBoundaries*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | **Paris** | France | **FRA · ADM2** | **exact** | **105** |
| 2 | Paris Paris | Egypt | EGY · ADM2 | prefix | 37,535 |
| 3 | Parisi | Brazil | BRA · ADM2 | prefix | 85 |

Only 3 candidates total on this index; the amendment doesn't change the
order here (pre- and post-amendment comparators agree).

*zurich — Overture*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | Zürich | Schweiz/Suisse/Svizzera/Svizra | CHE · ADM1 | exact | 1,729 |
| 2 | Zürich | Zürich | CHE · ADM2 | exact | 92 |
| 3 | Zürich | Zürich | CHE · ADM3 | exact | 92 |
| 4 | Zurich | Súdwest-Fryslân | NLD · ADM4 | exact | 4.7 |
| 5 | Zurich | Rooks County | USA · ADM4 (+2 more) | exact | 0.45 |

Unaffected by the amendment: every candidate is an `exact` match, so raw
`level` alone orders them, same as the pre-amendment comparator.

*zurich — geoBoundaries*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | Zürich | Switzerland | CHE · ADM1 | exact | 1,729 |
| 2 | Zürich | Switzerland | CHE · ADM2 | exact | 93 |

*london — Overture*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | London | Ontario | CAN · ADM2 | exact | 423 |
| 2 | Londonas | Ontario | CAN · ADM2 | prefix | 423 |
| 3 | City of London | England | GBR · ADM2 | word-prefix | 2.5 |
| 4 | London | Monroe County | USA · ADM4 (+18 more) | exact | 94 |
| 5 | London | Kiritimati | KIR · ADM4 (+1 more) | exact | 3.0 |

An improvement, not just a wash: "City of London" (ADM2, the real financial
district) now outranks the flood of random ADM4 villages honestly named
"London" that the pre-amendment matchClass-first order put first regardless
of level or real-world prominence.

*london — geoBoundaries*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | London | Canada | CAN · ADM2 | exact | 7,279 |
| 2 | Londonderry | St Lucia | LCA · ADM2 | prefix | 1.2 |
| 3 | London Road | St Lucia | LCA · ADM2 | prefix | 0.1 |
| 4 | New London | United States | USA · ADM2 | word-prefix | 1,801 |
| 5 | Little London | Jamaica | JAM · ADM2 | word-prefix | 45 |

*san — Overture*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | San | Mali | MLI · ADM1 | exact | 12,893 |
| 2 | Santrafríka | — | CAF · ADM0 | prefix | 618,719 |
| 3 | sangu'e | — | ESP · ADM0 | prefix | 506,120 |
| 4 | Sandominän | — | DOM · ADM0 | prefix | 48,206 |
| 5 | Sāng, cōng shā, bō lín sān duō dìqū | — | XQ · ADM0 | prefix | 1,462 |

The residual limitation at its most visible: four of five rows are
alternate-language country-name translations that happen to prefix-match
"san". "San, Mali" (a real town) survives at #1 only because its bounded
promotion (`exact`, ADM1 → `effLevel` 0) ties it with these ADM0 rows and
the `matchClassRank` tiebreak favours the exact match; "San Francisco"/
"Santiago"-type results don't make positions 2–5 at all. Flagged, not
fixed, per "Known residual limitation" above.

*san — geoBoundaries*

| # | name | context | country · level | match | area_km2 |
|---|---|---|---|---|---|
| 1 | Sanafir & Tiran Is. | — | ADM0 | prefix | 86 |
| 2 | San Marino | San Marino | SMR · ADM0 | prefix | 61 |
| 3 | San | Mali | MLI · ADM2 | exact | 6,090 |
| 4 | Santa Cruz | Bolivia | BOL · ADM1 | prefix | 368,674 |
| 5 | Santa Cruz | Argentina | ARG · ADM1 | prefix | 239,746 |

No alt-name pollution here (geoBoundaries has none), but the two tiny real
ADM0 units still sit ahead of "San, Mali" by the same bounded-promotion
arithmetic as above — accepted as correct, since these are genuine ADM0
countries, not translation noise.

### Amendment, 2026-11-12 — ranking-residual follow-up: `class`/`population`/`alt_of`

The amendment above explicitly deferred two things as "a materially larger
change": weighting alt-name rows below their primary, and pulling in a
real prominence signal (`population`/`class`) instead of `area_km2` for
the across-feature-kind comparisons `area_km2` gets backwards (city vs.
country). This amendment lands the *mechanism* for both — the comparator
extension and the `SearchResult` passthrough — while being explicit about
what it does **not** land: the data. `population` and `class` are
Overture columns that have not been populated on any shipped index yet
(the Overture names index this doc's examples above were measured
against has neither), so every example above is unchanged until a catalog
build actually fills them in. This is intentional: the ranking code is the
long pole (it ships once, in a release), the data is the catalog team's
and can land on its own schedule without another geocoder-core release.

**What changed, normatively** (folded into "The ranking rule,
normatively" above as components (5) and (6)):

- `isAlt` (component 5): at equal level, a primary-name match outranks an
  alt-name match for the same underlying feature. Derived from `alt_of`
  (already shipped, E8) — `isAlt = alt_of != null` on the matched row —
  not from a new column.
- Prominence (component 6): `population` descending when present,
  else a fixed `class` ladder (`city` > `town` > `village` > `hamlet` >
  anything else/absent), slotted ahead of `areaKm2`.
- `SearchResult.class`/`SearchResult.population` (§3.2's interface,
  above): passed through unconditionally, exactly like `areaKm2`/
  `parentName`/`countryName` before them, so a UI can use them directly
  (e.g. a population badge) without geocoder-core needing to change again
  once a catalog populates the columns.

**Why `isAlt` is defined this way rather than "never show an alt-name row
at all."** An alt-name row is still the *correct* answer to a query typed
in that alt name/language — hiding it would regress E8's whole point.
The fix is ordering, not suppression: when a primary- and an alt-name row
for the *same* feature genuinely tie on level/match-class/area today (the
common near-future case once `alt_of` rows multiply), the primary wins
the tiebreak. It does not, and structurally cannot, address the
measured residual limitation itself (an alt-name row for a *different,
unrelated* feature — Bahamas' Uzbek-looking transliteration — outranking
Baghdad): that is a cross-feature comparison the prominence tiebreak
(component 6) targets instead, once `population`/`class` are populated.

**Why prominence is a `[tier, key]` pair rather than always comparing
population, falling back to `-Infinity` on absence (`areaKm2`'s own
pattern).** `areaKm2`'s "missing sorts last" rule works because every
row being compared is the *same kind* of thing (an admin boundary with a
real area). Population/class crosses kinds on purpose: a hamlet's
`class` is real and known even when its `population` genuinely isn't.
Falling back to `-Infinity` on no `population` would make every
classed-but-no-population row (most of them, in practice) sort as if it
had no prominence signal at all, discarding the `class` ladder entirely
for rows that need it most. The two-tier shape keeps a row with a known
`population` always ahead of one without, while still ranking the
no-population majority by their `class` instead of leaving them all
tied.

**Scope, explicitly.** `dedupeByNameCountryLevel`'s own "keep the
biggest" representative-picking rule (§3.2 amendment, "Result
diversity") still compares by `areaKm2` alone — extending it to prefer
population/class too is a reasonable future refinement but is not part
of this follow-up's scope, and changing it changes which *concrete* row
represents a deduped group, a bigger behavioural change than reordering
ties. Left as is.

### Amendment, 2026-11-12 — alt-demotion follow-up: `isAlt` moved ahead of raw `level`

**The live reproduction.** Measured directly against the now-published
`portolan-mirrors/cn-gazetteer-overture` catalog (the demo's `?index=overture`
shortcut): searching "bag" put four alt-language spellings of Bahrain/Bahamas
(ADM0, `alt_of` non-null) in positions 1–4, above Bağcılar/Bagua (ADM2,
primary) and far above Baghdad. The ranking-residual follow-up above had
already added the `isAlt` tiebreak for exactly this kind of case — but
placed it *after* raw `level` (component (5) in that amendment's numbering).
That placement never fires for this bug: an ADM0 alt row's raw level (0) is
less than an ADM1+ row's, so `level` decides the comparison outright and
`isAlt` is never reached. "Alt rows inherit their division's level
privilege" — a country's alt-name translation gets to use that country's
ADM0 level even though, as a *name match*, it's exactly as arbitrary as any
other alt-name hit.

**The fix: a bounded, one-level demotion, mirroring the existing bounded
promotion.** A `prefix`/`word-prefix`/`substring` match against an alt-name
row is now treated as if its `effLevel` sat `altLevelDemotion` (default `1`)
levels *deeper* than its raw level — the exact mirror of how an `exact`
match is already treated as `exactLevelPromotion` levels *shallower*. `isAlt`
moves from component (5) to component (4), ahead of raw `level` — necessary,
not cosmetic: once the demotion ties a level-0 alt row with a level-1
primary at `effLevel` 1, checking raw `level` before `isAlt` would
immediately re-open the exact 1-level gap the demotion just closed, and the
alt row would win anyway on the old component (4). **An `exact` match
against an alt-name row is exempt from the demotion** (gets the normal
exact-match *promotion* instead): typing the full alt name in another
language — "Deutschland", "中国" — is a deliberate, high-confidence query,
and demoting it would be exactly backwards from what alt names exist for.

**Why bounded to one level, not more.** Identical reasoning to
`exactLevelPromotion`'s bound (see the first amendment): a one-level
demotion fixes a level-0-alt-vs-level-1-primary tie (closes exactly the gap
the live "bag" reproduction's `isAlt`-never-reached bug exposed) without
manufacturing a win for a level-4 primary four levels away — see "Known
residual limitation", revised below, for the honest, measured result of
that bound on "bag" specifically.

**A second, independent improvement, measured along the way: prominence is
no longer a no-op.** The ranking-residual follow-up above shipped
`population`/`class` as pending columns, unpopulated on every index at the
time. The published Overture catalog now populates both on a real fraction
of rows — confirmed live: Baghdad's city row carries `population: 7216040`,
`class: 'city'`; Bahrain's alt-name row carries `population: 1234571`. This
is not something this amendment's code changed (component (6) above was
already correctly wired), but it means component (6) now actually decides
real comparisons for the first time, and several of the measured
improvements below (the "London" case especially) come from prominence
alone, not from the alt-demotion fix. Both effects are measured together
below because they ship in the same catalog refresh and the tables are the
honest state of the live system either way.

> **Corrected 2026-11-12 by the population-promotion follow-up below.**
> "Prominence is no longer a no-op" was true of Overture, whose
> `population` column is 32-bit and decodes as a plain `number`, and
> **false of Who's On First**, which types the column as parquet `INT64`:
> hyparquet decodes that as a `BigInt`, every `typeof x === 'number'` guard
> rejected it, and prominence stayed a measured no-op on the index that
> populates the column most widely. Read this paragraph as "on Overture"
> and see the population-promotion amendment for the decode fix.

**Measured, live, against `?index=overture`** (the demo's default MapLibre
viewport — Northern California — is active for every query below, since
that's what a real user of this demo sees; the one case it visibly matters,
"london", is called out):

*"bag"* — top 8, unchanged in kind from the first amendment's table (the
residual limitation below is still live), but with a concrete improvement
inside it: Bağcılar (a real İstanbul district, ADM2, primary) and Bagua (a
real Peruvian province, ADM2, primary) now appear in positions 5–6, where
before this amendment they were crowded out by more ADM1 alt-noise
(Myanmar's "Bago" translations). The demotion is doing real work here; it
just isn't enough, alone, to clear four levels of gap down to Baghdad.

| # | name | context | country · level | note |
|---|---|---|---|---|
| 1 | Bagraain | — | BHR · ADM0 | alt (Bahrain) |
| 2 | Bagaman Sared | — | BHS · ADM0 | alt (Bahamas) |
| 3 | Bagam orollari | — | BHS · ADM0 | alt (Bahamas) |
| 4 | Bagama Adalary | — | BHS · ADM0 | alt (Bahamas) |
| 5 | Bağcılar | İstanbul | TUR · ADM2 | primary |
| 6 | Bagua | Amazonas | PER · ADM2 | primary |
| 7 | Baguirmi | Chari-Baguirmi | TCD · ADM2 | primary |
| 8 | Bagata | Kwilu | COD · ADM2 | primary |

Measured precisely, not just eyeballed: "Baghdad" (`name='Baghdad'`,
`country='IRQ'`, `class='city'`, `population=7216040`) is a level-4 alt row
(its primary name is Arabic) — a **4-level** gap from ADM0, outside the
1-level bound by design. "Baghdad Governorate" (`country='IRQ'`, level 1,
alt) is only a **1-level** gap and *is* reachable: it now lands at position
37 of 413 in the fully diversified result list (capped to 3 of its ~33
language-spelling variants by the existing `(country, level)` cap) — a real
improvement in absolute terms (previously un-findable; its raw sorted
position pre-this-amendment, uncapped, was 579 of 5159), but still well
outside `limit: 8`. See "Known residual limitation" below.

*"deutschland"* — exact alt match for the country itself wins outright,
confirming the exemption:

| # | name | country · level | note |
|---|---|---|---|
| 1 | Deutschland | DEU · ADM0 | **exact**, alt (German endonym) |
| 2 | Deutschlandsberg | AUT · ADM4 | prefix, primary (an unrelated Austrian town) |

*"zhongguo"* (pinyin) and *"中国"* (hanzi) — exact alt match for China wins
outright in both scripts:

| # | name | country · level | note |
|---|---|---|---|
| 1 | Zhōngguó | CHN · ADM0 | **exact**, alt |
| 2 | Zhongguo | CHN · ADM4 (+2 more) | exact, alt (unrelated villages, same romanized spelling) |
| 3 | Zhongguocun | CHN · ADM4 (+1 more) | prefix, alt |
| 4 | Zhongguojiangcun | CHN · ADM4 | prefix, alt |

| # | name | country · level |
|---|---|---|
| 1 | 中国 | CHN · ADM0 — **exact**, alt |
| 2–5 | 中国集村 / 中国热带农业科学院试验场七队 / 九队 / 中国城 | CHN/RUS · ADM4, unrelated villages that happen to prefix-match |

*"bahamas"* — exact alt match wins, ahead of even the primary "The Bahamas"
(a `word-prefix` match, since the primary name has the article):

| # | name | country · level | note |
|---|---|---|---|
| 1 | Bahamas | BHS · ADM0 | **exact**, alt (the plain English name is stored as alt; the primary is "The Bahamas") |
| 2 | Bahâmasa | BHS · ADM0 | prefix, alt |
| 3 | Bahamasi | BHS · ADM0 | prefix, alt |

*"paris"* — no regression from the first amendment's table; exact "Paris,
France" still wins outright, now ahead of even more ADM1/ADM2 noise than
before since prominence is live:

| # | name | context | country · level |
|---|---|---|---|
| 1 | Paris | Île-de-France | **FRA · ADM2** |
| 2 | Paris | Paris | FRA · ADM3 |
| 3 | Paris Paris | الوادي الجديد | EGY · ADM2 |
| 4 | Päris-Soome | Suomi / Finland | FIN · ADM1 |
| 5 | Paris | Paris (+3 more) | FRA · ADM4 |
| 6 | Paris | Howard County (+26 more) | USA · ADM4 |

*"london"* — no regression; exact "London" (Ontario) still wins outright at
ADM2. One instructive, *intentional* interaction with the demo's own
viewport boost, not this amendment: with no viewport, "London" (Westminster,
GBR, `population: 8908083`) is the clear #2 by prominence, ahead of every
same-named US town. With the demo's default Northern-California viewport
active, "London, Tulare County, California" (a real place inside that
viewport) gets `viewportBoost`ed ahead of it instead — the system correctly
prioritizing what's literally on the user's screen, the documented, intended
purpose of the viewport boost (§3.2, component (1)), confirmed by replaying
the same query through `search()` with and without a `viewport` option and
observing exactly that one row's position change. Not a ranking-residual or
alt-demotion effect; noted here only so a future reader comparing this
table against a live run with a different map centre doesn't mistake it for
one.

| # | name | context | country · level | note |
|---|---|---|---|---|
| 1 | London | Ontario | **CAN · ADM2** | exact |
| 2 | London | Tulare County (+18 more) | USA · ADM4 | exact, **viewport-boosted** (demo's default view) |
| 3 | London | Westminster | GBR · ADM4 | exact, `population: 8908083` — ranks #2 with no viewport active |
| 4 | London | London | CAN · ADM4 | exact, `population: 422324` |

**Known residual limitation — revised.** The first amendment's residual
limitation ("bag"/"san" still don't surface Baghdad/San Francisco within
`limit: 8`) is now *measurably smaller*, not closed: Baghdad's best
1-level-gap candidate (the governorate) moved from un-findable to position
37 of 413; Bağcılar/Bagua (real ADM2 primaries) now clear the Bahrain/
Bahamas ADM0 noise entirely, which they didn't before. What remains
unreachable is Baghdad's own best-known (city, English-language) match — a
4-level gap no *bounded* demotion closes, by design, for the same reason
the exact-match promotion is bounded: an unbounded version would simply
reintroduce a different false win (here, an alt-name city match beating a
primary country name it has no real claim to outrank). Closing the
remaining gap needs the same thing the first amendment already named:
weighting by `population`/`prominence` *across* the level hierarchy itself,
not just as a same-level tiebreak — out of scope for a bounded,
one-level-at-a-time fix. `new Geocoder({ ranking: { altLevelDemotion: 0 } })`
restores the pre-amendment ordering exactly, for a caller that needs to A/B
the two.

### Amendment, 2026-11-12 — UX-polish geocoder-core follow-up

Four small, independent follow-ups from the UX-polish pass, in geocoder-core
(the maplibre/openlayers adapters' consuming side is in
`combobox-helpers.js`/`geocoder-control.js` in each package).

**1. `primaryName` on alt matches.** `SearchResult.primaryName` (above):
present only when the match was against an alt-name row, resolved honestly
from data already loaded for the query -- the whole index in full-load
mode, or just this query's own fetched row(s) in range mode -- never a
dedicated network round trip per result. See `SearchResult.primaryName`'s
doc comment above for the two sources and when each one can/can't resolve.

**2. Expandable "+N more".** `SearchResult.collapsed` (above): the rows
`applyDiversity`'s dedupe step collapses were previously discarded outright
once counted into `moreCount`; up to `MAX_COLLAPSED_ROWS` (10) of them are
now kept, reduced to the minimal fields (`name`/`featureId`/`level`) a UI
needs to render and select one directly. `moreCount` itself stays uncapped.

**3. Attribution normalization.** Every manifest shipped so far declares
`share_alike` (snake_case); this doc's `AreaAttribution` has always declared
`shareAlike` (camelCase). `Geocoder`'s manifest ingestion now normalizes to
the documented shape on load, accepting either spelling, keeping the raw
entry alongside it (see `AreaAttribution.shareAlike`'s doc comment above).
Both adapters already defended against either spelling at the point they
read it; that defense is now redundant, not removed.

**4. Range-mode query latency.** Measured live against the published
5.6M-row Overture index (876 row groups, 6400 rows each; `searchRangeIndex`'s
own doc comment in geocoder-core has the full writeup): the range path
fetched its candidate row groups **sequentially**, one `await` at a time.
Per-group latency is dominated by the HTTP round trip (~1.1-1.7s observed
live, essentially flat regardless of row count per group -- decode time is
not the bottleneck), so a low-selectivity prefix spanning many candidate
groups paid that cost once *per group*. Fixed two ways: **bounded-concurrency
fetches** (5 at a time by default, `searchRangeIndex`'s own worker-pool
pattern, same shape as `geometry-resolver.js`'s `firstMatch` minus its
"stop on first hit" exit -- every candidate group here can hold real
matches), and a **documented cap** (24 candidate groups by default; beyond
that, only the first 24 by sort order are fetched at all, and the result is
marked `truncated: true` -- see `SearchResult`'s "range-mode progressive
search" note above). `Geocoder#search()`'s own promise now resolves as soon
as the first concurrency-sized batch is in, instead of waiting for every
candidate group, with the rest streamed in via a further `'results'` event
once complete (reusing the two-wave mechanism's exact grows-only
re-emission rule, not a new wave type).

Measured before/after, same four queries, live against the published
index (`node --test`-free, real network, real locally-pinned hyparquet --
see the follow-up's profiling scripts; numbers vary run to run with live
network conditions, typically by less than 2x, but the relative improvement
below was consistently reproduced across multiple independent runs):

| Query | Candidate groups | Before (sequential, one emission) | After: `search()` resolves (first wave) | After: fully in (background completion wave) |
|---|---|---|---|---|
| "san jo" | 1 | ~1.7s | ~1.7s (unaffected: concurrency only helps >1 group) | n/a — one group, one wave |
| "san" | 10 | ~6.4-11.7s | ~1.7-2.1s | ~3.2-3.5s |
| "a" | 37 (capped to 24) | ~34-44s (uncapped — fetched all 37) | ~1.7-2.0s, `truncated: true` immediately | ~6.2-7.2s, 24 of 37 groups, `truncated: true` |
| "zur" | 1 | ~0.4-1.6s | ~0.5-1.8s (unaffected, same reason as "san jo") | n/a — one group, one wave |

The two single-group queries are included to show the fix is a genuine
no-op for them (concurrency/capping only engage once a query's candidate
set exceeds the batch/cap size) -- their own run-to-run spread is ordinary
live-network variance for one HTTP range request, not anything this task
changed. The real win is "san" (sequential total cut by roughly 3-5x) and
especially "a" (sequential total cut by roughly 6-20x, *and* now bounded no
matter how unselective a prefix gets -- a single-character or CJK query
that matched hundreds of row groups would previously have had no ceiling
at all).

Usage:

```js
import { Geocoder } from 'https://cdn.jsdelivr.net/npm/@cngeo/geocoder-core@0.1.0/dist/geocoder-core.cdn.js';

const geocoder = new Geocoder();                   // default published index
input.addEventListener('focus', () => geocoder.load(), { once: true });
input.addEventListener('input', async () => {
  const results = await geocoder.search(input.value, { viewport: map.getBounds().toArray().flat() });
  renderList(results);
});
async function onPick(result) {
  const area = await geocoder.select(result);      // → Area
  areaLayer.setArea(area);
}
```

### Amendment, 2026-11-12 — population-promotion follow-up: "the Brooklyn case"

**The live reproduction.** Measured directly against the Who's On First
names index (9,478,779 rows — 5,405,294 primary, 4,073,485 alt — across
levels 0–5, served locally pending its `source.coop` repo; the demo's
`?index=wof` shortcut): searching "brooklyn" returned **no Brooklyn** at
all in the top 8. Positions 1–2 were `localadmin` townships (level 3) in
Ohio and New South Wales; positions 3–8 were localities named Brooklyn in
Australia, Canada, Jamaica, New Zealand and South Africa. Brooklyn the New
York borough — level 4, `placetype` `borough`, population 2,504,700, very
much present in the index — appeared nowhere. `compareRanked` component
(1) decided the whole list on level before any prominence tiebreak was
reached, exactly as the previous amendment's "Known residual limitation"
predicted it would for any case needing prominence to beat level.

This amendment turns out to involve **two independent defects**, and both
had to be fixed for the case to come out right. They are separated below
because the first one is a decode bug that silently disabled an entire
already-shipped comparator component, and is worth knowing about on its
own.

#### Defect (i): `population` was never decoded on WOF at all

The WOF names index types `population` as parquet **`INT64`**, and
`hyparquet` decodes `INT64` as a JavaScript **`BigInt`**. Both
`geocoder.js` and `ranking.js` guarded the column with `typeof x ===
'number'`, so every WOF row arrived at `rankRow` with `population:
undefined`. Measured: of the 109 candidate rows for "brooklyn", **zero**
reported a population through `SearchResult.population`, while 4,075 of
the 12,800 rows in the Parquet row group holding them carry one (p50 682,
p90 13,813, p99 1,019,022, max 2,504,700 — the borough). The previous
amendment's claim that prominence "now actually decides real comparisons
for the first time" was true of Overture, whose `population` column is
32-bit and decodes as a plain `number`, and false of WOF — the one index
that populates the column most widely. Fixed at the `geocoder.js`
boundary (a shared `toFiniteNumber` helper, landed by the JSON-safety
follow-up, which also covers `geometry_ref.row`), with a belt-and-braces
`toPopulation` guard inside `rankRow` for direct callers.

**Correction to the record.** The doc comments in `ranking.js` claiming
`class` and `population` were "pending data columns — not yet populated on
any shipped index" were stale in three places (the `CLASS_RANK` preamble,
`prominenceKey`'s doc comment, and component (6) of `compareRanked`'s
list) and have been corrected. The live state: the published Overture
divisions index populates **both** columns; the WOF names index populates
`population` on roughly a third of its rows and carries **no `class`
column at all**; a geoBoundaries CGAZ index still carries neither, so the
genuine no-op path is still a shipped configuration and is still pinned by
a test.

#### Defect (ii): fixing the decode is not enough — measured

With `population` decoding correctly and the comparator otherwise
untouched, "brooklyn" is **unchanged in kind**: the borough still does not
appear in the top 8. Prominence is component (6); components (1) and (2)
(`levelAdjusted`, `effLevel`) put a level-3 township ahead of a level-4
borough and the comparison ends there.

*"brooklyn" — decode fixed, no population promotion (level 3 still wins):*

| # | name · parent | level | effLevel | matchClass | population | country |
|---|---|---|---|---|---|---|
| 1 | Brooklyn (+6 more) · Cuyahoga | 3 | 2 | exact | 11,022 | USA |
| 2 | Brooklyn (+2 more) · Hornsby | 3 | 2 | exact | — | AUS |
| 3 | Brooklyn (+30 more) · Brooklyn | 4 | 3 | exact | 943 | USA |
| 4 | Brooklyn (+3 more) · Brooklyn | 4 | 3 | exact | — | AUS |
| 5 | Brooklyn (+5 more) · Kings | 4 | 3 | exact | — | CAN |
| 6 | Brooklyn (+1 more) · Wellington | 4 | 3 | exact | 3,855 | NZL |
| 7 | Brooklyn · Saint Mary | 4 | 3 | exact | — | JAM |
| 8 | Brooklyn (+1 more) · uMlalazi | 4 | 3 | exact | — | ZAF |

#### The fix: a third bounded `effLevel` adjustment, plus one reordering

**A bounded, one-level population promotion.** A row whose `population`
is at or above `populationPromotionThreshold` (default **`100_000`**, see
the sweep below) is treated as if its `effLevel` sat
`populationLevelPromotion` (default `1`) levels *shallower* than its raw
level — the exact shape of the two adjustments that already exist
(`exactLevelPromotion`, `altLevelDemotion`), and bounded for the identical
reason. A 2.5-million-person level-4 borough is treated as a level 3,
never as a level 0: `effLevel = max(0, level − exactPromotion +
altDemotion − populationPromotion)`.

**Deliberately not restricted to primary rows.** Brooklyn's
English-language WOF row *is* an alt row (`alt_of` non-null; its primary
name is another variant), and so is Baghdad's on Overture. A `!isAlt` gate
would have left both target cases exactly where they started.

**One gate, chosen by measurement: a row that took the alt demotion does
not also take the population promotion.** The two are the same magnitude
and would exactly cancel, handing a non-exact alt-name match back the
level privilege the alt demotion exists to remove — on the strength of
the population of the division whose name it merely transliterates.
Measured both ways:

| case | ungated | gated (shipped) |
|---|---|---|
| "paris" (WOF) | three Jamaican ADM1 alt rows ("Parish of Saint Catherine" 516,218; "Parish of Manchester" 189,797; "Parish of Saint James" 183,811) have their demotion cancelled, reach `effLevel` 1 and take positions **3–5**, pushing the `exact` "Paris, Paris, FRA" row (2,138,551) down to 6 | the parishes fall to **6–8**; positions 1–4 are all genuine Paris rows |
| "bag" (Overture) | "Bagraain" (alt spelling of Bahrain, ADM0, 1,234,571) has its demotion cancelled and **keeps position 1** — re-opening the exact bug the alt-demotion amendment closed | position 1 becomes Bağcılar (TUR ADM2, **primary**, 719,071) |

A `prefix` hit on a Jamaican parish out-ranking an `exact` hit on Paris is
plainly the wrong answer, and re-opening the "bag" bug one amendment after
closing it would be worse. Brooklyn and Baghdad are untouched by the gate:
their rows are alt rows but `exact` matches, so `isExact` already exempted
them from the demotion and the gate is open for them.

**Prominence moves from component (6) to component (5), ahead of raw
`level`.** This is necessary, not cosmetic, and is structurally identical
to the alt-demotion amendment's reason for moving `isAlt` ahead of raw
`level` one amendment earlier. Once the promotion brings the borough to
`effLevel` 2 alongside the townships, components (2), (3) and (4) all tie
too — every row in the "brooklyn" candidate set is an `exact`, alt-name
match — and the *old* component (5), raw `level`, is still 3 vs. 4. It
would immediately re-open the one-level gap the promotion had just closed,
and the township would win anyway. **Any adjustment whose purpose is to
manufacture a tie must have that tie resolved before raw `level` is
consulted.** Raw `level` keeps its job as the final level-based tiebreak;
it only loses priority, and a test pins that it still decides when
prominence ties.

The revised normative order is therefore: (1) `levelAdjusted`, (2)
`effLevel`, (3) `matchClass`, (4) `isAlt`, (5) **prominence**, (6) raw
`level`, (7) `areaKm2`, (8) `nameLength`, (9) `nameNorm`/`featureId`.

#### The threshold sweep — chosen from measurement, not taste

Five thresholds, same script, same eight query/index pairs. What each one
did:

| threshold | "brooklyn" (the target) | elsewhere |
|---|---|---|
| `10_000` | **breaks it.** Brooklyn, Ohio (level 3, 11,022) clears the threshold too, promotes to `effLevel` 1 and takes position 1 *from* the borough, which lands at 2. Brooklyn Park (75,781) and Brooklyn Center (30,104) — `prefix` matches, not even `exact` — take positions 4–5 | WOF p90 is ~13.8k, so a 10k threshold promotes roughly a tenth of every populated row and discriminates nothing |
| `50_000` | fixed (borough at 1), but Brooklyn Park, Minnesota (75,781) promotes to `effLevel` 2 and takes position 4 as a mere `prefix` match, pushing an `exact` "Brooklyn" (uMlalazi, ZAF) out of the top 8 | slightly **better** "bag": Bagua, Peru (95,858) clears 50k and rises 6 → 2. One extra parish (Saint George, VCT, 51,400) on "paris" |
| **`100_000`** | **shipped.** Fixed, with no `prefix`-over-`exact` inversion anywhere in the eight measured pairs | best measured "springfield": Springfield, Massachusetts (153,672) at 1 and Springfield, Missouri (171,589) at 2 |
| `250_000` | fixed | identical to `100_000` on seven of eight pairs, but drops Springfield, Missouri from position 2 to **6** |
| `1_000_000` | fixed (2.5M), and "baghdad" still fixed (7.2M) | loses Springfield, Missouri the same way *and* London, Ontario (346,765, position 3 at `100_000` → position 6). Cleanest "paris" of the five, the one argument in its favour |

`100_000` is where the two measured failure modes meet: below it,
`prefix`-matched mid-size towns start out-ranking `exact` matches on the
queried name; above it, genuinely large cities (Springfield MO, London ON)
stop being reachable. It is **not** a plateau — every neighbouring value
measurably changes something — so it is a real choice between measured
costs, not a round number picked for looks.

#### Measured, live, before and after — all eight query/index pairs

No viewport is active in any table below (these were replayed through
`search()` in Node, not through the demo's MapLibre view), so none of the
viewport-boost effects the previous amendment called out apply here.
`effLevel` is shown because it is what changed.

**WOF — `brooklyn`** (the target case). Before: no Brooklyn borough
anywhere. After: position 1.

| # | before | after |
|---|---|---|
| 1 | Brooklyn · Hornsby — AUS L3, eff 2, exact, alt, pop — | **Brooklyn · New York (+30 more) — USA L4, eff 2, exact, alt, pop 2,504,700** |
| 2 | Brooklyn · Dane (+6 more) — USA L3, eff 2, exact, alt, pop — | Brooklyn · Cuyahoga (+6 more) — USA L3, eff 2, exact, alt, pop 11,022 |
| 3 | Brooklyn · Brooklyn (+3 more) — AUS L4, eff 3, exact | Brooklyn · Hornsby (+2 more) — AUS L3, eff 2, exact, alt, pop — |
| 4 | Brooklyn · Brooklyn Township (+30 more) — USA L4, eff 3, exact | Brooklyn · Brooklyn (+3 more) — AUS L4, eff 3, exact |
| 5 | Brooklyn · Kings (+5 more) — CAN L4, eff 3, exact | Brooklyn · Kings (+5 more) — CAN L4, eff 3, exact |
| 6 | Brooklyn · Tasman District (+1 more) — NZL L4, eff 3, exact, alt | Brooklyn · Wellington (+1 more) — NZL L4, eff 3, exact, alt, pop 3,855 |
| 7 | Brooklyn · Saint Mary — JAM L4, eff 3, exact, alt | Brooklyn · Saint Mary — JAM L4, eff 3, exact, alt |
| 8 | Brooklyn · uMlalazi (+1 more) — ZAF L4, eff 3, exact, alt | Brooklyn · uMlalazi (+1 more) — ZAF L4, eff 3, exact, alt |

Note positions 2 and 6 in the "after" column: the decode fix alone makes
the comparator prefer, among otherwise-tied rows, the one that at least
*has* a population (Cuyahoga over Dane, Wellington over Tasman District) —
a small independent improvement from defect (i), visible even where the
promotion does not fire.

**WOF — `springfield`** (the classic ambiguous case). Before, the ordering
among the level-3 rows was decided by `nameNorm`/`featureId`, i.e.
arbitrarily. After, the two genuinely large Springfields are 1–2.

| # | before | after |
|---|---|---|
| 1 | Springfield · Gosford (+4 more) — AUS L3, eff 2, exact, alt, pop — | **Springfield · Hampden (+14 more) — USA L3, eff 1, exact, alt, pop 153,672** (Springfield, Massachusetts) |
| 2 | Springfield · Chelmsford — GBR L3, eff 2, exact, alt, pop — | **Springfield · Springfield Township (+92 more) — USA L4, eff 2, exact, alt, pop 171,589** (Springfield, Missouri) |
| 3 | Springfield · Penobscot (+14 more) — USA L3, eff 2, exact, alt | Springfield · Division No. 12 — CAN L3, eff 2, exact, alt, pop 0 |
| 4 | Springfield · Division No. 12 — CAN L3, eff 2, exact, alt | Springfield · Gosford (+4 more) — AUS L3, eff 2, exact, alt, pop — |
| 5 | Springfield · Fife (+2 more) — GBR L4, eff 3, exact | Springfield · Chelmsford — GBR L3, eff 2, exact, alt, pop — |
| 6 | Springfield · Lane (+92 more) — USA L4, eff 3, exact, alt | Springfield Township · Greene (+33 more) — USA L3, eff 2, prefix, pop 159,496 |
| 7 | Springfield · Division No. 12 (+5 more) — CAN L4, eff 3, exact, alt | Springfield · Fife (+2 more) — GBR L4, eff 3, exact, pop 960 |
| 8 | Springfield · Selwyn District (+2 more) — NZL L4, eff 3, exact, alt | Springfield · Division No. 12 (+5 more) — CAN L4, eff 3, exact, alt |

Springfield MA (153,672) ranks above Springfield MO (171,589) despite the
smaller population, because MA's row is level 3 and MO's is level 4: level
still dominates *within* the one-level bound, which is the bounded design
working as specified, not an ordering accident. `population: 0` at
position 3 is a real stored value in WOF, not a missing one, and is
treated as such (tier 0, population 0) rather than being falsified to
"absent".

**WOF — `paris`** (must not regress). It improves: "Paris, Paris, FRA"
(2,138,551) newly appears, at position 3.

| # | before | after |
|---|---|---|
| 1 | Paris · Ile-of-France — FRA L1, eff 0, exact, alt | Paris · Ile-of-France — FRA L1, eff 0, exact, alt, pop 2,117,702 |
| 2 | Paris (+1 more) — FRA L3, eff 2, exact, alt | Paris (+1 more) — FRA L3, eff 1, exact, alt, pop 2,257,981 |
| 3 | Paris · Oxford (+3 more) — USA L3, eff 2, exact, alt | **Paris · Paris — FRA L4, eff 2, exact, alt, pop 2,138,551** |
| 4 | Pariser Linie · Ancenis — FRA L2, eff 2, prefix | Paris · Oxford (+3 more) — USA L3, eff 2, exact, alt, pop 5,367 |
| 5 | Parish of Portland · Jamaica — JAM L1, eff 2, prefix, alt | Pariser Linie · Ancenis — FRA L2, eff 2, prefix, pop — |
| 6 | Parish of Saint Ann · Jamaica — JAM L1, eff 2, prefix, alt | Parish of Saint Catherine · Jamaica — JAM L1, eff 2, prefix, alt, pop 516,218 |
| 7 | Parish of Manchester · Jamaica — JAM L1, eff 2, prefix, alt | Parish of Manchester · Jamaica — JAM L1, eff 2, prefix, alt, pop 189,797 |
| 8 | Parish of Saint John · Antigua and Barbuda — ATG L1, eff 2, prefix, alt | Parish of Saint James · Jamaica — JAM L1, eff 2, prefix, alt, pop 183,811 |

The Jamaican parishes still occupy 6–8 (they are `prefix` matches at
`effLevel` 2 either way — the gate keeps them there), but they are now
ordered by population instead of alphabetically, and they no longer crowd
out a real Paris row.

**WOF — `london`** (must not regress). It improves substantially: London
(Westminster, GBR, 7,556,900) moves from position 7 to 2, and London,
Ontario (346,765) from 6 to 3.

| # | before | after |
|---|---|---|
| 1 | London · England — GBR L1, eff 0, exact, alt | London · England — GBR L1, eff 0, exact, alt, pop 7,556,900 |
| 2 | London · Madison — USA L3, eff 2, exact, alt | **London — GBR L4, eff 2, exact, alt, pop 7,556,900** |
| 3 | Londonderry · Causeway Coast and Glens — GBR L2, eff 2, prefix | **London · Middlesex — CAN L4, eff 2, exact, alt, pop 346,765** |
| 4 | Londonderry Borough · Derry City and Strabane — GBR L2, eff 2, prefix | London · Madison — USA L3, eff 2, exact, alt, pop 10,533 |
| 5 | London · London (+17 more) — USA L4, eff 3, exact, alt | London Borough of Barnet — GBR L3, eff 2, prefix, pop 386,083 |
| 6 | London · Middlesex — CAN L4, eff 3, exact, alt | London Borough of Croydon — GBR L3, eff 2, prefix, pop 382,304 |
| 7 | London — GBR L4, eff 3, exact, alt | London Borough of Newham — GBR L3, eff 2, prefix, pop 340,978 |
| 8 | London · Bushbuckridge (+2 more) — ZAF L4, eff 3, exact, alt | Londonderry · Causeway Coast and Glens — GBR L2, eff 2, prefix, pop — |

The three "London Borough of …" rows at 5–7 are the honest cost of the
threshold here: they are real level-3 London boroughs of 340k–386k people,
`prefix` matches on "london", promoted to `effLevel` 2. They sit *below*
every `exact` match at the same `effLevel` (component (3) still decides
that), so they displace only lower-ranked noise, not answers.

**WOF — `san francisco`** (must not regress). Unchanged in kind;
San Francisco, California holds position 1 (now at `effLevel` 0 rather
than 1), and the same-named Latin-American ADM2s behind it are now ordered
by population instead of by `nameNorm`.

| # | before | after |
|---|---|---|
| 1 | San Francisco · California — USA L2, eff 1, exact, alt | San Francisco · California — USA L2, eff 0, exact, alt, pop 808,988 |
| 2 | San Francisco · Zulia (+1 more) — VEN L2, eff 1, exact, alt | San Francisco · Zulia (+1 more) — VEN L2, eff 1, exact, alt, pop 11,030 |
| 3 | San Francisco · Agusan del Sur (+3 more) — PHL L2, eff 1, exact, alt | San Francisco · Atlántida (+2 more) — HND L2, eff 1, exact, alt, pop 10,683 |
| 4 | San Francisco · Antioquia (+2 more) — COL L2, eff 1, exact, alt | San Francisco · Veraguas — PAN L2, eff 1, exact, alt, pop 9,881 |
| 5 | San Francisco · Veraguas — PAN L2, eff 1, exact, alt | San Francisco · Petén — GTM L2, eff 1, exact, alt, pop 8,917 |
| 6 | San Francisco · Petén — GTM L2, eff 1, exact, alt | San Francisco · Agusan del Sur (+3 more) — PHL L2, eff 1, exact, alt, pop — |
| 7 | San Francisco · Ocotepeque (+2 more) — HND L2, eff 1, exact, alt | San Francisco · Antioquia (+2 more) — COL L2, eff 1, exact, alt, pop — |
| 8 | San Francisco · San Francisco — VEN L3, eff 2, exact, alt | San Francisco · San Francisco (+3 more) — USA L4, eff 2, exact, alt, pop 808,988 |

The first amendment's residual limitation for "san" (San Francisco not
reachable from a short prefix) is **not** addressed here and is unchanged:
this amendment only moves rows by one level, and that case needs more.

**Overture — `bag`** (must not regress the alt-demotion tables). The
previous amendment's table is reproduced exactly as the before-baseline.
It improves: Bağcılar clears all four Bahrain/Bahamas ADM0 alt rows.

| # | before (reproduces the alt-demotion amendment's table) | after |
|---|---|---|
| 1 | Bagraain — BHR L0, eff 1, prefix, alt, pop 1,234,571 | **Bağcılar · İstanbul — TUR L2, eff 1, prefix, primary, pop 719,071** |
| 2 | Bagaman Sared — BHS L0, eff 1, prefix, alt | Bagraain — BHR L0, eff 1, prefix, alt, pop 1,234,571 |
| 3 | Bagam orollari — BHS L0, eff 1, prefix, alt | Bagaman Sared — BHS L0, eff 1, prefix, alt |
| 4 | Bagama Adalary — BHS L0, eff 1, prefix, alt | Bagam orollari — BHS L0, eff 1, prefix, alt |
| 5 | Bağcılar · İstanbul — TUR L2, eff 2, prefix, primary | Bagama Adalary — BHS L0, eff 1, prefix, alt |
| 6 | Bagua · Amazonas — PER L2, eff 2, prefix, primary | Bagua · Amazonas — PER L2, eff 2, prefix, primary, pop 95,858 |
| 7 | Baguirmi · Chari-Baguirmi — TCD L2, eff 2, prefix, primary | Baguirmi · Chari-Baguirmi — TCD L2, eff 2, prefix, primary |
| 8 | Bagata · Kwilu — COD L2, eff 2, prefix, primary | Bagata · Kwilu — COD L2, eff 2, prefix, primary |

No row moves down except by being overtaken; nothing is demoted that was
not demoted before. Bağcılar at 1 is the improvement the alt-demotion
amendment explicitly wanted and measured itself unable to reach ("the
demotion is doing real work here; it just isn't enough, alone"). Bagua
(95,858) sits just under the 100,000 threshold and stays at 6; at a 50,000
threshold it rises to 2, which is the one measured argument for the lower
value.

**Overture — `baghdad`** (must not regress the alt-demotion tables). This
is the headline result: **Baghdad the city moves from position 7 to
position 1.**

| # | before | after |
|---|---|---|
| 1 | Baghdad Séng · العراق — IRQ L1, eff 2, prefix, alt | **Baghdad · محافظة بغداد — IRQ L4, eff 2, exact, alt, pop 7,216,040** |
| 2 | Baghdad Province · العراق — IRQ L1, eff 2, prefix, alt | Baghdad Séng · العراق — IRQ L1, eff 2, prefix, alt |
| 3 | Baghdad (gobernador) · العراق — IRQ L1, eff 2, prefix, alt | Baghdad Province · العراق — IRQ L1, eff 2, prefix, alt |
| 4 | Baghdad · Baardheere — SOM L4, eff 3, exact, primary | Baghdad (gobernador) · العراق — IRQ L1, eff 2, prefix, alt |
| 5 | Baghdad · Blantyre — MWI L4, eff 3, exact, primary | Baghdad · Baardheere — SOM L4, eff 3, exact, primary |
| 6 | Baghdad · Basseknou (+1 more) — MRT L4, eff 3, exact, primary | Baghdad · Blantyre — MWI L4, eff 3, exact, primary |
| 7 | **Baghdad · محافظة بغداد — IRQ L4, eff 3, exact, alt, pop 7,216,040** | Baghdad · Basseknou (+1 more) — MRT L4, eff 3, exact, primary |
| 8 | Baghdad · مديرية خب والشعف (+1 more) — YEM L4, eff 3, exact, alt, pop 537 | Baghdad · مديرية خب والشعف (+1 more) — YEM L4, eff 3, exact, alt, pop 537 |

The promotion takes Baghdad's city row from `effLevel` 3 to 2, tying the
three Iraqi ADM1 alt rows, and component (3) (`matchClass`) then resolves
the tie in favour of the `exact` match over their `prefix` matches. Note
how little work this needed once the mechanism existed: a one-level
promotion plus a tie resolved by an existing component.

#### Known residual limitation — revised again

The first amendment's residual ("bag"/"san" don't surface
Baghdad/San Francisco within `limit: 8`) is now **half closed**, measured:

- **"baghdad" is closed.** Baghdad the city is position 1. The previous
  amendment reported that only "Baghdad Governorate" (a 1-level gap) was
  reachable, at position 37 of 413, and that the city's own 4-level gap
  was closed by nothing bounded. That analysis assumed the only available
  lever was level arithmetic; the population promotion supplies a second
  one-level lever that *composes* with the exact-match promotion, closing
  two of those four levels — and the remaining two turn out not to need
  closing, because `matchClass` resolves the tie.
- **"bag" is still open**, and for the documented reason: Bagraain (an
  ADM0 alt row) holds position 2 on a 1,234,571 population it inherits
  from Bahrain, and the query "bag" gives no evidence the user meant
  Baghdad rather than Bahrain. Position 1 is now a real place that
  genuinely prefix-matches (Bağcılar), which is as good an answer as a
  3-letter prefix deserves.
- **"san" is unchanged.** Nothing here moves a row more than one level,
  and that case needs more.

**Opting out.** `new Geocoder({ ranking: { populationPromotionThreshold:
Infinity } })` disables the promotion and restores the pre-amendment
`effLevel`s exactly, for a caller that wants to A/B the two.
`populationLevelPromotion: 0` does the same. Both mirror
`altLevelDemotion: 0` from the previous amendment. Note that the
prominence/raw-`level` reordering is *not* behind an option: with the
promotion disabled it only reorders rows that an `effLevel` adjustment
already tied, which measured as no change on any of the eight pairs.

**Scope, explicitly.** `dedupeByNameCountryLevel`'s representative-picking
rule still compares by `areaKm2` alone, unchanged — same note as the
previous amendment. This matters slightly more now than it did: on WOF,
`area_km2` is absent from the index entirely, so a deduped group's
representative is whichever row came first in rank order. That is why the
"brooklyn" position-1 row reads "Brooklyn · New York (+30 more)" — the
borough *is* the representative, because it now ranks first within its
own `(nameNorm, country, level)` group. Before this amendment the same
31-row group was represented by a small Brooklyn locality inside a
"Brooklyn Township" (position 4 of the before table), with the borough
somewhere behind it in the collapsed `+30`. Worth revisiting if a future
WOF build adds `area_km2`.


### Amendment, 2026-11-13 — fuzzy-match fallback (adapted from Development Seed's gazet)

**What:** when a normal prefix search produces **zero** results and the
normalized query is at least 3 characters, `search()`/`searchSync()` fall
back to a fuzzy scan: Jaro-Winkler similarity plus a substring-containment
signal over index rows already resident in memory. Pure JS
(`src/fuzzy.js`), no new dependencies, no network.

**Provenance.** The ranking decisions are adapted from Development Seed's
[gazet](https://github.com/developmentseed/gazet) (MIT) — specifically
`src/gazet/search.py`'s `simple_fuzzy_search` and the DuckDB
`jaro_winkler_similarity` ordering it ships: substring containment
outranks a higher raw similarity ("Loja" inside "Loja Province" beats the
near-miss "Lodja"); a record is reachable by every name it answers to
(our alt-name rows give us this for free); population breaks ties. Blog:
<https://developmentseed.org/blog/2026-04-29-gazet>. gazet's *LLM*
components (place extraction, text-to-SQL) are deliberately not part of
this amendment.

**The contract:**

- **Trigger.** Only on an otherwise-empty result (after level/country
  filters), only when `normalize(query).length >= fuzzy.minQueryLength`
  (default 3). A non-empty prefix result is **never** reordered or
  augmented — zero risk to the ranking above this amendment.
- **Search space.** Full-load mode: all in-memory index rows. Range mode:
  the eagerly-loaded `prominent_index` rows — which are exactly the
  prominent places a typo'd query most plausibly means. A range-mode index
  without a prominent index skips the fallback entirely: **fuzzy never
  triggers range reads.** (Honest consequence, measured live: the WOF
  staging manifest ships no `prominent_index`, so WOF gets no fuzzy
  fallback until its catalog adds one.)
- **Candidate rule.** A row survives when its `name_norm` *contains* the
  folded query (one-directional, exactly gazet's `contains(s.folded,
  query)`; the reverse direction was tried and rejected — "bagdhad"
  contains "bag", so query-contains-name would hand every village named
  "Bag" a substring win over Baghdad's 0.967 similarity), OR its
  Jaro-Winkler similarity ≥ `fuzzy.minSimilarity` (default **0.90**).
  Winkler bonus: standard 0.1 prefix scale, 4-char cap, applied only above
  the 0.7 jaro boost threshold (DuckDB-compatible, so scores are
  comparable to gazet's).
- **Threshold, measured 2026-11-13** (this implementation, verified live
  against the published geoBoundaries and Overture indexes):
  targets "liechtenstien"→liechtenstein 0.9846, "bagdhad"→baghdad 0.9667,
  "brookln"→brooklyn 0.9750, "mumbia"→mumbai 0.9667, "san fransisco"→san
  francisco 0.9526, "californa"→california 0.9800 — all ≥ 0.95; noise
  "bagdhad" vs baghdud 0.8944 / bandad 0.8794 / baidoa 0.7968 — all
  < 0.90. 0.90 keeps every target with margin and cuts the whole measured
  noise tail.
- **Ordering.** `compareFuzzyRanked`: substring DESC, similarity DESC,
  then the existing `compareRanked` total order. Ranks are built by
  `rankFuzzyRow`, which reuses `rankRow`'s measured `effLevel` machinery
  (alt demotion, population promotion, and their mutual-exclusion gate)
  minus the exact-match promotion, which cannot apply (an exact match
  would have been found by the normal search). Verified live on Overture:
  "brookln" puts Brooklyn-the-borough (population 2.5M) first via the
  population promotion, above the closer-spelled small "Brooks" rows.
- **Result shape.** Normal `SearchResult` with `rank.matchClass: 'fuzzy'`
  (`MATCH_CLASS_RANK.fuzzy = 4`, below every real class) and
  `rank.similarity` (0..1) / `rank.substring` added. Diversity dedupe and
  the per-group cap apply unchanged; `scoreOf` maps a fuzzy rank's class
  component to `0.25 × similarity`, strictly below a real substring
  match's 0.25.
- **Options.** `GeocoderOptions.fuzzy?: boolean | { minSimilarity?:
  number, minQueryLength?: number }` — on by default, `false` disables.
- **Performance, measured** (M-series Mac, Node 22, mixed-length names,
  `similarityUpperBound` length prefilter active): 52K rows (geoBoundaries
  full index) 11–23 ms per no-match query; 300K rows ~59 ms. `search()`
  scans via `fuzzyScanAsync`, yielding every 16,384 rows (~3–7 ms of work
  per slice), so the main thread never blocks for the whole scan;
  `searchSync` (full-load only, zero-await contract) runs the scan
  synchronously and accepts the 11–23 ms worst case. A search superseded
  mid-scan resolves `[]` via the existing generation guard, never rejects.
- **Live demo verification:** `examples/geocoder-demo/verify-fuzzy.mjs`
  (screenshot `screenshot-fuzzy-fallback.png`): "liechtenstien" → fuzzy
  Liechtenstein on live geoBoundaries (full-load path, 421 ms cold);
  "brookln" → fuzzy Brooklyn first on Overture (range mode, prominent-scan
  path, 1.5 s including the range prefix miss); "bag" → prefix results
  with zero fuzzy rows (non-firing case). Known catalog-side gap, out of
  scope here: the Overture prominent index does not contain
  Baghdad-the-locality at all (Iraq's country rows and 112K-population
  Bagalkote are present), so "bagdhad" on Overture finds nothing — a
  prominent-selection issue to fix in cn-gazetteer-overture, not in this
  fallback.


### 3.3 `@cngeo/upload-core`

```ts
export interface UploadOptions {
  readonly maxBytes?: number;            // default 64 MiB; above → UPLOAD_TOO_LARGE
  readonly maxFeatures?: number;         // default 10_000
  readonly unionMode?: 'collect' | 'dissolve';   // default 'collect'
  /** Supplies the boolean union for `dissolve`. Registration, not dynamic
   *  import — see §4.4. */
  readonly dissolver?: (polys: AreaGeometry[]) => AreaGeometry;
  readonly filterVertexCeiling?: number; // default 10_000
  /** A declared non-4326 CRS: `reject` (default) or `assume-4326` with a
   *  recorded repair. No reprojection in core (design call #4: 4326 only). */
  readonly onForeignCrs?: 'reject' | 'assume-4326';
  readonly signal?: AbortSignal;
}

export interface UploadResult {
  readonly area: Area;
  readonly warnings: readonly UploadWarning[];
}

export type UploadWarning =
  | { code: 'overlapping-features'; count: number }
  | { code: 'simplified'; detail: AreaSimplification }
  | { code: 'assumed-4326'; declared: string }
  | { code: 'repaired'; repairs: readonly AreaRepair[] }
  | { code: 'degraded-to-bbox'; detail: AreaSimplification };

export declare function areaFromFile(file: File, options?: UploadOptions): Promise<UploadResult>;
export declare function areaFromGeoJson(json: unknown, meta: { name: string }, options?: UploadOptions): Promise<UploadResult>;
/** Wires drag/drop + paste on an element. Returns an unsubscribe. */
export declare function attachDropTarget(el: HTMLElement, onResult: (r: UploadResult) => void, options?: UploadOptions & { onError?: (e: CngError) => void }): Unsubscribe;
/** For the "more formats" plugin path of E4 (shapefile-js, gdal3.js): a
 *  reader is registered, and `areaFromFile` dispatches on media type /
 *  extension. Core registers GeoJSON only. */
export declare function registerReader(reader: GeometryReader): void;

export interface GeometryReader {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly mediaTypes: readonly string[];
  read(file: File, signal?: AbortSignal): Promise<{ features: GeoJSON.Feature[]; declaredCrs: string | null }>;
}
```

### 3.4 `@cngeo/extract-core`

```ts
export interface DownloadCoreOptions {
  readonly fetch?: typeof fetch;
  /** Row-reading engine. Default: the built-in hyparquet engine (design
   *  call #2). `@cngeo/engine-duckdb` registers an alternative. */
  readonly engine?: Engine;
  readonly formats?: readonly FormatPlugin[];
  readonly ceiling?: Partial<Ceiling>;
  /** Parallel range reads. Default 12; the sentinel-2 precedent says the win
   *  comes from parallelism, and that every read must be `cache: 'no-store'`
   *  so Chrome's cache lock does not serialize them. */
  readonly maxConcurrentRequests?: number;
  readonly signal?: AbortSignal;
}

export interface Ceiling {
  /** Refuse above these without an explicit `acceptCeiling()`. */
  readonly rows: number;        // default 5_000_000
  readonly outputBytes: number; // default 2 * 1024**3   (2 GiB)
  readonly readBytes: number;   // default 4 * 1024**3
  readonly files: number;        // default 500
  /** Blob-sink only, because a Blob is held in memory. */
  readonly blobBytes: number;   // default 256 * 1024**2
}

export interface Estimate {
  readonly requestDigest: string;   // sha-256 of the canonicalized DownloadRequest + area id
  readonly rows: Bounded;
  /** Bytes that must be read from object storage to answer the query. */
  readonly readBytes: Bounded;
  /** Bytes the output file is expected to be. Format-dependent; the format
   *  plugin supplies the bytes-per-row model — **but only on the
   *  `download()` path.** The standalone `estimate()` above takes no
   *  `OutputRequest`, so it cannot know the format and necessarily falls
   *  back to a generic, format-agnostic bytes-per-row model
   *  (`genericOutputBytesModel` in estimate.js), reported honestly as
   *  `exact: false`. Treat a standalone `estimate()`'s `outputBytes` as
   *  order-of-magnitude only; `download()` recomputes it internally from
   *  the real `FormatPlugin.estimateBytes` once the format is known, and
   *  *that* is the number its ceiling check uses. Every other field of an
   *  `Estimate` is identical on both paths. */
  readonly outputBytes: Bounded;
  readonly files: { readonly total: number; readonly selected: number };
  readonly rowGroups: { readonly total: number; readonly selected: number } | null;
  /** HTTP requests the download will issue. Surfaced because on this path
   *  request *depth* is the latency, not bytes (the sentinel-2 finding). */
  readonly requests: number;
  readonly prune: readonly PruneStage[];
  readonly columns: readonly string[];
  readonly warnings: readonly EstimateWarning[];
  readonly ceiling: {
    readonly exceeded: boolean;
    readonly limits: Ceiling;
    readonly breaches: readonly ('rows' | 'outputBytes' | 'readBytes' | 'files' | 'blobBytes')[];
  };
  readonly elapsedMs: number;
}

/** `exact: true` means the number came from metadata, not a model. */
export interface Bounded {
  readonly min: number;
  readonly max: number;
  readonly estimate: number;
  readonly exact: boolean;
}

export interface PruneStage {
  readonly stage: 'partition' | 'part-bbox' | 'part-time' | 'row-group-bbox' | 'row-group-stats' | 'row';
  readonly before: number;
  readonly after: number;
  readonly basis: string;    // e.g. "partition:keys year ∈ {2026}", "covering bbox", "no covering — full scan"
}

export type EstimateWarning =
  | { code: 'no-covering'; message: string }
  | { code: 'no-statistics'; message: string }
  | { code: 'single-row-group'; message: string; files: number }
  | { code: 'degraded-to-bbox'; message: string }
  | { code: 'antimeridian-split'; boxes: number }
  | { code: 'estimate-wide'; ratio: number }
  | { code: 'share-alike'; attribution: readonly AreaAttribution[] };

export declare function resolveDataset(
  descriptor: DatasetDescriptor,
  options?: { fetch?: typeof fetch; signal?: AbortSignal }
): Promise<DatasetDescriptor>;   // concrete: no `portolan-collection` source left

export declare function estimate(
  dataset: DatasetDescriptor,
  area: Area | null,
  filter: FilterSpec,
  options?: DownloadCoreOptions & { signal?: AbortSignal }
): Promise<Estimate>;

export declare function download(
  dataset: DatasetDescriptor,
  area: Area | null,
  filter: FilterSpec,
  output: OutputRequest,
  options?: DownloadCoreOptions & { sink?: Sink; acceptCeiling?: boolean }
): DownloadHandle;

/** Convenience: the same thing from a serialized request. */
export declare function downloadRequest(
  request: DownloadRequest,
  area: Area | null,
  options?: DownloadCoreOptions & { sink?: Sink; acceptCeiling?: boolean }
): DownloadHandle;
```

`download()` returns **synchronously**. A handle that only existed after an
await could not be cancelled during planning, which is exactly when a user
changes their mind.

```ts
export type DownloadState =
  | 'planning'    // resolving + estimating
  | 'blocked'     // ceiling exceeded; awaiting acceptCeiling() or cancel()
  | 'running'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface DownloadHandle {
  readonly id: string;
  readonly state: DownloadState;
  /** Resolves once planning finishes, even when the ceiling is breached. */
  readonly estimate: Promise<Estimate>;
  /** Rejects with `CeilingExceededError` if the handle is `blocked` and
   *  neither `acceptCeiling()` nor `acceptCeiling: true` was given.
   *  A **getter**, not a fixed promise: it returns the live run's promise,
   *  which `acceptCeiling()` replaces after a breach. See the 2026-11-12
   *  "blocked handles reject" amendment below. */
  readonly result: Promise<DownloadResult>;

  /** Both forms of progress, same events. The async iterable exists so a
   *  `for await` loop is a legitimate consumer. */
  readonly progress: AsyncIterable<Progress>;
  on<K extends keyof DownloadEvents>(event: K, handler: (payload: DownloadEvents[K]) => void): Unsubscribe;

  /** The refusal path (design call #3): an explicit, auditable act.
   *  Returns the continued run's promise — the one `result` hands back
   *  from here on — because the promise the caller was holding has already
   *  rejected. Idempotent on a handle that is not `blocked`. */
  acceptCeiling(): Promise<DownloadResult>;

  pause(): void;
  resume(): void;
  /** Resolves when the sink has been closed and any partial file removed
   *  (unless `keepPartial`). */
  cancel(reason?: string): Promise<void>;
}

export type Progress =
  | { readonly phase: 'planning' }
  | { readonly phase: 'pruning'; readonly stage: PruneStage }
  | { readonly phase: 'reading'; readonly rowGroupsDone: number; readonly rowGroupsTotal: number;
      readonly bytesRead: number; readonly rowsScanned: number; readonly rowsMatched: number;
      readonly requests: number; readonly bytesPerSecond: number; readonly etaMs: number | null }
  | { readonly phase: 'writing'; readonly rowsWritten: number; readonly bytesWritten: number }
  | { readonly phase: 'finalizing' };

export interface DownloadEvents {
  'state': { state: DownloadState };
  'estimate': Estimate;
  /** Emitted exactly once when the ceiling is breached, before `blocked`. */
  'ceiling': { estimate: Estimate };
  'progress': Progress;
  'warning': EstimateWarning;
  'done': DownloadResult;
  'error': CngError;
}

export interface DownloadResult {
  readonly rows: number;
  readonly bytes: number;
  readonly format: string;
  readonly filename: string;
  readonly elapsedMs: number;
  readonly requests: number;
  readonly readBytes: number;
  /** Where it went. A Blob sink puts the Blob here; an FS sink puts the
   *  handle. */
  readonly sink: { readonly kind: 'filesystem'; readonly handle: FileSystemFileHandle }
              | { readonly kind: 'blob'; readonly blob: Blob }
              | { readonly kind: 'stream' }
              | { readonly kind: 'memory'; readonly chunks: readonly Uint8Array[] };
  readonly estimate: Estimate;
  readonly truncated: boolean;     // `limit` was reached
  readonly attribution: readonly AreaAttribution[];
}
```

Sinks:

```ts
export interface Sink {
  readonly kind: 'filesystem' | 'blob' | 'stream' | 'memory';
  open(meta: { filename: string; mediaType: string; estimatedBytes: number | null }): Promise<WritableStreamDefaultWriter<Uint8Array>>;
  close(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

/** File System Access API. `showSaveFilePicker` must be called from a user
 *  gesture, so the picker runs *before* `download()`; the handle is passed in.
 *  Throws `SINK_UNSUPPORTED` where the API is absent. */
export declare function fileSystemSink(opts?: { handle?: FileSystemFileHandle; suggestedName?: string; keepPartial?: boolean }): Promise<Sink>;
/** Fallback: buffers, then triggers a download. Refuses above
 *  `ceiling.blobBytes` with `SINK_QUOTA_EXCEEDED`. */
export declare function blobSink(opts?: { maxBytes?: number }): Sink;
export declare function streamSink(stream: WritableStream<Uint8Array>): Sink;
export declare function memorySink(): Sink;
/** `fileSystemSink` where available, else `blobSink`. The default. */
export declare function autoSink(opts?: { suggestedName?: string }): Promise<Sink>;
```

Format plugins:

```ts
export interface FormatPlugin {
  readonly id: string;                     // 'geojson', 'geoparquet', 'gpkg', …
  readonly extension: string;
  readonly mediaType: string;
  /** False means the writer needs the whole result before it can emit a byte
   *  (the sql.js GeoPackage path). The estimate then also checks
   *  `ceiling.blobBytes`, and the UI says "this format buffers in memory". */
  readonly streaming: boolean;
  readonly capabilities: {
    readonly nestedColumns: boolean;
    readonly mixedGeometryTypes: boolean;
    readonly maxFeatures?: number;
    readonly crs: readonly string[];
  };
  /** Bytes-per-row model for the estimate. Given the projected schema. */
  estimateBytes(schema: readonly ColumnDescriptor[], rows: Bounded): Bounded;
  open(ctx: FormatContext): Promise<FormatWriter>;
}

export interface FormatContext {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly schema: readonly ColumnDescriptor[];
  readonly geometryColumn: string;
  readonly crs: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly attribution: readonly AreaAttribution[];
  readonly signal: AbortSignal;
}

export interface FormatWriter {
  writeBatch(batch: FeatureBatch): Promise<void>;
  /** `warnings`, added by the amendment below, is additive and optional:
   *  a format's own honesty mechanism for limits only it knows about
   *  (Shapefile's 10-char field names, one-shape-type-per-file, ~2GiB
   *  size ceiling — see `@cngeo/format-shapefile`'s README). */
  close(): Promise<{ rows: number; bytes: number; warnings?: readonly { code: string, message: string, context?: Record<string, unknown> }[] }>;
  abort(reason?: string): Promise<void>;
}

/** Column-oriented, because that is what hyparquet produces and what
 *  hyparquet-writer consumes. A row-oriented writer (geojson) iterates. */
export interface FeatureBatch {
  readonly rows: number;
  readonly columns: Readonly<Record<string, ArrayLike<unknown>>>;
  /** WKB per row, or null for a null geometry. */
  readonly geometry: readonly (Uint8Array | null)[];
}

export declare function registerFormat(plugin: FormatPlugin): void;
export declare function formats(): readonly FormatPlugin[];
```

### Amendment, 2026-11-12 — reason: a `blocked` handle's `result` never
settled (E10 API-vs-design audit, drift #1)

The audit read this section's `DownloadHandle.result` against the code and
found the most dangerous drift in the repo for an automated caller: a
`blocked` handle's `result` **waited forever** rather than rejecting with
`CeilingExceededError` as the interface above says. `await handle.result`
on a request that breached the ceiling simply never returned. The root
README listed it as a known issue and `AGENTS.md` carried a rule — "never
`await handle.result` without first awaiting `handle.estimate` and handling
`ceiling.exceeded`" — which is a workaround for a broken promise, not a
contract anyone should have to know.

The fix needs more than a `reject()` call, because a promise settles once
and the run is *not* over: `acceptCeiling()` may continue it. So `result`
becomes a **slot**, and the handle exposes it as a getter:

- The live run owns one deferred. `handle.result` returns its promise.
- Going `blocked` **rejects** that promise with `CeilingExceededError`,
  carrying `context.breaches`, `context.limits` and `context.estimate`, so
  a caller who only ever awaits `result` gets the estimate out of the
  error rather than needing a second channel.
- **`acceptCeiling()` installs a fresh deferred and returns it** — the
  continued run's `Promise<DownloadResult>`, and what `result` returns
  from then on. A promise captured before the breach stays rejected,
  because promises do not un-settle; that is the documented cost of the
  shape, and it is cheaper than the alternative (a second
  `completion` accessor whose relationship to `result` every caller then
  has to learn).
- `cancel()` while `blocked` leaves the already-rejected promise alone
  rather than re-settling it with a different code underneath a caller.
  `state` becomes `'cancelled'`; the promise keeps its `CEILING_EXCEEDED`.
  `cancel()` itself awaits an internal "run has finished tearing down"
  promise, not `result`, which while blocked is already settled.
- Ordering, which is load-bearing: the rejection happens *before*
  `setState('blocked')` and the `ceiling` emission, because events are
  synchronous (§3.5) and a handler may call `acceptCeiling()` during the
  emit — rejecting after that would reject the *continued* run's promise.
  A rejection handler runs as a microtask either way, so by the time any
  `.catch()` observes the error, `handle.state` already reads `'blocked'`.
  The blocked gate is likewise armed before `setState`, so an
  `acceptCeiling()` from a `state` handler resolves a gate that exists.

`acceptCeiling(): void` → `acceptCeiling(): Promise<DownloadResult>` is
source-compatible: a caller ignoring the return value is unaffected.

Implemented: `packages/extract-core/src/download.js`. Tests:
`packages/extract-core/test/download-handle.test.js` ("a blocked handle's
result REJECTS with CeilingExceededError rather than waiting forever", plus
the synchronous-handler, never-blocked and cancel-while-blocked cases).

### Amendment, 2026-11-12 — reason: format load state was pull-only (E7
portolan-browser integration)

`formats()` and `formatLoadState(id)` are both pull-only, while a lazy
format's state changes asynchronously underneath a UI that has already
rendered (`'idle'` → `'loading'` → `'loaded'`/`'failed'`, the middle step
being a CDN fetch of a few hundred KB). The portolan-browser integration
therefore *polled* — bumping a reactivity counter to force a re-read of
`formats()`. That is a missing subscription, not a design.

```ts
export type FormatStateChange = { id: string; state: 'idle' | 'loading' | 'loaded' | 'failed' };
/** Fires on registration (eager → `'loaded'`, lazy → `'idle'`) and on every
 *  lazy `load()` transition. Call `formats()` inside the handler for the
 *  full current list. Returns its own unsubscribe, per §3.5. */
export declare function onFormatState(handler: (change: FormatStateChange) => void): Unsubscribe;
```

A plain handler set rather than an `Emitter`: the registries are
module-level singletons (one per page, not one per `download()`), so there
is no instance to hang an `on(event, …)` off. Handlers run synchronously in
registration order; one that throws is swallowed, so a broken subscriber
cannot fail the registration or `load()` that triggered it, nor starve the
other subscribers.

Implemented: `packages/extract-core/src/registry.js`, exported from
`index.js`. Tests: the `onFormatState` cases in
`packages/extract-core/test/registry-lazy.test.js`.

### Amendment, 2026-11-13 — reason: the three extract-core performance items
(parallel reads, predicate pushdown, honest output sizes)

Three measured changes, with the measurements, including the parts that
did not come out the way the plan assumed.

#### 1. `maxConcurrentRequests` is implemented (and the win is smaller than "838 requests" suggested)

`DownloadCoreOptions.maxConcurrentRequests` was declared above with a
documented default of 12 and **read by nothing** — row groups were read
one at a time. It now works: row groups are fetched by that many workers
pulling from one shared cursor (the same worker-pool shape as
`@cngeo/geocoder-core`'s `searchRangeIndex`, commit 8c1308c — N workers
over a cursor and one `Promise.all`, never concurrency-sized waves, so a
slow read never idles the other N−1), while `onBatch` stays strictly in
row-group order, delivered by a single loop. Output is byte-for-byte what
the sequential implementation produced.

Three constraints that shaped it:

- **Read-ahead is bounded.** Ordered delivery is itself a buffer: if group
  0 is slow, every later group that finishes must be held. A worker will
  not start slot `i` while `i − delivered >= maxConcurrentRequests`, which
  caps live decoded groups at that many however wide the latency spread,
  instead of letting one slow group pull the whole remaining plan into
  memory. The worker holding slot `delivered` is never blocked by the
  bound, so the pipeline cannot deadlock.
- **`pause()` gates the workers, not just delivery.** `pause()` is
  implemented (§3.5) as an `onProgress` that does not resolve until
  `resume()`; a worker awaits that same promise *before starting another
  read*, or a paused download would keep hammering object storage.
- **A worker's error is captured, never rethrown.** A worker that rejected
  while its N−1 siblings were in flight would settle `Promise.all` early
  and leave their later rejections unhandled.

**Measured, live, against the real `sentinel-2-c1-l2a` STAC-GeoParquet
footprints** — §2.8's Kenya query minus its `limit`, which plans 825
row-group reads because that collection publishes no bbox covering, so
nothing prunes. Sequential and parallel arms were interleaved over the same
and over disjoint cold windows, to control for network drift:

| what | sequential | parallel (12) | ratio |
|---|---|---|---|
| **the whole 825-group query** | **736.9 s** (1 sample) | **65.5 / 67.1 / 73.9 s** | **11.0x** at the median |
| a fixed 96-row-group slice | 102.7 / 105.7 / 109.9 s | 9.2 / 9.8 s | 11.1x |
| the same slice, 4 workers | — | 23.1 s | 4.6x |
| the same slice, 24 workers | — | 5.0 s | 21.2x |

Requests, read bytes, rows and batch count are **identical** between the
two arms of the full query (825 / 208,463,067 / 6,822 / 8) — end-to-end
evidence that ordering and `limit` semantics did not move, not just a
faster number.

Two controls worth recording. The pre-change engine measured 106.5 / 105.9
/ 107.2 s on the same 96-group slice, and the new code at
`maxConcurrentRequests: 1` reproduces it at 102.7–109.9 s — **the pool adds
no measurable overhead**, and the sequential column is the real old
behaviour rather than a crippled new one. And repeated reads of the same
byte ranges on `data.source.coop` do *not* get faster (those three
pre-change samples are within ±1%), which is what makes comparing arms over
the same window legitimate.

Where the time actually goes, isolated: 8 row-group reads in series take
10.07 s and the same 8 concurrently take 1.59 s, while the engine's own
per-row filter loop (WKB decode, bbox test, polygon intersection,
`where[]`) costs **14 ms per 6,144-row group**. On this path latency is
round trip — not bytes, and not CPU — which is what the sentinel-2
precedent claimed and this now confirms end to end. 24 workers was still
scaling, so the specified default of 12 is a conservative point on an
un-flattened curve, chosen because peak memory scales with it.

`requests`/`bytesRead`/`rowGroupsDone`/`rowsScanned` are incremented by the
ordered delivery loop, so every counter reports the row groups that
actually contributed to the output and ends on exactly the sequential
totals. Consequence: when `filter.limit` stops the run, the at most
`maxConcurrentRequests − 1` reads already in flight finish, are discarded,
and are **not** counted — a limit-bound download's `requests` under-reports
real network use by up to that many. Chosen deliberately, so the verified
numbers in the READMEs stay comparable across the change.

#### 2. Predicate pushdown: a new `row-group-where` stage

`filter.where` was applied per row *after* the read. Row groups whose
min/max statistics prove no row can match are now dropped before being
fetched, using the same footer machinery as the bbox and time stages, and
reported as a sixth `PruneStage`. **`PruneStage.stage`'s union above gains
`'row-group-where'`.** The stage is emitted even with no `where` filter
(basis `'no where filter'`), so the cascade's shape does not depend on the
query.

Pruning is sound-only: a row group is dropped only when the statistics
*prove* no row in it can match, because a wrong prune silently removes
user data from a download — the worst failure available to this package.
Prunable: `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not_in`, `between`,
`is_null`, `is_not_null`. Not prunable, and documented as such in the
stage's own `basis` string: `like`/`ilike` (a leading `%` is undecidable
and getting it wrong drops data), any leaf inside a negated `not` (the
negation inverts what the statistics prove), and a path into a list or
struct element (chunk statistics describe the leaf, not the element).
Always unprunable whatever the operator: no statistics in the footer,
non-comparable or mixed-type statistics, and string-vs-number comparisons.
Each falls back to keeping the row group.

**Measured, live** (`estimate()` only — footers, no row data):

| dataset + predicate | row groups | requests | read bytes |
|---|---|---|---|
| FIRMS 2024 Africa, `brightness >= 500` | 649 → **147** | 678 → 176 | **−77.4%** (1.13 GB → 254 MB) |
| s2 2025 Kenya, `_month = 7` | 825 → 808 | 839 → 822 | −2.0% |
| FIRMS 2024 Africa, `confidence_pct >= 95` | 649 → 649 | — | 0% |
| FIRMS 2024 Africa, `satellite = "N"` | 649 → 649 | — | 0% |
| s2 2025 Kenya, `eo:cloud_cover <= 1` | 825 → 825 | — | 0% |
| s2 2025 Kenya, `s2:tile_id like 'S2B%'` | 825 → 825 | — | 0%, basis `no statistics-prunable operator` |

One dramatic win, one marginal, four no-ops — and the four are no-ops
because statistics exist but every row group's range spans the predicate's
value, which is what unsorted data does. The same lesson the bbox stage
already teaches on a dataset with no covering: pruning is a property of how
the file was written, not of how clever the client is. This is also
upstream-advocacy material: a FIRMS or s2 mirror sorted on a commonly
filtered column would turn the four no-ops into wins.

#### 3. `estimateBytes` gains a geometry term

`FormatPlugin.estimateBytes` modelled attribute columns and assumed a small
fixed constant for geometry (220 bytes a row for GeoJSON, 70 for CSV). On
boundary data that is wrong by orders of magnitude, because geometry *is*
the row. The signature gains an **additive** third argument:

```ts
estimateBytes(
  schema: readonly ColumnDescriptor[],
  rows: Bounded,
  ctx?: { avgGeometryBytes: number | null; geometryColumn: string },
): Bounded;
```

A plugin that ignores it, or a caller passing two arguments (the
portolan-browser format picker does), keeps working on the old constant.
`avgGeometryBytes` is average **uncompressed** bytes per row of the
geometry column, from footer statistics alone, so the estimate stays
metadata-only (O12). Uncompressed deliberately: what a format expands from
is decoded WKB, not the source file's codec — zstd-19 WKB and raw WKB
produce identical GeoJSON, and using compressed size would make the same
dataset model a different output size depending on how it was written.

Modelled ÷ actual, measured against three real datasets and 5 formats
(1.00 is perfect; below 1 under-estimates):

| dataset | geojson | csv | geoparquet | esrijson | shapefile |
|---|---|---|---|---|---|
| CGAZ ADM0 display (218 rows) — before | 0.006 | 0.001 | 0.003 | 0.003 | 0.007 |
| CGAZ ADM0 display — **after** | **1.01** | **1.01** | **1.01** | **1.01** | **1.00** |
| FTW Liechtenstein (795 rows) — before | 0.24 | 0.06 | 0.36 | 0.14 | 0.22 |
| FTW Liechtenstein — **after** | **1.05** | **1.03** | 3.08 | **1.02** | **1.08** |
| CGAZ ADM1 display (400 rows) — before | 0.019 | 0.005 | 0.009 | 0.011 | 0.022 |
| CGAZ ADM1 display — **after** | 0.41 | 0.41 | 0.41 | 0.41 | 0.43 |

**Two residuals, both honest and both visible above:**

- **CGAZ ADM1 under-estimates ~2.4x for every format.** A single per-format
  multiplier cannot be right everywhere: the expansion depends on how many
  decimal digits each coordinate needs, and ADM1's display geometries
  measure 3.8x WKB as GeoJSON where ADM0's measure 1.5x. Under-estimating
  is the dangerous direction for a ceiling, so this is a known gap. Fixing
  it properly needs a per-dataset calibration (O12's opt-in
  `sample: { rowGroups: 1 }` is the obvious hook).
- **GeoParquet over-estimates ~3x on FTW**, because the model expands from
  uncompressed source WKB while the output is recompressed. Over-estimating
  only costs a spurious ceiling prompt.

Both are a large improvement on a constant. Before, a 19 MB CSV modelled as
26 kB could never breach an `outputBytes` ceiling at all — the ceiling was
decorative on exactly the datasets it exists for. The improved number flows
into `est.outputBytes` and from there into both the `outputBytes` check in
`finalizeEstimate` and the `blobBytes` check in `download()`; the standalone
`estimate()` still has no format and still says so (see
`Estimate.outputBytes` above).

Implemented: `packages/extract-core/src/{engine-hyparquet,prune,estimate,
download}.js` and `src/formats/{geojson,geoparquet}.js`, plus
`@cngeo/format-extras`, `@cngeo/format-gpkg`, `@cngeo/format-shapefile`,
`@cngeo/format-flatgeobuf`. Tests:
`packages/extract-core/test/{engine-concurrency,prune-where,
estimate-geometry-bytes}.test.js`.

### Amendment, 2026-11-13 — reason: two extract-core API lies closed
(root README's known-issues table)

Two entries in the known-issues table described behaviour that
contradicted this document outright, rather than a documented gap. Both
are fixed; the table entries are removed.

#### 1. `inferTableFromSchema` no longer flattens a struct's children into the top-level column list

A parquet footer's `schema` is a **flat** array of thrift `SchemaElement`s
in file order — `schema[0]` a synthetic root, every other element either a
leaf column or a struct/group whose own children immediately follow it,
with `num_children` the only thing that says where its subtree ends. The
previous version of this function read every element's `.name` after the
root as if the array were already a column list
(`metadata.schema.slice(1).map((e) => e.name)`). For a GeoParquet 1.1
covering declared as a `bbox: {xmin, ymin, xmax, ymax}` struct (the shape
§2.1's `BboxCovering` documents, and the shape CGAZ/GAUL/World Bank
publish), that listed `bbox` **and** `xmin`, `ymin`, `xmax`, `ymax` as four
additional top-level columns that do not exist as physical parquet
columns. A dataset descriptor that declared `table` explicitly never hit
this (every descriptor in this repo does), but one that didn't — relying
on this function to infer the table — got `table.columns` with those four
phantom entries, and a read that projected one of them failed with
hyparquet's "parquet column not found".

The fix walks the flat array respecting `num_children`, so a struct is
kept as **one** top-level column (`{ name: 'bbox', type: 'struct' }`),
exactly matching how `predicate.js`'s dotted-path addressing
(`bbox.xmin`), `prune.js`'s `coveringPaths`, and `columns.js`'s
`BboxCovering.column` already treat it. No change to any declared-`table`
path; this only changes what an *inferred* table looks like.

Implemented: `packages/extract-core/src/estimate.js`
(`topLevelSchemaColumns`, `inferTableFromSchema`). Tests:
`packages/extract-core/test/infer-table.test.js`, against the real
struct-`bbox` fixtures `test/fixtures/{geo-metadata,bare}.parquet` (shared
with `geoparquet-decode.test.js`) plus synthetic schemas for a
non-`bbox`-named struct and a two-level-nested one.

#### 2. `filter.columns.dropGeometry` now actually drops geometry from the output

`resolveOutputColumns` (`columns.js`) already excluded the geometry column
from `outputColumns` correctly. The bug was downstream:
`engine-hyparquet.js`'s `buildBatch` populated `batch.geometry` from the
decoded row unconditionally, and every `FormatWriter` wrote from
`batch.geometry` unconditionally — `dropGeometry` changed nothing an
output ever saw.

**The design decision, worked through rather than assumed:** `dropGeometry`
is an *output* instruction only — "this download is a different product,
without geometry" (§2.2's `ColumnProjection` doc comment) — never a
promise that the engine will not look at the geometry column while
deciding what to filter. A spatial filter in `mode: 'intersects'` (or
`'clip'`, which runs `intersects` first) needs the real, decoded geometry
for its point-in-polygon/edge test regardless of what the output asks for;
so does `mode: 'bbox'` when the dataset has no bbox covering at all (§2.1
`BboxCovering: { kind: 'none' }`), because then there is no statistic to
get a row's bbox from except decoding its geometry. **This is deliberately
not a refusal.** `FILTER_REQUIRES_ENGINE` (`ceiling.js`'s
`requirementsOf`) exists for a filter an engine's declared `capabilities`
genuinely cannot run at all (`exact-clip` today); the hyparquet engine's
`'intersects'` capability already means "I can decode geometry to test it
exactly", so a `dropGeometry` request combined with a spatial filter the
engine can already satisfy is never refused — it simply reads geometry
when filtering needs it and withholds it from the output regardless. The
exact rule — four cases, each with its reasoning — is
`columns.js`'s `geometryNeededForFilter`, consumed by
`resolveReadColumns`'s new (optional, default-`true` for backward
compatibility) fifth argument. The net effect: geometry is excluded from
the *read* wherever nothing needs it (the common case — most downloads
have no spatial filter at all, or one a bbox covering already answers),
and excluded from the *output* unconditionally, every time.

`buildBatch` now only sets `batch.geometry[i]` from the decoded row when
`outputColumns` still carries the geometry column; otherwise every entry
is `null`, regardless of whether the column was read. A format whose
output always carries a geometry member (GeoJSON's `Feature.geometry`, in
`FormatWriter`'s terms "null for a null geometry") therefore writes
`null` for every feature. GeoParquet's writer does better, because it can:
it omits the physical geometry column, the `bbox_*` covering columns, and
the whole `geo` GeoParquet key-value metadata entry, producing an honest
plain Parquet file rather than a geometry column that exists but carries
nothing. `FormatPlugin.estimateBytes`'s geometry term (the item-7
amendment above) is correspondingly zero when the output schema it is
given has no geometry column, so a dropped-geometry request's
`outputBytes` estimate — and therefore its ceiling check — reflects what
actually gets written, not what would have been written with geometry.

Implemented: `packages/extract-core/src/{columns,engine-hyparquet,
estimate}.js` and `src/formats/{geojson,geoparquet}.js`. Tests:
`packages/extract-core/test/{columns,drop-geometry}.test.js`, including
an end-to-end case that drops geometry *and* runs an `intersects` filter
against a real fixture, asserting both that filtering is still correct
(only the row that actually intersects comes back) and that the output
carries no geometry.

### Amendment, 2026-11-12 — reason: lazy format loading (O5's heavy-format
survey, E10)

Chris's requirement, stated directly during E10: a heavy format should
load "on the fly ... just when people select that format," with its
weight shown *before* that fetch happens, not after. `registerFormat`
above is unchanged (an eager, ready `FormatPlugin`); this amendment adds
a second, lazy registration shape alongside it:

```ts
export interface LazyFormatDescriptor {
  readonly id: string;
  readonly label?: string;                 // for a format picker, e.g. "GeoPackage"
  readonly extension: string;
  readonly mediaType: string;
  readonly streaming: boolean;
  readonly capabilities: FormatPlugin['capabilities'];
  /** min+gz weight of what `load()` will fetch, known up front -- lets a
   *  format picker show "GeoPackage (+~340KB)" *before* the fetch. */
  readonly approxBytes?: { min: number; max: number; estimate?: number };
  /** Same signature as `FormatPlugin.estimateBytes` -- pure JS, must not
   *  require `load()` to have run. */
  estimateBytes(schema: readonly ColumnDescriptor[], rows: Bounded): Bounded;
  /** Resolves to the real `FormatPlugin`, an ESM module whose `default`
   *  is the plugin or a factory for it, or a bare factory. Every real
   *  implementation of this (`@cngeo/format-gpkg`, `@cngeo/format-flatgeobuf`)
   *  documents its `load()` as `() => import(<exact pinned absolute CDN
   *  URL>)` — never a bare specifier (§4.4 rule 2 still holds; see below
   *  for why this isn't a relaxation of it). */
  load(): Promise<FormatPlugin | { default: FormatPlugin | (() => FormatPlugin) } | (() => FormatPlugin)>;
}

export declare function registerLazyFormat(descriptor: LazyFormatDescriptor): void;
/** Lists both eager and lazy formats; a lazy entry carries `approxBytes`
 *  and `loadState` instead of a live plugin. Never calls `load()`. */
export declare function formats(): readonly (
  | (Pick<FormatPlugin, 'id' | 'extension' | 'mediaType' | 'streaming' | 'capabilities'> & { lazy: false; loadState: 'loaded' })
  | (LazyFormatDescriptor & { lazy: true; loadState: 'idle' | 'loading' | 'loaded' | 'failed' })
)[];
/** Loads a lazy format on first call (concurrent calls for the same id
 *  share one in-flight `load()` and one cached result), or returns an
 *  already-loaded/eager format immediately. The only function that ever
 *  calls a `LazyFormatDescriptor.load()`. */
export declare function resolveFormat(id: string): Promise<FormatPlugin | undefined>;
export declare function formatLoadState(id: string): 'idle' | 'loading' | 'loaded' | 'failed' | 'unknown';
```

`download()` now resolves the requested format with `resolveFormat`
*inside* its internal `run()` (after the handle has already been
returned, design doc §3.4's synchronous-return requirement is unaffected)
rather than synchronously before planning starts. If the format is lazy
and not yet loaded, it emits a `{ phase: 'loading-format', format: string
}` `Progress` event first, so a UI can show "fetching GeoPackage writer,
~340KB..." A `load()` that throws is wrapped in a new error code,
**`FORMAT_LOAD_FAILED`** (§3.5's `CngErrorCode` union; retryable by
default, same as `NETWORK`/`INDEX_FETCH_FAILED` — a CDN fetch failing is
the same transient-failure shape under a format-specific name).

**Why this does not relax §4.4 rule 2** ("never a bare specifier"): the
rule's intent was that a bare-specifier `import` only resolves through a
bundler or an import map the host must maintain, which breaks the
zero-build promise. `load()` is documented, by every real implementation
of this descriptor, to call `import()` on an exact, pinned, absolute CDN
URL — exactly the mechanism `cdn.js`'s hyparquet-writer loader already
uses, just deferred until the format is actually selected instead of run
at module-load time. The format is still fully "registered" the moment
`registerLazyFormat` runs — its id, label, and weight are known and
listable immediately — only the *load* is deferred.

Implemented: `packages/extract-core/src/registry.js`,
`packages/extract-core/src/download.js`; new `FORMAT_LOAD_FAILED` code in
`packages/spec/src/errors.js`. Every new format plugin from E10
(`@cngeo/format-gpkg`, `@cngeo/format-flatgeobuf`) exports a ready-made
`*FormatDescriptor` using this shape; the zero-dependency ones
(`@cngeo/format-shapefile`, `@cngeo/format-extras`) export one too, whose
`load()` resolves immediately — the registry treats "lazy but free" and
"lazy and heavy" the same way. Tests:
`packages/extract-core/test/registry-lazy.test.js` and the lazy-format
cases appended to `packages/extract-core/test/download-handle.test.js`.

Engine plugin seam (so DuckDB stays strictly opt-in):

```ts
export interface Engine {
  readonly id: string;              // 'hyparquet' | 'duckdb-wasm'
  readonly capabilities: readonly FilterRequirement[];
  plan(dataset: DatasetDescriptor, area: Area | null, filter: FilterSpec, ctx: EngineContext): Promise<EnginePlan>;
  run(plan: EnginePlan, onBatch: (b: FeatureBatch) => Promise<void>, ctx: EngineContext): Promise<{ rows: number; readBytes: number; requests: number }>;
}
export declare function registerEngine(engine: Engine): void;
```

### 3.5 Events, cancellation, errors

**Event model.** One mechanism everywhere: `on(event, handler) =>
unsubscribe`. No `EventTarget` (its typing is poor and `once`/`removeEventListener`
pairing is a common leak), no Node `EventEmitter` (not available zero-build).
Handlers are called synchronously in registration order; a throwing handler is
caught, reported via the `error` event, and does not stop the others.
`DownloadHandle` additionally exposes `progress` as an `AsyncIterable` that
drops intermediate values under backpressure (latest-wins), because a progress
bar wants the newest number, not every number.

**Cancellation.** Three rules:

1. Every public async function takes `{ signal?: AbortSignal }`, and every
   internal `fetch` gets it. An abort rejects with `CancelledError` (`code:
   'CANCELLED'`), never a bare `DOMException`, so a consumer has one thing to
   match.
2. Cancellation is **cooperative at batch boundaries**. The engine checks the
   signal after each row group and before each `writeBatch`. In-flight range
   reads are aborted immediately; decoding of an already-fetched chunk is
   allowed to finish (it is milliseconds, and tearing a decode loop costs more
   complexity than it saves).
3. `handle.cancel()` is the superset: it aborts reads, calls
   `writer.abort()`, calls `sink.abort()`, and — for a filesystem sink whose
   handle *we* created — removes the partial file. `keepPartial: true` leaves
   it, for the "my 3 GB download died at 90%" case.

Superseded searches do not reject. `geocoder.search()` for a stale query
resolves to `[]`; this is the single most common source of unhandled rejections
in typeahead code and it is cheap to design away.

**Error taxonomy.** One base class, a stable string `code`, and a `retryable`
flag. The `code` is the API: messages are for humans and may be reworded,
codes may not.

```ts
export declare class CngError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}
export declare class CancelledError extends CngError {}        // 'CANCELLED'
export declare class CeilingExceededError extends CngError {}  // 'CEILING_EXCEEDED'
export declare function isCngError(e: unknown): e is CngError;
```

| code | thrown by | retryable | what the UI should say / do |
|---|---|---|---|
| `AREA_INVALID_CRS` | spec, upload | no | "Only EPSG:4326 (lon/lat) data is supported." Offer reprojection instructions, not a reprojection. |
| `AREA_UNSUPPORTED_GEOMETRY` | upload | no | "This file has points/lines; an area needs polygons." |
| `AREA_EMPTY` | upload, geocoder | no | "No usable polygon in that file." |
| `AREA_VERTEX_CEILING` | spec | no | Only when auto-simplify is disabled. "Area too detailed; simplify or raise the ceiling." |
| `AREA_ANTIMERIDIAN_CLIP` | download | no | "Exact clip is not available across the antimeridian. Use intersects." |
| `UPLOAD_TOO_LARGE` | upload | no | Name the limit and the file size. |
| `UPLOAD_UNSUPPORTED_FORMAT` | upload | no | **Added to this table 2026-11-12** (it existed in `upload-core` from the start, as a documented deviation). No registered reader for that extension/media type. Name the formats that do work, and `registerReader` for others. |
| `UPLOAD_PARSE_ERROR` | upload | no | **Added to this table 2026-11-12**, same history. Unreadable file, or not valid JSON. Quote the parse error. |
| `INDEX_FETCH_FAILED` | geocoder | **yes** | "Couldn't load the place index." Retry button. |
| `INDEX_SCHEMA_MISMATCH` | geocoder | no | Developer error: index lacks a required column. Name the column. |
| `INDEX_VERSION_MISMATCH` | geocoder | no | "The boundary files were rebuilt; reload the page." Carries both versions. |
| `INDEX_TOO_LARGE` | geocoder | no | Only with `loadStrategy: 'full'` and an index over the cap. Suggest `'range'`. |
| `INDEX_MULTI_SOURCE_UNSUPPORTED` | geocoder | no | **Added 2026-11-12.** `indexUrl` was given two or more URLs (or a non-string). Multi-source search is planned, not implemented (§8); this refusal replaces the silent fallback to `DEFAULT_INDEX_URL`, which loaded an index the caller never named. Developer error: construct one `Geocoder` per index. |
| `RANGE_NOT_SUPPORTED` | geocoder, download | no | The host returned 200 to a `Range` request. "This host doesn't support partial downloads." |
| `GEOMETRY_NOT_FOUND` | geocoder | no | `featureId` absent from the boundary file. Usually a version skew in disguise. |
| `DATASET_UNRESOLVED` | download | yes | Collection JSON unreachable or malformed. |
| `DATASET_UNSUPPORTED` | download | no | Design call #8's graceful refusal: "Downloads aren't supported for raster/zarr data." Name what was found. |
| `DATASET_NO_GEOMETRY_COLUMN` | download | no | "This table has no geometry column." |
| `DATASET_CRS_UNSUPPORTED` | download | no | Name the CRS found. |
| `FILTER_UNKNOWN_COLUMN` | download | no | Name the column and the nearest match (the plugin's `_suggest_column` behaviour). |
| `FILTER_UNSUPPORTED_PREDICATE` | download | no | Engine cannot express the predicate. |
| `FILTER_REQUIRES_ENGINE` | download | no | "This filter needs the DuckDB engine plugin." Name the requirement. |
| `CEILING_EXCEEDED` | download | no | **The refusal path.** `handle.result` rejects with this the moment the handle goes `blocked` (see the 2026-11-12 amendment below: it used to just wait, forever). Carries `context.breaches`, `context.limits` and `context.estimate`. Show the estimate, the limit, and a "download anyway" that calls `acceptCeiling()` — whose return value is the continued run's promise. |
| `FORMAT_UNAVAILABLE` | download | no | "GeoPackage output needs the @cngeo/format-gpkg plugin." |
| `FORMAT_CAPABILITY` | download | no | e.g. nested columns into GeoPackage, or a non-4326 CRS into any E10 plugin, or mixed geometry types into one Shapefile/Esri JSON file. Offer GeoParquet/GeoJSON. |
| `FORMAT_LOAD_FAILED` | download | **yes** | **Added by the lazy-format-loading amendment (E10).** A lazy format's CDN `load()` threw (network, usually). "Couldn't load the GeoPackage writer — check your connection and try again." Retryable: the registry's `resolveFormat` does not cache a rejection, so a retry re-attempts `load()`. |
| `SINK_PERMISSION_DENIED` | download | yes | User dismissed the save picker. Not an error worth a dialog. |
| `SINK_QUOTA_EXCEEDED` | download | no | "Too large to buffer in memory; use a browser that supports direct-to-disk saving." |
| `SINK_UNSUPPORTED` | download | no | Used internally to fall back from FS to Blob; surfaced only if both fail. |
| `NETWORK` | all | yes | Generic fetch failure. |
| `CORS` | all | no | Distinguished from `NETWORK` because the fix is the publisher's, not the user's. Name the host. |
| `HTTP_STATUS` | all | depends | Carries `context.status`. `retryable` for 5xx/429, not for 4xx. |
| `CANCELLED` | all | no | Never surfaced to the user. Rule 1 above is now enforced at the one place that was breaking it: `parquet-io.js` checks `signal.aborted` when a footer or row read throws, so an abort reports `CANCELLED` (and `state: 'cancelled'`) instead of the `NETWORK`/`DATASET_UNRESOLVED` the aborted `fetch` looked like. It tests the signal rather than the error's type, because a caller-supplied `fetch` may reject with anything. |
| `INTERNAL` | all | no | Bug. Include a repro hint and the package version. |

---

## 4. Zero-build ESM packaging

Design call #12 is binding: `sentinel-2-catalog/apps/explorer` imports
`hyparquet` straight from a CDN with no bundler, and these packages must drop
into that app. That rules out a lot of normal library practice.

### 4.1 Three build artifacts per package

| artifact | `exports` subpath | externals | consumer |
|---|---|---|---|
| `dist/<name>.js` | `.` | **bare specifiers** (`import … from 'hyparquet'`) | bundlers (vite/rollup/webpack), npm installs, `portolan-browser` |
| `dist/<name>.cdn.js` | `./cdn` | **pinned absolute CDN URLs** | zero-build ESM pages. **The design-call-#12 artifact.** |
| `dist/<name>.bundle.js` | `./bundle` | **none — everything inlined** | CSP-strict, air-gapped, or offline-first pages |

All three are ESM, minified, with a sourcemap and a `.d.ts`. The `.cdn.js` and
`.bundle.js` builds are produced from the same source by one esbuild pass each;
the only difference is an alias map.

```json
{
  "name": "@cngeo/extract-core",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".":        { "types": "./dist/index.d.ts", "default": "./dist/extract-core.js" },
    "./cdn":    { "types": "./dist/index.d.ts", "default": "./dist/extract-core.cdn.js" },
    "./bundle": { "types": "./dist/index.d.ts", "default": "./dist/extract-core.bundle.js" }
  },
  "dependencies": {
    "@cngeo/spec": "0.1.0",
    "hyparquet": "1.26.0",
    "hyparquet-compressors": "1.1.1",
    "hyparquet-writer": "^0.5.0"
  }
}
```

### 4.2 The decision: externalize `hyparquet` to a pinned CDN URL, do not inline it

In `dist/<name>.cdn.js`, a dependency import becomes an exact, pinned URL:

```js
// inside dist/extract-core.cdn.js
import { parquetMetadataAsync, parquetReadObjects } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.26.0/src/hyparquet.js';
import { compressors } from 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/src/index.js';
import { normalizeArea, splitAntimeridian } from 'https://cdn.jsdelivr.net/npm/@cngeo/spec@0.1.0/dist/spec.cdn.js';
```

**Why externalize rather than inline:**

1. **One module instance.** A page that uses both `geocoder-core` and
   `extract-core` — the whole point of this project — would otherwise load two
   copies of hyparquet: ~70 KB of duplicate transfer, two parse costs, two sets
   of module state. With the identical pinned URL, the browser's module map
   gives both packages the same instance, one fetch, one parse.
2. **It unifies with the host app.** `sentinel-2-catalog/apps/explorer` already
   imports hyparquet from a CDN. If our pinned URL matches theirs, the app pays
   for hyparquet once whether or not it loads our packages. If we inlined, the
   app would carry two.
3. **`@cngeo/spec` must be a singleton.** `instanceof CngError` and `Area`
   validation across package boundaries only behave if there is one `spec`
   module. Externalizing makes that structural rather than hoped-for.
4. **Security patching is a URL change.** A hyparquet CVE is fixed by republishing
   our packages with a bumped URL — or, for an urgent case, by the consumer
   adding one import-map entry — without waiting for a rebuild of every package.

**Why pinned, exact versions and never a range:** `.../hyparquet@1.26.0/...`,
never `hyparquet` or `hyparquet@1`. A floating CDN specifier means the code
running in a user's browser changes without anyone publishing anything. The
build fails if any CDN URL in a `.cdn.js` artifact lacks an exact
`@major.minor.patch`.

**The version-unification obligation this creates.** Benefit (1) above is real
only if every `@cngeo` package pins the *same* hyparquet URL — and the
ecosystem is already divergent: `portolan-browser` has `hyparquet@1.26.0` +
`hyparquet-compressors@1.1.1`, while E1's harness pinned `1.33.0` + `1.1.3`
from jsdelivr. So: **one hyparquet version per `@cngeo` release train**, declared
once in the repo root and injected into every package's alias map by the build,
with CI failing on a mismatch between any two packages. A consumer stuck on a
different version repoints it with one import-map line (§4.3) — which is the
other reason the import map ships. Picking the shared version is a release
chore, not a design question; the constraint is that it be exactly one.

**The costs, and what pays for them:**

- *CDN availability.* jsdelivr down means our packages fail to load. Paid for by
  `dist/<name>.bundle.js` (zero external fetches) and by the published import
  map (§4.3) that lets a consumer repoint every specifier at their own origin
  in one line.
- *A third-party origin in the dependency graph.* Documented plainly; the
  `.bundle.js` artifact is the answer for anyone who cannot accept it.
- *Subresource integrity is unavailable for ESM imports.* True today. Partly
  mitigated by exact pinning and by publishing SHA-256 digests of every
  artifact in the release notes and in `dist/integrity.json`.

**CDN choice:** `cdn.jsdelivr.net` primary — it serves correct
`Content-Type: text/javascript` and permissive CORS for `/npm/`, supports exact
version pinning, and is what the sentinel-2 explorer already uses. `esm.sh`
is explicitly *not* used for our own pinned URLs: it rewrites and re-bundles,
which would reintroduce duplicate instances. Documented as a consumer option,
not a build target.

### 4.3 A published import map

Each release publishes `dist/importmap.json`, so a zero-build page can use bare
specifiers — the nicest consumer experience, and the escape hatch for anyone
who wants to self-host:

```html
<script type="importmap">
{
  "imports": {
    "@cngeo/spec":            "https://cdn.jsdelivr.net/npm/@cngeo/spec@0.1.0/dist/spec.js",
    "@cngeo/geocoder-core":   "https://cdn.jsdelivr.net/npm/@cngeo/geocoder-core@0.1.0/dist/geocoder-core.js",
    "@cngeo/extract-core":   "https://cdn.jsdelivr.net/npm/@cngeo/extract-core@0.1.0/dist/extract-core.js",
    "@cngeo/maplibre":        "https://cdn.jsdelivr.net/npm/@cngeo/maplibre@0.1.0/dist/maplibre.js",
    "hyparquet":             "https://cdn.jsdelivr.net/npm/hyparquet@1.26.0/src/hyparquet.js",
    "hyparquet-compressors": "https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/src/index.js",
    "hyparquet-writer":      "https://cdn.jsdelivr.net/npm/hyparquet-writer@0.5.0/src/index.js"
  }
}
</script>
<script type="module">
  import { Geocoder } from '@cngeo/geocoder-core';
  import { estimate, download, autoSink } from '@cngeo/extract-core';
</script>
```

Note this map points at the **bare** `dist/<name>.js` artifacts: with an import
map, bare specifiers resolve, so the bare build is the right one. Swapping any
line to a self-hosted copy repoints that dependency for the whole page. Two
documented paths, then:

- **No import map:** import the `./cdn` artifacts by URL. Nothing to set up.
- **With an import map:** paste `importmap.json`, import bare specifiers, and
  own your origins.

### 4.4 Rules the source must obey

These are lint-enforced in CI, because each one is a way to silently break
zero-build consumption:

1. No Node builtins, no `process`, no `Buffer`, no `__dirname`.
2. **No dynamic `import()` of a bare specifier.** Without a bundler or an
   import map, `import('hyparquet')` throws. Optional heavy features are
   therefore **registered, not lazily imported**: the consumer imports
   `@cngeo/format-gpkg` themselves and calls `registerFormat(gpkgFormat)`. This
   is the single most consequential packaging rule in this document, and it is
   why §3.4 has `registerFormat` / `registerEngine` / `registerReader` rather
   than a `format: 'gpkg'` string that magically works.
3. No top-level `await` in core packages (it blocks the whole module graph).
   Permitted in `@cngeo/format-gpkg` and `@cngeo/engine-duckdb` for wasm
   instantiation, documented on each.
4. No CSS imports, no JSON import assertions, no `new URL(..., import.meta.url)`
   for anything that must be fetched — a CDN-relative asset fetch works, but the
   path becomes part of the public contract, so adapters inline their (tiny) CSS
   as a string.
5. Named exports only; no default exports. Every package exports `VERSION`.
6. Workers: a cross-origin script cannot be a `new Worker(url)` target. The
   wasm plugins create their worker from a Blob shim that `import()`s the
   absolute CDN URL — a two-line, well-known pattern, documented in the plugin
   READMEs rather than hidden in core.
7. `fetch` is always called through the injected `options.fetch`, defaulting to
   `globalThis.fetch`, and range reads always pass `cache: 'no-store'` (the
   measured sentinel-2 finding: Chrome serializes concurrent reads of one URL
   behind its cache lock, 2.1 s → 0.4 s for the same eight reads).

### 4.5 Bundle-weight budget

Targets for our own code; measured values for existing dependencies. **"min+gz"
is what crosses the wire.** Our packages are budgets to hold, not measurements
— they are marked as such.

| artifact | raw | min+gz | status | notes |
|---|---|---|---|---|
| `hyparquet@1.26.0` | 448 KB on disk | **35 KB** | **measured** (`src/*.js` concatenated, gzip -9) | pure JS ESM |
| `hyparquet-compressors@1.1.1` | 204 KB on disk | **79 KB** | **measured**, same method | zstd+snappy+brotli, pure JS, no wasm. Needed for every zstd file, i.e. all of ours |
| `hyparquet-writer` | — | ~20 KB | **estimate** — not installed locally; E5 measures | GeoParquet output |
| `@cngeo/spec` | — | **≤ 10 KB** | budget | bbox math, antimeridian, Visvalingam, validators. Types erase to nothing |
| `@cngeo/geocoder-core` | — | **≤ 15 KB** | budget | + spec + hyparquet(+compressors) |
| `@cngeo/upload-core` | — | **≤ 10 KB** | budget | GeoJSON only |
| `@cngeo/extract-core` | — | **≤ 30 KB** | budget | pruning, estimate, sinks, geojson + geoparquet writers |
| `@cngeo/maplibre` | — | **≤ 8 KB** | budget | `maplibre-gl` is a peer, not counted |
| `@cngeo/openlayers` | — | **≤ 9 KB** | budget | `ol` is a peer, not counted |
| `@cngeo/stac` | — | **≤ 6 KB** | budget | pure JSON traversal |

**Realistic page totals** (min+gz, excluding the map library):

| page | packages | total |
|---|---|---|
| geocoder only, full-load index | spec + geocoder-core + hyparquet + compressors | **~139 KB** |
| geocoder + maplibre adapter | + maplibre adapter | **~147 KB** |
| the whole widget (search + upload + download to GeoJSON/GeoParquet) | spec, geocoder, upload, download, maplibre, hyparquet, compressors, writer | **~207 KB** |

For comparison: `maplibre-gl` alone is roughly 200 KB min+gz. The core widget
is therefore about "one more map library" at worst, and about a third of that
if the host already loads hyparquet (as both `portolan-browser` and the
sentinel-2 explorer do).

**Optional plugins:**

| plugin | wasm | js | min+gz total | basis |
|---|---|---|---|---|
| `@cngeo/format-flatgeobuf` | — | 10,074 B | **~10 KB — measured** (E10) | jsdelivr `+esm` bundle of `flatgeobuf@4.6.1`'s `geojson` submodule, `gzip -9`. Lighter than estimated: loading only the GeoJSON-specific submodule (not the full package, which also pulls in Arrow-IO-adjacent machinery this plugin never touches) tree-shakes well. |
| `@cngeo/format-shapefile` | — | ~5 KB | **~5 KB — measured** (E10) | zero dependencies: hand-written `.shp`/`.shx`/`.dbf` + a STORED-only ZIP, no wasm |
| `@cngeo/format-extras` (CSV + Esri JSON) | — | ~2 KB | **~2 KB — measured** (E10) | zero dependencies |
| `@cngeo/format-gpkg` — sql.js path (**shipped, E10**) | 321,893 B | 17,352 B | **~339 KB — measured** (E10) | `sql.js@1.13.0`'s published `sql-wasm.wasm` + `sql-wasm.js`, `gzip -9`, plus this plugin's own ~3KB. Lighter than estimated (sql.js got smaller between the versions compared). Validated: `ogrinfo -al -so` + DuckDB's `ST_Read` read every table this plugin writes cleanly; a live FTW-Liechtenstein download round-trips end to end (`packages/format-gpkg/test/gpkg-integration.test.js`). R-tree: measured absent from sql.js's published wasm build (`CREATE VIRTUAL TABLE ... USING rtree` throws `no such module: rtree`); documented as a known gap, not required for the base GeoPackage profile. |
| `@cngeo/format-gpkg` — gdal3.js path | 9,074,360 B | — | **9.07 MB — measured** (E10) | `gdal3.js@2.8.1`'s `gdal3WebAssembly.wasm`, `gzip -9`. Heavier than the original estimate's upper bound; confirms the sql.js path above as the right default. Not implemented — stays `@cngeo/format-gdal` future work for drivers neither sql.js nor Shapefile's flat-file format can reach (File Geodatabase via `OpenFileGDB`, chiefly). |
| `terrio-js` (full) | 10,623,358 B | — | **10.6 MB — measured** (E10) | `terrio-js@0.8.0`'s published `terrio_bg.wasm`, `gzip -9`. **Works** — writes correct GeoPackage and Shapefile, validated with `ogrinfo`/DuckDB — but the heaviest candidate measured, disqualifying it from the "light path" mandate. See `experiments/e10-heavy-formats/RESULTS.md` §1. |
| `terrio-js/core` (GeoTIFF/COG, GeoJSON, FlatGeobuf, GeoPackage, Shapefile, PMTiles/MBTiles, CRS) | 6,059,247 B | — | **6.1 MB — measured** (E10) | same source, the smallest module terrio-js offers; still 18x the sql.js path above |
| `@cngeo/engine-duckdb` — mvp bundle | ~2.5 MB wasm (gz) | ~250 KB | **~2.8 MB** *(est.)* | DuckDB-WASM's own published bundle sizes |
| `@cngeo/engine-duckdb` — eh + spatial | **~6–9 MB wasm** | ~250 KB | **~6–9 MB** *(est.)* | the spatial extension is the bulk; needed for `ST_Intersects`/`ST_Intersection` |

Two consequences stated as policy, not preference:

- **GeoPackage is opt-in and labelled with its weight in the UI.** A format
  picker shows "GeoPackage (+~0.5 MB)" next to "GeoParquet (included)". If E5
  finds only the gdal3.js path viable, the label says "+~5 MB" and GeoPackage
  stops being a reasonable default for a widget on a public page.
- **DuckDB-WASM at 3–9 MB is ~15–45× the entire core widget.** That is design
  call #2's quantified justification, and it is why the engine seam exists at
  all: so the 2% of users who need `whereSql` or exact clip can have it without
  the other 98% paying for it.

---

## 5. Adapter contracts

### 5.1 What an adapter adds, and what it must not do

Core owns: index loading, normalization, ranking, geometry fetch, the `Area`,
simplification, pruning, estimation, downloading. Core imports **no** map
library and touches **no** DOM.

An adapter adds exactly five things:

1. **Search control UI** — an accessible combobox: `<input role="combobox">`
   + `<ul role="listbox">`, `aria-activedescendant`, arrow/enter/escape
   handling, debounce, loading and empty states, and the attribution that
   design call #11 requires.

   > **Amendment (2026-11-13, compact attribution).** The design-call-#11
   > attribution was an unconstrained-width text line inside the control;
   > a full geoBoundaries citation spanned the entire map (Chris: "Could
   > we make the display of the attribution a bit better? Like put it on
   > the bottom maybe with the 'i', instead of going over everything.").
   > It is now a compact widget modeled on MapLibre's own compact
   > attribution: a 24px circular ⓘ button anchored bottom-left of the
   > MAP (bottom-right belongs to the basemap attribution in both
   > MapLibre and OpenLayers), expanding upward into a themed pill
   > (max-width `min(70vw, 480px)`) carrying the same
   > `Area.provenance.attribution` text/links and the share-alike badge.
   > Collapsed by default; collapses on outside click and on each new
   > selection; keyboard accessible (`aria-expanded`/`aria-controls`);
   > mounted in MapLibre's bottom-left control corner / OL's stop-event
   > overlay container and removed on `onRemove`/`setMap(null)`.
   > `showAttribution: false` still suppresses it entirely. The pill
   > content element keeps the `.cng-attribution` class, so existing
   > assertions on its text keep working.

   The default option renderer (overridable via
   `renderItem`) shows `SearchResult.parentName`/`countryName` as
   disambiguating secondary text when the loaded index carries one (§3.2
   amendment, "Dropdown context" — e.g. `"Bag — Rajasthan · IND · ADM4"`),
   and appends `"(+N more)"` when `moreCount` is set by result diversity.
2. **Viewport provider** — a `() => BBox` over the live map, passed into
   `search()` for the ranking boost. The only reason the adapter needs the map
   at all for search.
3. **Outline layer** — renders `Area.geometry`, and optionally a ghost of
   `Area.filterGeometry` so a user can *see* that their filter was simplified.
4. **Camera** — `fitBounds` from `Area.bboxes`, antimeridian-aware (two boxes
   means fit the one nearer the current centre, or the union in a
   `renderWorldCopies` map).
5. **Projection bridge** — the only real asymmetry between the two adapters.
   Core is 4326-only; OpenLayers maps are frequently 3857 or something exotic,
   so the OL adapter reprojects on the way *in* (draw tool output) and *out*
   (layer rendering). MapLibre is 4326-native for GeoJSON sources, so its
   adapter does nothing here.

An adapter must **not**: fetch an index, rank results, simplify geometry,
construct an `Area` from raw coordinates without going through
`@cngeo/spec`'s normalizer, or hold dataset/filter state. Each of those is a
behaviour that would then differ between MapLibre and OpenLayers.

### 5.2 Signatures

```ts
// @cngeo/maplibre
import type { IControl, Map } from 'maplibre-gl';

export interface GeocoderControlOptions {
  /** **Required in practice. The documented `new Geocoder()` default is
   *  PLANNED, not implemented — §8, and deliberately so:** defaulting it
   *  here would make `@cngeo/maplibre`/`@cngeo/openlayers` import
   *  `@cngeo/geocoder-core` (and through it a parquet reader), which §4.5's
   *  adapter budget and §5.1's "what an adapter must not do" both rule
   *  out. With no `geocoder`, the control renders and accepts typing but
   *  every search is a no-op. Construct the `Geocoder` yourself and pass
   *  it; every example in this repo does. */
  readonly geocoder?: Geocoder;
  /** **PLANNED, not implemented — §8.** Accepted and ignored, for the same
   *  package-boundary reason as `geocoder`'s default above: honoring it
   *  means constructing a `Geocoder` in here. */
  readonly geocoderOptions?: GeocoderOptions;
  readonly placeholder?: string;
  readonly debounceMs?: number;             // default 80
  readonly useViewport?: boolean;           // default true
  readonly limit?: number;
  readonly fitBounds?: boolean | { padding?: number; maxZoom?: number };  // default true
  readonly outline?: false | AreaLayerStyle; // default: a sensible outline
  readonly showAttribution?: boolean;       // default true — see design call #11
  readonly renderItem?: (r: SearchResult) => string | Node;
}

export declare class GeocoderControl implements IControl {
  constructor(options?: GeocoderControlOptions);
  onAdd(map: Map): HTMLElement;
  onRemove(): void;
  readonly geocoder: Geocoder;
  readonly area: Area | null;
  setArea(area: Area | null): void;
  clear(): void;
  focus(): void;
  on<K extends 'select' | 'clear' | 'error' | 'results'>(event: K, handler: (p: unknown) => void): Unsubscribe;
}

export interface AreaLayerStyle {
  readonly lineColor?: string; readonly lineWidth?: number; readonly lineDasharray?: number[];
  readonly fillColor?: string; readonly fillOpacity?: number;
  /** Draw `filterGeometry` as a second, dashed outline when it differs. */
  readonly showFilterGeometry?: boolean;    // default true when simplified
  readonly beforeId?: string;
}

export interface AreaLayerHandle {
  setArea(area: Area | null): void;
  setStyle(style: AreaLayerStyle): void;
  fit(options?: { padding?: number; maxZoom?: number }): void;
  remove(): void;
}

export declare function addAreaLayer(map: Map, options?: AreaLayerStyle & { id?: string }): AreaLayerHandle;
export declare function viewportProvider(map: Map): () => BBox;
/** Minimal draw: rectangle (drag) and "use current viewport" (one click, no
 *  drag). Emits an Area with `source: 'draw'`, built through
 *  `@cngeo/spec`'s `buildArea` like every other Area this adapter produces.
 *  Not a replacement for mapbox-gl-draw/terra-draw; a host that already has
 *  a draw library passes its GeoJSON to `areaFromGeoJson` instead.
 *
 *  **Implemented 2026-11-13 — see the two amendments below.** All three
 *  tools work: rectangle and viewport first, then `polygon` (click each
 *  corner; double-click/Enter/first-corner closes; Escape cancels).
 *  `tools` still defaults to `['rectangle', 'viewport']`, so polygon is
 *  opt-in. No holes, no multi-part shapes, no snapping and no
 *  self-intersection check: a host needing those still brings its own draw
 *  library and passes its GeoJSON to `@cngeo/upload-core`'s
 *  `areaFromGeoJson` (`source: 'upload'`). */
export declare function createDrawTool(map: Map, options?: { tools?: ('rectangle'|'polygon'|'viewport')[], id?: string, names?: { drawn?: string, viewport?: string } }): DrawToolHandle;

export interface DrawToolHandle {
  readonly armed: boolean;
  /** `'viewport'` is one-shot: builds and emits an Area from the map's
   *  current bounds immediately, with nothing left armed afterward.
   *  `'rectangle'` arms a crosshair cursor and pointer drag; disarms itself
   *  the moment a non-degenerate rectangle is dragged out, or on `Escape`. */
  arm(tool?: 'rectangle' | 'viewport'): void;
  disarm(): void;
  on(event: 'area' | 'armed' | 'disarmed' | 'cancel', handler: (payload: unknown) => void): () => void;
  remove(): void;
}

/** Drag a displayed outline's vertices, insert a vertex at a midpoint
 *  (mousedown-drag on the midpoint marker), delete a vertex (double-click
 *  it) — single exterior ring only (the larger one, for a `MultiPolygon`);
 *  holes and other polygon components are carried through unedited, not
 *  dropped. Emits an updated Area with `source: 'edited'` on every commit
 *  — see §1.2's `EditedProvenance` for what it keeps from the parent. Hand-
 *  rolled rather than built on terra-draw; `packages/maplibre/src/
 *  edit-tool.js`'s header records the measured weight that comparison was
 *  based on and why it went the other way. */
export declare function createEditTool(map: Map, area: Area, options?: { id?: string }): EditToolHandle;

export interface EditToolHandle {
  on(event: 'change', handler: (payload: { area: Area }) => void): () => void;
  getArea(): Area;
  remove(): void;
}
```

### Amendment, 2026-11-13 — `createDrawTool` implemented; `createEditTool` added

`createDrawTool` moves from §8's "specified here, not implemented" table to
shipped (`packages/maplibre/src/draw-tool.js`): rectangle-by-drag and
one-click viewport, both producing an `Area` through `buildArea` (never a
hand-built provenance object, per §5.1). `polygon` stayed unimplemented at
first — declared in the `tools` type for forward compatibility, but
`arm('polygon')` threw, pointing at the `areaFromGeoJson` escape hatch. See
the second amendment below: it is implemented now. Keyboard: `Escape`
disarms rectangle mode, mid-drag or not.

`createEditTool` (`packages/maplibre/src/edit-tool.js`) is new, for "edit a
boundary you brought up with the place search": drag a vertex, drag a
midpoint marker out to insert a vertex there, double-click a vertex to
delete it (refused below a 3-vertex ring — a no-op, not a thrown error).
Built by hand rather than on terra-draw; the file's header has the measured
weight (terra-draw 1.39.0's jsdelivr `+esm` bundle: 262,509 B min / 48,359 B
gzip, plus its separate MapLibre-adapter package) and the version-pinning
argument against adding a second drawing library with its own compatibility
surface. The real cost of the choice made instead: only the largest
exterior ring of the Area's geometry is editable — holes and any other
polygon in a `MultiPolygon` pass through unchanged.

`@cngeo/openlayers` exports the same names with OL types
(`Control`, `Map` from `ol`, `VectorLayer`/`VectorSource` internally) and one
extra option:

```ts
export interface OlGeocoderControlOptions extends GeocoderControlOptions {
  /** The view projection to render into. Default: read from `map.getView()`.
   *  Core stays 4326; this is where the adapter bridges. */
  readonly featureProjection?: string;
}
```

Both adapters are ~250 lines of which ~150 is the shared combobox. That shared
part lives in `@cngeo/spec`? No — it is DOM, and `spec` is I/O-free. It lives in
an internal, unpublished `packages/_ui` workspace package that both adapters
inline at build time. Stated here because "the combobox is implemented twice"
would be the predictable drift.


### Amendment, 2026-11-13 (later) — `createDrawTool`'s `polygon` implemented

The amendment above left `polygon` as the one piece of `createDrawTool` that
still threw, on the reasoning that a half-working draw tool is worse than
none and that a host needing it could reach for terra-draw plus
`areaFromGeoJson`. The first host to need it — portolan-browser's download
widget, which wanted "Draw polygon" beside "Draw a box" — measured that
escape hatch at the ~262 KB `edit-tool.js` had already costed for terra-draw
and its MapLibre adapter, against about a hundred lines of click handling for
the thing actually wanted: click corners, close the ring.

So it is implemented, in the same file, with the same contract as the other
two tools: an `Area` through `buildArea`, `provenance.source: 'draw'`, and
`provenance.draw.tool: 'polygon'`. It was briefly written in the host
instead, shaped to this API so the move would be mechanical, and then moved
here and deleted there — the host now imports the shared tool, and its own
tests exercise it through its bundler alias.

Gestures: click to add a corner; double-click, `Enter`, or a click on the
first corner closes the ring; `Escape` cancels and emits `cancel` with
`duringDraw`. Fewer than three corners will not close and leaves the tool
armed, matching how a mousedown with no drag is ignored by the rectangle.
`doubleClickZoom` is disabled while armed and restored on disarm, and the
ordinary `click` MapLibre delivers as the first half of a double-click is
dropped rather than becoming a duplicate corner. The handle gains `tool` and
`vertices` getters.

One addition to the options, driven by the same host: `names: { drawn,
viewport }` overrides the emitted Area's display name, which previously was
the hardcoded English `'Drawn area'` / `'Current viewport'`. An adapter that
bakes in a user-visible string cannot be used by a translated host.

Still out of scope, and now said at the declaration rather than promised
away: no holes, no multi-part shapes, no vertex snapping, and no
self-intersection check — a ring the user crosses over itself is emitted as
drawn.

### 5.3 Hosting in `portolan-browser`

`portolan-browser` is Vue 3 + Vite, MapLibre + deck.gl, **already depends on
`hyparquet@1.26.0` and `hyparquet-compressors@1.1.1`**, and has **no**
OpenLayers and **no** DuckDB. That is a near-perfect fit: the download widget
adds our packages and no new heavy dependency.

Its four extension points, and which one each piece of this uses:

| extension point | mechanism | what we put there |
|---|---|---|
| `widgets.config.js` | hook id → array of `{ id, component, props, condition }`, rendered by `<WidgetHook>` | **the download panel.** `AreaDownload.vue` at `view-catalog-meta-end` and `view-item-secondary-end`, with `condition: ({ data }) => Boolean(stacToDescriptor(data))` so it appears only on collections/items that actually have downloadable vector GeoParquet |
| `assetActions.config.js` | `AssetActionPlugin` subclass with `show`/`uri`/`text` | **not used.** Asset actions produce a link-out (`uri`); a download panel is not a link. Noted because it is the tempting wrong answer |
| `stacActions.config.js` | `StacActionPlugin` on catalog/collection/item cards | *optional:* a "Download an area…" button on a collection card that scrolls to / opens the widget |
| `codeGenerators.config.js` | generator objects, Python first | **the reproducibility seam.** A `DownloadRequestGenerator` that emits the §2.3 `DownloadRequest` JSON, plus a `PythonGenerator` variant that emits the equivalent DuckDB SQL recipe. This is design call #7's "documented SQL recipes" delivered in the place portolan-browser already has for exactly this |

The glue, kept deliberately thin:

```
portolan-browser/
  widgets.config.js                 # +1 entry per hook
  src/widgets/AreaDownload.vue       # ~200 lines: the only new component
  src/codegen/DownloadRequestGenerator.js   # ~60 lines
```

`AreaDownload.vue` does four things and nothing else:

1. `stacToDescriptor(this.data)` — from `@cngeo/stac`, against the stac-js object
   already in the Vuex store. Returns `null` for raster/zarr, which is what the
   `condition` tests, so "not supported" is an absence rather than an error
   dialog (design call #8).
2. Mounts `GeocoderControl` and `addAreaLayer` from `@cngeo/maplibre` onto the
   **existing** `MapView.vue` map instance, obtained via the store rather than
   by creating a second map.
3. Renders the estimate and the ceiling refusal using
   `bootstrap-vue-next` components already in the project, so it inherits the
   theme.
4. Pipes `attribution` into the existing attribution slot.

Version coupling: `portolan-browser` pins `hyparquet` and so do we. Our
`package.json` lists `hyparquet` as a normal dependency, and the Vite build
dedupes to one copy — so inside portolan-browser we use the **bare** `.js`
artifacts, never `./cdn`. Worth stating because importing `./cdn` inside a
bundled app is exactly how you end up with two hyparquets.

### 5.4 Note for a future stac-browser widget

`portolan-browser` is a fork of STAC Browser and shares the widget/action/
codegen systems verbatim, so a stac-browser widget is the same
`AreaDownload.vue` with three subtractions:

- `@cngeo/stac`'s derivation must degrade gracefully when
  `partition:*`/`table:*`/`portolan:*` are absent — a plain STAC collection
  with one GeoParquet asset and GeoParquet file metadata is the floor. Already
  how §2.4's fallback chain is written; this is the reason it is written that
  way.
- No Portolan styles/render-order handling (that code is not in the widget
  anyway).
- The map instance lookup differs (upstream STAC Browser's `Map.vue`), so
  `AreaDownload.vue` should take the map as a prop rather than reaching into
  the store. **Design it that way from the start** — it costs one prop and
  removes the only portolan-specific line in the component.

Keeping `@cngeo/stac` a separate package is what makes this a 20-line diff
rather than a fork.

---

## 6. Index file interface

The contract between `@cngeo/geocoder-core` and the sidecar the
`portolan-mirrors/geoboundaries` catalog publishes. The catalog repo owns the
builder; this section is the interface it must satisfy. Two artifacts: a
**names index parquet** and a small **JSON manifest** beside it.

> **Amendments (2026-11-12, from the two shipped index builds).** Measured
> results from `portolan-mirrors/geoboundaries-catalog` (52K rows) and
> `portolan-mirrors/cn-geocoder-overture` (5.6M rows) revise three points:
> (1) **Row-group size scales with total rows**: the footer carries one record
> per column per row group and a range client reads the whole footer first, so
> the 100–150 KiB target only holds for small indexes — at 5.6M rows,
> ~477 KiB groups cut footer+first-group cost from 8.3 MB to 2.5 MB. The rule
> is now: *minimize (footer + page index + one row group)*, and restrict
> column statistics to prunable columns. (2) **`bbox` may be float32** with
> directed outward rounding (both catalogs do this; verified never-narrower).
> (3) **GeoParquet with a point geometry column is permitted** (Overture index
> carries ST_PointOnSurface so the collection renders); clients must read with
> `geoparquet: false` + `utf8: false` on binary columns regardless (see the
> hyparquet findings in PLAN.md). Alt-name rows may carry null
> geometry/geometry_ref; consumers resolve via the primary row (`alt_of`).

> **Further amendments (2026-11-12, client-side speed pass — this doc's
> `footer_bytes`/`footer_metadata_bytes` and `prominent_index` fields
> below).** All additive and **optional on every manifest entry**:
> `geocoder-core` is written to no-op gracefully on their absence (an
> older or not-yet-rebuilt manifest behaves exactly as before), so the
> catalog side can ship any of them independently and the client never
> needs a matching release to stay correct — only to stay as fast as it
> could be. **Shipped and verified live** against
> `portolan-mirrors/geoboundaries-catalog` the same day (`footer_bytes`/
> `footer_metadata_bytes` on every file entry; a level-2 `display` file;
> retuned `row_group_rows`), confirmed field-for-field below.
>
> **(4) `footer_bytes` and `footer_metadata_bytes`** — two exact
> trailing-byte counts, declared on the index manifest's `index` entry and
> on each boundary level's `full`/`display` entries (both live
> contiguously at the file's tail, in this order: `[data][page index]
> [footer metadata][8-byte length + "PAR1"]"`):
>
> - `footer_bytes` — the **whole trailing span**, footer metadata plus
>   page index. One range request of exactly this many bytes from the end
>   of the file leaves a reader holding all of the file's metadata,
>   period.
> - `footer_metadata_bytes` — the **thrift footer alone**, smaller than
>   `footer_bytes` by however big the page index is. This is the number a
>   hyparquet client should actually ask for: hyparquet has no sub-chunk
>   read and never reads page-index bodies at all, so fetching the extra
>   span `footer_bytes` covers would be pure waste for it.
>
> **`geocoder-core` passes `footer_metadata_bytes` as hyparquet's
> `initialFetchSize` — never `footer_bytes`** — falling back to
> `footer_bytes` only on a manifest old enough to declare that alone (a
> single-size field, pre-dating this distinction), then to hyparquet's own
> default when the entry declares neither
> (`geocoder.js`'s `initialFetchSizeOf`). Measured live, post-fix, against
> the geoBoundaries catalog: every boundary-file footer GET came back at
> exactly its declared `footer_metadata_bytes` (e.g. ADM0 full 271,716 B,
> ADM0 display 189,008 B, ADM2 display 200,258 B) — never hyparquet's
> 512 KB default, and never a second round trip. The gap this closes is
> real and measured on both catalogs: on 5 of the Overture names index's
> files the plain 512 KB speculative fetch is *short* (a guaranteed second
> round trip — the full Overture names index's own `footer_metadata_bytes`
> alone is 2,150,142 bytes), and on the geoBoundaries catalog the
> speculative fetch was measured *over*-fetching by roughly 5× on an ADM0
> boundary file (524,288 bytes fetched against an actual
> `footer_metadata_bytes` need of 271,716). The builder computes both
> numbers directly from the parquet writer's own footer-length output; a
> client cannot derive either without first fetching the footer, which is
> exactly the round trip these fields exist to skip.
>
> **(5) `prominent_index`** — a top-level manifest field, sibling to
> `index`: `{ url, size, checksum, row_count, row_groups, row_group_rows,
> footer_bytes, footer_metadata_bytes, sorted_by, load: "eager",
> rows_per_level, criteria: { ..., fallback } }` — the same per-file shape
> as a `boundaries[].full`/`.display` entry, plus catalog-authored
> `criteria` documenting *what* counts as prominent and *when a client
> should fall back* to the full index (machine-readable, but advisory —
> `geocoder-core` reads only `url`/`size`/`rows` (falling back to
> `row_count`, below) /`footer_bytes`/`footer_metadata_bytes`; `criteria`
> is for a UI or a human to read, not parsed). **Field name note:** the
> shipped Overture staging manifest uses `row_count`, not `rows`, matching
> every other per-file entry in this doc's schema (`boundaries[].full`/
> `.display` both use `row_count`) — `IndexInfo.prominent.rows` is filled
> from `prominent_index.rows ?? prominent_index.row_count` for this
> reason. Rows in the prominent index **share `feature_id`/`geometry_ref`/
> `name_norm` with the full index's own rows** for the same feature — a
> client must dedupe the two waves by `feature_id`, which is exactly what
> `search()`'s two-wave `resultsAddRows` check (below) already does.
>
> Names a **small (the shipped Overture one: 8.62 MiB, 108,919 rows —
> comfortably inside this doc's original ≤ 8 MB framing) subset** of the
> full names index — the catalog's own choice of what counts as
> "prominent" (the shipped criteria: every primary row at levels 0–3,
> every level-0 alt-language spelling, and level-4 localities at
> `cartography.prominence >= 50`) — built as an ordinary standalone
> names-index parquet satisfying every rule in §6.2/§6.3 on its own (sorted
> by `name_norm`, same schema, same `catalog_version`). The client
> eager-loads it in full on `load()`, in parallel with (not after) opening
> the main index, so `search()` can answer from it before the main index
> -- which may be tens of MB and take seconds to open in `range` mode --
> is even ready. See §3.2's `Geocoder#search()` doc comment and the
> "Two-wave search" semantics there for exactly how the two answers are
> merged/superseded; absence of this field is a complete no-op (every
> `search()` behaves exactly as it did before this existed, with exactly
> one answer per query).

### 6.1 Format

**Plain Parquet, not GeoParquet.** The index carries no geometry column, so
GeoParquet metadata would have nothing to describe and a `bbox` declared as a
GeoParquet 1.1 `covering` for a non-existent primary column is invalid. The
bbox is four ordinary `DOUBLE` columns inside a struct. This satisfies the
"pure parquet wherever possible" constraint without lying in the metadata.

### 6.2 Schema (design call #6, source-agnostic)

| column | parquet type | required | notes |
|---|---|---|---|
| `name_norm` | `BYTE_ARRAY` / `String` | **yes** | **The sort key.** NFD → strip combining marks (`\p{M}`) → lowercase → collapse whitespace → trim. After normalization the alphabet is: Unicode letters (any script), digits, space, `-`, `'`. Everything else is removed. |
| `name` | `BYTE_ARRAY` / `String` | **yes** | Display name exactly as published. |
| `level` | `INT32` | **yes** | 0-based admin level. |
| `country` | `BYTE_ARRAY` / `String`, dictionary | **yes** | ISO 3166-1 alpha-3. For an ADM0 row, its own code. |
| `feature_id` | `BYTE_ARRAY` / `String` | **yes** | `shapeID` for geoBoundaries. The stable logical key (design call #5). Never a row offset. |
| `source` | `BYTE_ARRAY` / `String`, dictionary | **yes** | e.g. `geoboundaries-cgaz`. Lets one index hold several sources and lets a result say where it came from. |
| `bbox` | `STRUCT<xmin, ymin, xmax, ymax: DOUBLE>` | **yes** | EPSG:4326 degrees. Signed: `xmin > xmax` means antimeridian-crossing (RUS, FJI). Powers the viewport ranking boost at zero extra cost. |
| `parent_name` | `String` | no | Disambiguates "Springfield" in a result list — rendered as dropdown secondary text (§3.2 amendment, "Dropdown context"). Overture's division-names index carries this; geoBoundaries' CGAZ-names index does not. Strongly recommended. |
| `parent_id` | `String` | no | `feature_id` of the parent, for a future drill-down. |
| `area_km2` | `DOUBLE` | no | **Amended 2026-11-12**: no longer just a hypothetical tiebreak — it's component (5) of the ranking comparator (§3.2) and the "keep the biggest" rule in result-diversity's dedupe. Both Overture's and geoBoundaries' names indexes carry this column. |
| `country_name` | `String` | no | **Added 2026-11-12.** geoBoundaries' CGAZ-names-index column: the ISO country's display name (e.g. `"Switzerland"` alongside `country: "CHE"`). Rendered as dropdown secondary text (§3.2 amendment) in place of `parent_name` when the index has this column instead. Overture's division-names index does not carry this (it has `parent_name` instead). |
| `geometry_ref` | `STRUCT<file: String(dict), row_group: INT32, row: INT64>` | no | **Advisory** fast path for `select()`. Never authoritative (§6.3). |
| `name_lang` | `String`, dictionary | no | E8. BCP-47. `null`/absent means "the published name, language unstated". |
| `alt_of` | `String` | no | E8. An alt-name row sets this to the primary row's `feature_id`; `null` on primary rows. A consumer dedupes by `feature_id` when showing results. **Also consumed by the ranking-residual follow-up** (§3.2): `isAlt = alt_of != null` is the comparator's primary-vs-alt tiebreak. |
| `class` | `String`, dictionary | no | **Reserved by the ranking-residual follow-up (§3.2), unpopulated on every index shipped so far.** A place-prominence class, e.g. `"city"`/`"town"`/`"village"`/`"hamlet"` — Overture's own vocabulary. Powers the ranking comparator's prominence tiebreak when `population` is absent. |
| `population` | `DOUBLE` or `INT64` | no | **Reserved by the ranking-residual follow-up (§3.2), unpopulated on every index shipped so far.** Powers the ranking comparator's prominence tiebreak (descending) ahead of `area_km2`, and is passed through to `SearchResult.population` for direct UI use. |

Validation on load: a missing required column → `INDEX_SCHEMA_MISMATCH` naming
the column. A present-but-wrong-typed column is the same error. No silent
coercion: a geocoder that guesses about its index is a geocoder that ranks
wrongly in production.

### 6.3 Layout guarantees

These are **requirements on the builder**, asserted by a builder self-check and
re-asserted by geocoder-core on load (cheaply, from the footer alone):

1. **Sort.** Rows sorted ascending by `(name_norm, level, country, feature_id)`.
   `name_norm` is compared **byte-wise on its UTF-8 encoding** — not with any
   locale collation — so that a JavaScript `a < b` on the same normalized
   strings agrees with the file's order. This is what makes the range path's
   binary search correct; a locale collation would quietly break it for
   non-ASCII names, which is most of the index.
2. **Declared sort.** The parquet footer's `sorting_columns` declares
   `name_norm` ascending, nulls first. geocoder-core refuses the `range`
   strategy on a file that does not declare it (`INDEX_SCHEMA_MISMATCH`), and
   falls back to `full` with a warning rather than binary-searching an
   undeclared order.
3. **Row groups — a byte target, not a row count.** Target **100–150 KB per
   row group**, which at the measured ~53 bytes/row for this schema is ≈2,048
   rows. E1 measured this directly: at ~49.5K rows, 2,048-row groups beat
   8,192-row groups on every scripted query — roughly half the latency and
   half the bytes (106–430 KB vs 429–869 KB on a first query) — with no
   measured downside, because the binary search over groups is O(log n) either
   way and the extra statistics cost a few hundred footer bytes. A byte target
   rather than a row count is what keeps per-query fetch size *constant as the
   index grows*, which is the only reason the range path is worth having.
   Explicitly **never one group**: E1's single-row-group variant had to fetch
   and decode all 2.6 MB for a 3-match query, reproducing at index scale the
   exact pathology E0 found in every tge-labs file.
4. **Statistics.** `name_norm` min/max present on every row group and **not
   truncated**. If the writer truncates long values, the builder must flag it in
   the manifest (`stats_truncated: true`) and geocoder-core then widens its
   binary search by one group on each side. Stated because a truncated max is
   the classic silent off-by-one in range-based prefix search.
5. **Page index.** Column index + offset index written, so the range path can
   read one page rather than a whole column chunk.
6. **Compression.** zstd, level ≥ 9. `hyparquet-compressors` carries zstd, and
   it is already a dependency.
7. **Dictionary encoding** on `country`, `source`, `level`, `name_lang`,
   `geometry_ref.file`.
8. **Size budget.** ≤ 3 MB for the default shipped index (design call #9).
   E1 measured **2.50 MB** for ADM0+ADM2 (49,530 rows, 7 columns, zstd), so the
   budget holds with room for ADM1. geocoder-core's `auto` strategy picks
   `full` at ≤ 5 MB and `range` above — so the default ships on the full-load
   path, and the fieldmaps ADM3/4 future (E1 extrapolates ~16 MB at 300K rows)
   crosses into `range` without an API change.

9. **Footer read size.** The manifest declares `index.size` and
   `index.row_groups`, so the range path can read the footer with one exactly-
   sized tail request. This matters: hyparquet's default speculative footer
   fetch is 512 KB, which E1 measured as ~20% of the whole 2.5 MB index spent
   just reading metadata. geocoder-core therefore passes an explicit
   `initialFetchSize` on the range path — 64 KB, widening once on a miss —
   rather than taking the default. (The full-load path is unaffected; it
   fetches the file.)

10. **No null names.** `name` and `name_norm` must be non-null on every row.
    The builder drops unnamed features and reports the count: E1 found **37 of
    49,349 CGAZ ADM2 rows have a null `shapeName`** (mostly Turkmenistan, a few
    Japan units). An unnamed feature cannot be found by name, so excluding it
    is correct — but the count belongs in the manifest
    (`dropped_unnamed: 37`) and in the upstream bug report, not silently in a
    `WHERE` clause.
11. **CORS + ranges.** The host must send `Access-Control-Allow-Origin`,
    `Accept-Ranges: bytes`, and expose `Content-Range` and `Content-Length`
    via `Access-Control-Expose-Headers`. source.coop does. A 200 response to a
    `Range` request → `RANGE_NOT_SUPPORTED`, and `auto` degrades to `full`.
    E1's harness needed a custom `serve.py` because `python3 -m http.server`
    answers a `Range` request with a 200 and the whole file — worth knowing,
    because that is precisely the failure this check catches, and it fails
    silently as "the range path is mysteriously slow" rather than as an error.

### 6.4 Version pinning: `shapeID` + catalog version

Design call #5 makes `shapeID` the stable key and has one pipeline build index
and mirror together. The mechanism:

**A manifest beside the index** (`index.json`), fetched first — it is ~1 KB and
tells the geocoder what it is about to load:

```json
{
  "spec": "cnmw-index/1.0",
  "source": "geoboundaries-cgaz",
  "index_version": "2026-11-12T00:00:00Z",
  "catalog_version": "geoboundaries-cgaz-2025-09-30",
  "rows": 53000,
  "levels": [0, 1, 2],
  "stats_truncated": false,
  "index": {
    "url": "./names.parquet",
    "size": 2847193,
    "footer_bytes": 61440,
    "checksum": "1220f3a1…",
    "row_groups": 18
  },
  "prominent_index": {
    "url": "./names-prominent.parquet",
    "size": 612000,
    "footer_bytes": 8192,
    "rows": 4800
  },
  "boundaries": [
    {
      "level": 0,
      "feature_id_column": "shapeID",
      "geometry_column": "geometry",
      "full": { "url": "../adm0/boundaries.parquet", "size": 93458112, "footer_bytes": 180224, "row_count": 218 },
      "display": { "url": "../adm0/display.parquet", "size": 7340032, "footer_bytes": 32768, "row_count": 218 }
    },
    { "level": 1, "feature_id_column": "shapeID", "geometry_column": "geometry",
      "full": { "url": "../adm1/boundaries.parquet", "size": 104857600, "footer_bytes": 212992, "row_count": 3600 },
      "display": { "url": "../adm1/display.parquet", "size": 9437184, "footer_bytes": 40960, "row_count": 3600 } },
    { "level": 2, "feature_id_column": "shapeID", "geometry_column": "geometry",
      "full": { "url": "../adm2/boundaries.parquet", "size": 101711872, "footer_bytes": 245760, "row_count": 49349 },
      "display": { "url": "../adm2/display.parquet", "size": 14680064, "footer_bytes": 57344, "row_count": 49349 } }
  ],
  "attribution": [
    { "text": "Boundaries: geoBoundaries CGAZ", "license": "CC-BY-4.0",
      "url": "https://www.geoboundaries.org/", "share_alike": false }
  ]
}
```

`footer_bytes`/`prominent_index` are both optional (see the "Further
amendments" block in §6's intro, above the format section) — the example
shows them populated only because this is the target shape once the
catalog side ships them; a manifest missing either is still fully valid
and `geocoder-core` reads it exactly as it did before either field
existed.

**The pinning rule.** `catalog_version` appears in three places, and all three
must agree:

1. the manifest's `catalog_version`;
2. the index parquet's footer key-value metadata (`cng:catalog_version`);
3. every boundary file's footer key-value metadata (`cng:catalog_version`).

`select()` reads the boundary file's footer anyway — it needs the row-group
offsets — so the check is free. On mismatch: `INDEX_VERSION_MISMATCH` carrying
both values, default `onVersionSkew: 'error'`. Hard failure is the right default
because the alternative is an `Area` whose geometry belongs to a different
generation of boundaries than its name, which is a wrong answer that looks
right.

**Why a logical key makes skew recoverable.** Because the index stores
`feature_id` (`shapeID`) and not a row offset, a skew is not fatal to the data —
only to the fast path. `onVersionSkew: 'warn'` therefore has a meaningful
behaviour: ignore `geometry_ref`, look the feature up by `shapeID`, and return
the geometry with a `warning` event. Had the index stored row offsets, a skew
would silently return *someone else's polygon*. This is the whole argument for
design call #5, and it is why `geometry_ref` is advisory:

**`select()`'s resolution order**, which is also the verification contract:

1. If `geometry_ref` is present and `catalog_version` matches: range-read that
   row group, decode `shapeID` for that row, **assert it equals
   `result.featureId`**. On mismatch, fall through — never trust the hint.
   **Client-side speed pass:** since `geometry_ref` already names the
   exact row, the verification read and the geometry read for that *same*
   row are issued in parallel rather than sequentially -- the geometry
   read is purely speculative until the verification read confirms the
   join key, and is discarded (not awaited further) on a mismatch. This
   trades one wasted speculative read in the rare mismatch case for
   shaving a full round trip off the overwhelmingly common hit.
2. Otherwise: read the boundary file's `shapeID` column chunks (dictionary-
   encoded, small, and the file is sorted by `(country, shapeID)` per the mirror
   recipe) to locate the row, then range-read that row group's geometry column.
3. If `shapeID` is absent entirely: `GEOMETRY_NOT_FOUND`.

**Handle reuse, across both paths.** The file handle + parsed footer
opened above is cached per `Geocoder` instance, keyed by boundary URL
(`footer_bytes`'s "Further amendments" block, above, covers the footer
read itself): a second `select()` against the same boundary file -- or
one that lands after the background footer prefetch (below) already
warmed the cache -- reuses it rather than re-opening the file and
re-fetching the footer. A cached handle never carries a particular
caller's `AbortSignal` (it can be shared by several concurrent/later
selects, and one caller's abort must never cancel another's read of the
same file); only the geometry decode itself still observes the signal.

**Footer prefetch.** Once `load()` is ready, `Geocoder` opens every
boundary file's footer declared in the manifest -- display variants
first (the default `resolution`), then full -- in the background, one at
a time via `requestIdleCallback` (`setTimeout` outside a browser), using
the same per-instance handle cache above. A failed prefetch is simply
dropped from the cache (never surfaced as a warning or error): nothing
the user did caused it, and `select()` just performs the real fetch
itself when it gets there. The effect: by the time a user actually picks
a result, the footer latency that `select()` → `resolveGeometry` would
otherwise pay synchronously has typically already been paid in the
background while they were still reading the dropdown.

**Requirements this places on the E2 boundary mirror**, so the two halves fit:

- sorted by `(country, shapeID)`, declared in `sorting_columns`;
- row groups ~1,000–2,000 rows, so one selection reads one group;
- `shapeID` min/max statistics per row group;
- a `bbox` struct column (used to populate `AreaFeatureRef.bbox` without
  decoding geometry);
- a **separate display-simplified file** per level, same row order, same
  `shapeID`, same `catalog_version` — so `resolution: 'both'` is two range
  reads at the same row index, not a join;
- `cng:catalog_version` in the footer metadata of each.

---

## 7. Open items

Genuinely unresolvable until E1/E2 numbers land (or until an external decision
arrives). Each has the default I would ship today, so nothing here blocks E3
implementation.

| # | item | blocked on | **default I'd pick** |
|---|---|---|---|
| **O1** ✅ | npm scope. `@cngeo` is short (matters in CDN URLs) but cryptic; availability unverified. | an `npm view` check and Chris's preference | **RESOLVED 2026-11-17: `@cngeo`.** Registry checked — zero published packages under `@cngeo` *or* `@cngeo`, so the choice was free. `@cngeo` is equally short and actually expands ("cloud-native geospatial"). Package *names* (`geocoder-core`, `extract-core`, …) were settled either way. |
| **O2** | `filterVertexCeiling = 10,000`. | E5 measuring per-row point-in-polygon cost at 1k/10k/50k vertices against a real FTW/FIRMS download | **10,000.** Raise it if E5 shows the cost is negligible; the mechanism (auto-simplify + reported `areaDeltaRatio`) does not change either way. |
| **O3** | ~~`loadStrategy: 'auto'` threshold, 5 MB.~~ **Resolved by E1.** | — | **5 MB, confirmed.** E1: the 2.50 MB index full-loads in 203 ms (8 ms fetch + 196 ms decode, localhost) and answers warm keystrokes in 0.0–0.1 ms; the range path adds round trips for no benefit at this size. Extrapolated, a 300K-row index is ~16 MB and would full-load in ~1.2 s, already past the cold budget — so 5 MB sits correctly between the two. **Residual unknown:** E1's cold number is localhost; the 1 s budget is "on broadband", so the real cold-focus fetch of 2.5 MB over the public path is still unmeasured. Default stands; re-check in E6 against source.coop. |
| **O4** | ~~Whether `searchSync` is worth its API surface.~~ **Resolved by E1.** | — | **Ship it.** E1 measured warm full-load search at **0.0 ms p50, 0.1 ms p95** — a binary search over an in-memory array. At that cost the promise is not an optimization detail, it *is* the per-keystroke cost, and an `await` per keystroke also forces the caller's render into a later microtask. Keep the `state`-guarded throw. |
| **O5** | ~~GeoPackage: sql.js vs gdal3.js.~~ **Resolved by E10.** | — | **sql.js, shipped as `@cngeo/format-gpkg`.** Measured 339 KB min+gz (lighter than the ~480 KB estimate), validated with `ogrinfo -al -so` and DuckDB's `ST_Read` — a live FTW-Liechtenstein download round-trips end to end. gdal3.js measured 9.07 MB gzip (heavier than the estimate's ~2–8 MB upper bound), confirming sql.js as the right default; stays `@cngeo/format-gdal` future work. **New candidate found and rejected on weight, not function:** `terrio-js` (opengeos/terrio), a pure-Rust GDAL-adjacent I/O library with wasm bindings — it genuinely works (writes correct, `ogrinfo`/DuckDB-validated GeoPackage *and* Shapefile) but its smallest module (`terrio-js/core`) measures 6.1 MB gzip, 18x the sql.js path; not shipped. Shapefile also shipped (`@cngeo/format-shapefile`, zero deps, ~5 KB), FlatGeobuf shipped (`@cngeo/format-flatgeobuf`, ~10 KB, lighter than its own ~25 KB estimate), and CSV + Esri JSON shipped (`@cngeo/format-extras`, zero deps). See `experiments/e10-heavy-formats/RESULTS.md` for every measurement and the terrio verdict in full. |
| **O6** | Non-4326 datasets. Design call #4 makes `Area` 4326-only, but a dataset in 3857 or a UTM zone is common. | whether E6/E7 hit one in practice | **Refuse with `DATASET_CRS_UNSUPPORTED`**, naming the CRS and the `ogr2ogr` command that fixes it. Reprojecting *features* needs proj in core; reprojecting the *area* to the dataset's CRS needs proj too and silently changes what "intersects" means near the edges. Revisit as `@cngeo/reproject` (a thin `proj4` wrapper — `portolan-browser` already depends on `proj4`). |
| **O7** | Exact clip implementation. `intersects` needs only point-in-polygon; `clip` needs real polygon intersection. | E5 choosing between a ~15 KB `polygon-clipping` dependency in `extract-core` vs. requiring `@cngeo/engine-duckdb` | **Ship `clip` as a small opt-in plugin** (`@cngeo/clip`, registering a clipper), so core stays at its 30 KB budget and `clip` does not imply a 3–9 MB DuckDB. Already the shape of §1.4's `dissolver` and §3.4's registration seam. |
| **O8** | Default `ceiling` numbers (5M rows / 2 GiB output / 500 files). | E5/E6 observing what a plausible FIRMS-month or S2-year request actually produces | **As tabled.** They are deliberately generous: the ceiling's job is to stop the accident, not to second-guess the user, and `acceptCeiling()` is one call away. |
| **O9** | Partition enumeration where no `collection-mirror` exists and `item` links number in the hundreds (fieldmaps' 518 per-country collections is the live example). | E7 hitting it | **`stac-items` with a bounded concurrency of 8 and a hard cap of 200 item fetches**, above which the estimate reports `files.total` as unknown and pruning falls back to glob-expansion by declared `PartitionKey.values`. Also: advocate for `collection-mirror` as a Portolan best practice — it is the right fix, and it belongs upstream. |
| **O10** | Multilingual rows in the default index (`name_lang`, `alt_of`). | E8, and design call #11's licensing question (Chris flagged it) | **Columns reserved in the schema now, unpopulated in the default CC-BY index.** Reserving them costs nothing; adding columns later forces an index-version bump and a geocoder release. The ODbL-enriched index is a separate artifact at a separate URL with `share_alike: true` attribution that the adapter is required to surface. |
| **O11** | `@cngeo/spec` as a hard singleton. If two packages on one page resolve different `spec` versions, `instanceof` checks and `Area` validation diverge. | nothing — it is a design choice to make now | **Runtime guard:** `spec` registers itself on `globalThis[Symbol.for('cng.spec')]` with its version; a second, different version logs one loud warning and the later loader defers to the first for the validators. Ugly, and the only thing that actually catches this in a zero-build page. |
| **O12** | Whether `estimate()` should ever read data pages. Metadata-only is cheap and honest; it makes row estimates wide (`Bounded.exact: false`) when predicate selectivity is unknown. | E5 measuring how wide "wide" is on real requests | **Metadata-only, with an opt-in `sample: { rowGroups: 1 }`** that reads one admitted row group to calibrate selectivity. Report `estimate-wide` when `max/estimate > 10` so the UI can say "between 2,000 and 400,000 rows" instead of pretending to know. |
| **O13** | deck.gl adapter. `PLAN.md` leaves it open; `portolan-browser` has deck.gl. | E7 finding MapLibre's GeoJSON source insufficient for a large outline | **Not now.** `addAreaLayer` on a MapLibre GeoJSON source handles one outline at the display vertex ceiling. A `@cngeo/deckgl` adapter is additive and needs no core change. |

---

## 8. Specified here, not implemented

*Added 2026-11-12, from an audit that read every interface in this document
against `packages/*/src`.* Everything above describes shipped behaviour
**except** the entries below. Each is marked **PLANNED, not implemented —
§8** at its declaration, so nobody reads an interface here and assumes it
works; this table is the single list, with the reason it has not been
built and the thing to do instead today.

The distinction matters because this document is normative: an API that is
specified but absent costs a consumer more than one that was never
specified, and two of these were actively harmful before this pass (a
silent fallback, and a promise that never settled — both now fixed rather
than merely documented).

| what | where it is declared | what happens today | why not implemented / what to do instead |
|---|---|---|---|
| `indexUrl` as an **array** (multi-source search) | §3.2 `GeocoderOptions.indexUrl` | A one-element array works. Two or more now throw `INDEX_MULTI_SOURCE_UNSUPPORTED`. **Was** a silent fallback to `DEFAULT_INDEX_URL` — a caller naming two gazetteers got a third, with no error. | Real multi-source means parallel manifest loads, N open indexes queried per keystroke, merged ranking and a partial-failure policy — and design call #6 already puts cross-source merging/dedupe out of scope. Construct one `Geocoder` per index and merge in your own UI. |
| `load:progress` | §3.2 `GeocoderEvents` | Never emitted. Subscribing succeeds and the handler never fires. | Needs byte counting against `content-length` through both the manifest and index fetches, plus throttling (an unthrottled emit on a 4 MB index fires hundreds of times). Genuinely worth building — cold index load, 1.9–5.3 s, is this library's biggest measured UX gap — but it is a feature, not a doc fix. Until then: the `state` event's `'loading'` → `'ready'` transition is what a spinner needs. |
| `GeocoderControlOptions.geocoder`'s `new Geocoder()` default, and `geocoderOptions` | §5.2 | No default; `geocoderOptions` is accepted and ignored. With no `geocoder` the control renders and types but never searches. | **Deliberate, and should stay.** Either would make the adapters import `@cngeo/geocoder-core` and through it a parquet reader, against §4.5's adapter budget and §5.1's rules. The adapters take a `Geocoder`; the host constructs it. |
| `GeometryResolverOptions.boundaryUrls` | §3.2 | Accepted and ignored; boundary URLs always come from the manifest. | Small (two call sites in `select()`), but nothing needs it: the manifest is the versioned source of truth for which file a level lives in, and an override that disagrees with it silently defeats §6.4's version-skew check. Mirror the catalog and point `indexUrl` at your manifest instead. |
| `GeocoderOptions.initialFetchSize` | §3.2 | Accepted and ignored. | Superseded by the manifest contract: each file entry declares `footer_metadata_bytes`, so the footer read is exact *per file* rather than one global guess. Nothing is gained by letting a caller override an exact number with an estimate. |

**Resolved since this table was written, and so *not* in it:**
`createDrawTool` — implemented 2026-11-13 (rectangle + viewport, then
polygon later the same day; see the two §5.2 amendments). A `blocked`
handle's `result` now rejects (§3.4 amendment); cancellation now reports
`CANCELLED` rather than `NETWORK`/`DATASET_UNRESOLVED` (§3.5);
`DownloadCoreOptions.maxConcurrentRequests` is now honoured;
`DEFAULT_INDEX_URL` is now the published manifest; `rank.viewportRank`,
the two `UPLOAD_*` codes and the `deduped-points` repair kind are now
named correctly here.

---

## Appendix — provenance of the factual claims here

- Design calls #1–#12, the "near-instant" budgets, the default index URL, and
  the data-source decisions: `PLAN.md`.
- The index measurements folded into §6.3 and open items O3/O4 — 2.50 MB for
  49,530 rows, 203 ms cold full-load, 0.0 ms warm keystroke, rg2048 beating
  rg8192 roughly 2:1, the single-row-group variant re-reading the whole file,
  hyparquet's 512 KB default footer fetch, the 37 null `shapeName` rows, and
  the ~16 MB / ~1.2 s extrapolation at 300K rows:
  `experiments/e1-search-index/RESULTS.md`. That experiment's index is
  provisional (ADM0+ADM2, built from the tge-labs mirror); the official
  sidecar comes from the `portolan-mirrors/geoboundaries` catalog, and §6 is
  the contract it must satisfy.
- CGAZ single-row-group pathology, the mislabeled ADM1 file, the ~53K feature
  scale, the licensing table, and the fact that every tge-labs file is single-
  row-group: `PLAN.md` and `experiments/e0-data-recon/RESULTS.md`.
- `portolan-browser` extension points (`widgets.config.js` hook ids,
  `assetActions.config.js`'s `AssetActionPlugin` shape, `codeGenerators.config.js`),
  and its dependency set (Vue 3 + Vite, MapLibre + deck.gl, `hyparquet@1.26.0`,
  `hyparquet-compressors@1.1.1`, `proj4`, no OpenLayers, no DuckDB):
  `~/repos/portolan-browser/docs/widgets.md`, `docs/actions.md`, the config
  files, and `package.json`.
- DuckDB-WASM's 74–123 GETs / 6.6–49.5 s on app-shaped queries, the
  `cache: 'no-store'` cache-lock finding (2.1 s → 0.4 s for eight reads), and
  the "chain depth, not bytes, is the cost" conclusion:
  `~/repos/sentinel-2-catalog/docs/search-latency-experiments.md` and the
  header comment of `apps/explorer/search.js`.
- hyparquet 35 KB / hyparquet-compressors 79 KB gzipped: measured locally by
  concatenating each package's `src/*.js` and `gzip -9`.
- Portolan partition extension field names (`partition:scheme`,
  `partition:strategy`, `partition:keys`, `partition:file_count`,
  `partition:glob`) and `table:*` usage: the live
  `firms-catalog/catalog/detections/collection.json`,
  `sentinel-2-catalog/catalog/sentinel-2-c1-l2a/collection.json`, and
  `ftw-portolan/catalog/predictions/vectors/collection.json`. The
  `collection-mirror` asset role and single-`*`-per-segment glob semantics:
  `portolan-browser/src/utils/parquetGlob.js`.
- What the Python consumer already has (`DownloadJob`, `where_fragment`,
  `validate_where_fragment`, `core/sql.py`'s `sql_str`/`sql_ident`,
  `core/output_formats.py`, `core/copy_options.py`, `data/formats.json`,
  `data/presets.json`, `core/schema.py`'s dotted-path resolution):
  `~/repos/qgis_plugin_gpq_downloader/gpq_downloader/`.
- Every number marked *(est.)* in §4.5 is an estimate to be replaced by an E5
  measurement, and every `Bounded.exact: false` in §3.4 is the same honesty
  applied at runtime.
