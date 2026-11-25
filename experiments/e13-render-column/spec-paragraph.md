# Draft — columns that say how a collection is drawn

**Status: a draft, not proposed anywhere.** Written for Chris to read, change
or drop. Evidence: [`RESULTS.md`](RESULTS.md).

Written against `portolan-spec` `origin/main` at `d48bae0` (2026-11-18), where
the document is `specs/incubating/stac-geoparquet.md`, **"Incubating:
STAC-GeoParquet catalog index"**. (The first version of this draft was written
against an older local working copy, placed its text under a heading that no
longer exists, and called the file a "collections index". Corrected after
review.)

## Where this could go — a decision before any text

The current document says of the catalog index: *"The layout below follows the
shape agreed on 2026-11-04 in stac-geoparquet-spec#17 … When upstream changes
the schema, this document changes with it. **Portolan does not define its own
variant.**"*

Three columns that only Portolan has are a variant. So this is not a paragraph
to drop into that file as it stands. There are three honest routes, and they
are different amounts of commitment:

1. **Upstream.** Propose the columns in
   [stac-geoparquet-spec#17](https://github.com/radiantearth/stac-geoparquet-spec/issues/17),
   where the layout is being agreed. Slowest, and the `kind` vocabulary below
   is one client's; upstream may reasonably want something more general.
2. **Registry-only columns, no spec change.** The registry's index already
   carries one column the layout does not list, `portolan_registry:id`, and
   the document does not forbid extra columns. The same could be done here
   under prefixed names (`portolan:render`, `portolan:thumbnail`,
   `portolan:attribution`), documented with the registry rather than in the
   spec. Fastest; nothing is promised to other catalogs.
3. **A Portolan extension of the catalog index.** A new section in the
   incubating document — which means changing the sentence quoted above to say
   what Portolan *adds* on top of the upstream layout, and that the additions
   are optional and ignorable.

The experiment does not choose between these. It shows the columns are cheap
and useful; where they are specified is Chris's call. `@cngeo/stac` reads the
unprefixed names today (`render`, `thumbnail`, `attribution`) and would follow
whichever names are settled on — a one-line change.

## The text, for whichever route

### Saying how a collection is drawn

A catalog index says what each collection is: its title, extent, dates and
licence. It does not say how to show it. A client that has found a collection
must fetch that collection's JSON and work out from its assets and links
whether there are vector tiles with a style, a COG, an item mirror of imagery,
or nothing to draw. That is one request per collection — the request the
catalog index exists to avoid — and it means a client cannot search for
"collections I can put on a map" at all.

A catalog index MAY carry three more columns. They are null on a `Catalog`
row.

| Column | Type | Collection row |
|--------|------|----------------|
| `render` | list of struct of `kind`, `id`, `title`, `url`, `style`, `layers` (list of string), `display_asset`, `items`, `reason` | One entry for each thing the collection draws as |
| `thumbnail` | string | A preview image of the collection |
| `attribution` | list of struct of `text`, `license`, `url`, `share_alike` (boolean) | Whom to credit, and on what terms |

Each `render` entry has a `kind`:

| `kind` | When | Fields used |
|---|---|---|
| `pmtiles-vector` | a `rel: "pmtiles"` link, or a PMTiles asset | `url` (the archive), `layers` (its source layers), `style` (a style JSON: the asset with roles `style` and `default`, else the only `style` asset) |
| `cog` | a collection-level Cloud-Optimized GeoTIFF | `url` |
| `scenes` | an item mirror of imagery | `items` (the mirror, when it is one file), `display_asset` (the item asset to draw) |
| `table` | parquet with no geometry column | `url` |
| `unsupported` | anything else | `reason`, for a person to read |

`title` is set only when it differs from the collection's own. Every address
is an absolute `http(s)` URL: a client must be able to use the entry without
knowing where the collection document lives. (`href` in this file may be
relative to the index; these may not.) A collection whose assets are published
only at `s3://` is `unsupported`.

`render` is derived from the collection document — the row's own `original` —
and holds only what is specific to drawing. A collection's extent, dates and
licence are already columns, and a client takes them from there. `attribution`
belongs with it: a client that adds a layer from the index alone, without the
collection document, has no other way to credit it.

The same rule as the rest of the file applies: the JSON stays the normative
representation. A client MUST treat `render` as a convenience; where it is
absent, or an entry cannot be used, the collection document is the authority.

### Evidence

Measured on the Portolan registry's index (2026-11-25; 7,049 collection rows,
6,941 distinct collections):

- the three columns are 454 KB as zstd parquet (DuckDB), against the 2.1 MB a
  search reads — likely about 0.5 MB from the registry's own writer;
- every collection could be described; 4,842 draw as one layer, 2,047 are
  tables with nothing to draw;
- rebuilt from the columns, the layers of 6,940 of 6,941 collections are
  identical to those derived from `original` (the one difference is a bbox
  edge of 180.00005 against 180).

## Open questions for whoever takes this up

- Which of the three routes above.
- Should the `kind` vocabulary be Portolan's, or wait for something upstream
  in STAC? These five are what one client needed.
- Is a struct the right encoding, or a JSON column like `original`? A struct
  lets `kind` be filtered by a query engine without parsing; JSON is easier
  to extend.
- Should a publisher be able to state `render` rather than have it derived?
  The registry derives everything today.
