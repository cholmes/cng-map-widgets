# E14 — what an imagery search costs today

**Date:** 2026-11-25 (revised the same day after code review; see "What changed")
**Question:** before building the imagery search (Phase 2), what does a
search through today's `@cngeo/extract-core` cost on the three collections
it must handle, and what does that decide?
**Short answer:** pruning already works on all three. Nothing is remembered
between calls, so every search re-plans from scratch: on Sentinel-2 that
means re-listing the dataset's files *and* re-reading a 7.9 MB footer. A
cache has to hold both. A scene's `assets` can be read along with the search
on NAIP and OpenAerialMap, and not affordably on Sentinel-2.

Gate C of [`docs/superpowers/specs/2026-11-25-map-widgets-design.md`](../../docs/superpowers/specs/2026-11-25-map-widgets-design.md).

## Method

`node experiments/e14-search-cost/measure.mjs --runs 3` — Node 22.23.2,
hyparquet injected, live data on `data.source.coop`, a home connection.
Each dataset: one city-sized box, `intersects`, three light columns,
`limit: 200`.

Two kinds of number appear below and are labelled each time:

- **measured** — from a wrapper around `fetch` that logs every request, its
  transferred bytes and when its body finished, tagged by phase;
- **modelled** — what `estimate()` reports. It is a plan, not a recording.

Times are medians of three runs and include the network. They moved a lot
between sets of runs on the same day (a whole Sentinel-2 search measured
9.6 s, 8.1 s and 7.3 s across three sets), so read them as proportions.

| dataset | area | time window | descriptor |
|---|---|---|---|
| Sentinel-2 C1 L2A | Nairobi | June 2025 | `resolveDataset()` from the collection |
| NAIP | San Francisco | 2024 (not applied, see below) | hand-written `{ kind:'parquet' }` (not resolvable yet) |
| OpenAerialMap CC-BY-4.0 | Dar es Salaam | none (see below) | hand-written `{ kind:'parquet' }` (not resolvable yet) |

## The files (read from their footers)

For Sentinel-2 this is **one of twelve yearly parts**, the 2025 one; the
others were not inspected.

| | Sentinel-2 (2025 part) | NAIP | OpenAerialMap |
|---|---|---|---|
| File size | 6.31 GB | 45.4 MB | 11.7 MB |
| Footer | **7.92 MB** | 98 KB | 402 KB |
| Row groups | 825 | 30 | 10 |
| Rows (median per group) | 5,065,361 (6,144) | 245,554 (8,192) | 19,336 (2,048) |
| `assets` column | one `BYTE_ARRAY` (a JSON string) | struct, 6 leaf columns | struct, 54 leaf columns |
| `assets`, compressed, per row | 1,061 bytes | 45 bytes | 170 bytes |
| `assets`, compressed, per row group | **6.5 MB** | 369 KB | 348 KB |
| `assets` share of the file | **85%** (5.37 of 6.31 GB) | 24% | 26% |
| Parquet offset indexes | none (0 of 50,325 chunks) | all (870 of 870) | none (0 of 3,590) |

## One search: `plan()` then `run()`

| | Sentinel-2 | NAIP | OpenAerialMap |
|---|---|---|---|
| **Pruning** (modelled, and what the engine then read) | | | |
| Files | 12 → 1 (by time) | 1 | 1 |
| Row groups | 825 → **21** | 30 → **1** | 10 → **2** |
| Pruned by | native geometry statistics | covering `bbox` | covering `bbox` |
| Rows returned | 18 | 27 | 21 |
| **Time** (measured, median of 3) | | | |
| `resolveDataset` | 0.9 s | — | — |
| `estimate()`, first / second call | 5.4 s / 5.0 s | 1.5 s / 2.1 s | 2.8 s / 2.8 s |
| `plan()` | 4.7 s | 1.5 s | 1.9 s |
| … of which listing the dataset's parts | **1.5 s** | 0 | 0 |
| … of which reading footers | **3.0 s** | 1.5 s | 1.9 s |
| `run()` | 2.7 s | 1.5 s | 1.4 s |
| **A search (`plan` + `run`)** | **7.3 s** | **3.0 s** | **3.4 s** |
| **On the wire** (measured) | | | |
| `plan()`: part-listing requests | 13 (`collection.json` + 12 item JSONs) | 0 | 0 |
| `plan()`: footer requests / bytes | 3 / 7.92 MB | 3 / 98 KB | 3 / 402 KB |
| `run()`: requests / bytes | 84 / 5.25 MB | 1 / 765 KB | 6 / 811 KB |
| **Whole search: requests / bytes** | **100 / 13.2 MB** | **4 / 863 KB** | **9 / 1.21 MB** |
| **What `estimate()` reports** (modelled) | | | |
| `requests` / `readBytes` | 35 / 5.25 MB | 2 / 760 KB | 3 / 810 KB |

