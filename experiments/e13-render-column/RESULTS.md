# E13 — a `render` column for the catalog index

**Date:** 2026-11-25
**Question:** a catalog index says what each collection *is* and nothing about
how to *show* it, so adding a search result to a map means fetching that
collection's JSON and working it out. Would a column or two in the index
remove that fetch, and what would it cost?
**Short answer:** yes. Three small columns — `render`, `thumbnail`,
`attribution` — add about 0.45 MB (measured as zstd parquet; probably nearer
0.5 MB from the registry's own writer) to the 2.1 MB a search already loads.
With them a result becomes a map layer in under a tenth of a millisecond and
no request, against a median of about 100 ms and one request without. They
also make possible something no number of fetches does: searching by *what
can be drawn*. All 7,049 collections in the registry could be described;
rebuilt from the columns, the layers of 6,940 of the 6,941 distinct
collections are identical to those derived from the collection's own JSON.

> **Corrected after review (2026-11-25).** The first version of this file
> gave the size as "about 0.3 MB, +15%". That was an estimate — the columns'
> values as JSON lines under zstd — presented as the figure to rely on. The
> real pages are 45% larger. It also said the live sample "spans a dozen"
> hosts; it spans three. Both are fixed below, and the lossless check now
> covers every row instead of a sample of 60.

Asked for in the design review of
[`docs/superpowers/specs/2026-11-25-map-widgets-design.md`](../../docs/superpowers/specs/2026-11-25-map-widgets-design.md)
(Phase 3). **Nothing here has been proposed upstream.** The two drafts beside
this file are drafts.

## Method

```bash
node experiments/e13-render-column/build.mjs      # reads the live index, writes out/ (not committed)
node experiments/e13-render-column/measure.mjs    # prints every number below; writes out/measure.json
```

- **Input:** `https://registry.portolan-sdi.org/v0.1/collections.parquet` as
  published at 14:21 UTC on 2026-11-25: 20,409,030 bytes, 17,585 rows, one row
  group, zstd.
- **`build.mjs`** downloads it whole — the one place this project reads its
  `original` column — and runs `@cngeo/stac`'s `layersFromCollection` over
  every collection's JSON. It writes the index's own columns, minus `original`
  and `links`, plus:
  - `render`: `list<struct<kind, id, title, url, style, layers: list<string>, display_asset, items, reason>>`,
    one entry per layer (`renderFromLayers`);
  - `thumbnail`: string;
  - `attribution`: `list<struct<text, license, url, share_alike: bool>>`.
- **`measure.mjs`** reads both files through `CatalogIndex`, counting bytes;
  re-encodes the built index as zstd parquet with DuckDB (when `duckdb` is on
  the PATH) to size the columns under the live file's codec; compares every
  collection's rebuilt layers with those derived from its `original`; then,
  for a seeded random sample of 60 collections, fetches each collection's
  JSON live and compares again.
- Node 22.23.2, DuckDB 1.4.1, a home connection. Times include the network
  and are a range, not a constant; the script was run four times and the
  range is given.

## Results

### 1. Bytes

| | live index (zstd, pyarrow) | built index (snappy, hyparquet-writer) | built index re-encoded (zstd, DuckDB) |
|---|---|---|---|
| whole file | 20.41 MB | 4.00 MB | — |
| `original` | 12.52 MB | — | — |
| `links` | 5.62 MB | — | — |
| what a search loads (12 columns) | 2.12 MB | 3.14 MB | 1.83 MB |
| `render` | — | 493 KB (2,102 KB uncompressed) | **335 KB** |
| `thumbnail` | — | 132 KB (656 KB uncompressed) | **88 KB** |
| `attribution` | — | 41 KB (82 KB uncompressed) | **31 KB** |
| the three together | — | 666 KB | **454 KB** |
| `CatalogIndex.load()` reads | 2.19 MB, 6 requests | 3.87 MB, 5 requests | — |

The built file is snappy because `hyparquet-writer` cannot write zstd, and
the registry writes zstd, so the middle column cannot be held against the
first. The third column is the like-for-like figure: the built index
re-encoded as zstd parquet, one row group, and its column chunks read back.

**The three columns are 454 KB: +25% on the twelve search columns in the same
writer (1.83 MB), 21% of the live file's 2.12 MB, 2.2% of the 20.4 MB file.**

One caution on carrying that to the registry. DuckDB packs the twelve shared
columns 14% smaller than the registry's pyarrow does (1.83 MB against
2.12 MB), so the same three columns written by the registry's own script
would likely come to about **0.5 MB**. That last figure is an extrapolation;
the 454 KB is measured.

(For the record, the columns' values as JSON lines under zstd level 3 are
206 KB, 78 KB and 30 KB. That is not a size of anything in a parquet file.)

### 2. Coverage

All 7,049 collection rows were derived; none failed. It took 0.43 s.

