# @cng/upload-core

Drag, drop or pick a GeoJSON file; get back the **same `Area` object**
`@cng/geocoder-core` emits and `@cng/download-core` consumes. That
interchangeability is the entire purpose of this package — "search for an area"
and "bring your own area" are two front doors to one pipeline.

It also does the unglamorous part: real-world GeoJSON is full of unclosed
rings, backwards winding, stray Z coordinates and Points mixed into a polygon
layer. This package repairs what it can, drops what it can't, and **reports
every single change** so a UI can tell the user what happened to their file.

```js
const { area, warnings } = await areaFromFile(file);
```

- **Status:** experimental, pre-npm. GeoJSON only. See the [root README](../../README.md).
- **Normative design:** [`docs/design/widgets-architecture.md`](../../docs/design/widgets-architecture.md) §3.3, plus §1.4 (multi-feature) and §1.2 (`AreaRepair`).
- **License:** MIT (code). No data, no data license.

---

## Install / import

```html
<script type="importmap">
{
  "imports": {
    "@cng/spec": "/packages/spec/src/index.js",
    "@cng/upload-core": "/packages/upload-core/src/index.js"
  }
}
</script>
<script type="module">
  import { attachDropTarget } from '@cng/upload-core';
</script>
```

Zero runtime dependencies beyond `@cng/spec`. No network, no CDN, no wasm —
nothing to inject or configure. Works in Node as-is (Node 20+ has `File`).

**Coming:** `npm i @cng/upload-core`.

## Size

| | files | raw | gzip | gzip, comments stripped | design-doc budget (§4.5) |
|---|---|---|---|---|---|
| `@cng/upload-core` src | 5 | 23.1 KiB | 7.5 KiB | **4.3 KiB** | ≤ 10 KB min+gz |

Plus `@cng/spec` (6.2 KiB stripped+gz). The lightest package here by a wide
margin.

---

## Minimal example

```js
import { areaFromFile } from '@cng/upload-core';

const text = JSON.stringify({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { name: 'my field' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[9.47, 47.05], [9.64, 47.05], [9.64, 47.28], [9.47, 47.28], [9.47, 47.05]]],
    },
  }],
});
const file = new File([text], 'my-field.geojson', { type: 'application/geo+json' });

const { area, warnings } = await areaFromFile(file);

area.name;                              // 'my-field.geojson'
area.provenance.source;                 // 'upload'
area.provenance.combine;                // 'single'
area.provenance.upload.filename;        // 'my-field.geojson'
area.provenance.upload.featureCount;    // 1
area.provenance.upload.declaredCrs;     // null  -- RFC 7946 says WGS84
warnings;                               // []
```

Wired to a drop zone, which is the actual use:

```js
import { attachDropTarget, areaFromFile } from '@cng/upload-core';

const detach = attachDropTarget(
  document.getElementById('dropzone'),
  ({ area, warnings }) => {
    areaLayer.setArea(area);           // @cng/maplibre or @cng/openlayers
    renderWarnings(warnings);
  },
  { onError: (err) => showError(err.code, err.message) },
);

// attachDropTarget handles `dragover`, `drop` and `paste`. A hidden file
// input is still worth wiring for click-to-browse -- and for Playwright,
// which cannot synthesize a real cross-origin DataTransfer:
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) onResult(await areaFromFile(file));
});

detach();   // removes all three listeners
```

---

## API reference

Verified by [`docs/verify-snippets.mjs`](../../docs/verify-snippets.mjs)
(`node docs/verify-snippets.mjs upload`).

### `areaFromFile(file, options?) => Promise<UploadResult>`

Dispatches to a registered `GeometryReader` by file extension, then by media
type. An unrecognized file throws `UPLOAD_UNSUPPORTED_FORMAT` naming the
filename and type rather than guessing.

### `areaFromGeoJson(json, meta, options?) => Promise<UploadResult>`

