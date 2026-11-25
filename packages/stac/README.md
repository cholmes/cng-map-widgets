# @cngeo/stac

STAC for the map: turn a collection into layer specs, search STAC-GeoParquet
imagery, and search a `collections.parquet` index. Headless — no DOM and no
map library; the controls that use it live in `@cngeo/maplibre`.

**Status: under construction.** `layersFromCollection` is here; imagery
search and catalog search are not yet. The design, and the order the pieces
arrive in, is in
[`docs/superpowers/specs/2026-11-25-map-widgets-design.md`](../../docs/superpowers/specs/2026-11-25-map-widgets-design.md).

## `layersFromCollection(collection, { baseUrl })`

How would a map show this STAC collection? Answered from the collection
document alone: synchronous, no fetch. Returns `LayerSpec[]`
([`@cngeo/spec`](../spec/README.md#layers)) for `@cngeo/maplibre`'s
`LayerManager` to draw.

```js
import { layersFromCollection } from '@cngeo/stac';

const url = 'https://data.source.coop/portolan-mirrors/unosat/tropical-cyclones/2018/tc20180209ton/tc20180209ton-damage-sites/collection.json';
const collection = await fetch(url).then((r) => r.json());
const [layer] = layersFromCollection(collection, { baseUrl: url });

layer.kind;              // 'pmtiles-vector'
layer.source.url;        // 'https://…/tc20180209ton-damage-sites.pmtiles' (absolute)
layer.source.layers;     // ['damage-sites']
layer.source.style.url;  // 'https://…/styles/default.json'
layer.attribution;       // [{ text, license: 'CC-BY-4.0', url, shareAlike: false, share_alike: false }]
```

Rules, in order. A collection can yield more than one layer (NAIP gives its
scenes and its national overview COG):

| # | kind | when |
|---|---|---|
| 1 | `pmtiles-vector` | a `rel:"pmtiles"` link, else a PMTiles asset. Style: the asset with roles `style` and `default`, else the only `style` asset |
| 2 | `scenes` | an imagery item table: a `collection-mirror` asset, or STAC item columns over hive partitions or a `data` parquet asset |
| 3 | `cog` | each collection-level Cloud-Optimized GeoTIFF |
| 4 | `table` | parquet with no geometry column — described, not drawable |
| 5 | `unsupported` | anything else; `source.reason` says why and `source.assetTypes` what was found |

It does not refuse a collection: one it cannot draw comes back as a single
`table` or `unsupported` layer, so a UI can say *why* there is no map layer.
Members of the wrong shape (a `links` that is an object, a null in
`table:columns`, a `roles` that is a string) are tolerated, because this is
meant to be run over thousands of other people's documents.

It throws `LAYER_INVALID` for two things, both the caller's: something that
is not a collection (`context.field: 'collection'`), and a missing or relative
`baseUrl` (`'baseUrl'`). `baseUrl` is required because collections use
relative hrefs and a layer must be self-contained.

Only assets a browser can fetch count. A collection whose tiles or imagery
are published at `s3://…` is `unsupported`, and its reason names the URL. An
attribution link or thumbnail that is not `http(s)` is dropped.

The first layer takes the collection's `id` and `title`; any further layer
is `<id>:<asset key>`. `bbox` is left off when the collection's extent
crosses the antimeridian (no single `[w, s, e, n]` box describes it).

## `imageryProfile(collection, { baseUrl, overrides? })`

Reads an imagery collection into what a scene search needs. Synchronous, no
fetch. It exists because published imagery collections agree on STAC and on
little else:

| | NAIP | OpenAerialMap | Sentinel-2 |
|---|---|---|---|
| item table | a `data` parquet asset | a `collection-mirror` asset | hive partitions, no asset |
| `assets` column | struct | struct | a JSON string, ~18 KB a row |
| time | `datetime` | start/end, `datetime` null | `datetime` |
| picture asset | `image` | `visual` (role `data`) | `visual` |
| thumbnail | none per item | an asset | a URL column |
| columns declared | two tables in one list | none | yes |

```js
import { imageryProfile } from '@cngeo/stac';

const profile = imageryProfile(collection, { baseUrl: collectionUrl });

profile.dataset;        // a DatasetDescriptor: { kind: 'parquet', url } or the collection to resolve
profile.table;          // { idColumn, geometryColumn, timeColumn?, timeInterval? }
profile.displayAsset;   // 'visual' -- the item asset to draw
profile.thumbnail;      // { column: 'thumbnail_url' } or { asset: 'thumbnail' } or undefined
profile.assets;         // 'struct' | 'json' | 'unknown'
profile.filters;        // [{ column: 'eo:cloud_cover', label: 'Cloud cover (%)', kind: 'max', type: 'double' }, …]
profile.searchColumns;  // what a search reads -- `assets` only when it is a struct
profile.attribution;    // display it
```

- **`filters`**, at most six, most useful first: `eo:cloud_cover` and `gsd`
  (`max`), then categorical columns — `*:state`, `*:platform_type`,
  `platform`, `constellation` (`enum`) — then `*:year` (`range`). They come
  from `table:columns`, or from `summaries` when a collection declares no
  columns; `summaries` also supplies an enum's `values` and a range's
  `minimum` / `maximum`.
- **`assets: 'json'`** means a scene's assets are *not* read by a search:
  measured on Sentinel-2 that column is 85% of the file. They are resolved
  for one scene, when it is added to the map.
- **`columnsKnown: false`** means the collection declared no columns and
  STAC's defaults were assumed (`datetime`, `start_datetime` /
  `end_datetime`). A profile is a reading of the *document*, which can be
  silent or wrong about its files; `ImagerySearch` checks it against the item
  table's real schema when it first opens it.
- A `table:columns` that lists more than one table (NAIP) is read up to the
  first repeated column name.
- **`overrides`** replace what was derived: `displayAsset`, `thumbnail`,
  `filters`, `assets`, `assetHref` (a function from a scene to its picture
  URL, for a collection with a naming convention), `table` (merged),
  `searchColumns`.

Throws `LAYER_UNSUPPORTED` when the collection has no item table of scenes
(`context.kinds` lists what it does have), and `LAYER_INVALID` as
`layersFromCollection` does.

## `ImagerySearch`

Scenes from a STAC-GeoParquet item table, by area, time and attributes. No
server: it is `@cngeo/extract-core`'s `queryRows` — the same resolve → prune →
read a download does — plus what a scene search needs on top.

```js
import { imageryProfile, ImagerySearch } from '@cngeo/stac';

const search = new ImagerySearch(imageryProfile(collection, { baseUrl: collectionUrl }));
search.warm();                                  // when the search panel opens; optional

const { scenes, truncated, partial, plan } = await search.search({
  area,                                         // an Area, or omit to search everywhere
  time: { start: '2025-06-01T00:00:00Z', end: '2025-07-01T00:00:00Z' },
  where: [{ col: 'eo:cloud_cover', op: '<=', value: 20 }],
  sort: { by: 'datetime', order: 'desc' },      // the default: newest first
  limit: 200,                                   // the default
  onScenes: (batch) => draw(batch),             // as each row group is read
});

scenes[0];
// { id, datetime, start, end, bbox: [w, s, e, n], geometry, properties, thumbnail, self, assets? }

layerManager.add(await search.layerSpecFor(scenes[0]));   // a `cog` layer, in the collection's group
```

**One search at a time.** Starting a search supersedes the one in flight: it
stops reading and resolves `{ scenes: [], superseded: true }`. It never
rejects and never delivers another batch, so `search()` is safe to call on
every change of a date slider.

**A `Scene` is one shape** whatever the collection does: `bbox` is
`[w, s, e, n]` whether the file stores a list or a struct; times are ISO
strings whether it stores timestamps or text; `start` / `end` are set for a
scene that covers a span (and `datetime` may then be null); `properties` is
every other column the search read. `assets` is present only when the search
read them — see below.

**What a search costs.** The dataset is resolved once and its part listing and
footers are kept (a plan cache, 10 minutes by default; `options.maxAgeMs`, or
pass your own `options.cache` to share one). A repeated search pays for row
reads only. `onPlan(plan)` fires before any row with what will be read
(`plan.files`, `plan.rowGroups`) and the pruning narration (`plan.prune`).
`plan.requests` models one request per row group; the reader makes one per
column chunk, so expect about four times as many on a wide table.

**`limit`, `sort` and `scanLimit`.** Rows come in file order, so the newest N
cannot be had without reading every match. A search therefore reads up to
`scanLimit` matching rows (5,000 by default), then sorts, then cuts to
`limit`. `truncated` says there were more matches than `scenes` returned;
`partial: true` says the read itself stopped at `scanLimit`, so the order is
over that subset only — narrow the area or the dates. `matched` is how many
rows were read. `onScenes` batches are unsorted and uncut.

**A scene's files are resolved when you ask for them**, not for every row.
`resolveAssets(scene)` returns the first of:

1. the assets its row carried — a struct column, read with the search (NAIP,
   OpenAerialMap);
2. `profile.assetHref(scene)`, a naming convention, as the display asset;
3. the scene's own STAC item document (`scene.self`, from the row's `links`),
   one request, kept — how a Sentinel-2 scene is resolved, whose `assets`
   column is a JSON string too large to read per search.