## What this decides

1. **Cache the plan's inputs, both of them.** The second `estimate()` costs
   the same as the first on every dataset: nothing is remembered. On
   Sentinel-2 each plan re-fetches `collection.json` and all 12 yearly item
   documents (13 requests, 1.5–2.3 s across three sets of runs; a reviewer's
   own two runs saw 3.2–4.7 s, with one small JSON straggling by 3 s each
   time) and then re-reads the 7.92 MB footer (about 3 s). **A cache of
   footers alone would leave the part listing repaid on every search.** The
   cache must hold the resolved part list as well. NAIP and OpenAerialMap
   are single files, so there planning is all footer.
   With both cached, a repeat search should cost about what `run()` does
   (2.7 s, 1.5 s and 1.4 s here). **That is an inference from these numbers,
   not a measurement**; Phase 2 must measure it.
2. **The first search is slow on Sentinel-2**: 7–10 s end to end across the
   three sets of runs, more if the UI shows an estimate first. Warming the
   cache when the control opens, and streaming scenes as row groups arrive,
   make that tolerable. Neither shrinks the 7.92 MB footer; only a
   differently laid-out file would.
3. **`estimate().requests` under-reports what a search sends.** It models one
   request per admitted row group; the engine issues one per column chunk,
   and planning adds its own. Sentinel-2: 35 modelled, 100 measured. The
   design has the imagery control showing `est.requests` to the user before
   a large search; it should either show a measured-style count or be
   labelled as the data reads only. (The estimate lives in existing
   `extract-core` code, outside this experiment.)
4. **Asset resolution differs by collection.**
   - NAIP and OpenAerialMap: read `assets` along with the search. It is a
     struct costing 45 and 170 bytes a row.
   - Sentinel-2: reading `assets` along with the search would add roughly
     21 × 6.5 MB ≈ 140 MB to a 5 MB read, and with no offset indexes one
     scene's `assets` cannot be fetched without its whole 6.5 MB chunk.
     Routes that avoid it, none of them measured here: the profile's
     `assetHref(scene)` convention (what the original app does); fetching
     that one 6.5 MB chunk only when the user adds a scene to the map; or
     fetching the scene's own STAC item JSON.
   - The design's "single-row read where offset indexes exist" branch is
     **not needed for these three collections**: only NAIP has offset
     indexes, and NAIP does not need it. It would also need reader work,
     since hyparquet as used here does not read page-index bodies
     (AGENTS.md). Whether to keep it in the design is Chris's call; this
     experiment only shows it buys nothing for these three.
5. **Two filters do nothing today, and Phase 2 must fix both.**
   - OpenAerialMap was measured with no time filter, because its rows have
     `start_datetime`/`end_datetime` and a null `datetime`; the current
     single-column filter would drop every row.
   - NAIP's time filter was silently not applied (the estimate raised
     `no-statistics`): a bare `{ kind:'parquet' }` descriptor infers no time
     column, which matches the engine code. The 27 rows above are every year
     for that box, not 2024 alone. Resolving these item tables with STAC
     table defaults is what supplies `datetime`.

## After Phase 2: what the cache did (measured 2026-11-25)

Point 1 above ended on an inference. This is the measurement. The search is
now `@cngeo/stac`'s `ImagerySearch` over `queryRows`, with a plan cache.

