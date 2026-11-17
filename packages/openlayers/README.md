# @cng/openlayers

The OpenLayers half of the widgets: the same five things
[`@cng/maplibre`](../maplibre/README.md) provides — search control, `Area`
outline layer, viewport provider, antimeridian-aware fit — **plus the one real
asymmetry between the two adapters: a projection bridge.**

Core is EPSG:4326-only. MapLibre's GeoJSON sources are 4326-native, so its
adapter does nothing here. OpenLayers views are routinely EPSG:3857 or
something more exotic, so this adapter reprojects on the way out (rendering,
camera) and on the way in (viewport bboxes for the ranking boost).

```js
const control = new GeocoderControl({ geocoder });
map.addControl(control);        // no 'load' event to wait for
```

- **Status:** experimental, pre-npm. See the [root README](../../README.md).
- **Normative design:** [`docs/design/widgets-architecture.md`](../../docs/design/widgets-architecture.md) §5, especially §5.1 item 5.
- **Peer dependency:** `ol@^10`. `GeocoderControl` imports `ol/control/Control.js`; the layer and projection modules import `ol` modules too.
- **License:** MIT.

---

## Install / import

Unlike the MapLibre adapter, this one *does* import `ol` modules by bare
specifier, so a zero-build page needs an import-map **prefix** entry:

```html
<script type="importmap">
{
  "imports": {
    "@cng/spec": "/packages/spec/src/index.js",
    "@cng/geocoder-core": "/packages/geocoder-core/src/index.js",
    "@cng/upload-core": "/packages/upload-core/src/index.js",
    "@cng/openlayers": "/packages/openlayers/src/index.js",
    "ol/": "https://cdn.jsdelivr.net/npm/ol@10.11.0/",
    "rbush": "https://cdn.jsdelivr.net/npm/rbush@4.0.1/+esm"
  }
}
</script>
```

That is the map `examples/upload-demo/index.html` actually runs on. Two things
about it are easy to get wrong:

- **`rbush` is required.** OpenLayers' own modules import it by bare specifier,
  so without that line the module graph fails to resolve — with a console error
  naming an `ol/` file, not this package. The `+esm` endpoint is needed because
  `rbush`'s own entry point has bare imports of its own.
- **Pin an exact `ol` version** — never `ol@10` or a bare `ol/`. A floating CDN
  specifier means the code running in a user's browser changes without anyone
  publishing anything.

CSS is inlined as a string and injected once under
`id="cnmw-ol-geocoder-style"`. Override via `.cnmw-geocoder-ol`.

**Coming:** `npm i @cng/openlayers`.

## Size

| | files | raw | gzip | gzip, comments stripped | design-doc budget (§4.5) |
|---|---|---|---|---|---|
| `@cng/openlayers` src | 8 | 27.8 KiB | 8.6 KiB | **5.1 KiB** | ≤ 9 KB min+gz |

`ol` is a peer and not counted. Note `src/projection.js` has **no `ol`
dependency at all** — the Web Mercator transform is closed-form — so those
helpers are usable anywhere.

---

## Minimal example

Complete and verified:
[`examples/upload-demo/index.html`](../../examples/upload-demo/index.html),
which also demonstrates the composability seam (a searched area and an uploaded
GeoJSON on the same map, in different colours).

```js
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import OSM from 'ol/source/OSM.js';
import { fromLonLat } from 'ol/proj.js';

import { Geocoder } from '@cng/geocoder-core';
import { GeocoderControl, addAreaLayer } from '@cng/openlayers';

const map = new Map({
  target: 'map',
  layers: [new TileLayer({ source: new OSM() })],
  view: new View({ center: fromLonLat([-121.9, 37.9]), zoom: 7 }),   // EPSG:3857
});

const geocoder = new Geocoder({
  indexUrl: 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json',
  limit: 8,
});

// No map.on('load') dance: OL's setMap() hook does the wiring, and the
// vector layer needs no style to have loaded first.
map.addControl(new GeocoderControl({ geocoder, placeholder: 'Search for a place…' }));

// A second, differently-coloured outline for an uploaded area:
const uploadOutline = addAreaLayer(map, { lineColor: '#e8710a', fillColor: '#e8710a' });
uploadOutline.setArea(uploadedArea);
uploadOutline.fit({ padding: 60 });
```

---

## API reference

The projection helpers are verified by
[`docs/verify-snippets.mjs`](../../docs/verify-snippets.mjs)
(`node docs/verify-snippets.mjs openlayers`) and by unit tests; the DOM is
verified by Playwright.

