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

---

## 0. Shape of the system

```
        ┌──────────────────┐   ┌────────────────┐   ┌─────────────┐
        │ @cnmw/geocoder-  │   │ @cnmw/upload-  │   │ (adapter    │
        │ core             │   │ core           │   │  draw tool) │
        │ names index →    │   │ GeoJSON file → │   │ map draw →  │
        └────────┬─────────┘   └───────┬────────┘   └──────┬──────┘
                 │                     │                   │
                 └──────────► A r e a ◄┴───────────────────┘        ← the seam
                                 │
                                 ▼
                      ┌─────────────────────┐
                      │ @cnmw/download-core │  ◄── DatasetDescriptor + FilterSpec
                      │ estimate / download │      (declarative JSON — also the
                      └──────────┬──────────┘       QGIS-shared artifact)
                                 │
                 ┌───────────────┼────────────────┐
                 ▼               ▼                ▼
          geojson writer   geoparquet writer   @cnmw/format-gpkg
            (in core)        (in core)           (opt-in plugin)
```

Three contracts carry the whole system, and all three are **plain JSON, versioned,
and serializable**: `Area`, `DatasetDescriptor`, `FilterSpec`. TypeScript
interfaces are the convenient form; JSON Schema (published in `@cnmw/spec`) is
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
// @cnmw/spec — area.ts

/** [west, south, east, north] in EPSG:4326 degrees. `west > east` means the
 *  box crosses the antimeridian; see `Area.bboxes` for the split form. */
export type BBox = [number, number, number, number];

/** The only geometry types an Area may carry. Points and lines are rejected:
 *  an area is an area. */
export type AreaGeometry =
  | GeoJSON.Polygon
  | GeoJSON.MultiPolygon;

export type AreaSourceKind = 'geocoder' | 'upload' | 'draw';

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

  /** What to filter with. `null` means "no usable polygon" — filtering falls
   *  back to `bboxes` alone, and download-core emits a
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
   *  Never interpreted by any @cnmw package. */
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
   *  download-core stamps this into GeoParquet/GeoPackage output metadata. */
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
  | { kind: 'dropped-feature'; count: number; reason: string };