For an already-parsed value — pasted text, a fetch response, a draw tool's
output. `meta` is `{ name }`. Accepts any legal top-level GeoJSON: a
`FeatureCollection`, a single `Feature`, a `GeometryCollection`, or a bare
geometry.

### `attachDropTarget(el, onResult, options?) => unsubscribe`

Wires `dragover`, `drop` and `paste` on `el`. A dropped or pasted *file* goes
through `areaFromFile`; pasted *text* that parses as JSON goes through
`areaFromGeoJson` with `name: 'Pasted GeoJSON'`. Pasted text that is not JSON
is ignored silently — this is a passive listener on an element that may also
be a normal text target. `options.onError` receives every `CngError`;
without it, failures are swallowed.

### `registerReader(reader) => void`

Adds a format. `reader` is
`{ id, extensions: string[], mediaTypes: string[], read(file, signal?) =>
Promise<{ features, declaredCrs }> }`. `features` is an array of
`Feature`-shaped objects (or bare geometries); the repair pipeline runs on
whatever you return, so a new reader gets every repair for free.

This is the seam for shapefile-js, gdal3.js and friends — **this package never
imports them.** Registration rather than lazy `import()` is deliberate: a bare
dynamic specifier does not resolve in a zero-build page.

```js
import { registerReader, areaFromFile } from '@cng/upload-core';

// A toy "WKT polygon in a .wkt file" reader.
registerReader({
  id: 'wkt-txt',
  extensions: ['.wkt'],
  mediaTypes: ['text/plain'],
  async read(file) {
    const text = await file.text();
    const ring = text
      .replace(/^POLYGON\s*\(\(/i, '').replace(/\)\)\s*$/, '')
      .split(',')
      .map((p) => p.trim().split(/\s+/).map(Number));
    return {
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
      declaredCrs: null,
    };
  },
});

const { area } = await areaFromFile(new File(['POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))'], 'square.wkt', { type: 'text/plain' }));
area.vertexCount.display;   // 5

await areaFromFile(new File(['x'], 'thing.shp', { type: '' }));
// CngError { code: 'UPLOAD_UNSUPPORTED_FORMAT' }
```

### `repairFeatures(rawFeatures) => { features, repairs }`

The repair pipeline, standalone and format-agnostic. Useful if you already have
GeoJSON and only want the cleanup.

```js
import { repairFeatures } from '@cng/upload-core';

const { features, repairs } = repairFeatures([
  { geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0]]] }, properties: {} },
  { geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
]);
features.length;   // 1
repairs;           // [{ kind: 'dropped-non-areal', count: 1, types: ['Point'] },
                   //  { kind: 'closed-ring', count: 1 }, { kind: 'rewound-ring', count: 1 }]
```

### Also exported

| export | notes |
|---|---|
| `geoJsonReader` | The built-in reader, in case you want to wrap or inspect it. |
| `extractRawFeatures(json)` | Any top-level GeoJSON value → a flat `{ geometry, properties }[]`. |
| `detectDeclaredCrs(json)` | The legacy pre-RFC-7946 top-level `crs` member, or `null`. |
| `VERSION` | `'0.1.0'`. |

### `UploadOptions`

| option | type | default | notes |
|---|---|---|---|
| `maxBytes` | `number` | `67_108_864` (64 MiB) | Checked against `file.size`, or the JSON text length for `areaFromGeoJson`. Over → `UPLOAD_TOO_LARGE`. |
| `maxFeatures` | `number` | `10_000` | Checked **after** repair, so dropped junk does not count. |
| `unionMode` | `'collect' \| 'dissolve'` | `'collect'` | Only consulted when more than one feature survives. |
| `dissolver` | `(polys) => geometry` | — | Required for `'dissolve'`; without it, `INTERNAL`. There is no boolean-union dependency in core. |
| `filterVertexCeiling` | `number` | `10_000` | Passed to `buildArea`. |
| `onForeignCrs` | `'reject' \| 'assume-4326'` | `'reject'` | See below. No reprojection, ever — this package is 4326-only. |
| `signal` | `AbortSignal` | — | Threaded into the reader. |