Otherwise it rejects with `SCENE_ASSETS_UNAVAILABLE` (`context.scene`,
`context.reason`: `no-source`, `item-fetch-failed`, `item-has-no-assets`,
`no-such-asset`).

`layerSpecFor(scene, { asset? })` turns that into a validated `cog`
`LayerSpec` — id `<collection>:<scene>`, `group` the collection id, the
collection's attribution, the scene's bbox, time span and thumbnail. The
asset is `asset ?? profile.displayAsset` and must be an http(s) GeoTIFF;
anything else is `LAYER_UNSUPPORTED` rather than a layer that draws nothing.

**The profile is checked against the file.** `search.profile` starts as the
profile you passed. After `warm()` — for a single-file item table — it has
been settled against the file's real schema: columns the file lacks are
dropped, `assets` is known to be a struct or not, and the row's `links` and
`title` are read when they exist. For a partitioned collection no footer is
read up front and the collection's declared columns are trusted.

**Nothing waits forever.** `options.timeoutMs` (60 s; `0` for none) bounds
every request a search waits on: resolving the dataset, listing its files, a
footer, a row read. A request that never answers used to hold the search, and
every search after it. Past the limit, preparing fails as a retryable
`NETWORK` error (`context.reason: 'timeout'`) and is not remembered; a row
read is made again — a search retries a failed read twice, a moment apart.
`cancel()` and a superseding search take effect at once even while the
dataset is still being prepared.