| draws as (first of) | collections | |
|---|---|---|
| vector tiles (`pmtiles-vector`), every one with a published style | 4,784 | 67.9% |
| a table with no geometry | 2,047 | 29.0% |
| nothing drawable (`unsupported`) | 110 | 1.6% |
| a COG | 58 | 0.8% |
| imagery scenes only | 50 | 0.7% |

- **4,842 collections (68.7%) can be added to a map as one layer today.**
- 240 collections draw as more than one thing: 211 are vector tiles plus an
  imagery item table, 29 a COG plus one. 7,290 layers in all.
- 4,954 collections have a thumbnail.
- The 110 with nothing to draw: 39 are imagery with no item table to search,
  39 are spatial GeoParquet with no tiles, 26 have no drawable asset (8 of
  them only a PNG), 5 are Zarr, 1 is FlatGeobuf.

### 3. Agreement

**Is the encoding lossless? Every row, no network.** The index carries each
collection's JSON in `original`, so the question does not need a sample: for
all 6,941 distinct collections, the layers rebuilt from the columns
(`layersFromRender`) against the layers derived from `original`
(`layersFromCollection`), compared on kind, id, title, source, attribution,
bbox, dates and thumbnail. **6,940 identical; 1 differs**, in one number: a
bbox whose east edge is 180.00005 in the collection and 180 in the index's
own `bbox` column. (The review ran this check first; it is now in
`measure.mjs`.)

**Is the index stale? A live sample.** For 60 collections chosen at random
(seed 13), the stored value against the collection's JSON fetched at
measurement time: **60 the same, 0 different** in three of four runs; in the
fourth, 59 the same and 1 unreachable (an HTTP 520 from its host). The sample
is 3 hosts of the registry's 9 (Google Cloud Storage 40, Source Cooperative
17, Azure 3) and 23 catalogs: 32 vector-tile collections, 24 tables, 2
imagery, 1 COG, 1 unsupported. It compares kind, id, title and source only.
The index and the sample were hours apart, so this is a weak test of
staleness and no test at all of how fast a `render` value goes stale.

(The very first run reported one difference. It was the comparison's: an
`unsupported` layer's list of asset types is deliberately not stored, and the
script was comparing it. Corrected, and noted here because the first number
was wrong.)

### 4. Time from "result chosen" to "layer in hand"

| | median | p90 | max | requests |
|---|---|---|---|---|
| with `render` (in memory) | 53–91 µs | 93–172 µs | | 0 |
| without (fetch the JSON, then derive) | 65–133 ms | 416–1,024 ms | 0.9–12.2 s | 1 |

Four runs, sequential, Node. The spread in the second row is the hosts' and
the hour's: the sample is on three hosts, and one request in one run took
12 seconds.

### 5. What only the column makes possible

A search for "buildings" finds 153 collections. With `render` the index can
say that **144 of them can be drawn**, and offer that as a filter and a count
before anything is clicked. Without it, knowing that would take 153 fetches;
for the whole registry, 7,049.

## What this decides

1. **The column is worth having.** About 0.45–0.5 MB for no request per added
   layer, kind badges and thumbnails on result cards, and a "things I can
   draw" filter. `CatalogIndex` already uses it when present and falls back
   to fetching when not, so the widget works on the registry as it is today
   and gets better the day the registry adds it.
2. **It needs `attribution` beside it.** An index that lets a layer be added
   without fetching its collection must say whom to credit: today it carries
   `license` and no provider. 31 KB.
3. **Nearly a third of the registry is tables.** A catalog search that cannot
   tell says "Add to map" on 2,047 collections that have nothing to add. This
   is the strongest argument for the column, more than the saved request.
4. **`render` is derived, not authored.** Every value came from the
   collection's own `original`, which the registry already holds when it
   writes a row. It is as fresh as `original` and costs the crawl nothing
   more to fetch. It does need the derivation written where the index is
   built (the registry's script is Python; the rules are five, in
   `packages/stac/src/layers-from-collection.js`).
5. **Keep it flat and specific to drawing.** Nine fields. Extent, dates,
   title and licence are already columns; a layer takes them from there.

## What this does not show

- The size from the registry's own writer. 454 KB is DuckDB's zstd; pyarrow's
  was not run, and "about 0.5 MB" is an extrapolation from how the two differ
  on the shared columns.
- Browser timings. Node has no main-thread contention and no CORS preflight.
- How quickly a `render` value goes stale, or what a publisher who wants a
  different default layer would do. The derivation follows the collection's
  own `default` role and render order where it has them; nobody was asked.
- Whether the registry wants the rules in Python, in a shared specification,
  or called from this package.
- The 211 collections that are both vector tiles and imagery: the widget adds
  the tiles and says the imagery is searched elsewhere. Whether that is what
  a person expects was not tested.
