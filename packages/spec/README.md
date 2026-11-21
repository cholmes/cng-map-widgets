# @cngeo/spec

The shared contracts every other `@cngeo` package speaks, plus the pure geo
helpers they all need. **No I/O, no DOM, no dependencies** — `fetch` is never
called from this package, and nothing here knows what a map is.

Three things live here:

1. **The `Area`** — the object a geocoder selection, a GeoJSON upload or a map
   draw tool all produce, and the only thing `@cngeo/extract-core` consumes.
   This is the seam that makes the widgets composable.
2. **The error taxonomy** — one `CngError` class with a stable string `code`.
3. **Pure functions** — bbox math with real antimeridian handling, Visvalingam
   simplification (sync and chunked-async), WKB → GeoJSON, and the name
   normalization the gazetteer index builders use.

`@cngeo/spec` is a separate package for one reason: a page that loads
`geocoder-core` and `extract-core` from a CDN must get **one** `Area`
implementation, not two. See [Why one copy matters](#why-one-copy-matters).

- **Status:** experimental, pre-npm. See the [root README](../../README.md).
- **Normative design:** [`docs/design/widgets-architecture.md`](../../docs/design/widgets-architecture.md) §1 (`Area`), §2 (descriptor/filter), §3.5 (errors).
- **License:** MIT (code). This package carries no data and imposes no data license.

---

## Install / import

Nothing is published to npm yet. Today you point an import map at the source:

```html
<script type="importmap">
{ "imports": { "@cngeo/spec": "/packages/spec/src/index.js" } }
</script>
<script type="module">
  import { buildArea, normalizeName } from '@cngeo/spec';
</script>
```

In Node or a bundler, with this repo as a workspace:

```js
import { buildArea, normalizeName } from '@cngeo/spec';
```

**Coming:** `npm i @cngeo/spec`, and a CDN form —
`import { buildArea } from 'https://cdn.jsdelivr.net/npm/@cngeo/spec@0.3.0/src/index.js'`.
The module code never changes between those; only the specifier does.

## Size

No build step exists yet, so what crosses the wire is the commented source.

| | files | raw | gzip | gzip, comments stripped | design-doc budget (§4.5) |
|---|---|---|---|---|---|
| `@cngeo/spec` src | 9 | 47.0 KiB | 13.8 KiB | **6.2 KiB** | ≤ 10 KB min+gz |

Measured with `cat src/*.js | gzip -9`; the stripped column is the same with
block and line comments removed, which is the closest honest stand-in for the
minified build that §4.5 budgets against. This package is comfortably inside
its budget; the gap between columns 4 and 5 is doc comments, which a build
would drop.

---

## The `Area`

```js
{
  type: 'Area',
  version: 1,
  id: 'area_m3z8k1a9f2b',        // session-stable, not a global id
  name: 'Contra Costa',
  crs: 'EPSG:4326',              // the only legal value
  bbox: [-122.42, 37.71, -121.55, 38.11],   // SIGNED; west > east means it wraps
  bboxes: [[-122.42, 37.71, -121.55, 38.11]], // COMPUTATIONAL: 1 or 2 normalized boxes
  crossesAntimeridian: false,
  geometry: { type: 'Polygon', coordinates: [ /* what you draw */ ] },
  filterGeometry: { type: 'Polygon', coordinates: [ /* what you filter with */ ] },
  vertexCount: { display: 41, filter: 41 },
  provenance: {
    source: 'geocoder',          // 'geocoder' | 'upload' | 'draw'
    createdAt: '2026-11-12T19:04:11.000Z',
    features: [ /* one AreaFeatureRef per contributing feature */ ],
    combine: 'single',           // 'single' | 'collect' | 'dissolve'
    geometryVariant: 'display-simplified',
    simplification: undefined,   // present iff filterGeometry !== geometry
    attribution: [ /* what the hosting UI MUST show */ ],
    geocoder: { /* or `upload`, or `draw` -- exactly one, matching `source` */ },
  },
}
```

Four things about this object are worth internalizing, because the rest of the
system depends on them:

**Two geometries, on purpose.** `geometry` is what you draw; `filterGeometry`
is what you test rows against. A 90 MB ADM2 coastline is not something to push
through a map style on every selection, and a 200,000-vertex ring makes every
point-in-polygon test expensive. Collapsing them into one field forces a choice
between a slow map and a dishonest download. `filterGeometry: null` means "no
usable polygon" — filtering falls back to `bboxes` alone, and
`@cngeo/extract-core` emits a `degraded-to-bbox` warning on every estimate.

**`bbox` is for people, `bboxes` is for arithmetic.** `bbox` is signed and may
wrap (`west > east`) so it round-trips and reads correctly in a UI.
**Everything that computes — row-group pruning, partition pruning, viewport
ranking — uses `bboxes`,** which is always 1 or 2 boxes each with
`west <= east`.

**Coordinates stay as published,** in `[-180, 180]`, per RFC 7946. No `+360`
unwrapping, so an `Area` drops into geojson.io, GDAL or QGIS unchanged.

**The wire form is a GeoJSON `Feature`.** `toAreaDocument(area)` puts the extras
under namespaced `area:*` properties in `snake_case`; `fromAreaDocument(doc)`
reads them back as `camelCase`. A saved `Area` opens in `ogr2ogr` with zero
translation.

### Building one

```js
import { buildArea, validateArea } from '@cngeo/spec';

const area = buildArea({
  name: 'A square over Liechtenstein',
  geometry: {
    type: 'Polygon',
    coordinates: [[[9.47, 47.05], [9.47, 47.28], [9.64, 47.28], [9.64, 47.05], [9.47, 47.05]]],
  },
  source: 'upload',
  features: [{ featureId: null, name: 'box' }],
});

area.type;                      // 'Area'
area.crs;                       // 'EPSG:4326'
area.bbox;                      // [9.47, 47.05, 9.64, 47.28]
area.bboxes.length;             // 1
area.crossesAntimeridian;       // false
area.vertexCount;               // { display: 5, filter: 5 }
area.filterGeometry === area.geometry;   // true -- under the ceiling, same object
area.provenance.combine;        // 'single'
area.provenance.simplification; // undefined -- nothing was simplified

validateArea(area);             // throws CngError on a malformed Area
```

Points and lines are refused structurally, not quietly dropped:

```js
buildArea({ name: 'p', geometry: { type: 'Point', coordinates: [0, 0] }, source: 'upload', features: [] });
// CngError { code: 'AREA_UNSUPPORTED_GEOMETRY' }
```

### Serializing one

```js
import { toAreaDocument, fromAreaDocument } from '@cngeo/spec';

const doc = toAreaDocument(area);
doc.type;                                          // 'Feature'
doc.properties['area:name'];                       // 'Contra Costa'
doc.properties['area:crs'];                        // 'EPSG:4326'
doc.properties['area:provenance'].geometry_variant;        // 'display-simplified'
doc.properties['area:provenance'].features[0].feature_id;  // 'USA-ADM2-3160769234B82345678'

const back = fromAreaDocument(doc);   // validates on the way in
back.provenance.geometryVariant;      // 'display-simplified'
```

---

## API reference

Every signature below was read off `src/` and exercised by
[`docs/verify-snippets.mjs`](../../docs/verify-snippets.mjs) (`node docs/verify-snippets.mjs spec`).

### `Area`

| export | signature | notes |
|---|---|---|
| `AREA_VERSION` | `1` | The `Area.version` this build writes. |
| `generateAreaId()` | `() => string` | `area_<base36>`; session-stable, **not** a global identifier. |
| `buildArea(input)` | `(input) => Area` | See the options table below. Applies the display ceiling, then the filter ceiling, then fills provenance. |
| `validateArea(area)` | `(unknown) => Area` | Structural check: `type`, `crs`, polygon-only geometry, non-empty `bboxes`. Throws on the first violation. Not a JSON Schema validator. |
| `toAreaDocument(area)` | `(Area) => GeoJSON.Feature` | `camelCase` → `snake_case` under `area:`. |
| `fromAreaDocument(doc)` | `(GeoJSON.Feature) => Area` | Inverse; runs `validateArea`. |

`buildArea(input)` options:

| field | type | default | notes |
|---|---|---|---|
| `name` | `string` | — | Human label. Never used for filtering. |
| `geometry` | `Polygon \| MultiPolygon` | — | Anything else throws `AREA_UNSUPPORTED_GEOMETRY`. |
| `source` | `'geocoder' \| 'upload' \| 'draw'` | — | Lands on `provenance.source`. |
| `features` | `object[]` | — | One `AreaFeatureRef` per contributing feature, in input order. |
| `combine` | `'single' \| 'collect' \| 'dissolve'` | `'single'` | Recorded, not performed — the caller combines. |
| `geometryVariant` | `'full' \| 'display-simplified' \| 'unknown'` | `'unknown'` | Which variant `geometry` holds. |
| `attribution` | `object[]` | `[]` | Copied to `provenance.attribution` verbatim. |
| `provenanceExtra` | `object` | `{}` | Spread into `provenance` — where the `geocoder`/`upload`/`draw` block goes. |
| `filterVertexCeiling` | `number` | `10_000` | Above this, `filterGeometry` is simplified. |
| `displayVertexCeiling` | `number` | `200_000` | Above this, `geometry` is simplified. |
| `areaDeltaMaxRatio` | `number` | `0.05` | Above 5% area change, refuse: `filterGeometry: null`, `degradedToBbox: true`. |
| `areaDeltaWarnRatio` | `number` | `0.01` | **Reserved** — accepted and currently unused; read `provenance.simplification.areaDeltaRatio` yourself. |
| `maxSyncInputVertices` | `number` | `undefined` | Guard: above this, skip the O(m²) search and degrade to bbox immediately. See [the simplification gotcha](#gotchas). |

### bbox + antimeridian

| export | signature | notes |
|---|---|---|
| `bboxOfGeometry(geometry)` | `(Polygon\|MultiPolygon) => BBox` | The naive min/max. For a wrapping geometry this is misleadingly wide — that is the point of the next two. |
| `crossesAntimeridian(geometry)` | `(Polygon\|MultiPolygon) => boolean` | True when the naive bbox spans > 180° **and** no vertex sits within ±20° of longitude 0. Ambiguous cases return `false`: a too-wide bbox over-fetches (a performance bug), a wrongly-split one under-fetches (a correctness bug). |
| `computeBBoxes(geometry)` | `(…) => { bbox, bboxes, crossesAntimeridian }` | The signed bbox, the 1–2 normalized boxes, and the flag. |
| `bboxesIntersect(a, b)` | `(BBox, BBox) => boolean` | Closed intersection. Both boxes must be normalized. |
| `bboxContainsPoint(box, [lon, lat])` | `(BBox, [number, number]) => boolean` | |
| `bboxCenter(box)` | `(BBox) => [number, number]` | |
| `scaleBBox(box, factor)` | `(BBox, number) => BBox` | Scales about the center. Powers the ranking `near` test. |
| `unionBBoxes(boxes)` | `(BBox[]) => BBox` | |

`BBox` is `[west, south, east, north]` in EPSG:4326 degrees.

```js
import { computeBBoxes, crossesAntimeridian, bboxOfGeometry } from '@cngeo/spec';

const fiji = {
  type: 'MultiPolygon',
  coordinates: [
    [[[177.3, -17.8], [177.9, -17.8], [177.9, -17.2], [177.3, -17.2], [177.3, -17.8]]],
    [[[-179.9, -19.2], [-178.2, -19.2], [-178.2, -16.1], [-179.9, -16.1], [-179.9, -19.2]]],
  ],
};

crossesAntimeridian(fiji);                        // true
bboxOfGeometry(fiji);                             // spans 357 degrees -- useless for pruning
const { bbox, bboxes } = computeBBoxes(fiji);
bbox;        // [177.3, -19.2, -178.2, -16.1]  -- signed, west > east
bboxes;      // two normalized boxes, each west <= east
```

### Name normalization

| export | signature | notes |
|---|---|---|
| `normalizeName(input)` | `(string) => string` | NFD → strip `\p{M}` → lowercase → drop everything outside `[\p{L}\p{N} '-]` → collapse whitespace → trim. |

This **must** agree with the index builder's `name_norm` column, or the
geocoder's binary search over a sorted index silently misses rows. Overriding
`GeocoderOptions.normalize` without rebuilding the index breaks the sort
guarantee.

```js
normalizeName('Zürich');              // 'zurich'
normalizeName('  Côte d’Ivoire ');    // 'cote divoire'
normalizeName('Saint-Denis  (Réunion)'); // 'saint-denis reunion'
normalizeName('東京都');               // '東京都' -- non-Latin scripts survive untouched
```

### Simplification

| export | signature | notes |
|---|---|---|
| `simplifyToVertexCeiling(geometry, opts)` | `(…) => SimplifyResult` | Binary-searches an area tolerance over `[1e-7, 1]`, ≤ 20 passes, taking the largest tolerance that lands under `vertexCeiling`. **O(m²) per pass.** |
| `simplifyToVertexCeilingAsync(geometry, opts)` | `(…) => Promise<SimplifyResult>` | Same contract, O(m log m) via a min-heap, yields to the event loop between chunks. Safe on raw full-resolution geometry. `maxIterations` defaults to 12 (vs 20). |
| `visvalingamRing(ring, areaTolerance)` | `(number[][], number) => number[][]` | One closed ring, fixed tolerance. |
| `visvalingamRingAsync(ring, areaTolerance, opts?)` | `(…) => Promise<number[][]>` | `opts`: `{ chunkOps = 4000, yieldBudgetMs = 8, signal }`. |
| `ringArea(ring)` | `(number[][]) => number` | Unsigned shoelace area, deg². |
| `vertexCount(geometry)` | `(Polygon\|MultiPolygon) => number` | Counts every ring's points, closing duplicate included. |
| `totalArea(geometry)` | `(Polygon\|MultiPolygon) => number` | Sum of ring areas, deg². |
| `MAX_SYNC_SIMPLIFY_VERTICES` | `1500` | The largest input the sync search stays under ~100 ms on. |

`SimplifyResult` is `{ geometry, method: 'visvalingam'|'none'|'bbox', toleranceDeg,
inputVertices, outputVertices, areaDeltaRatio, degradedToBbox }`.
`toleranceDeg` is a *triangle-area* tolerance in deg², not a distance —
Visvalingam is area-based; the field name follows the design doc.

```js
import { simplifyToVertexCeiling, simplifyToVertexCeilingAsync, vertexCount } from '@cngeo/spec';

const ring = [];
for (let i = 0; i <= 1200; i++) {
  const t = (i / 1200) * 2 * Math.PI;
  ring.push([10 + Math.cos(t), 45 + Math.sin(t)]);
}
const circle = { type: 'Polygon', coordinates: [ring] };
vertexCount(circle);                                   // 1201

const r = simplifyToVertexCeiling(circle, { vertexCeiling: 200 });
r.method;            // 'visvalingam'
r.outputVertices;    // 14   -- it stops at the largest tolerance under the ceiling
r.areaDeltaRatio;    // 0.0458 -- a circle is Visvalingam's worst case
r.degradedToBbox;    // false  -- still inside the 5% areaDeltaMaxRatio

// The guard refuses to run the O(m^2) search on a big input at all:
simplifyToVertexCeiling(circle, { vertexCeiling: 200, maxSyncInputVertices: 1000 });
// { method: 'bbox', degradedToBbox: true, ... }

// The async version is safe on any size.
(await simplifyToVertexCeilingAsync(circle, { vertexCeiling: 200 })).method;  // 'visvalingam'
```

### WKB

| export | signature | notes |
|---|---|---|
| `wkbToGeoJson(buf)` | `(Uint8Array\|ArrayBuffer) => Polygon\|MultiPolygon` | **Polygon (3) and MultiPolygon (6) only.** Any other type throws. No Z/M, no EWKB/SRID. |
| `wkbToGeoJsonAsync(buf, opts?)` | `(…) => Promise<Polygon\|MultiPolygon>` | Same, yielding every `chunkPoints` (50,000) / `chunkPolygons` (20). `opts.signal` is checked between chunks. |

```js
wkbToGeoJson(polygonBytes);   // { type: 'Polygon', coordinates: [...] }
wkbToGeoJson(pointBytes);     // throws: 'unsupported geometry type 1'
```

If you need Point/MultiPoint, `@cngeo/extract-core` exports
`decodeWkbGeometry` — a decorator over this one. Folding that back in here is a
known follow-up.

### Cooperative yielding

| export | signature | notes |
|---|---|---|
| `yieldToMain()` | `() => Promise<void>` | `scheduler.yield()` where available (Chrome 115+), else `setTimeout(0)`. |
| `forEachChunked(items, fn, opts?)` | `(…) => Promise<void>` | Yields every `opts.chunkSize` (500) items; `opts.signal` aborts. |

### Errors

| export | notes |
|---|---|
| `CngError` | `new CngError(message, code, { retryable?, context?, cause? })`. Fields: `.code`, `.retryable`, `.context`. Extends `Error`. |
| `CancelledError` | `code: 'CANCELLED'`. |
| `CeilingExceededError` | `code: 'CEILING_EXCEEDED'`. |
| `isCngError(e)` | `(unknown) => boolean`. |

**The `code` is the API. Messages are for humans and may be reworded; codes may
not.** `retryable` defaults to `true` for `INDEX_FETCH_FAILED`,
`DATASET_UNRESOLVED`, `SINK_PERMISSION_DENIED` and `NETWORK`, and `false`
otherwise.

```js
import { CngError, isCngError } from '@cngeo/spec';

const err = new CngError('Only EPSG:4326 (lon/lat) data is supported.', 'AREA_INVALID_CRS', {
  context: { crs: 'EPSG:3857' },
});
err.code;        // 'AREA_INVALID_CRS'
err.retryable;   // false
err.context.crs; // 'EPSG:3857'
isCngError(err);           // true
err instanceof Error;       // true
new CngError('x', 'INDEX_FETCH_FAILED').retryable;  // true
```

The full code table, with what a UI should say for each, is in
[`@cngeo/extract-core`'s README](../extract-core/README.md#error-codes) —
it is the package that can throw most of them.

### Misc

| export | notes |
|---|---|
| `VERSION` | `'0.3.0'`. |

---

## Why one copy matters

`@cngeo/spec` registers itself on `globalThis[Symbol.for('cng.spec')]` at import
time. A second, *different* version logs one loud warning and defers to the
first:

```
@cngeo/spec: multiple versions loaded on this page (0.1.0 and 0.2.0).
instanceof checks and Area validation may diverge; the first-loaded version wins.
```

This exists because `instanceof CngError` and `validateArea` only behave if
there is one `spec` module on the page. In a zero-build page, the way to
guarantee that is to have every `@cngeo` package import the **same URL** — which
is why the packaging design externalizes dependencies to pinned absolute URLs
rather than inlining them. If you see that warning, two packages disagree about
which `spec` to load; fix it with one import-map line.

## Gotchas

**Simplification is O(m²) in the synchronous path.** `simplifyToVertexCeiling`
runs up to 20 Visvalingam passes, and at least one of them (the highest
tolerance tried) strips the ring to its minimum regardless of your ceiling — so
cost is driven by *input* size, not by how close the input already is to the
ceiling. Measured against this implementation: 1,000 vertices ≈ 38 ms, 5,000
≈ 921 ms, 10,000 ≈ 3,852 ms. There is no "a little over the ceiling is cheap"
regime. Canada's ADM0 mainland ring alone is ~195,000 points, which is where
this came from: it hung the browser for ~24 s before the guard existed. Either
pass `maxSyncInputVertices: MAX_SYNC_SIMPLIFY_VERTICES` and accept a bbox
degradation, or use `simplifyToVertexCeilingAsync`.

**`filterGeometry: null` is a real state, not an error.** It means the filter
geometry could not be produced within `areaDeltaMaxRatio`. Consumers must handle
it: `@cngeo/extract-core` falls back to `bboxes` and warns. If you write your
own consumer and dereference `area.filterGeometry.coordinates`, you will crash
on exactly the big countries your users search for first.

**`bbox` can have `west > east`.** Anything that does `east - west` on
`Area.bbox` is wrong for Fiji and Russia. Use `bboxes`.

**`wkbToGeoJson` only knows polygons.** By design — the gazetteer boundary
files publish nothing else. A point dataset needs
`@cngeo/extract-core`'s `decodeWkbGeometry`.

**`validateArea` is a shape check, not a schema.** It will accept an `Area`
with a nonsensical `provenance`. The JSON Schemas the design doc promises
(§2.9, for the Python QGIS consumer) are not written yet.

**Attribution keys are not normalized here.** `buildArea` copies
`attribution` through verbatim, so an entry that came from an index manifest
keeps its `snake_case` (`share_alike`) while one built by
`@cngeo/extract-core`'s collection resolver uses `camelCase` (`shareAlike`).
Read both until that is unified. See the
[root README's known issues](../../README.md#known-issues).

## Tests

```
node --test packages/spec/test/*.test.js
```

6 files covering `Area` construction/validation/round-trip, bbox and
antimeridian detection, normalization, sync and async simplification, and WKB
decoding.