`cancel()` stops the search in flight and keeps the cache. `sort(scenes,
order)` reorders scenes already found without reading anything (right only
when the list is every match — see `truncated`). `close()` stops the search
and forgets what was cached, unless the cache is one you passed in.

## `CatalogIndex`

Search a catalog of collections, in the browser. A Portolan catalog publishes
an index of everything in it as one parquet file, `collections.parquet`: a
row per catalog and per collection.

```js
import { CatalogIndex } from '@cngeo/stac';

const index = new CatalogIndex('https://registry.portolan-sdi.org/v0.1/collections.parquet');
await index.load();              // or let the first search do it
index.entries.length;            // 6,941 collections (2026-11-25)

const { results, total, facets } = await index.search({
  text: 'buildings',
  area,                          // an Area: the map view, say
  time: { start: '2024-01-01T00:00:00Z' },
  license: 'CC-BY-4.0',
  limit: 50,
});
results[0];      // { key, id, title, description, href, license, keywords, catalog, catalogs, bbox, start, end, kinds, thumbnail, score, fit }
facets.license;  // [{ value: 'CC-BY-4.0', count: 87 }, …]
```

The URL may also be a `catalog.json` that links to its index with
`rel: "data"`.

**What it reads.** The registry's index is 20 MB, of which 12.5 MB is each
collection's whole JSON (`original`) and 5.6 MB its `links`. Neither is ever
read. Titles, descriptions, keywords, extents and licences are 2.1 MB in six
requests (measured in Node; seven in a browser on a host that hides
`Content-Range`, GitHub Pages among them), and the rows are then searched in
memory.

