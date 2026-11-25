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
