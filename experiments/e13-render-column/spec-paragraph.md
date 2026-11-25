# Draft — for `portolan-spec/specs/incubating/stac-geoparquet.md`

**Status: a draft, not proposed.** Written for Chris to read, change or drop.
It would go under "STAC-GeoParquet Mirrors of Collections", after the
paragraph that ends "no existing tooling reads such a file". Evidence:
[`RESULTS.md`](RESULTS.md).

---

### Saying how a collection is drawn

A collections index says what each collection is: its title, extent, dates
and licence. It does not say how to show it. A client that has found a
collection must fetch that collection's JSON and work out from its assets and
links whether there are vector tiles with a style, a COG, an item table of
imagery, or nothing to draw. That is one request per collection, and it means
a client cannot search for "collections I can put on a map" at all.

An index MAY carry three more columns:

| column | type | meaning |
|---|---|---|
| `render` | `list<struct<kind, id, title, url, style, layers: list<string>, display_asset, items, reason>>` | One entry per thing the collection draws as. Null for a catalog row. |
| `thumbnail` | string | A preview image for the collection. |
| `attribution` | `list<struct<text, license, url, share_alike: bool>>` | Whom to credit, and on what terms. |

Each `render` entry has a `kind`:

| `kind` | when | fields used |
|---|---|---|
| `pmtiles-vector` | a `rel: "pmtiles"` link, or a PMTiles asset | `url` (the archive), `layers` (its source layers), `style` (a style JSON: the asset with roles `style` and `default`, else the only `style` asset) |
| `cog` | a collection-level Cloud-Optimized GeoTIFF | `url` |
| `scenes` | an item table of imagery: a `collection-mirror` asset, or STAC item columns over a partitioned or single `data` parquet | `items` (the table, when it is one file), `display_asset` (the item asset to draw) |
| `table` | parquet with no geometry column | `url` |
| `unsupported` | anything else | `reason`, for a person to read |

`title` is set only when it differs from the collection's own. Every address
is an absolute `http(s)` URL: a client must be able to use the entry without
knowing where the collection document lives. A collection whose assets are
published only at `s3://` is `unsupported`.

`render` is derived from the collection document and holds only what is
specific to drawing. A collection's extent, dates and licence are already
columns, and a client takes them from there. `attribution` is not optional in
spirit: a client that adds a layer from the index alone, without the
collection document, has no other way to credit it.

A client MUST treat `render` as a convenience. Where it is absent, or an
entry cannot be used, the collection document is the authority.

Measured on the Portolan registry's index of 7,049 collections (2026-11-25):
the three columns add about 0.3 MB to the 2.1 MB a search reads; every
collection could be described; 4,842 draw as one layer, 2,047 are tables with
nothing to draw; and a sample of 60 agreed with their live documents every
time.

---

## Open questions for whoever takes this up

- Should the `kind` vocabulary be Portolan's, or wait for something upstream
  in STAC? These five are what one client needed.
- Is a struct the right encoding, or a JSON column like `original`? A struct
  lets `kind` be filtered by a query engine without parsing; JSON is easier
  to extend.
- Should a publisher be able to state `render` rather than have it derived?
  The registry derives everything today.