**Search.**

- `text`: every word must be found, in the title, keywords, id or
  description; the last may be unfinished, as it is while typing. Accents do
  not matter (`baume` finds `Bäume`). A word of six letters or more may be
  one letter off, which is what lets `buildings` find `Building`; a short
  word must match as typed, because one letter off a short word is another
  word (`Bäume`, trees; `Räume`, rooms). Only when nothing matches at all is
  a looser spelling tried. A title match counts for more.
- `area`: keeps collections whose extent intersects it, on either side of the
  antimeridian. A collection with no extent is in no area.
- `time`: keeps collections whose own span overlaps the window. A start with
  no end means ongoing. A collection with no dates is in no window.
- `license`, `catalog`, `kinds`: a value or a list.
- **Order**: by how well the text matches and, when an area is given, by how
  much of the collection lies inside it (`fit`, 0..1). A city's own buildings
  come before a global buildings layer for the same words; with no area the
  two rank by text alone.
- **Facets** say what each filter could be set to and how many collections
  that would leave. Each is counted over the matches of all the *other*
  filters, so choosing a licence does not empty the list of licences.
- One search at a time: a new call supersedes the one in flight, which
  resolves `{ results: [], total: 0, superseded: true }`. Safe on every
  keystroke.

**Things the live index taught it.**

