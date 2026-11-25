# @cngeo/maplibre

The MapLibre GL half of the widgets: an accessible search box, an outline
layer, a viewport provider, an antimeridian-aware camera, a rectangle/
polygon/viewport draw tool, and a vertex editor for an existing outline.

```js
const control = new GeocoderControl({ geocoder });
map.on('load', () => map.addControl(control, 'top-left'));
```

**What this adapter deliberately does not do** (design doc §5.1): fetch an
index, rank results, simplify geometry, construct an `Area` from raw
coordinates, or hold dataset/filter state. All of that lives in
`@cngeo/geocoder-core` and `@cngeo/spec`, so it cannot drift between the MapLibre
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
    "@cngeo/spec": "/packages/spec/src/index.js",
    "@cngeo/geocoder-core": "/packages/geocoder-core/src/index.js",
    "@cngeo/maplibre": "/packages/maplibre/src/index.js"
  }
}
</script>
<script type="module">
  import { Geocoder } from '@cngeo/geocoder-core';
  import { GeocoderControl, addAreaLayer } from '@cngeo/maplibre';
</script>
```

The control's CSS is **inlined as a string** and injected once into
`document.head` under `id="cng-geocoder-style"` — no stylesheet to load, no
build step to configure, and nothing to break a zero-build page. Override by
targeting `.cng-geocoder` and its children.

**Coming:** `npm i @cngeo/maplibre`.

## Size

| | files | raw | gzip | gzip, comments stripped | design-doc budget (§4.5) |
|---|---|---|---|---|---|
| `@cngeo/maplibre` src | 5 | 18.9 KiB | 5.9 KiB | **4.3 KiB** | ≤ 8 KB min+gz |

(Table above predates `draw-tool.js`/`edit-tool.js`, added 2026-11-13; not
remeasured here — see the design doc amendment in §5.2 for what they add and
`edit-tool.js`'s own header for the terra-draw weight comparison that went
into not adding a dependency instead.)

`maplibre-gl` itself is ~200 KiB min+gz and is a peer — not counted here,
because you already have it.

---

## Minimal example

Complete, runnable, and verified:
[`examples/quickstart/index.html`](../../examples/quickstart/index.html).

```js
import { Geocoder } from '@cngeo/geocoder-core';
import { GeocoderControl } from '@cngeo/maplibre';

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
  // `area` is ready for @cngeo/extract-core. The outline is already drawn
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
| `showAttribution` | `boolean` | `true` | The design-call-#11 attribution, rendered from `Area.provenance.attribution` after the first selection — since 2026-11-13 as a compact bottom-left ⓘ button on the map (in MapLibre's `bottom-left` control corner; bottom-right is MapLibre's own attribution) that expands to a pill with the text and links. The pill starts collapsed, collapses on outside click and on each new selection, and the host is removed in `onRemove`. Keep page overlays out of the map's bottom-left corner, or the pill expands underneath them. |
| `renderItem` | `(SearchResult) => string \| Node` | the default renderer | A returned string is assigned to `innerHTML`; a `Node` is appended. |
| `geocoderOptions` | `GeocoderOptions` | — | **Not honored.** Construct the `Geocoder` yourself. |
| `upgradeNoticeStrings` | `Partial<{ upgrading, upgraded, cancelled, cancelLabel, cancelTitle }>` | English defaults | i18n override for the "loading full detail…" notice below. `upgrading` is a function of the formatted vertex label (`''` when no estimate), e.g. `(v) => v ? \`Chargement… ~${v} sommets\` : 'Chargement…'`. |

| member | notes |
|---|---|
| `control.geocoder` | The instance you passed. |
| `control.area` | The current `Area`, or `null`. |
| `onAdd(map)` / `onRemove()` | MapLibre's lifecycle. `onRemove` detaches the document click listener, unsubscribes from every geocoder event (`'select'`, `'area:upgrading'`, `'area:upgraded'`, `'area:upgrade-cancelled'`, `'results'`), clears the notice's auto-hide timer, and removes the outline layer. |
| `setArea(area)` | Draws it, fits the camera (if `fitBounds`), renders attribution. `null` clears. |
| `clear()` | Empties the input, closes the list, clears the area, emits `'clear'`. |
| `focus()` | Focuses the input. |
| `on(event, handler)` | `=> unsubscribe`. |