`UploadResult` is `{ area, warnings }`. Warning codes:
`overlapping-features` (`{count}`), `simplified` (`{detail}`),
`degraded-to-bbox` (`{detail}`), `assumed-4326` (`{declared}`),
`repaired` (`{repairs}`).

---

## What the repair pipeline actually does

In order:

1. **Non-areal features are dropped** and counted (`dropped-non-areal`, with
   the types found). A Point in a polygon layer is not an error; it is a line
   item.
2. **Per-ring damage:** a Z coordinate (`dropped-z`), an out-of-range lon/lat
   (`clamped-coordinate`), a run of duplicate consecutive points
   (`deduped-points`), an unclosed ring (`closed-ring`), wrong winding order
   (`rewound-ring` — RFC 7946 §3.1.6 wants exterior CCW, holes CW).
3. **A ring left with fewer than 4 points is dropped** (`dropped-empty`). If it
   was a polygon's exterior ring, the polygon goes with it.
4. **A feature left with zero polygons is dropped** (`dropped-feature`).

```js
const damaged = {
  type: 'FeatureCollection',
  features: [
    // Clockwise exterior ring, unclosed, with a Z on every vertex.
    { type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[[0, 0, 12], [0, 1, 12], [1, 1, 12], [1, 0, 12]]] } },
    // Not an area at all.
    { type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
  ],
};

const { area, warnings } = await areaFromGeoJson(damaged, { name: 'damaged.geojson' });

area.provenance.upload.repairs.map((r) => r.kind);
// ['dropped-non-areal', 'closed-ring', 'rewound-ring', 'dropped-z']
warnings[0].code;                                   // 'repaired'
area.geometry.coordinates[0][0].length;             // 2  -- Z stripped
area.geometry.coordinates[0].at(-1);                // === coordinates[0][0] -- ring closed
```

`deduped-points` is **one kind beyond the design doc's `AreaRepair` union**
(§1.2), added because removing duplicate consecutive points is a real and
common fix and folding it into an unrelated kind would be dishonest. Everything
else here is exactly the design doc's taxonomy.

**Coordinate precision is *not* truncated on upload.** Design doc §1.3 is
explicit that precision trimming happens on serialization only — it is a format
writer's job (`@cng/download-core`'s `geojson` plugin takes `precision`).

## Multiple features: `collect`, not `dissolve`

```js
const two = { type: 'FeatureCollection', features: [polyA, polyB] };  // they overlap
const { area, warnings } = await areaFromGeoJson(two, { name: 'two.geojson' });

area.provenance.combine;              // 'collect'
area.geometry.type;                   // 'MultiPolygon'
area.geometry.coordinates.length;     // 2
area.provenance.features.length;      // 2, in input order, with names and bboxes
warnings;                             // [{ code: 'overlapping-features', count: 1 }]
```

`collect` concatenates the polygons into one `MultiPolygon`: no boolean
operation, no dependency, no failure mode on invalid input. Semantically "the
area is the set of these features".

The honest consequence, stated plainly: **if the input features overlap, a
downloaded feature lying in the overlap matches more than one part of the
MultiPolygon.** Under `spatial.mode: 'intersects'` that is harmless — a row
either matches or does not. Under `'clip'` it would produce overlapping output
fragments, which is why this package raises `overlapping-features` and
`@cng/download-core` refuses `clip` on such an Area. That is the entire cost
of not shipping a polygon clipper in core, and `unionMode: 'dissolve'` plus
your own `dissolver` is the opt-out.

## CRS

4326 only, and no reprojection anywhere in this package. A file that *declares*
a different CRS via the legacy top-level `crs` member is rejected:

```js
const projected = {
  type: 'Feature',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
  properties: {}, geometry: { /* ... */ },
};

await areaFromGeoJson(projected, { name: 'm.geojson' });
// CngError { code: 'AREA_INVALID_CRS' }

// ...unless you opt in, which records the assumption rather than hiding it:
const { area, warnings } = await areaFromGeoJson(projected, { name: 'm.geojson' }, { onForeignCrs: 'assume-4326' });
area.provenance.upload.declaredCrs;   // 'urn:ogc:def:crs:EPSG::3857'  -- verbatim
warnings;                             // [{ code: 'assumed-4326', declared: '…EPSG::3857' }]
```

Recognized 4326 aliases: `EPSG:4326`, `OGC:CRS84`, `CRS:84`,
`urn:ogc:def:crs:OGC:1.3:CRS84`, `urn:ogc:def:crs:EPSG::4326`,
`urn:ogc:def:crs:EPSG:6.6:4326`. A file with **no** `crs` member is WGS84 by
RFC 7946, which is the common and correct case.

## Error codes

| code | when |
|---|---|
| `AREA_UNSUPPORTED_GEOMETRY` | Nothing areal was ever present (points/lines only). "This file has points/lines; an area needs polygons." |
| `AREA_EMPTY` | Something areal was present but nothing survived repair. "No usable polygon in that file." |
| `AREA_INVALID_CRS` | A declared non-4326 CRS with `onForeignCrs: 'reject'`. Offer `ogr2ogr` instructions, not a reprojection. |
| `UPLOAD_TOO_LARGE` | `maxBytes` or `maxFeatures` exceeded. The error's `context` names which limit and the actual value. |
| `UPLOAD_UNSUPPORTED_FORMAT` | No registered reader for that extension or media type. |
| `UPLOAD_PARSE_ERROR` | Unreadable file, or not valid JSON. |
| `INTERNAL` | `unionMode: 'dissolve'` with no `dissolver` supplied. |

`UPLOAD_UNSUPPORTED_FORMAT` and `UPLOAD_PARSE_ERROR` shipped with this package
as two codes *beyond* the design doc's §3.5 table — it had no slot for either,
and both are things a user can cause and a UI must distinguish. **They were
added to that table on 2026-11-12**, so the doc and the code now agree.

## Gotchas

**`attachDropTarget` swallows errors without `onError`.** A bad file then looks
like nothing happened. Always pass it.

**Real drag-and-drop cannot be automated.** A WebDriver/CDP client cannot make
a synthetic `DragEvent` carry a real `File` from outside the page. Wire a
hidden `<input type="file">` to the same handler — that is what
[`examples/upload-demo/verify.mjs`](../../examples/upload-demo/verify.mjs)
drives, and it exercises the identical code path.

**`maxFeatures` is checked after repair, `maxBytes` before.** A 100 MB file is
rejected without being parsed; a file with 20,000 Points and 3 polygons passes
a `maxFeatures: 10_000` check, because only 3 features survive.

**`buildArea` here does *not* pass `maxSyncInputVertices`.** This package has no
interactive-latency budget the way a map click does, so a large upload runs the
full O(m²) simplification search synchronously. A 50,000-vertex uploaded
polygon will block for seconds. If that matters for your UI, simplify before
calling, or use `@cng/spec`'s `simplifyToVertexCeilingAsync` yourself.

**`properties` is carried through verbatim** onto each
`provenance.features[].properties`, and never interpreted. Feature `name` is
read only to label the entry.

## Tests

```
node --test packages/upload-core/test/*.test.js
```

4 files: the GeoJSON reader, the repair pipeline, `areaFromFile`/
`areaFromGeoJson` including every refusal path, and `attachDropTarget`'s
listener wiring. The browser-level drop and repair reporting are covered by
`examples/upload-demo/verify.mjs`, which drops a deliberately damaged fixture
(`examples/upload-demo/fixtures/needs-repair.geojson`) and asserts the rendered
repair list.