- `id` is not unique across catalogs; `key` (the collection's URL) is. 23 ids
  are shared by two or more *drawable* collections, so a layer's id is not
  proof of which dataset it is (`CatalogSearchControl` compares sources).
- 108 of 7,049 collection rows repeat another row's URL: the same collection,
  registered under a second catalog. One collection is one entry, and
  `catalogs` lists every catalog it is under — the `catalog` filter and facet
  match any of them. (Keeping only the first hid one registered catalog
  entirely: all 79 of its collections are listed under another first.)
  `index.duplicates` counts the folded rows.
- Its host, GitHub Pages, misreports the file's size to a `HEAD` request;
  `@cngeo/extract-core` no longer asks that way.
- `href`, a parent's `href` and `thumbnail` may be relative to the index
  file; entries carry them absolute. A row whose `href` is not then http(s)
  is left out.

**Time limits.** `timeoutMs` (60 s; 0 for none) bounds every request the
index makes: each read while loading, the `catalog.json` it may start from,
and the collection document `resolve()` fetches. A host that never answers
is `NETWORK` or `LAYER_LOAD_FAILED`, retryable, and is not remembered.

**Text search is [MiniSearch](https://github.com/lucaong/minisearch)** (MIT),
loaded from a pinned URL (`MINISEARCH_URL`) the first time a search has words
in it — about 0.8 s to index the registry, then 1–35 ms a search (measured:
the long end is a one-letter last word, which matches thousands). In Node, or
inside a bundler, hand it in:

```js
import MiniSearch from 'minisearch';
import { setMinisearchModules } from '@cngeo/stac';
setMinisearchModules({ MiniSearch });
```

`kinds` — whether a collection draws as vector tiles, a COG, imagery scenes
or not at all — is known only when the index has a `render` column, which the
registry's does not yet (`index.hasRender`). See
[`experiments/e13-render-column`](../../experiments/e13-render-column/).

**From a result to the map.** `resolve(result)` says what a found collection
draws as:

```js
const { drawable, undrawable, source } = await index.resolve(results[0]);
for (const spec of drawable) await layerManager.add(spec);
undrawable;   // [{ title, kind: 'table', reason: 'A table with no geometry: there is nothing to draw on a map.' }]
source;       // 'collection' -- its JSON was fetched -- or 'render'
```

- With no `render` column, the collection's JSON is fetched (once per
  collection; kept) and read with `layersFromCollection`.
- With one, there is no request at all: `layersFromRender(entry)`.
- `drawable` is what a map can show as one layer today (`pmtiles-vector`,
  `cog`, `geojson`; pass `drawableKinds` to change that). Everything else is
  in `undrawable` **with a reason**: a table has no geometry, an imagery
  collection is searched rather than drawn, an unsupported one says what was
  found. A result that adds nothing to the map has to be able to say why.
- A collection whose JSON is gone, or is not a collection, rejects
  `LAYER_LOAD_FAILED` naming it.

**The `render` column** is a proposal, measured in
[E13](../../experiments/e13-render-column/RESULTS.md): one short list per
collection, an entry per layer, nine flat fields (`RENDER_FIELDS`: `kind`,
`id`, `title`, `url`, `style`, `layers`, `display_asset`, `items`, `reason`).
It holds only what is specific to drawing; a layer's extent, dates, thumbnail
and credit come from the row's other columns. `renderFromLayers(layers)`
writes it and `layersFromRender(entry)` reads it back. Credit matters here:
an index that says how to draw a collection without fetching its JSON has to
say whom to credit too, so the same proposal adds an `attribution` column.
Without one, a layer is credited with the collection's title and licence.

Rejects `CATALOG_INDEX_INVALID` for something that is not a collections
index. `close()` forgets what was read.

## `chunksFromStac(collection, { baseUrl, fetch?, unit?, format?, assetType? })`

Timeline chunks from a collection whose data is cut by time: one per item
that has dates and a tiles asset. The result is what
[`@cngeo/timeline`](../timeline/README.md) takes.

```js
import { chunksFromStac } from '@cngeo/stac';

const url = 'https://data.source.coop/portolan-mirrors/firms-catalog/detections/collection.json';
const collection = await fetch(url).then((r) => r.json());
const { chunks, skipped } = await chunksFromStac(collection, { baseUrl: url });
chunks[0];   // { id: '2000', start: '20001101', end: '20001231', unit: 'day', format: 'pmtiles',
             //   url: 'https://…/detections/year=2000/fire-2000.pmtiles', priority: 0 }
```

- An item's span is its `start_datetime`..`end_datetime` (or its `datetime`),
  as UTC days. A date-time that names no zone is read as UTC, not in the
  reader's own zone; an interval that ends at exactly midnight ends the day
  before (`…/2024-01-01T00:00:00Z` is all of 2023).
- Its tiles are the asset of `assetType` (default `application/vnd.pmtiles`)
  with role `tiles`, else `visual`, else the first.
- An item that cannot be fetched (60 s limit), has no dates, or has no such
  asset is left out and listed in `skipped`, each with a reason. One bad item
  does not cost the rest.
- One request per item, eight at a time. Plain objects come back: this
  package does not import `@cngeo/timeline`.
- A rolling "latest" file or an all-time overview that the collection links
  to directly is not an item and has no dates here. Add those chunks
  yourself, with a `priority` for the one that should win where it overlaps.
- **An item's dates are as fresh as the catalog, not as the file.** Measured
  on the live FIRMS collection (2026-11-25): the item for 2026 says the year
  ends on 15 September; the archive it points to holds data to 25 November.
  A chunk that claims less than its file holds hides the difference. Where
  that matters, ask the file: `describePmtilesChunk(url)` in
  `@cngeo/maplibre` reads an archive's own span.