Events: `select` (`{ result, area }`), `results` (`SearchResult[]`),
`upgrade` (`{ area }` — a background `resolution: 'both'` upgrade landed),
`upgrade-cancelled` (`{ area }` — the user clicked Cancel on the notice
below), `clear`, `error`.

### The "loading full detail…" notice

If the `Geocoder` is constructed with (or the control's `select()` runs
with) `geometry: { resolution: 'both', upgradeDisplay: true }`, the control
shows a small notice below the combobox while the background full-resolution
fetch is in flight:

```
Loading full detail… ~69K vertices                                    ✕
```

The `✕` calls `geocoder.cancelUpgrade()`. Click it and the notice becomes
"Keeping simplified outline." (auto-hiding after ~2.6s); let it finish and
it becomes "Full detail loaded." instead, and the outline itself swaps to
the full-resolution geometry **in place — no camera move**. The vertex
number is a cheap, manifest-derived *estimate* (geocoder-core's
`estimateUpgradeOf`) — the average feature size in that boundary file, not
this feature's actual size — and is simply omitted when the manifest
doesn't declare enough to compute one.

The outline swap itself is deferred one idle slot
(`requestIdleCallback`/`setTimeout(fn, 0)`) rather than applied synchronously
inside the `'area:upgraded'` handler: at `upgradeDisplay`-scale (Canada ADM0
is ~500K vertices), `GeoJSONSource#setData()`'s structured-clone to
MapLibre's tiling worker is itself a measurable main-thread task, and
deferring it keeps that cost off of whatever the user is doing right now.
See the geocoder demo's long-task report for the measured numbers.

