# E13 — a `render` column for the catalog index

**Date:** 2026-11-25
**Question:** a catalog index says what each collection *is* and nothing about
how to *show* it, so adding a search result to a map means fetching that
collection's JSON and working it out. Would a column or two in the index
remove that fetch, and what would it cost?
**Short answer:** yes. Three small columns — `render`, `thumbnail`,
`attribution` — add about 0.3 MB to the 2.1 MB a search already loads. With
them a result becomes a map layer in under a tenth of a millisecond and no
request, against a median of about 110 ms and one request without. They also
make possible something no number of fetches does: searching by *what can be
drawn*. All 7,049 collections in the registry could be described, and a
sample of 60 agreed with their live JSON 60 times out of 60.

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
  then, for a seeded random sample of 60 collections, fetches each
  collection's JSON live and compares.
- Node 22.23.2, a home connection. Times include the network and are a range,
  not a constant; the script was run twice and both runs are given.

## Results

### 1. Bytes

| | live index (zstd) | built index (snappy) |
|---|---|---|
| whole file | 20.41 MB | 4.00 MB |
| `original` | 12.52 MB | — |
| `links` | 5.62 MB | — |
| what a search loads (12 columns) | 2.12 MB | 3.14 MB |
| `render` | — | 493 KB (2,102 KB uncompressed) |
| `thumbnail` | — | 132 KB (656 KB uncompressed) |
| `attribution` | — | 41 KB (82 KB uncompressed) |
| `CatalogIndex.load()` reads | 2.19 MB, 6 requests | 3.87 MB, 5 requests |

The two files use different codecs, so their columns cannot be compared
directly: `hyparquet-writer` writes snappy and the registry writes zstd (the
same twelve columns are 2.12 MB under one and 3.14 MB under the other). For a
like-for-like figure, the three new columns' *values*, as JSON lines under
zstd level 3, are **206 KB, 78 KB and 30 KB — about 0.31 MB together**. That
is an estimate (JSON lines, not parquet pages), and it is the one to hold
against the live file: **+15% on the 2.12 MB a search loads, +1.5% on the
20.4 MB file.**

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

For 60 collections chosen at random (seed 13), `layersFromRender` of the
stored value against `layersFromCollection` of the collection's JSON fetched
live at measurement time: **60 the same, 0 different, 0 unreachable.**

(The first run reported one difference. It was the comparison's: an
`unsupported` layer's list of asset types is deliberately not stored, and the
script was comparing it. Corrected, and noted here because the first number
was wrong.)

The index and the sample were hours apart, so this says the encoding loses
nothing; it does not say how fast a `render` value goes stale.

### 4. Time from "result chosen" to "layer in hand"

| | median | p90 | max | requests |
|---|---|---|---|---|
| with `render` (in memory) | 68–73 µs | 163–167 µs | | 0 |
| without (fetch the JSON, then derive) | 109–113 ms | 416–1,024 ms | 1.0–3.6 s | 1 |

Two runs, sequential, Node. The spread in the second row is the hosts': the
sample spans a dozen of them.

### 5. What only the column makes possible

A search for "buildings" finds 153 collections. With `render` the index can
say that **144 of them can be drawn**, and offer that as a filter and a count
before anything is clicked. Without it, knowing that would take 153 fetches;
for the whole registry, 7,049.

## What this decides

1. **The column is worth having.** About 0.3 MB for no request per added
   layer, kind badges and thumbnails on result cards, and a "things I can
   draw" filter. `CatalogIndex` already uses it when present and falls back
   to fetching when not, so the widget works on the registry as it is today
   and gets better the day the registry adds it.
2. **It needs `attribution` beside it.** An index that lets a layer be added
   without fetching its collection must say whom to credit: today it carries
   `license` and no provider. 41 KB.
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

- Sizes under zstd as real parquet pages. The 0.31 MB is an estimate.
- Browser timings. Node has no main-thread contention and no CORS preflight.
- How quickly a `render` value goes stale, or what a publisher who wants a
  different default layer would do. The derivation follows the collection's
  own `default` role and render order where it has them; nobody was asked.
- Whether the registry wants the rules in Python, in a shared specification,
  or called from this package.
- The 211 collections that are both vector tiles and imagery: the widget adds
  the tiles and says the imagery is searched elsewhere. Whether that is what
  a person expects was not tested.
