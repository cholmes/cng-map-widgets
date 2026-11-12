# @cnmw/maplibre

The MapLibre GL half of the widgets: an accessible search box, an outline
layer, a viewport provider and an antimeridian-aware camera. Five small things,
~580 lines, no logic of its own.

```js
const control = new GeocoderControl({ geocoder });
map.on('load', () => map.addControl(control, 'top-left'));
```

**What this adapter deliberately does not do** (design doc §5.1): fetch an
index, rank results, simplify geometry, construct an `Area` from raw
coordinates, or hold dataset/filter state. All of that lives in
`@cnmw/geocoder-core` and `@cnmw/spec`, so it cannot drift between the MapLibre
and OpenLayers adapters. This file is DOM and event wiring.

- **Status:** experimental, pre-npm. See the [root README](../../README.md).
- **Normative design:** [`docs/design/widgets-architecture.md`](../../docs/design/widgets-architecture.md) §5.
- **Peer dependency:** `maplibre-gl@^4 || ^5`. Not bundled, not imported by this package — `GeocoderControl` only touches the `map` object you hand it.
- **License:** MIT.

---

## Install / import

```html
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" />
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script type="importmap">
{
  "imports": {
    "@cnmw/spec": "/packages/spec/src/index.js",
    "@cnmw/geocoder-core": "/packages/geocoder-core/src/index.js",
    "@cnmw/maplibre": "/packages/maplibre/src/index.js"
  }
}
</script>
<script type="module">
  import { Geocoder } from '@cnmw/geocoder-core';
  import { GeocoderControl, addAreaLayer } from '@cnmw/maplibre';
</script>
```

The control's CSS is **inlined as a string** and injected once into
`document.head` under `id="cnmw-geocoder-style"` — no stylesheet to load, no
build step to configure, and nothing to break a zero-build page. Override by
targeting `.cnmw-geocoder` and its children.

**Coming:** `npm i @cnmw/maplibre`.

## Size

| | files | raw | gzip | gzip, comments stripped | design-doc budget (§4.5) |
|---|---|---|---|---|---|
| `@cnmw/maplibre` src | 5 | 18.9 KiB | 5.9 KiB | **4.3 KiB** | ≤ 8 KB min+gz |

`maplibre-gl` itself is ~200 KiB min+gz and is a peer — not counted here,
because you already have it.

---

## Minimal example

Complete, runnable, and verified:
[`examples/quickstart/index.html`](../../examples/quickstart/index.html).

```js
import { Geocoder } from '@cnmw/geocoder-core';
import { GeocoderControl } from '@cnmw/maplibre';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [10, 25],
  zoom: 2,
});

const geocoder = new Geocoder({
  indexUrl: 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json',
  limit: 8,
  geometry: { resolution: 'both' },
});

const control = new GeocoderControl({ geocoder, placeholder: 'Search for a place…' });

// addAreaLayer (inside onAdd) calls map.addSource/addLayer, which MapLibre
// refuses until the style has finished loading -- so add the control on 'load'.
map.on('load', () => map.addControl(control, 'top-left'));

control.on('select', ({ result, area }) => {
  // `area` is ready for @cnmw/download-core. The outline is already drawn
  // and the camera already moved.
});
```

That is the whole integration. The control owns the combobox, the outline, the
camera, and the attribution line.

---

## API reference

