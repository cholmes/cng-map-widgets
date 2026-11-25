# E14 — what an imagery search costs today

**Date:** 2026-11-25
**Question:** before building the imagery search (Phase 2), what does a
search through today's `@cngeo/extract-core` cost on the three collections
it must handle, and what does that decide?
**Short answer:** pruning already works on all three. Every search re-reads
the file footers, which is most of the wait; caching them roughly halves
it. A scene's `assets` can be read with the search on NAIP and
OpenAerialMap, and cannot be read affordably at all on Sentinel-2.

Gate C of [`docs/superpowers/specs/2026-11-25-map-widgets-design.md`](../../docs/superpowers/specs/2026-11-25-map-widgets-design.md).

## Method

`node experiments/e14-search-cost/measure.mjs --runs 3` — Node 22.23.2,
hyparquet injected, live data on `data.source.coop`, a home connection.
Each dataset: one city-sized box, `intersects`, three light columns,
`limit: 200`. Times are medians of three runs and include the network; read
them as proportions, not as a benchmark. Sentinel-2 run 2 had one 14.9 s
outlier on its first estimate, which is why medians are reported.

| dataset | area | time window | descriptor |
|---|---|---|---|
| Sentinel-2 C1 L2A | Nairobi | June 2025 | `resolveDataset()` from the collection |
| NAIP | San Francisco | 2024 | hand-written `{ kind:'parquet' }` (not resolvable yet) |
| OpenAerialMap CC-BY-4.0 | Dar es Salaam | none (see below) | hand-written `{ kind:'parquet' }` (not resolvable yet) |

## The files

| | Sentinel-2 (2025 part) | NAIP | OpenAerialMap |
|---|---|---|---|
| File size | 6.31 GB | 45.4 MB | 11.7 MB |
| Footer | **7.92 MB** | 98 KB | 402 KB |
| Time to read the footer alone | 4.0 s | 1.6 s | 3.0 s |
| Row groups | 825 | 30 | 10 |
| Rows (median per group) | 5,065,361 (6,144) | 245,554 (8,192) | 19,336 (2,048) |
| `assets` column | one `BYTE_ARRAY` (a JSON string) | struct, 6 leaf columns | struct, 54 leaf columns |
| `assets`, compressed, per row | 1,061 bytes | 45 bytes | 170 bytes |
| `assets`, compressed, per row group | **6.5 MB** | 369 KB | 348 KB |
| `assets` share of the file | **85%** (5.37 of 6.31 GB) | 24% | 26% |
| Parquet offset indexes | **none** (0 of 50,325 chunks) | all (870 of 870) | **none** (0 of 3,590) |

## One search

| | Sentinel-2 | NAIP | OpenAerialMap |
|---|---|---|---|
| Files | 12 → 1 (by time) | 1 | 1 |
| Row groups | 825 → **21** | 30 → **1** | 10 → **2** |
| Pruned by | native geometry statistics | covering `bbox` | covering `bbox` |
| Requests | 35 | 2 | 3 |
| Bytes read | 5.2 MB | 0.76 MB | 0.81 MB |
| Rows returned | 18 | 27 | 21 |
| `resolveDataset` | 0.9 s | — | — |
| `estimate()`, first call | 5.6 s | 2.0 s | 1.2 s |
| `estimate()`, second call | 5.4 s | 2.1 s | 1.8 s |
| engine `plan()` | 5.5 s | 1.3 s | 1.6 s |
| engine `run()` | 4.1 s | 1.6 s | 1.0 s |

## What this decides

1. **A footer cache is the first thing to build.** The second `estimate()`
   costs the same as the first on every dataset: nothing is remembered
   between calls. A search today is `plan()` + `run()`: about **9.6 s** on
   Sentinel-2, 2.9 s on NAIP, 2.6 s on OpenAerialMap. Planning is almost all
   footer reading (the Sentinel-2 footer alone takes 4.0 s), so with footers
   cached a repeat search should be close to `run()` alone: about 4.1 s,
   1.6 s and 1.0 s. That last figure is an inference from these numbers, not
   a measurement; Phase 2 must measure it.
2. **The first search is still slow on Sentinel-2** — about 10 s end to end,
   and more if the UI shows an estimate before running. Warming the footer
   when the control opens, and streaming scenes as row groups arrive, are
   what make that tolerable. Neither fixes the 7.9 MB footer itself; only a
   differently laid-out file would.
3. **Asset resolution has to differ by collection.**
   - NAIP and OpenAerialMap: read `assets` with the search. It is a struct
     costing 45 and 170 bytes a row.
   - Sentinel-2: `assets` cannot be read per scene. There are no offset
     indexes, so one row's `assets` means fetching its whole row-group chunk,
     6.5 MB. The profile's `assetHref(scene)` shortcut (deriving the COG URL
     from the thumbnail's folder, as the original app does) is the only
     affordable path. Reading `assets` with the search would turn a 5.2 MB
     search into roughly 140 MB.
   - The "single-row read where offset indexes exist" branch in the design
     would only ever apply to NAIP, which does not need it. **Drop it.**
4. **Two filters do nothing today, and Phase 2 must fix both:**
   - OpenAerialMap was measured with no time filter, because its rows have
     `start_datetime`/`end_datetime` and a null `datetime`; the current
     single-column filter would drop every row.
   - NAIP's time filter was silently not applied (the estimate raised
     `no-statistics`): a bare `{ kind:'parquet' }` descriptor infers no time
     column. The 27 rows above are therefore every year for that box, not
     2024 alone. Resolving these item tables with STAC table defaults is what
     supplies `datetime`.

## What this does not show

- Browser timings. Node has no HTTP cache lock and no main-thread contention;
  the widgets run in a browser.
- Larger areas or longer windows, where `run()` grows with the number of
  admitted row groups.
- The cost of decoding geometry for footprints at scale (18–27 rows here).