export interface DrawProvenance {
  readonly tool: 'polygon' | 'rectangle' | 'circle' | 'viewport';
  /** The map's projection at draw time, for the record. The Area itself is
   *  always already reprojected to EPSG:4326 by the adapter. */
  readonly mapCrs: string;
  /** Circle tools only: the circle before it was polygonized. */
  readonly circle?: { center: [number, number]; radiusMeters: number; segments: number };
}
```

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
iterations, taking the largest tolerance whose output is under the ceiling;
abort early if `areaDeltaRatio > areaDeltaMaxRatio`. Deterministic, no
dependency on a geometry library, ~20 passes over the ring at worst, which for
a 200k-vertex input is milliseconds.

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
not, and download-core deduplicates by row identity within a file. Under
`spatial.mode = 'clip'` it produces overlapping output fragments. So:
`upload-core` detects overlapping input bboxes and sets
`warnings: ['overlapping-features']`; `download-core` refuses `clip` on an
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
5. **Pruning is per-box and unioned.** `download-core` runs partition and
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
`geometry`; `Area.bbox` ↔ the Feature's `bbox`. `@cnmw/spec` exports
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
// @cnmw/spec — dataset.ts

export interface DatasetDescriptor {
  readonly spec: 'cnmw-dataset/1.0';
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
   *  Lets download-core prune whole files with zero HTTP requests. */
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
  /** EPSG:4326 / OGC:CRS84 is the only value download-core filters against.
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
// @cnmw/spec — filter.ts

export interface FilterSpec {
  readonly spec: 'cnmw-filter/1.0';

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
   *  `@cnmw/spec`'s `requirementsOf(filter)`, and written into a serialized
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
  readonly spec: 'cnmw-output/1.0';
  /** Format plugin id. `geojson` and `geoparquet` are in core; `gpkg`,
   *  `flatgeobuf`, `csv`, `duckdb` come from plugins. */
  readonly format: string;
  readonly filename?: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface DownloadRequest {
  readonly spec: 'cnmw-request/1.0';
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
| `gpkg` | `{ layerName?: string, spatialIndex?: boolean (true) }` | Plugin. Non-streaming in the sql.js path. |
| `flatgeobuf` | `{ spatialIndex?: boolean (true) }` | Plugin. |
| `csv` | `{ geometry?: 'wkt'\|'drop' ('wkt'), delimiter?: string (',') }` | Plugin. |

### 2.4 Resolution: collection JSON → descriptor

A `portolan-collection` source is resolved by `@cnmw/download-core`'s
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
- `requires` lists `'sql'` whenever `whereSql` is present. `download-core`'s
  default (hyparquet) engine refuses with `FILTER_REQUIRES_ENGINE` and names the
  capability; registering `@cnmw/engine-duckdb` makes it work.
- Both may be present; they are ANDed. A UI can therefore offer structured
  predicates for the common cases (which then prune row groups via statistics)
  and a raw fragment for the rest.
- `whereSql.fragment` is **untrusted text that becomes SQL**. The plugin's
  existing warning applies verbatim and is restated in our docs: treat a pasted
  filter like a small script. No `@cnmw` package ever puts a `whereSql` into a
  URL, a saved preference, or a generated code snippet without the user having
  typed it in this session.

### 2.6 Worked example 1 — single-file FTW GeoParquet

Fields of The World field boundaries for one country, high-confidence fields
only, as GeoPackage.

```json
{
  "spec": "cnmw-request/1.0",
  "dataset": {
    "spec": "cnmw-dataset/1.0",
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
    "spec": "cnmw-filter/1.0",
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
    "spec": "cnmw-output/1.0",
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
  "spec": "cnmw-request/1.0",
  "dataset": {
    "spec": "cnmw-dataset/1.0",
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
    "spec": "cnmw-filter/1.0",
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
    "spec": "cnmw-output/1.0",
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
  "spec": "cnmw-request/1.0",
  "dataset": {
    "spec": "cnmw-dataset/1.0",
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
    "spec": "cnmw-filter/1.0",
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
    "spec": "cnmw-output/1.0",
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
- `share_alike: true` on the attribution means `download-core` stamps the
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
spec is real. `@cnmw/spec` publishes the JSON Schemas to npm *and* as plain
files in this repo under `spec/`, so the Python side vendors a copy and
validates with `jsonschema` (already an indirect QGIS dependency).

---

## 3. Package design and public APIs

### 3.1 Names

npm scope **`@cnmw`** (cloud-native map widgets). Short matters here: these
specifiers appear verbatim in CDN import URLs in every example, and
`@cloud-native-map-widgets/download-core` makes a 90-character import line.
Availability of the scope is unverified — [open item O1](#7-open-items), with
`@cn-widgets` as the fallback.

| package | contents | depends on |
|---|---|---|
| `@cnmw/spec` | TypeScript types + JSON Schemas for `Area`, `DatasetDescriptor`, `FilterSpec`, `OutputRequest`, `DownloadRequest`; pure helpers: bbox math, antimeridian split/detect, Visvalingam simplify, normalize/validate `Area`, `requirementsOf(filter)`, `toAreaDocument`/`fromAreaDocument`. **No I/O, no dependencies.** | — |
| `@cnmw/geocoder-core` | index load (full + range), normalization, prefix search, ranking, geometry resolution → `Area`. Framework-agnostic, no DOM. | `@cnmw/spec`, `hyparquet`, `hyparquet-compressors` |
| `@cnmw/upload-core` | file/drop handling, GeoJSON parse, validate/repair, combine, → `Area`. GeoJSON only (E4). | `@cnmw/spec` |
| `@cnmw/download-core` | dataset resolution, pruning cascade, estimate, streaming download, sinks, format registry, `geojson` + `geoparquet` writers. | `@cnmw/spec`, `hyparquet`, `hyparquet-compressors`, `hyparquet-writer` |
| `@cnmw/maplibre` | `GeocoderControl`, `AreaLayer`, `DrawTool` (thin), viewport provider. | `@cnmw/spec`; **peer**: `maplibre-gl` |
| `@cnmw/openlayers` | the same three, OpenLayers flavour. | `@cnmw/spec`; **peer**: `ol` |
| `@cnmw/format-gpkg` | GeoPackage writer plugin. Opt-in, heavy. | `@cnmw/spec` |
| `@cnmw/format-flatgeobuf` | FlatGeobuf writer plugin. Opt-in, light. | `@cnmw/spec` |
| `@cnmw/engine-duckdb` | DuckDB-WASM engine plugin + benchmark harness. Opt-in, heavy. Design call #2: never in core. | `@cnmw/spec`; **peer**: `@duckdb/duckdb-wasm` |
| `@cnmw/stac` | `stacToDescriptor(stacObject)` — the §2.4 derivation as a standalone function over a plain STAC JSON. Extracted so `portolan-browser` and a future `stac-browser` widget share it. | `@cnmw/spec` |

Why `@cnmw/spec` exists as its own package rather than living in
`geocoder-core`: all five runtime packages need the `Area` contract, and a page
that loads `geocoder-core` and `download-core` from a CDN must get **one**
`Area` implementation, not two. A shared, separately-versioned, zero-dependency
spec package is the only way to guarantee that across independent CDN imports.

Why `@cnmw/stac` is separate from `download-core`: design call #8 wants
portolan glue thin, and E7's notes want a stac-browser extraction path. The
STAC→descriptor derivation is the *entire* portolan-specific surface. Isolating
it means the future stac-browser widget is "same packages, different host
component", not a fork.

### 3.2 `@cnmw/geocoder-core`

```ts
// @cnmw/geocoder-core

export interface GeocoderOptions {
  /** Default: `DEFAULT_INDEX_URL` — the published
   *  portolan-mirrors/geoboundaries sidecar (design call #10). An array means
   *  several sources searched together; results carry `source`. Merging and
   *  dedupe across sources is explicitly out of scope (design call #6): the
   *  results are concatenated and ranked, duplicates included. */
  readonly indexUrl?: string | readonly string[];

  /** `full` fetches the whole index once (design call #9's default path);
   *  `range` binary-searches row groups over HTTP ranges; `auto` picks `full`
   *  when the index's declared size is <= `fullLoadMaxBytes`, else `range`. */
  readonly loadStrategy?: 'full' | 'range' | 'auto';   // default 'auto'
  readonly fullLoadMaxBytes?: number;                  // default 5_242_880 (design call #9)
  /** Range path only: footer tail read size. Default 65_536, widened once on
   *  a miss. Not hyparquet's 512 KB default, which E1 measured as ~20% of a
   *  2.5 MB index spent reading metadata. */
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
}

export type MatchClass = 'exact' | 'prefix' | 'word-prefix' | 'substring';

export interface SearchOptions {
  /** Current map viewport, for the ranking boost. The adapters supply this
   *  automatically; a bare core caller may omit it. */
  readonly viewport?: BBox;
  readonly limit?: number;
  readonly levels?: readonly number[];
  readonly countries?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface SearchResult {
  /** `shapeID` for geoBoundaries. The stable key (design call #5). */
  readonly featureId: string;
  readonly name: string;
  readonly nameNorm: string;
  readonly level: number;
  readonly country: string;
  readonly parentName?: string;
  readonly bbox: BBox;
  readonly source: string;

  readonly score: number;
  /** Why this ranked where it did. Exposed because an opaque score is
   *  untunable and untestable. */
  readonly rank: {
    readonly matchClass: MatchClass;
    readonly level: number;
    readonly levelAdjusted: number;
    readonly viewport: 'inside' | 'overlap' | 'near' | 'outside';
    readonly nameLength: number;
  };
  /** Advisory locator for the geometry fetch fast path (§6.3). Never
   *  authoritative: `select()` verifies `featureId` after reading. */
  readonly geometryRef?: { readonly file: string; readonly rowGroup?: number; readonly row?: number };
}

export interface GeometryResolverOptions {
  /** `display` fetches the pre-simplified variant (E2) and sets
   *  `geometryVariant: 'display-simplified'`; `full` fetches full resolution;
   *  `both` fetches display for `Area.geometry` and full for
   *  `Area.filterGeometry`. Default `display`. */
  readonly resolution?: 'display' | 'full' | 'both';
  /** Override the boundary file URLs the index sidecar declares. */
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
   *  to `[]` rather than rejecting (so a UI never has to track staleness). */
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

  on<K extends keyof GeocoderEvents>(event: K, handler: (payload: GeocoderEvents[K]) => void): Unsubscribe;

  /** Drops the in-memory index and aborts in-flight work. */
  close(): void;
}

export interface GeocoderEvents {
  'state': { state: GeocoderState };
  'load:progress': { bytes: number; total: number | null };
  'load': IndexInfo;
  'results': { query: string; results: SearchResult[]; elapsedMs: number };
  'select': { result: SearchResult; area: Area; elapsedMs: number };
  'error': CnmwError;
  /** Emitted when `onVersionSkew: 'warn'` and a skew was tolerated. */
  'warning': { code: string; message: string; detail?: unknown };
}

export type Unsubscribe = () => void;

export const DEFAULT_INDEX_URL: string;
export const VERSION: string;
```

**The ranking rule, normatively.** Results are sorted by this tuple, ascending,
with every component a total order:

1. `matchClassRank` — `exact` 0, `prefix` 1, `word-prefix` 2, `substring` 3.
2. `levelAdjusted` = `level − (viewportBoost if viewport is 'inside' or 'overlap' else 0)`.
3. `level` — the raw level, so an ADM0 still beats a promoted in-viewport ADM1
   on a tie. This is what makes "ADM0 first, then ADM1, …" hold while still
   letting the viewport matter.
4. `viewportRank` — `inside` 0, `overlap` 1, `near` 2, `outside` 3.
5. `nameLength` ascending — "Contra Costa" before "Contra Costa Centre".
6. `nameNorm` ascending, then `featureId` ascending — so the order is
   deterministic and testable.

`viewportRank` is computed from `bboxes` (never the signed `bbox`): `inside` if
the feature bbox's centre is in the viewport, `overlap` if the boxes intersect,
`near` if the feature bbox intersects the viewport scaled by `nearFactor`
about its centre, else `outside`.

`score` is a derived `0..1` number for display only; the sort never reads it.

Usage:

```js
import { Geocoder } from 'https://cdn.jsdelivr.net/npm/@cnmw/geocoder-core@0.1.0/dist/geocoder-core.cdn.js';

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

### 3.3 `@cnmw/upload-core`

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
export declare function attachDropTarget(el: HTMLElement, onResult: (r: UploadResult) => void, options?: UploadOptions & { onError?: (e: CnmwError) => void }): Unsubscribe;
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

### 3.4 `@cnmw/download-core`

```ts
export interface DownloadCoreOptions {
  readonly fetch?: typeof fetch;
  /** Row-reading engine. Default: the built-in hyparquet engine (design
   *  call #2). `@cnmw/engine-duckdb` registers an alternative. */
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
   *  plugin supplies the bytes-per-row model. */
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
   *  neither `acceptCeiling()` nor `acceptCeiling: true` was given. */
  readonly result: Promise<DownloadResult>;

  /** Both forms of progress, same events. The async iterable exists so a
   *  `for await` loop is a legitimate consumer. */
  readonly progress: AsyncIterable<Progress>;
  on<K extends keyof DownloadEvents>(event: K, handler: (payload: DownloadEvents[K]) => void): Unsubscribe;

  /** The refusal path (design call #3): an explicit, auditable act. */
  acceptCeiling(): void;

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
  'error': CnmwError;
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
  close(): Promise<{ rows: number; bytes: number }>;
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
export declare class CnmwError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}
export declare class CancelledError extends CnmwError {}        // 'CANCELLED'
export declare class CeilingExceededError extends CnmwError {}  // 'CEILING_EXCEEDED'
export declare function isCnmwError(e: unknown): e is CnmwError;
```

| code | thrown by | retryable | what the UI should say / do |
|---|---|---|---|
| `AREA_INVALID_CRS` | spec, upload | no | "Only EPSG:4326 (lon/lat) data is supported." Offer reprojection instructions, not a reprojection. |
| `AREA_UNSUPPORTED_GEOMETRY` | upload | no | "This file has points/lines; an area needs polygons." |
| `AREA_EMPTY` | upload, geocoder | no | "No usable polygon in that file." |
| `AREA_VERTEX_CEILING` | spec | no | Only when auto-simplify is disabled. "Area too detailed; simplify or raise the ceiling." |
| `AREA_ANTIMERIDIAN_CLIP` | download | no | "Exact clip is not available across the antimeridian. Use intersects." |
| `UPLOAD_TOO_LARGE` | upload | no | Name the limit and the file size. |
| `INDEX_FETCH_FAILED` | geocoder | **yes** | "Couldn't load the place index." Retry button. |
| `INDEX_SCHEMA_MISMATCH` | geocoder | no | Developer error: index lacks a required column. Name the column. |
| `INDEX_VERSION_MISMATCH` | geocoder | no | "The boundary files were rebuilt; reload the page." Carries both versions. |
| `INDEX_TOO_LARGE` | geocoder | no | Only with `loadStrategy: 'full'` and an index over the cap. Suggest `'range'`. |
| `RANGE_NOT_SUPPORTED` | geocoder, download | no | The host returned 200 to a `Range` request. "This host doesn't support partial downloads." |
| `GEOMETRY_NOT_FOUND` | geocoder | no | `featureId` absent from the boundary file. Usually a version skew in disguise. |
| `DATASET_UNRESOLVED` | download | yes | Collection JSON unreachable or malformed. |
| `DATASET_UNSUPPORTED` | download | no | Design call #8's graceful refusal: "Downloads aren't supported for raster/zarr data." Name what was found. |
| `DATASET_NO_GEOMETRY_COLUMN` | download | no | "This table has no geometry column." |
| `DATASET_CRS_UNSUPPORTED` | download | no | Name the CRS found. |
| `FILTER_UNKNOWN_COLUMN` | download | no | Name the column and the nearest match (the plugin's `_suggest_column` behaviour). |
| `FILTER_UNSUPPORTED_PREDICATE` | download | no | Engine cannot express the predicate. |
| `FILTER_REQUIRES_ENGINE` | download | no | "This filter needs the DuckDB engine plugin." Name the requirement. |
| `CEILING_EXCEEDED` | download | no | **The refusal path.** Show the estimate, the limit, and a "download anyway" that calls `acceptCeiling()`. |
| `FORMAT_UNAVAILABLE` | download | no | "GeoPackage output needs the @cnmw/format-gpkg plugin." |
| `FORMAT_CAPABILITY` | download | no | e.g. nested columns into GeoPackage. Offer GeoParquet. |
| `SINK_PERMISSION_DENIED` | download | yes | User dismissed the save picker. Not an error worth a dialog. |
| `SINK_QUOTA_EXCEEDED` | download | no | "Too large to buffer in memory; use a browser that supports direct-to-disk saving." |
| `SINK_UNSUPPORTED` | download | no | Used internally to fall back from FS to Blob; surfaced only if both fail. |
| `NETWORK` | all | yes | Generic fetch failure. |
| `CORS` | all | no | Distinguished from `NETWORK` because the fix is the publisher's, not the user's. Name the host. |
| `HTTP_STATUS` | all | depends | Carries `context.status`. `retryable` for 5xx/429, not for 4xx. |
| `CANCELLED` | all | no | Never surfaced to the user. |
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
  "name": "@cnmw/download-core",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".":        { "types": "./dist/index.d.ts", "default": "./dist/download-core.js" },
    "./cdn":    { "types": "./dist/index.d.ts", "default": "./dist/download-core.cdn.js" },
    "./bundle": { "types": "./dist/index.d.ts", "default": "./dist/download-core.bundle.js" }
  },
  "dependencies": {
    "@cnmw/spec": "0.1.0",
    "hyparquet": "1.26.0",
    "hyparquet-compressors": "1.1.1",
    "hyparquet-writer": "^0.5.0"
  }
}
```

### 4.2 The decision: externalize `hyparquet` to a pinned CDN URL, do not inline it

In `dist/<name>.cdn.js`, a dependency import becomes an exact, pinned URL:

```js
// inside dist/download-core.cdn.js
import { parquetMetadataAsync, parquetReadObjects } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.26.0/src/hyparquet.js';
import { compressors } from 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/src/index.js';
import { normalizeArea, splitAntimeridian } from 'https://cdn.jsdelivr.net/npm/@cnmw/spec@0.1.0/dist/spec.cdn.js';
```

**Why externalize rather than inline:**

1. **One module instance.** A page that uses both `geocoder-core` and
   `download-core` — the whole point of this project — would otherwise load two
   copies of hyparquet: ~70 KB of duplicate transfer, two parse costs, two sets
   of module state. With the identical pinned URL, the browser's module map
   gives both packages the same instance, one fetch, one parse.
2. **It unifies with the host app.** `sentinel-2-catalog/apps/explorer` already
   imports hyparquet from a CDN. If our pinned URL matches theirs, the app pays
   for hyparquet once whether or not it loads our packages. If we inlined, the
   app would carry two.
3. **`@cnmw/spec` must be a singleton.** `instanceof CnmwError` and `Area`
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
only if every `@cnmw` package pins the *same* hyparquet URL — and the
ecosystem is already divergent: `portolan-browser` has `hyparquet@1.26.0` +
`hyparquet-compressors@1.1.1`, while E1's harness pinned `1.33.0` + `1.1.3`
from jsdelivr. So: **one hyparquet version per `@cnmw` release train**, declared
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
    "@cnmw/spec":            "https://cdn.jsdelivr.net/npm/@cnmw/spec@0.1.0/dist/spec.js",
    "@cnmw/geocoder-core":   "https://cdn.jsdelivr.net/npm/@cnmw/geocoder-core@0.1.0/dist/geocoder-core.js",
    "@cnmw/download-core":   "https://cdn.jsdelivr.net/npm/@cnmw/download-core@0.1.0/dist/download-core.js",
    "@cnmw/maplibre":        "https://cdn.jsdelivr.net/npm/@cnmw/maplibre@0.1.0/dist/maplibre.js",
    "hyparquet":             "https://cdn.jsdelivr.net/npm/hyparquet@1.26.0/src/hyparquet.js",
    "hyparquet-compressors": "https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/src/index.js",
    "hyparquet-writer":      "https://cdn.jsdelivr.net/npm/hyparquet-writer@0.5.0/src/index.js"
  }
}
</script>
<script type="module">
  import { Geocoder } from '@cnmw/geocoder-core';
  import { estimate, download, autoSink } from '@cnmw/download-core';
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
   `@cnmw/format-gpkg` themselves and calls `registerFormat(gpkgFormat)`. This
   is the single most consequential packaging rule in this document, and it is
   why §3.4 has `registerFormat` / `registerEngine` / `registerReader` rather
   than a `format: 'gpkg'` string that magically works.
3. No top-level `await` in core packages (it blocks the whole module graph).
   Permitted in `@cnmw/format-gpkg` and `@cnmw/engine-duckdb` for wasm
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
| `@cnmw/spec` | — | **≤ 10 KB** | budget | bbox math, antimeridian, Visvalingam, validators. Types erase to nothing |
| `@cnmw/geocoder-core` | — | **≤ 15 KB** | budget | + spec + hyparquet(+compressors) |
| `@cnmw/upload-core` | — | **≤ 10 KB** | budget | GeoJSON only |
| `@cnmw/download-core` | — | **≤ 30 KB** | budget | pruning, estimate, sinks, geojson + geoparquet writers |
| `@cnmw/maplibre` | — | **≤ 8 KB** | budget | `maplibre-gl` is a peer, not counted |
| `@cnmw/openlayers` | — | **≤ 9 KB** | budget | `ol` is a peer, not counted |
| `@cnmw/stac` | — | **≤ 6 KB** | budget | pure JSON traversal |

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

**Optional plugins — all estimates, all to be replaced by E5 measurements:**

| plugin | wasm | js | min+gz total | basis for the estimate |
|---|---|---|---|---|
| `@cnmw/format-flatgeobuf` | — | ~25 KB | **~25 KB** *(est.)* | `flatgeobuf` npm package is small, pure JS |
| `@cnmw/format-gpkg` — sql.js path | ~450 KB wasm (gz) | ~30 KB | **~480 KB** *(est.)* | sql.js is a SQLite build; GeoPackage is SQLite + a few tables we write ourselves. Non-streaming: buffers the DB in memory |
| `@cnmw/format-gpkg` — gdal3.js path | **~2–8 MB wasm** | ~60 KB | **~2–8 MB** *(est., wide)* | a GDAL wasm build with the drivers we'd need; the wide range is exactly why E5 must measure before this is offered as a default |
| `@cnmw/engine-duckdb` — mvp bundle | ~2.5 MB wasm (gz) | ~250 KB | **~2.8 MB** *(est.)* | DuckDB-WASM's own published bundle sizes |
| `@cnmw/engine-duckdb` — eh + spatial | **~6–9 MB wasm** | ~250 KB | **~6–9 MB** *(est.)* | the spatial extension is the bulk; needed for `ST_Intersects`/`ST_Intersection` |

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
   handling, debounce, loading and empty states, and the attribution line that
   design call #11 requires.
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
`@cnmw/spec`'s normalizer, or hold dataset/filter state. Each of those is a
behaviour that would then differ between MapLibre and OpenLayers.

### 5.2 Signatures

```ts
// @cnmw/maplibre
import type { IControl, Map } from 'maplibre-gl';

export interface GeocoderControlOptions {
  readonly geocoder?: Geocoder;             // default: new Geocoder()
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
/** Minimal draw: rectangle + polygon + "use current viewport". Emits an Area
 *  with `source: 'draw'`. Not a replacement for mapbox-gl-draw; a host that
 *  already has a draw library passes its GeoJSON to `areaFromGeoJson`. */
export declare function createDrawTool(map: Map, options?: { tools?: ('rectangle'|'polygon'|'viewport')[] }): DrawToolHandle;
```

`@cnmw/openlayers` exports the same five names with OL types
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
part lives in `@cnmw/spec`? No — it is DOM, and `spec` is I/O-free. It lives in
an internal, unpublished `packages/_ui` workspace package that both adapters
inline at build time. Stated here because "the combobox is implemented twice"
would be the predictable drift.

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

1. `stacToDescriptor(this.data)` — from `@cnmw/stac`, against the stac-js object
   already in the Vuex store. Returns `null` for raster/zarr, which is what the
   `condition` tests, so "not supported" is an absence rather than an error
   dialog (design call #8).
2. Mounts `GeocoderControl` and `addAreaLayer` from `@cnmw/maplibre` onto the
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

- `@cnmw/stac`'s derivation must degrade gracefully when
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

Keeping `@cnmw/stac` a separate package is what makes this a 20-line diff
rather than a fork.

---

## 6. Index file interface

The contract between `@cnmw/geocoder-core` and the sidecar the
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
| `parent_name` | `String` | no | Disambiguates "Springfield" in a result list. Strongly recommended. |
| `parent_id` | `String` | no | `feature_id` of the parent, for a future drill-down. |
| `area_km2` | `DOUBLE` | no | Display, and a tiebreak if `nameLength` ever proves insufficient. |
| `geometry_ref` | `STRUCT<file: String(dict), row_group: INT32, row: INT64>` | no | **Advisory** fast path for `select()`. Never authoritative (§6.3). |
| `name_lang` | `String`, dictionary | no | E8. BCP-47. `null`/absent means "the published name, language unstated". |
| `alt_of` | `String` | no | E8. An alt-name row sets this to the primary row's `feature_id`; `null` on primary rows. A consumer dedupes by `feature_id` when showing results. |

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
    "checksum": "1220f3a1…",
    "row_groups": 18
  },
  "boundaries": [
    {
      "level": 0,
      "feature_id_column": "shapeID",
      "geometry_column": "geometry",
      "full": { "url": "../adm0/boundaries.parquet", "size": 93458112, "row_count": 218 },
      "display": { "url": "../adm0/display.parquet", "size": 7340032, "row_count": 218 }
    },
    { "level": 1, "feature_id_column": "shapeID", "geometry_column": "geometry",
      "full": { "url": "../adm1/boundaries.parquet", "size": 104857600, "row_count": 3600 },
      "display": { "url": "../adm1/display.parquet", "size": 9437184, "row_count": 3600 } },
    { "level": 2, "feature_id_column": "shapeID", "geometry_column": "geometry",
      "full": { "url": "../adm2/boundaries.parquet", "size": 101711872, "row_count": 49349 },
      "display": { "url": "../adm2/display.parquet", "size": 14680064, "row_count": 49349 } }
  ],
  "attribution": [
    { "text": "Boundaries: geoBoundaries CGAZ", "license": "CC-BY-4.0",
      "url": "https://www.geoboundaries.org/", "share_alike": false }
  ]
}
```

**The pinning rule.** `catalog_version` appears in three places, and all three
must agree:

1. the manifest's `catalog_version`;
2. the index parquet's footer key-value metadata (`cnmw:catalog_version`);
3. every boundary file's footer key-value metadata (`cnmw:catalog_version`).

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
2. Otherwise: read the boundary file's `shapeID` column chunks (dictionary-
   encoded, small, and the file is sorted by `(country, shapeID)` per the mirror
   recipe) to locate the row, then range-read that row group's geometry column.
3. If `shapeID` is absent entirely: `GEOMETRY_NOT_FOUND`.

**Requirements this places on the E2 boundary mirror**, so the two halves fit:

- sorted by `(country, shapeID)`, declared in `sorting_columns`;
- row groups ~1,000–2,000 rows, so one selection reads one group;
- `shapeID` min/max statistics per row group;
- a `bbox` struct column (used to populate `AreaFeatureRef.bbox` without
  decoding geometry);
- a **separate display-simplified file** per level, same row order, same
  `shapeID`, same `catalog_version` — so `resolution: 'both'` is two range
  reads at the same row index, not a join;
- `cnmw:catalog_version` in the footer metadata of each.

---

## 7. Open items

Genuinely unresolvable until E1/E2 numbers land (or until an external decision
arrives). Each has the default I would ship today, so nothing here blocks E3
implementation.

| # | item | blocked on | **default I'd pick** |
|---|---|---|---|
| **O1** | npm scope. `@cnmw` is short (matters in CDN URLs) but cryptic; availability unverified. | an `npm view` check and Chris's preference | **`@cnmw`**, with `@cn-widgets` as fallback. Package *names* (`geocoder-core`, `download-core`, …) are settled either way. |
| **O2** | `filterVertexCeiling = 10,000`. | E5 measuring per-row point-in-polygon cost at 1k/10k/50k vertices against a real FTW/FIRMS download | **10,000.** Raise it if E5 shows the cost is negligible; the mechanism (auto-simplify + reported `areaDeltaRatio`) does not change either way. |
| **O3** | ~~`loadStrategy: 'auto'` threshold, 5 MB.~~ **Resolved by E1.** | — | **5 MB, confirmed.** E1: the 2.50 MB index full-loads in 203 ms (8 ms fetch + 196 ms decode, localhost) and answers warm keystrokes in 0.0–0.1 ms; the range path adds round trips for no benefit at this size. Extrapolated, a 300K-row index is ~16 MB and would full-load in ~1.2 s, already past the cold budget — so 5 MB sits correctly between the two. **Residual unknown:** E1's cold number is localhost; the 1 s budget is "on broadband", so the real cold-focus fetch of 2.5 MB over the public path is still unmeasured. Default stands; re-check in E6 against source.coop. |
| **O4** | ~~Whether `searchSync` is worth its API surface.~~ **Resolved by E1.** | — | **Ship it.** E1 measured warm full-load search at **0.0 ms p50, 0.1 ms p95** — a binary search over an in-memory array. At that cost the promise is not an optimization detail, it *is* the per-keystroke cost, and an `await` per keystroke also forces the caller's render into a later microtask. Keep the `state`-guarded throw. |
| **O5** | GeoPackage: sql.js vs gdal3.js. The weight gap is ~0.5 MB vs ~2–8 MB. | E5 measuring both wasm payloads and whether a hand-written sql.js GeoPackage writer passes `ogrinfo`/QGIS validation | **sql.js**, writing the GeoPackage tables ourselves. GeoPackage is a documented SQLite schema; we only need the vector-features profile. gdal3.js becomes a second plugin (`@cnmw/format-gdal`) for anyone who wants its other drivers and will pay for them. |
| **O6** | Non-4326 datasets. Design call #4 makes `Area` 4326-only, but a dataset in 3857 or a UTM zone is common. | whether E6/E7 hit one in practice | **Refuse with `DATASET_CRS_UNSUPPORTED`**, naming the CRS and the `ogr2ogr` command that fixes it. Reprojecting *features* needs proj in core; reprojecting the *area* to the dataset's CRS needs proj too and silently changes what "intersects" means near the edges. Revisit as `@cnmw/reproject` (a thin `proj4` wrapper — `portolan-browser` already depends on `proj4`). |
| **O7** | Exact clip implementation. `intersects` needs only point-in-polygon; `clip` needs real polygon intersection. | E5 choosing between a ~15 KB `polygon-clipping` dependency in `download-core` vs. requiring `@cnmw/engine-duckdb` | **Ship `clip` as a small opt-in plugin** (`@cnmw/clip`, registering a clipper), so core stays at its 30 KB budget and `clip` does not imply a 3–9 MB DuckDB. Already the shape of §1.4's `dissolver` and §3.4's registration seam. |
| **O8** | Default `ceiling` numbers (5M rows / 2 GiB output / 500 files). | E5/E6 observing what a plausible FIRMS-month or S2-year request actually produces | **As tabled.** They are deliberately generous: the ceiling's job is to stop the accident, not to second-guess the user, and `acceptCeiling()` is one call away. |
| **O9** | Partition enumeration where no `collection-mirror` exists and `item` links number in the hundreds (fieldmaps' 518 per-country collections is the live example). | E7 hitting it | **`stac-items` with a bounded concurrency of 8 and a hard cap of 200 item fetches**, above which the estimate reports `files.total` as unknown and pruning falls back to glob-expansion by declared `PartitionKey.values`. Also: advocate for `collection-mirror` as a Portolan best practice — it is the right fix, and it belongs upstream. |
| **O10** | Multilingual rows in the default index (`name_lang`, `alt_of`). | E8, and design call #11's licensing question (Chris flagged it) | **Columns reserved in the schema now, unpopulated in the default CC-BY index.** Reserving them costs nothing; adding columns later forces an index-version bump and a geocoder release. The ODbL-enriched index is a separate artifact at a separate URL with `share_alike: true` attribution that the adapter is required to surface. |
| **O11** | `@cnmw/spec` as a hard singleton. If two packages on one page resolve different `spec` versions, `instanceof` checks and `Area` validation diverge. | nothing — it is a design choice to make now | **Runtime guard:** `spec` registers itself on `globalThis[Symbol.for('cnmw.spec')]` with its version; a second, different version logs one loud warning and the later loader defers to the first for the validators. Ugly, and the only thing that actually catches this in a zero-build page. |
| **O12** | Whether `estimate()` should ever read data pages. Metadata-only is cheap and honest; it makes row estimates wide (`Bounded.exact: false`) when predicate selectivity is unknown. | E5 measuring how wide "wide" is on real requests | **Metadata-only, with an opt-in `sample: { rowGroups: 1 }`** that reads one admitted row group to calibrate selectivity. Report `estimate-wide` when `max/estimate > 10` so the UI can say "between 2,000 and 400,000 rows" instead of pretending to know. |
| **O13** | deck.gl adapter. `PLAN.md` leaves it open; `portolan-browser` has deck.gl. | E7 finding MapLibre's GeoJSON source insufficient for a large outline | **Not now.** `addAreaLayer` on a MapLibre GeoJSON source handles one outline at the display vertex ceiling. A `@cnmw/deckgl` adapter is additive and needs no core change. |

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