The DOM behaviour here is verified end to end by Playwright rather than unit
tests — see [Tests](#tests).

### `new GeocoderControl(options?)`

Implements MapLibre's `IControl`, so `map.addControl(control, position)` works.

| option | type | default | notes |
|---|---|---|---|
| `geocoder` | `Geocoder` | — | **Required in practice.** See the gotcha below: there is no default. |
| `placeholder` | `string` | `'Search for a place…'` | |
| `debounceMs` | `number` | `80` | |
| `useViewport` | `boolean` | `true` | `false` stops passing the map's bounds to `search()`, disabling the ranking boost. |
| `limit` | `number` | the geocoder's own | Passed to each `search()`. |
| `fitBounds` | `boolean \| { padding?, maxZoom? }` | `true` | `padding` defaults to 40. |
| `outline` | `false \| AreaLayerStyle` | a sensible outline | `false` draws nothing — useful if you render the area yourself. |
| `showAttribution` | `boolean` | `true` | The design-call-#11 attribution line, rendered from `Area.provenance.attribution` after the first selection. |
| `renderItem` | `(SearchResult) => string \| Node` | the default renderer | A returned string is assigned to `innerHTML`; a `Node` is appended. |
| `geocoderOptions` | `GeocoderOptions` | — | **Not honored.** Construct the `Geocoder` yourself. |

| member | notes |
|---|---|
| `control.geocoder` | The instance you passed. |
| `control.area` | The current `Area`, or `null`. |
| `onAdd(map)` / `onRemove()` | MapLibre's lifecycle. `onRemove` detaches the document click listener, unsubscribes from `'area:upgraded'`, and removes the outline layer. |
| `setArea(area)` | Draws it, fits the camera (if `fitBounds`), renders attribution. `null` clears. |
| `clear()` | Empties the input, closes the list, clears the area, emits `'clear'`. |
| `focus()` | Focuses the input. |
| `on(event, handler)` | `=> unsubscribe`. |

Events: `select` (`{ result, area }`), `results` (`SearchResult[]`),
`upgrade` (`{ area }` — a background `resolution: 'both'` upgrade landed),
`clear`, `error`.

### The combobox

ARIA 1.2 combobox-with-listbox, not a div soup:
`<input role="combobox" aria-expanded aria-autocomplete="list" aria-controls
aria-activedescendant aria-busy>` plus
`<ul role="listbox"><li role="option" aria-selected>`. Arrow Up/Down wrap
around the list, Enter selects the active option, Escape closes it, and a
click outside closes it. `aria-busy` reflects an in-flight search.

The index loads **lazily on first focus** (`geocoder.load()`, `{ once: true }`)
— design call #9, because most page views never search and the index is
megabytes.

The default option renderer shows the name plus disambiguating secondary text:

```
Contra Costa  — United States · USA · ADM2
Bag           — Rajasthan · IND · ADM4 (+7 more)
```

The context line is `result.parentName ?? result.countryName` (Overture
carries one, geoBoundaries the other; never both), and `(+N more)` comes from
`result.moreCount` when result diversity collapsed duplicates. With neither
column it falls back to `"USA · ADM2"`.

### `addAreaLayer(map, options?) => AreaLayerHandle`

Renders an `Area` as a fill + a line, and — when `filterGeometry` differs from
`geometry` — a dashed "ghost" of the filter geometry, so a user can *see* that
their filter was simplified.

```js
import { addAreaLayer } from '@cnmw/maplibre';

const outline = addAreaLayer(map, { lineColor: '#e8710a', fillOpacity: 0.12 });
outline.setArea(area);
outline.fit({ padding: 60 });
outline.setStyle({ lineWidth: 3 });
outline.remove();
```

| option | default |
|---|---|
| `id` | `'cnmw-area'` — prefixes every source/layer id, so two layers can coexist. |
| `lineColor` | `'#1a73e8'` |
| `lineWidth` | `2` |
| `lineDasharray` | — |
| `fillColor` | `'#1a73e8'` |
| `fillOpacity` | `0.08` |
| `showFilterGeometry` | `true` |
| `beforeId` | — insert below an existing layer. |

Sources and layers created, which you can also reach directly:
`<id>-display` and `<id>-filter` (GeoJSON sources), `<id>-fill`, `<id>-line`,
`<id>-filter-line`.

Reading the drawn geometry is the right way to assert in a test:

```js
map.getSource('cnmw-area-display')._data.features[0].geometry.type;   // 'Polygon'
```

### `viewportProvider(map) => () => BBox`

```js
import { viewportProvider } from '@cnmw/maplibre';

const getViewport = viewportProvider(map);
const results = await geocoder.search(query, { viewport: getViewport() });
```

A one-liner over `map.getBounds()` → `[west, south, east, north]`. This is the
only reason the adapter needs the map for *search* at all.

### `fitAreaBounds(map, bboxes, options?)`

Antimeridian-aware camera. MapLibre's own `fitBounds` cannot be handed a bbox
with `west > east` — it does not know it is a wrap — so for the 2-box case this
fits **the box nearer the map's current centre**, by shortest wraparound
longitude distance. A reasonable default for "I just searched for Fiji and want
to see it", with no `renderWorldCopies` tricks.

```js
fitAreaBounds(map, area.bboxes, { padding: 40, maxZoom: 12 });
```

`AreaLayerHandle.fit()` calls this for you with the current area.

---

## Gotchas

**`options.geocoder` has no default.** The design doc says it defaults to
`new Geocoder()`; it does not. With no `geocoder`, the control renders and
accepts typing but every search is a silent no-op (`_doSearch` returns early)
and `_onPick` throws on `this.geocoder.select`. This is deliberate — it keeps
`@cnmw/maplibre` from importing `@cnmw/geocoder-core`, so a page that only
wants `addAreaLayer` does not pull in a parquet reader — but it means you must
always pass one. `geocoderOptions` is accepted and ignored for the same reason.

**Add the control on `map.on('load')`.** `onAdd` calls `addAreaLayer`, which
calls `map.addSource`/`addLayer`, which MapLibre refuses before the style has
loaded. Adding it too early throws.

**`createDrawTool` does not exist.** The design doc (§5.2) specifies a minimal
rectangle/polygon/viewport draw tool; it is not implemented. If you already
have a draw library, pass its GeoJSON to `@cnmw/upload-core`'s
`areaFromGeoJson` and you get the same `Area` with `source: 'upload'`.

**A `renderItem` string goes through `innerHTML`.** If any of it comes from the
index, you are trusting the index's `name` column. Return a `Node` instead if
that matters to you. The default renderer uses `textContent` throughout.

**The attribution line only appears after a selection.** It renders from
`Area.provenance.attribution`, which does not exist until there is an `Area`.
If you need attribution visible from page load (and for ODbL data you probably
do), read `geocoder.attribution` after `load()` and render it yourself.

**One document click listener per control instance.** `onRemove` cleans it up;
dropping a control without calling `onRemove` leaks it.

## Tests

Nothing here is unit-tested directly: it is DOM wiring against a live
map instance, which is better verified for real.

```bash
python3 serve.py 8000 &
node examples/quickstart/verify.mjs 8000       # control renders, loads on focus, selects, draws, attributes
node examples/geocoder-demo/verify-live.mjs 8000   # ADM0/1/2, progressive upgrade, 0 console errors
node examples/download-demo/verify.mjs 8000    # the control feeding @cnmw/download-core
```

Those assert on `map.getSource('cnmw-area-display')._data`,
`aria-activedescendant` after an arrow key, and the rendered
`.cnmw-attribution` text — not on screenshots.

`packages/maplibre/test/` holds unit tests for the pure combobox helpers as
they are extracted from the control.
