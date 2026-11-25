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
results[0];      // { key, id, title, description, href, license, keywords, catalog, bbox, start, end, kinds, thumbnail, score, fit }
facets.license;  // [{ value: 'CC-BY-4.0', count: 87 }, …]
```

The URL may also be a `catalog.json` that links to its index with
`rel: "data"`.

**What it reads.** The registry's index is 20 MB, of which 12.5 MB is each
collection's whole JSON (`original`) and 5.6 MB its `links`. Neither is ever
read. Titles, descriptions, keywords, extents and licences are 2.1 MB in six
requests (measured), and the rows are then searched in memory.

**Search.**

- `text`: every word must be found, in the title, keywords, id or
  description; the last may be unfinished, as it is while typing, and a small
  misspelling is forgiven. A title match counts for more.
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

- `id` is not unique across catalogs; `key` (the collection's URL) is.
- 108 of 7,049 collection rows repeat another row's URL. One collection is
  one entry; `index.duplicates` says how many were left out.
- Its host, GitHub Pages, misreports the file's size to a `HEAD` request;
  `@cngeo/extract-core` no longer asks that way.

**Text search is [MiniSearch](https://github.com/lucaong/minisearch)** (MIT),
loaded from a pinned URL (`MINISEARCH_URL`) the first time a search has words
in it — about 0.8 s to index the registry, then 1–3 ms a search. In Node, or
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

Rejects `CATALOG_INDEX_INVALID` for something that is not a collections
index. `close()` forgets what was read.