Without `upgradeDisplay`, the background upgrade still runs (it always has —
it's what keeps `filterGeometry` honest), but the notice never appears and
the outline never changes: there is nothing user-visible to report.

This state machine (`upgrade-notice.js`'s `upgradeNoticeReducer`/
`describeUpgradeNotice`) is pure and unit-tested without a DOM, same split
as the combobox's own `combobox-helpers.js`.

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

The default option renderer shows the name — with the matched substring
wrapped in `<mark>` — plus disambiguating secondary text:

```
Contra Costa  — United States · USA · County/District  [ADM2]
Bag       alt — Rajasthan · IND · Locality  [ADM4]  (+7 more)
```

Reading that line, left to right: `result.parentName ?? result.countryName`
(Overture carries one, geoBoundaries the other; never both), the ISO country
code, a human-readable level from `result.class` or `result.level`, the raw
`ADM<n>` as a small badge for anyone who thinks in admin levels, and
`(+N more)` when result diversity collapsed duplicates into this row. An
`alt` badge marks a match against an alternate-language name.

Every part of it is `textContent`, never `innerHTML`.

### `addAreaLayer(map, options?) => AreaLayerHandle`

Renders an `Area` as a fill + a line, and — when `filterGeometry` differs from
`geometry` — a dashed "ghost" of the filter geometry, so a user can *see* that
their filter was simplified.

```js
import { addAreaLayer } from '@cngeo/maplibre';

const outline = addAreaLayer(map, { lineColor: '#e8710a', fillOpacity: 0.12 });
outline.setArea(area);
outline.fit({ padding: 60 });
outline.setStyle({ lineWidth: 3 });
outline.remove();
```

| option | default |
|---|---|
| `id` | `'cng-area'` — prefixes every source/layer id, so two layers can coexist. |
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
map.getSource('cng-area-display')._data.features[0].geometry.type;   // 'Polygon'
```

### `viewportProvider(map) => () => BBox`

```js
import { viewportProvider } from '@cngeo/maplibre';

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

### `createDrawTool(map, options?) => DrawToolHandle`

```js
import { createDrawTool } from '@cngeo/maplibre';

const drawTool = createDrawTool(map, { tools: ['rectangle', 'polygon', 'viewport'] });
drawTool.on('area', ({ area }) => { /* an Area with provenance.source === 'draw' */ });
drawTool.arm('rectangle'); // crosshair cursor; drag a rectangle; Escape disarms
drawTool.arm('polygon');   // click each corner; double-click/Enter closes; Escape cancels
drawTool.arm('viewport');  // one-shot: the current map bounds, no drag
```

`tools` defaults to `['rectangle', 'viewport']`, so `polygon` has to be asked
for. Arming one tool disarms whichever was armed before.

**Polygon.** Click each corner. Double-click, press <kbd>Enter</kbd>, or click
the first corner again to close the ring; <kbd>Esc</kbd> cancels and emits
`cancel`. Fewer than three corners will not close, and leaves the tool armed.
`doubleClickZoom` is disabled while armed and restored on disarm, and the
ordinary `click` MapLibre delivers as the first half of a double-click is
dropped rather than becoming a duplicate corner. `handle.vertices` is the
corners placed so far, and `handle.tool` is the armed tool.

`options.names` overrides the emitted Area's display name — `{ drawn }` for
the rectangle and the polygon, `{ viewport }` for the viewport tool — which a
host that has to translate those strings will want. Every emitted `Area` goes
through `@cngeo/spec`'s `buildArea`, same as every other Area this adapter
produces, with `provenance.draw.tool` naming which tool drew it.

### `createEditTool(map, area, options?) => EditToolHandle`

```js
import { createEditTool } from '@cngeo/maplibre';

const editTool = createEditTool(map, area);
editTool.on('change', ({ area: edited }) => { /* Area with provenance.source === 'edited' */ });
// ... user drags a vertex, drags a midpoint out to insert one, double-clicks one to delete it ...
const finalArea = editTool.getArea();
editTool.remove();
```

Edits the exterior ring with the most vertices (the whole geometry for a
`Polygon`; the largest component's outer ring for a `MultiPolygon`) — holes
and any other polygon pass through unedited. `provenance.edited` keeps the
parent Area's lineage (`parentAreaId`, `parentSource`, `parentCreatedAt`);
`provenance.features` is carried over from the parent verbatim so the
original `featureId` is never lost. Hand-rolled rather than built on
terra-draw — see [`src/edit-tool.js`](src/edit-tool.js)'s header for the
measured weight that comparison was based on.

---

## Layers

A layer stack for a map: styled vector tiles, COGs and GeoJSON in one ordered
list, with a panel to drive it. Working example:
[`examples/layers-demo`](../../examples/layers-demo/index.html).

```js
import { LayerManager, LayerControl, urlAddProvider } from '@cngeo/maplibre';
import { layersFromCollection } from '@cngeo/stac';

const manager = new LayerManager(map);                 // the stack sits under the basemap's labels
map.addControl(new LayerControl({
  manager,
  basemapStyleUrl: STYLE_URL,                          // groups the basemap's layers under one row
  addProviders: [urlAddProvider({ layersFromCollection })],
}), 'top-right');

const url = 'https://storage.googleapis.com/carto-open-catalogs/ocha-cod-jamaica/main/parishes/collection.json';
const [parishes] = layersFromCollection(await fetch(url).then((r) => r.json()), { baseUrl: url });
await manager.add(parishes);                           // drawn with the collection's own style

await manager.add({
  spec: 'cng-layer/1.0', id: 'image', kind: 'cog',
  source: { url: 'https://example.org/scene.tif' },    // read by range request, reprojected in the browser
});
manager.move('image', 0);                              // to the bottom; the map follows
```

### `new LayerManager(map, options?)`

One bottom-first array of [`LayerSpec`s](../spec/README.md#layers) is the
truth; the map is made to agree with it.

| member | notes |
|---|---|
| `add(spec, { visible?, opacity?, index? })` | `Promise<LayerEntry>`. Rejects `LAYER_INVALID` (bad spec; an id already in the stack, or one that becomes the same map id, e.g. `"a b"` and `"a/b"`) or `LAYER_UNSUPPORTED` (a `table`, an `unsupported` layer, a kind with no renderer, a PMTiles archive of raster tiles). A load failure rejects with `LAYER_LOAD_FAILED`, and the layer **stays in the list** with `status: 'error'`. Called before the map's style has loaded, it waits for it. |
| `remove(id)` | Safe while the layer is still loading. |
| `setVisible(id, bool)` / `setOpacity(id, 0..1)` | Opacity is clamped, and always scaled from what the layer's style defined. |
| `move(id, toIndex)` | Index in the bottom-first list. |
| `list()` / `get(id)` | Copies: `{ id, title, kind, visible, opacity, status, error?, note?, bbox?, attribution, spec }`. |
| `on('change' \| 'error', fn)` | Returns an unsubscribe. `change`: `{ type, id }`, type one of `add ready remove move visible opacity note error`. `error`: `{ id, error }`. |
| `attribution({ deckOnly? })` | What must be credited for the layers currently shown: each credit with its layer's `id` and `title`. |
| `settled()` | Resolves when no add or rebuild is in flight. |
| `deckLayers()` | The deck.gl layer objects currently on the map. |
| `destroy()` | Takes everything off the map. |

Options: `beforeId` — the MapLibre layer the stack sits just below (default:
the basemap's first symbol layer; `null` for above everything);
`addProtocol` — MapLibre's `addProtocol`, needed for PMTiles (default:
`globalThis.maplibregl.addProtocol`, so pass it when MapLibre is an ES-module
import); `renderers`, `loadDeck` — per-instance overrides.

A `note` is something worth telling the user that is not a failure: a
published style that could not be loaded (the layer is drawn with a default
style), a tile that failed.

**A layer can become an error after it was ready.** deck.gl reports a file it
cannot open (a 404) or cannot draw (a single-band Float32 COG has no default
rendering) some time after the layer was handed over. The entry then turns to
`status: 'error'` with the reason, `error` and `change` fire, and nothing of
it stays on the map. A PMTiles archive is checked before anything is added:
one that cannot be read is `LAYER_LOAD_FAILED`.

**Credit.** A layer's `attribution` is put on its MapLibre sources, so
MapLibre's own attribution control shows it while the layer is shown. deck.gl
layers have no source, so their credits appear in a second small box in the
same corner. The text is escaped and a credit links only to an `http(s)` URL
(`attributionHtml()` is exported for a host that wants to render credits itself).

Not yet handled: a 16-bit image shows nothing in a browser without
`EXT_texture_norm16` and nothing reports it (`deckSupport()` tells you
whether the browser has it). Stretches and band composites are imagery work
for a later phase.

**What draws what.** `pmtiles-vector` and `geojson` are MapLibre style layers.
`cog` is drawn by Development Seed's deck.gl-raster in one shared, interleaved
deck.gl overlay, so a raster can sit *between* two vector layers. deck.gl
arrives as one prebuilt module the first time a raster is added (446 KB gzip;
see [`vendor/README.md`](vendor/README.md)); a page with only vector layers
never loads it. `registerLayerRenderer(kind, factory)` adds or replaces a renderer.

After `map.setStyle()`, which drops every added layer, the stack is put back
in the same order and state.

**Projections are local.** A COG is reprojected on the GPU from whatever CRS
it declares, and deck.gl-raster looks that CRS up by EPSG code: from proj4's
own definitions when it has one (4326, 3857, the WGS84 UTM zones), and from
`https://epsg.io/<code>.json` otherwise. Before its first layer the `cog`
renderer therefore calls `registerKnownProjections(deck)`, which defines the
UTM families imagery is published in — NAD83 (269xx), NAD83(2011)
(6328–6348), ETRS89 (258xx), SIRGAS 2000 (31965–31985), GDA94 (283xx),
GDA2020 (78xx) — so a NAIP or OpenAerialMap scene opens without that request
(measured: one request to epsg.io before, none after). `utmDefinition(epsg)`
gives the proj4 string, or `null`. A CRS outside those families still goes to
epsg.io; to avoid that, define it yourself before adding the layer —
`deck.proj4.defs('EPSG:2154', '…')`, or `deck.registerProjection(2154, wktOrProjjson)`.

**Decoding survives a strict CSP.** Tiles are decompressed in web workers,
which the prebuilt bundle starts from a Blob URL. A page whose
Content-Security-Policy does not allow `blob:` in `worker-src` cannot start
one. That is probed once per page (`canStartBlobWorker()`); where it fails,
layers decode on the main thread instead — slower, and drawn, rather than
"ready" and blank.

### `new LayerControl({ manager, addProviders?, basemapStyleUrl?, collapsed? })`

The panel: toggle, opacity, drag to reorder, and a menu per row (right-click,
or Shift+F10) with remove, move and zoom. (Its Rename changes the row's label
in the panel only; the layer's `title` is not changed.) `control.ready`
resolves when it is on the map.

It is opengeos'
[maplibre-gl-layer-control](https://github.com/opengeos/maplibre-gl-layer-control)
0.18.3, loaded from a pinned URL, with three things added: it is themed by
the same `--cng-*` tokens as the geocoder, with dark mode; it is
keyboard-operable (Alt+↑/↓ on a row's checkbox reorders it; the menu takes
arrow keys, Enter and Escape); and it has an **Add** button.

`addProviders` are what the Add button offers.
`urlAddProvider({ layersFromCollection })` accepts a `collection.json`,
`.pmtiles`, `.tif` or `.geojson` URL. Reading a STAC collection is passed in
because this package does not import `@cngeo/stac`.

### `new ImagerySearchControl({ search, manager, area?, time?, limit?, collapsed? })`

Find imagery scenes and add them to the map. A panel with where to search,
a date range, the property filters the collection offers, an order and
result cards; and on the map, the footprints of what was found.

```js
import { imageryProfile, ImagerySearch } from '@cngeo/stac';
import { LayerManager, ImagerySearchControl } from '@cngeo/maplibre';

const search = new ImagerySearch(imageryProfile(collection, { baseUrl: collectionUrl }));
const manager = new LayerManager(map);
map.addControl(new ImagerySearchControl({ search, manager }), 'top-left');
```

`search` is injected — an `ImagerySearch` from `@cngeo/stac`, or anything with
its `search()` and `layerSpecFor()` — because this package does not import
that one. The host owns it: call `search.close()` when you are done with it.

- **Where.** "This view" searches the map's bounds (a view of the whole world
  searches everywhere; one across the antimeridian searches both sides). Pass
  `area: () => Area | null` — the area your geocoder or draw tool holds — and
  the panel also offers "Selected area".
- **When.** Two date inputs; "to" is inclusive. `time: { start, end }`
  (`YYYY-MM-DD`) sets them initially. With no `time`, a partitioned archive
  starts on its last 30 days (`defaultTimeWindow(profile)`): a search with no
  dates has to plan every part of it, which on Sentinel-2 is a footer of
  about 8 MB per year. A single-file collection starts with no dates.
  `time: null` means none, whatever the collection.
- **Filters and order** are generated from `profile.filters`: a number input
  for a `max`/`min` filter, a menu for an `enum` whose values the collection
  lists, two inputs for a `range`. **Null means unknown:** a numeric filter
  keeps a scene that has no value in that column — a scene whose cloud cover
  was never recorded is not a cloudy scene. Choosing a category does not.
  Changing the order reorders the list at once (by searching again only when
  some matches are not shown).
- **Results** stream in as they are read, then settle into the sorted answer.
  The status line says what is shown out of what matched, and unfolds into
  how the search ran: the files and row groups read out of how many, and
  each pruning stage.
- **Add to map** hands the scene to the `LayerManager` as a `cog` layer in
  the collection's group. A scene that cannot be added says why on its card.
- **Footprints** are one GeoJSON source and two style layers
  (`cng-layer-imagery-footprints--fill` / `--line`), kept just above the
  layer stack and below the labels — so they stay visible over an image you
  add. Hovering a card highlights its footprint, and the reverse. Only the
  hovered footprint is filled: scenes overlap, and a faint fill on each
  stacks into solid colour.

`control.search()` runs a search programmatically; `control.model` is the
state. The control survives `map.setStyle()` (its footprints are put back)
and being removed and added again, as a React wrapper does to one instance;
it makes a new model then, so read `control.model` rather than keeping a
reference to it.

Not tested in `npm test`: the panel's DOM. There is no DOM in the unit
suite, so everything the panel decides lives in the model (`statusOf`,
`whereFromFilters`, `defaultTimeWindow`, add, order), which is unit-tested,
and the panel itself is checked in a real browser by
`examples/imagery-search/verify.mjs`.

Everything from a remote document reaches the panel as text; a thumbnail is
shown only from an `http(s)` URL, lazily.

**Without the panel.** `createImagerySearchModel({ search, manager })` is the
same state with no DOM — `setArea`, `setTime`, `setFilter`, `setSort`, `run`,
`cancel`, `hover`, `add`, `on('change')`, `destroy` — for a host with its own
UI. `footprintsGeoJson(scenes, hoveredId)` and `areaFromBounds([w, s, e, n])`
are exported too.

**Drawing something of your own just above the stack.** Add your style
layers before `manager.anchor()` (the layer the stack sits below), then
declare them: `manager.setTopLayers([ids, bottom first])`. The declaration
matters. deck.gl puts an image's layer group *directly* under whatever it is
slotted beneath and moves it back there on every update, so a layer you
merely insert under the labels ends up beneath the next image added. Declared,
the stack is slotted under your layers instead. Declare again after
`map.setStyle()`; `setTopLayers([])` lets go.

### `new CatalogSearchControl({ index, manager, limit?, collapsed?, useView?, title? })`

Find collections in a catalog and add them to the map. A search box, an
"only this map area" switch, a menu per facet, and result cards.

```js
import { CatalogIndex } from '@cngeo/stac';
import { LayerManager, LayerControl, CatalogSearchControl, catalogAddProvider } from '@cngeo/maplibre';

const index = new CatalogIndex('https://registry.portolan-sdi.org/v0.1/collections.parquet');
const manager = new LayerManager(map);
const catalog = new CatalogSearchControl({ index, manager });
map.addControl(catalog, 'top-left');
// "Add" in the layer panel leads to it:
map.addControl(new LayerControl({ manager, addProviders: [catalogAddProvider(catalog)] }), 'top-right');
```

`index` is injected — a `CatalogIndex` from `@cngeo/stac`, or anything with
its `load()`, `search()` and `resolve()`.

- **Typing** searches after 200 ms; each search supersedes the last.
- **Only this map area** keeps what intersects the view and ranks a local
  collection above a global one for the same words. It follows the map as it
  moves.
- **Facets** — catalog, licence, and (when the index has a `render` column)
  what a collection draws as — each show how many results a choice would
  leave.
- **Hovering a card** shows that collection's extent on the map.
- **Add to map** resolves the collection and adds every layer of it that can
  be drawn. A collection that is a table, an imagery archive, or something
  nothing here draws **says so on its card** instead of adding nothing in
  silence; one that is partly drawable adds what it can and names the rest.
- A result whose layers are removed from the map can be added again.
- **Collection ids repeat across catalogs** (the registry has 23 shared by
  drawable collections: two `place`, two `land_use`…), and a layer is named
  after its collection. So a layer already on the map counts as "this one"
  only when its *source* is the same; a different dataset with the same id is
  added beside it as `<catalog>/<id>`.

`control.search(text)` runs a search; `control.show()` opens the panel and
focuses its box; `control.model` is the state. Like the imagery search, it
survives `map.setStyle()` and being removed and added again, and its DOM is
checked in a browser by `examples/catalog-search/verify.mjs` rather than in
`npm test`.

`createCatalogSearchModel({ index, manager })` is the same state with no DOM
(`setText`, `setUseView`, `setArea`, `setFacet`, `run`, `add`, `hover`,
`on('change')`, `destroy`); `catalogStatusOf(state)` and
`extentsGeoJson(results, hoveredKey)` are exported too.

**Two search panels on one map** each keep layers of their own above the
stack (footprints, an extent). `LayerManager.setTopLayers(ids, owner)` is per
owner for that reason: one declaring does not undo the other.

### A timeline layer, and `new TimelineControl({ manager, layer, metricLabel?, autoplay?, speed?, loop?, theme? })`

A histogram of time under the map, with a selection that decides what the
map draws, over data published as **chunks** — files that each cover a span
of time. The chunks are one layer:

```js
import { chunksFromTemplate } from '@cngeo/timeline';
import { LayerManager, LayerControl, TimelineControl, describePmtilesChunk } from '@cngeo/maplibre';

const BASE = 'https://data.source.coop/portolan-mirrors/firms-catalog/detections';
// The overview says its own span: it is rebuilt less often than the years are.
const overview = await describePmtilesChunk(`${BASE}/alltime.pmtiles`);   // { unit: 'month', start, end, url, format }
const fires = {
  spec: 'cng-layer/1.0',
  id: 'fires',
  title: 'Active fires',
  kind: 'timeline',
  source: {
    chunks: [
      ...chunksFromTemplate({ template: `${BASE}/year={YYYY}/fire-{YYYY}.pmtiles`, period: 'year', start: '2000-11-01' }),
      { ...overview, id: 'alltime' },
    ],
    aggregate: { layer: 'aggregate', idProperty: 'a5_cell' },   // cells with a count_YYYYMMDD column per day
    points: { layer: 'features', property: 'day' },             // features that each carry their own day
  },
  attribution: [{ text: 'NASA FIRMS' }],
};

const manager = new LayerManager(map);
map.addControl(new TimelineControl({ manager, layer: fires, metricLabel: 'detections' }), 'bottom-left');
map.addControl(new LayerControl({ manager }), 'top-right');   // the timeline is one entry in it
```

The page must be able to resolve **`@cngeo/timeline`** (one more line in the
import map): this package loads it the first time a timeline layer is added,
and not before, so a page with no timeline never needs it. In Node or a
bundler: `setTimelineModules(await import('@cngeo/timeline'))`.

**The layer** (`kind: 'timeline'`). `source`:

| | |
|---|---|
| `chunks` | Chunk descriptors: `{ id, start, end, unit, format, url, priority? }`. See [`@cngeo/timeline`](../timeline/README.md); `chunksFromStac` in `@cngeo/stac` builds them from a collection. |
| `aggregate` | `{ layer?, prefix = 'count_', idProperty?, maxzoom? }` — a vector layer whose features have a count per bucket. Within a chunk the selection is the **sum of its columns**, so moving it recolours the map and fetches nothing. A selection that spans chunks is drawn by each of them from its own columns: a cell present in two is drawn twice, each coloured by its own share, not once by the total. `false` when the archive has none. |
| `points` | `{ layer, property, minzoom?, color? }` — a layer of features that each carry their own day (`20240105`, or an ISO date). The selection filters them on the GPU. `color` is an `[r, g, b, a]`, or data: `{ property: 'frp', stops: [[0, '#4a5bd4'], [50, '#c9cf4a'], …] }`. |
| `stops` | Cell colours by count: `[[1, '#2c3d5a'], …]`. Default: `@cngeo/timeline`'s `COUNT_RAMP`. |
| `cap` | Most big chunks a view loads. Default 3. |
| `open` | `{ selectDays = 5, viewDays = 100 }`: where it opens, counted back from the end of the record. |

A `source` is plain data (it is part of a `LayerSpec`), so nothing in it is a
function.

An archive's time axis is read from its own metadata — a `cng:timeline`
(or `firms:timeline`) declaration `{ unit, min, max }`, else the bucket
columns its `vector_layers` declare — never from a sampled feature. A chunk
whose span is not in its name (a rolling "latest", an overview that lags the
present) can say its own:

```js
import { describePmtilesChunk } from '@cngeo/maplibre';
const latest = { ...(await describePmtilesChunk(`${BASE}/fire-latest.pmtiles`)), id: 'latest', priority: 1 };
// { unit: 'day', start: '20261118', end: '20261125', url, format: 'pmtiles', id: 'latest', priority: 1 }
```

A descriptor that claims more than its archive holds shows the difference as
loaded-and-empty: false zeros.

However many chunks are mounted, the layer manager has **one entry**: hide,
fade, reorder and remove act on all of it. `manager.handle(id)` is its
**session** — `state`, `on('change')`, `setView()`, `setSelection()`,
`retry()`, `tiles()` — for a host that wants its own controls. A **hidden**
timeline paints nothing and goes on loading, so its track still counts what
is in view. A chunk that will not load is a note on the layer, a gap in the
track and a Retry in the panel; the layer itself fails only when it has never
shown anything and cannot — one year answering a 520 in the middle of a
session is not that. A *tile* that fails is a note too, with how many: its
chunk is otherwise "loaded", and the hole it leaves in the map and the short
count in the track would say nothing.

An archive that has been opened stays open while the layer is on the map
(the eight most recently used), and its tiles' bytes stay in a 64 MiB cache:
going out to months and back in does not fetch the year again.

**The control.** Drag the selection or its handles; drag elsewhere to pan;
wheel or pinch to zoom; shift-drag to draw a selection; arrow keys move it.
Spans (7 days … All), zoom and fit buttons, two date inputs, step and
play / pause with a speed. Zoom out far enough and the track changes from
days to months, when the chunk set has a monthly chunk to show them with; in
again and it changes back. What is not loaded is hatched, not drawn as zero,
and the status line says how much of the selection that is.

- `layer` is the id of a timeline layer already in the manager, or a spec to
  add. Removing the control leaves the layer.
- Playback holds while the next chunk is loading. With
  `prefers-reduced-motion` nothing plays by itself and nothing runs faster
  than a step a second.
- `control.ready`, `control.session`, `control.play()`, `control.pause()`.
- It survives `map.setStyle()` and being removed and added again. Its DOM is
  checked in a browser by `examples/timeline-firms/verify.mjs`.

**Another chunk format.** `pmtiles` is built in. `registerChunkFormat(name,
factory)` adds one for `chunk.format: name`: a `ChunkFormat` from
`@cngeo/timeline` whose mounts also return `layers(state, beforeId)` (deck.gl
layers). `pmtilesChunkFormat()` is exported as the example.

### Loaders

Three third-party modules load lazily, each from an exact pinned URL, each
with an injection seam for a bundled host: `setDeckModules()`,
`setPmtilesModules()`, `setLayerControlModules()`.

---

## Dropdown states

Besides plain options, the listbox renders: a spinner row while loading or
searching, an error row with a Retry button, a `No matches for "…".` row,
and — when geocoder-core's fuzzy fallback produced the results (every
`rank.matchClass` is `'fuzzy'`, which only happens when the prefix search
found nothing) — a non-interactive caption row above them:
*No exact matches — showing close matches.* (`li.cng-fuzzy-note`,
`role="presentation"`, excluded from keyboard navigation and click
handling). A custom `renderItem` only replaces option contents; the caption
still renders.

## Gotchas

**`options.geocoder` has no default.** The design doc listed a
`new Geocoder()` default; that is now marked planned-not-implemented in its
§8, deliberately. With no `geocoder`, the control renders and
accepts typing but every search is a silent no-op (`_doSearch` returns early)
and `_onPick` throws on `this.geocoder.select`. This is deliberate — it keeps
`@cngeo/maplibre` from importing `@cngeo/geocoder-core`, so a page that only
wants `addAreaLayer` does not pull in a parquet reader — but it means you must
always pass one. `geocoderOptions` is accepted and ignored for the same reason.

**Add the control on `map.on('load')`.** `onAdd` calls `addAreaLayer`, which
calls `map.addSource`/`addLayer`, which MapLibre refuses before the style has
loaded. Adding it too early throws.

**`createDrawTool` draws one ring, with no snapping or self-intersection
check.** Polygon is click-to-add-corner and nothing more: no holes, no
multi-part shapes, no vertex snapping, and a ring you cross over yourself is
emitted as drawn. For anything richer, pass your own draw library's GeoJSON
to `@cngeo/upload-core`'s `areaFromGeoJson` and you get the same `Area` with
`source: 'upload'`.

**`createEditTool` edits one ring.** Holes, and every polygon in a
`MultiPolygon` other than the one with the largest exterior ring, are not
editable — they pass through the edit unchanged, not dropped.

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
node examples/download-demo/verify.mjs 8000    # the control feeding @cngeo/extract-core
```

Those assert on `map.getSource('cng-area-display')._data`,
`aria-activedescendant` after an arrow key, and the rendered
`.cng-attribution` text — not on screenshots.

`packages/maplibre/test/` holds unit tests for the pure combobox helpers as
they are extracted from the control.