### `new GeocoderControl(options?)`

Extends `ol/control/Control`. Added with `map.addControl(control)`; OL calls
`setMap(map)` then, and `setMap(null)` on removal.

Every [`@cng/maplibre` option](../maplibre/README.md#new-geocodercontroloptions)
applies identically — `geocoder` (**required in practice, no default**),
`placeholder`, `debounceMs` (80), `useViewport` (true), `limit`, `fitBounds`
(true), `outline`, `showAttribution` (true — the compact bottom-left ⓘ
attribution widget, same UX as `@cng/maplibre`'s; here it mounts in the
map's stop-event overlay container and is torn down on `setMap(null)`),
`renderItem`, `upgradeNoticeStrings` — plus:

| option | type | notes |
|---|---|---|
| `featureProjection` | `string` | The view projection to render into. Defaults to reading `map.getView().getProjection()`. This is the bridge. |
| `target` | `HTMLElement` | OL's standard "render the control outside the map viewport" escape hatch, passed straight to `Control`. |

Members and events match the MapLibre adapter: `control.geocoder`,
`control.area`, `setArea`, `clear`, `focus`, `on(event, handler)`, and the
events `select`, `results`, `upgrade`, `upgrade-cancelled`, `clear`, `error`.
With `geometry: { resolution: 'both', upgradeDisplay: true }` on the
`Geocoder`, this control shows the same
["loading full detail…" notice, with a cancel affordance](../maplibre/README.md#the-loading-full-detail-notice)
as the MapLibre adapter — same pure state machine
(`./src/upgrade-notice.js`, duplicated verbatim), same deferred-outline-swap
jank mitigation. The combobox is the same ARIA 1.2 pattern, the same
keyboard handling, the same lazy `geocoder.load()` on first focus, and the
[same default option renderer](../maplibre/README.md#the-combobox).

> The ~150 lines of combobox DOM are **duplicated** between this package and
> `@cng/maplibre` rather than shared. Design doc §5.2 puts them in an
> unpublished internal `packages/_ui` workspace that both adapters inline at
> build time; with no build step, that is not available yet. The duplication is
> known, flagged in both files, and the predictable drift risk. Pure helpers
> are being extracted into each package's `src/combobox-helpers.js` as a first
> step.

### `addAreaLayer(map, options?) => AreaLayerHandle`

A `VectorLayer` + `VectorSource` holding the display geometry, and a second for
the dashed `filterGeometry` ghost. Same handle shape as the MapLibre adapter:
`setArea(area | null)`, `setStyle(style)`, `fit(options?)`, `remove()`.

| option | notes |
|---|---|
| `lineColor`, `lineWidth`, `fillColor`, `fillOpacity` | As MapLibre. |
| `lineDash` | **Note the name:** `lineDash` (OL's own term), not MapLibre's `lineDasharray`. |
| `showFilterGeometry` | Default `true`. |
| `featureProjection` | The view projection to reproject into. |

Geometry arrives in 4326 and is reprojected into `featureProjection` before
being handed to the vector source, which is why you can read it back in view
coordinates.

### `viewportProvider(map, options?) => () => BBox`

```js
const getViewport = viewportProvider(map, { featureProjection: 'EPSG:3857' });
await geocoder.search(query, { viewport: getViewport() });   // always 4326, always [w,s,e,n]
```

Reads the view's extent and **unprojects it to 4326**, because the ranking
boost compares against the index's 4326 bboxes. This is the "on the way in"
half of the bridge.

### `fitAreaBounds(map, bboxes, options?)`

Picks the nearer box for an antimeridian area (via `selectNearestBBox`),
projects it into the view projection, and calls `view.fit`. Options:
`{ padding = 40, maxZoom, featureProjection }`.

### `selectNearestBBox(bboxes, centerLon) => BBox | null`

The pure decision behind that camera choice: of 1–2 boxes, the one whose centre
is nearest `centerLon` by **shortest wraparound** longitude distance.

```js
const fiji = [[177.3, -19.2, 180, -12.4], [-180, -19.2, -176.8, -12.4]];
selectNearestBBox(fiji, 178);    // the eastern box
selectNearestBBox(fiji, -178);   // the western box
selectNearestBBox([[0, 0, 1, 1]], 170);  // a no-op for the 1-box case
selectNearestBBox([], 0);        // null
```

### The projection helpers

Dependency-free and closed-form for Web Mercator — the standard formula every
map library implements identically. For anything else they delegate to the
injectable `transform` (which the adapter wires to `ol/proj`'s `transform`).

| export | signature |
|---|---|
| `isMercatorCode(code)` | `=> boolean` — true for `EPSG:3857`, `EPSG:900913`, and the usual aliases. |
| `isLonLatCode(code)` | `=> boolean` — true for `EPSG:4326` and friends. |
| `lonLatToMercator([lon, lat])` | `=> [x, y]` metres. |
| `mercatorToLonLat([x, y])` | `=> [lon, lat]` degrees. Exact inverse. |
| `projectPoint(lonLat, toCode, opts?)` | 4326 → `toCode`. A no-op into 4326. |
| `unprojectPoint(coord, fromCode, opts?)` | `fromCode` → 4326. |
| `projectExtent(bbox, toCode, opts?)` | A normalized 4326 `BBox` → `[minX, minY, maxX, maxY]`. |
| `unprojectExtent(extent, fromCode, opts?)` | The inverse. |
| `projectGeometry(geometry, toCode, opts?)` | Deep-reprojects a Polygon/MultiPolygon. |

`opts.transform` overrides the transform:
`(coord, from, to) => [x, y]`.

```js
import { lonLatToMercator, mercatorToLonLat, projectExtent, projectGeometry } from '@cng/openlayers';

const [x, y] = lonLatToMercator([9.5, 47.14]);   // ≈ [1057535, 5964956]
mercatorToLonLat([x, y]);                        // [9.5, 47.14] -- round trips exactly

projectExtent([9.47, 47.05, 9.64, 47.28], 'EPSG:3857');  // [minX, minY, maxX, maxY] in metres
projectGeometry(area.geometry, 'EPSG:3857').coordinates[0][0];  // metres, not degrees
```

**Corner projection is correct here** only because `bboxes[]` entries are
always normalized (`west <= east`) before this is called — the antimeridian
split already happened in `@cng/spec`. Do not feed it a signed
`Area.bbox`.

---

## Dropdown states

Besides plain options, the listbox renders: a spinner row while loading or
searching, an error row with a Retry button, a `No matches for "…".` row,
and — when geocoder-core's fuzzy fallback produced the results (every
`rank.matchClass` is `'fuzzy'`, which only happens when the prefix search
found nothing) — a non-interactive caption row above them:
*No exact matches — showing close matches.* (`li.cnmw-fuzzy-note`,
`role="presentation"`, excluded from keyboard navigation and click
handling). A custom `renderItem` only replaces option contents; the caption
still renders.

## Gotchas

**`options.geocoder` has no default**, exactly as in the MapLibre adapter, and
for the same reason (keeping this package from importing a parquet reader).
`geocoderOptions` is accepted and ignored. Both are listed as
planned-not-implemented in design doc §8. Always construct the `Geocoder`
yourself.

**`lineDash`, not `lineDasharray`.** The two adapters' style objects are
otherwise identical; this one field follows each library's own naming. Passing
`lineDasharray` here is silently ignored.

**An `ol/` prefix entry *and* an `rbush` entry are mandatory in a zero-build
page,** because this package imports `ol` modules by bare specifier and OL
imports `rbush` the same way. Without either, the module graph fails to resolve
and nothing renders — with a console error that names an `ol/` file, not this
package.

**`setMap(null)` does not remove the document click listener.** The MapLibre
adapter's `onRemove` cleans up its equivalent; this one does not yet. Removing
and re-adding many controls on one page leaks a listener each time.

**Everything crossing this boundary is 4326.** `Area.geometry`,
`Area.bboxes`, the `viewport` you pass to `search()` — all lon/lat, always.
The projection happens inside this package, at the last possible moment. If
you find yourself projecting an `Area` before handing it to anything `@cng`,
something is wrong.

**Non-Mercator views go through `ol/proj`.** The closed-form path covers 4326
and 3857, which is the overwhelming majority. A UTM or polar view falls back to
`transform`, which requires OL to know that projection (register it with
`proj4` first, as OL documents). Accuracy there is OL's, not ours.

## Tests

```
node --test packages/openlayers/test/*.test.js
```

`projection.test.js` (the Mercator round trip, extents, deep geometry
reprojection, the injectable transform), `nearest-bbox.test.js` (the
antimeridian camera choice), and `combobox-helpers.test.js`.

DOM behaviour is verified against a live map by
[`examples/upload-demo/verify.mjs`](../../examples/upload-demo/verify.mjs),
which searches "fiji" (two bboxes, through the projection bridge), selects it,
then uploads a deliberately damaged GeoJSON and asserts both features land on
their respective vector layers with the expected repair list.