**Same query twice, Node, same harness style as above** (a `fetch` wrapper
counting requests and `content-length`; Sentinel-2, the Nairobi box, June
2025):

| | before (E14, above) | first search now | repeat now |
|---|---|---|---|
| listing requests | 13, every search | 14, once (`warm()`) | **0** |
| footer | 7.92 MB, every search | once | **0** |
| row reads | 84 | 85 | 84 |
| whole search | 100 requests / 13.2 MB | 14 + 87 requests | **84 requests / 8.3 MB** |
| time | 7–10 s | 5.6–7.7 s after a 2–3 s warm | **2.9–3.8 s** |

Bytes are not like for like: this search reads nine columns where the
baseline read three, including the row's `links` (how a scene's files are
found later), so the row reads grew from about 5.2 MB to 8.3 MB while the
7.9 MB footer and the listing went away.

**In a browser** (headless Chrome, `examples/imagery-search/verify.mjs`,
which counts requests from the browser's own network log):

| | Sentinel-2 | NAIP | OpenAerialMap |
|---|---|---|---|
| page load + first search | 16 documents, 1 HEAD, 1 footer, 85 row reads | 2, 1, 1, 3 | 2, 1, 1, 10 |
| a repeated search | **76 row reads, nothing else** | **2 row reads** | **9 row reads** |
| first search, range over 5–7 runs | 6.0–24 s (five of six between 6 and 9) | 0.5–3.3 s | 0.9–5.5 s |
| repeated search, range over 5–7 runs | 2.2–9.0 s (five of seven between 2 and 5) | 0.5–2.0 s | 0.9–2.4 s |

The request counts were identical on every run; the times were not, by a
factor of four on the same afternoon, so the counts are the finding and the
times are a range. Later the same day the Sentinel-2 host was answering some
range requests with HTTP 520 and a first search took 55 s (those runs are
not in the ranges above); every search still completed, on the retry
described below. (The Sentinel-2 "repeated search" is a ten-day window
inside the first search's month, which is why it is 76 reads and not 85.)

What it leaves:

- **A Sentinel-2 search is still about 80 requests.** They are row reads:
  roughly four range requests per row group, because the columns a search
  needs are not next to each other in the file and the 6.5 MB `assets` chunk
  sits between them. Only a different file layout, or a reader that merges
  nearby ranges, would lower it. Point 3's 4x gap between `estimate()`'s
  modelled requests and real ones is unchanged, so the search panel reports
  row groups and files and does not quote a request count.
- **One range read failing failed the search.** One of seven verifier runs
  lost a Sentinel-2 search to a transport error on a single request
  (`ERR_QUIC_PROTOCOL_ERROR`, after hanging for over two minutes), and a
  second run lost one the same way. The reader now makes a failed row-group
  read once more before giving up (`readRetries`, default 1), which covers a
  dropped connection. It still has **no per-request timeout**: a request
  that hangs, hangs the search until the browser gives up on it. Not
  addressed in Phase 2.
- **A scene's files on Sentinel-2** come from the scene's own STAC item (one
  request to Earth Search, on "Add to map") — the third of point 4's routes,
  now measured to work; the `assets` column is never read.
- Both filters of point 5 are fixed: OpenAerialMap is searched by span
  overlap, and a bare item table gets its `datetime` column from its schema.

## What this does not show

- Browser timings. Node has no HTTP cache lock and no main-thread contention.
- Larger areas or longer windows, where `run()` grows with the row groups admitted.
- The other eleven Sentinel-2 parts.
- The cost of decoding geometry for footprints at scale (18–27 rows here).
- Any of the alternative Sentinel-2 asset routes in point 4.

## What changed in the revision

The first version of this file said planning was "almost all footer reading"
and that a footer cache would roughly halve a search. A code review measured
the requests and found the part listing: 13 of a Sentinel-2 plan's 16
requests. That version also presented `estimate()`'s modelled request and
byte counts as if they were measurements, and timed "the footer alone" from a
single cold sample. `measure.mjs` now logs real requests and times the two
halves of planning separately, inside the runs loop.
