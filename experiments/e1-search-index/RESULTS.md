# E1 — Static autocomplete index: results

Benchmarks of three browser-side approaches to name-prefix search over a
geoBoundaries CGAZ name index, run 2026-11-12. See `PLAN.md` (repo root) for
the full experiment brief; this covers E1 only.

**Status of the index used here: provisional.** A separate effort is
building the official geoBoundaries catalog + search sidecar in
`~/repos/geoboundaries`. The index built by `build-index.sql` in this
directory exists only so this harness has real data to run against today.
Every approach module takes the index URL as a parameter
(`loadFullIndex(url)`, `openRangeIndex(url)`), so re-pointing at the
official sidecar later is a one-line change, not a rewrite — see
`bench/run-bench.mjs`'s `RUNS` array and `public/index.html`'s `indexUrl`
`<select>`.

## What was built

- `build-index.sql` — DuckDB script. Combines geoBoundaries CGAZ ADM0 (218
  rows) + ADM2 (49,349 rows) from the tge-labs source.coop mirror into one
  source-agnostic sidecar schema (`name`, `name_norm`, `level`, `country`,
  `feature_id`, `bbox`, `source`), sorted by `name_norm`, zstd-compressed.
  ADM1 is skipped (confirmed bad data at this mirror, per PLAN.md recon —
  it's a mislabeled copy of ADM0).
- **Data-quality finding, logged for upstream reporting:** 37 of 49,349
  ADM2 rows have a `NULL` `shapeName` (mostly Turkmenistan, a few Japan
  units). An unnamed feature can't be searched by name, so these are
  dropped from the index. Final row count: **49,530** (218 + 49,312).
- Three row-group variants of the same sorted data, to compare
  range-request pruning granularity:

  | file | row groups | size |
  |---|---|---|
  | `index-provisional-rg2048.parquet` | 25 (2048 rows/group) | 2,624,983 B (2.50 MB) |
  | `index-provisional-rg8192.parquet` | 7 (8192 rows/group) | 2,619,006 B (2.50 MB) |
  | `index-provisional-single.parquet` | 1 (all rows) | 2,599,739 B (2.48 MB) |

  Compression doesn't care about row-group boundaries, so all three are
  essentially the same size (~2.5 MB) — confirming the PLAN.md recon's
  "low single-digit MB" scale estimate for ADM0+ADM2.

- `public/lib/*.js` — three approach implementations (full-load,
  range-request, duckdb-wasm baseline), plain ESM, hyparquet pinned from
  jsdelivr (`hyparquet@1.33.0`, `hyparquet-compressors@1.1.3` for zstd,
  `@duckdb/duckdb-wasm@1.29.0`).
- `public/index.html` — human-usable live demo: one search box drives all
  three approaches simultaneously with live timings.
- `bench/bench.html` + `bench/run-bench.mjs` — automated harness. Playwright
  drives headless Chromium against `serve.py` (a Range-request-capable
  static server — plain `python3 -m http.server` does NOT support Range
  requests, which would have silently broken the range-request benchmark).
  Raw output: `bench/results.json`.

## Results

Scripted queries: `s`, `sa`, `san`, `san f`, `contra costa`, `ber`, `united`.
15 repeats per query for (a)/(b) (local, cheap); 3 repeats for (c) (remote,
expensive — see below). All local runs served from `serve.py` on
localhost; duckdb-wasm always queries the real remote tge-labs mirror
(`geoBoundariesCGAZ_ADM2.parquet`, 97 MB, 1 row group) since that's the
point of the baseline.

### Summary table

| approach | cold start | warm per-keystroke p50 | warm per-keystroke p95 | bytes, first query | index size |
|---|---|---|---|---|---|
| (a) full-load, rg8192 | 203 ms (fetch 8 + decode 196) | **0.0 ms** | 0.1 ms | 0 B (no network after cold load) | 2.50 MB |
| (b) range-request, rg2048 | 7 ms footer (524 KB) | 5.6–25.1 ms | 6.9–49.5 ms | 106–430 KB | 2.50 MB |
| (b) range-request, rg8192 | 4 ms footer (524 KB) | 20.3–44.2 ms | 21.9–66.8 ms | 429–869 KB | 2.50 MB |
| (b) range-request, single group | 6 ms footer (524 KB) | 127.6–172.7 ms | 175.0–193.7 ms | 2.60 MB (whole file, every query) | 2.48 MB |
| (c) duckdb-wasm, remote ADM2 (no index) | 957 ms (instantiate 886 + first query 71) | 267.7–807.8 ms | 275.2–**10,944** ms | ~90 MB per query (full file, every time) | n/a — no index, 97 MB source file |

Full per-query breakdown (all 7 scripted queries × all 3 row-group
variants, plus duckdb-wasm) is in `bench/results.json`.

### Key observations

1. **Full-load wins outright at this scale.** 49.5K rows / 2.5 MB fits
   comfortably in the "default index ≤ ~3 MB" budget (design call 9). Cold
   load is ~200 ms (well under the 1 s budget), and warm per-keystroke
   search is sub-0.1 ms — not "fast," effectively **free**, because it's a
   binary search over an array already in memory. Range-request adds
   network round trips for no benefit here.

2. **Range-request's footer overhead is disproportionate for a small
   index.** hyparquet's default speculative footer fetch is 512 KB
   (`defaultInitialFetchSize`); on our ~2.5 MB file that's ~20% of the
   whole index just to read metadata, before touching any data. This
   doesn't matter much in absolute terms (7 ms) but it's a sign that
   range-request is the wrong tool below a certain size — exactly what
   design call 9's "~5 MB" range-request-mandatory threshold is for.

3. **Row-group granularity matters, and the single-row-group file
   reproduces the E0 recon finding at index scale.** With everything in
   one row group, every query — even `"united"`, 3 matches — has to fetch
   and decode the *entire* 2.6 MB file, because there's no finer-grained
   statistics to prune with. That's the same failure mode the recon
   documented for the raw ADM2 source file (49,349 rows, single row
   group, predicate pushdown prunes nothing), just at a much smaller
   absolute size because this is a 7-column sidecar instead of a
   boundary file with full polygon geometry. rg2048 vs rg8192 shows the
   expected trend: finer groups → fewer bytes and lower latency per
   query (rg2048 first-run bytes 106–430 KB vs rg8192's 429–869 KB,
   latency roughly halved).

4. **duckdb-wasm against the raw remote file is the "why optimization is
   needed" baseline, and it is dramatically worse than either index-based
   approach** — exactly as PLAN.md design call 2 (hyparquet-first,
   duckdb-wasm as benchmark baseline only) predicted, and consistent with
   the sentinel-2-catalog numbers already cited there (74–123 GETs,
   6.6–49 s). Captured via Playwright's CDP-level `page.on('response')`
   (duckdb-wasm's HTTP reads happen inside a Worker, invisible to
   in-page `window.fetch` instrumentation — see `run-bench.mjs` comments):
   **every single query re-downloaded the entire 97 MB file** (`200 OK`,
   not `206`) rather than reading just the matching rows — 28 requests
   totaling ~1.9 GB for 21 queries in one run. `ILIKE 'prefix%'` against a
   1-row-group parquet file gives DuckDB-Wasm no column statistics to
   prune on, so it reads everything, every time. Per-query latency ranged
   from 268 ms up to **10.9 seconds**, both far outside the 150 ms warm
   budget.

## Verdict against PLAN.md design call 9's budgets

| budget | result |
|---|---|
| warm per-keystroke < 150 ms | **(a) and (b) pass easily** (0.0–193.7 ms across all local variants, worst case being the degenerate single-row-group file). **(c) fails by 2–3 orders of magnitude** (268 ms – 10.9 s). |
| cold-to-first-suggestions < 1 s on broadband | **(a) passes** (203 ms, localhost — see caveats). **(c) is borderline on cold start alone** (957 ms instantiate+warmup, before even running a real query) and fails once the first real query's ~90 MB download is counted. |
| default index ≤ ~3 MB, fetched lazily on focus | **Passes.** 2.5 MB for ADM0+ADM2, all three row-group variants. |
| range-request becomes mandatory above ~5 MB | **Not yet triggered** — current index is ~2.5 MB, half the threshold. See extrapolation below for when it will be. |

**Recommendation: ship full-load for the current ADM0+ADM2 scale.**
Range-request is implemented, tested, and correct (this harness proves
it), but it's solving a problem the index doesn't have yet at ~2.5 MB.
Keep it in the core as the designed fallback for when the index crosses
the ~5 MB line (see below) — not as the default.

## Row-group size recommendation for the official sidecar

**Target ~100–150 KB per row group (≈2048 rows at this schema's current
~53 bytes/row), not a fixed row count.** Reasoning:

- At the current scale, rg2048 is strictly faster than rg8192 on every
  scripted query (roughly half the latency, roughly half the bytes) with
  no measured downside — more row groups means a marginally larger
  footer (a few more statistics entries), not more round trips, because
  the binary search over groups is O(log n) either way.
- A byte-based target, rather than a fixed row count, keeps per-query
  fetch size (and therefore latency) **constant as the index grows**,
  which is the property that makes range-request worth having at all.
  Fixing row count instead would make row groups (and per-query fetches)
  grow proportionally with total index size for any schema with larger
  average row width.
- This also keeps per-group fetches comfortably above the point where
  per-request overhead (TLS, HTTP headers, TCP) would dominate — 100 KB+
  is well past that floor.
- Avoid a single row group under essentially any circumstances for a
  sidecar meant to be queried by prefix — that configuration cannot be
  pruned at all, which is precisely the ADM2 source-file failure mode
  this whole index exists to avoid.

## What changes at 300K+ rows (fieldmaps ADM3/4)

Not measured directly (no fieldmaps subnational build available yet per
PLAN.md; "~2026-11-13"), extrapolated analytically from the current
numbers, which scale close to linearly in file size and row count:

- **Bytes/row holds roughly constant** (~53 bytes/row compressed, for this
  7-column schema with short name strings) regardless of total row count,
  so a 300K-row index (≈6× current) would be **≈16 MB** — well past the
  "~5 MB range-request-mandatory" line, and a full-load cold fetch+decode
  at that size would scale from today's ~200 ms to roughly **~1.2 s**
  (linear in bytes for both fetch and hyparquet decode, per today's
  numbers), already past the 1 s cold-start budget on its own, before
  counting real network latency.
- **Range-request's per-query cost does NOT scale with total index
  size**, because it's governed by row-group byte size, which a
  byte-targeted row-group policy (above) holds constant. A 300K-row
  index at ~2048 rows/group would have ~146 row groups instead of today's
  25 — negligible for the O(log n) group search — but each individual
  query still only fetches 1–4 row groups of ~100–150 KB each, the same
  as measured here. This is the entire argument for why design call 9
  marks range-request "mandatory" above a size threshold: it's the only
  approach whose per-keystroke cost is scale-invariant.
- **Conclusion:** at fieldmaps ADM3/4 scale, flip the default from
  full-load to range-request. The harness and both implementations
  already exist and are tested; this is a config change
  (`indexUrl` + which approach the geocoder-core package calls), not new
  code.

## Honest caveats

- **Localhost vs. real network.** All (a)/(b) numbers above are served
  from `serve.py` on `localhost` — effectively zero RTT. A real range-
  request query needing 2–4 row-group fetches (e.g. `"s"` on rg2048: 4
  groups) would add one real round trip per fetch on a genuine network;
  at a plausible 50–100 ms mobile RTT, that alone could push total
  latency past the 150 ms warm budget even though the local measurement
  looks fine. The duckdb-wasm numbers, by contrast, ARE against the real
  remote tge-labs mirror over genuine network, so those are realistic
  (if anything, probably better than a slower connection would produce).
- **hyparquet's default speculative footer fetch (512 KB) wasn't tuned
  for a file this small.** A production implementation should pass a
  smaller `initialFetchSize` to `parquetMetadataAsync` when the sidecar
  itself is known to be small, to avoid fetching ~20% of the file just
  for metadata.
- **`normalize()` in the browser (`toLowerCase` + NFKD + strip combining
  marks) is an approximation of DuckDB's `strip_accents(lower(...))`,**
  not a byte-for-byte port. It matches for every scripted query tested
  here (all Latin script), but hasn't been checked against the full
  range of scripts in geoBoundaries names (relevant to E8, multilingual
  search).
- **duckdb-wasm's byte counts required a different measurement path**
  (Playwright CDP `page.on('response')`, not in-page `fetch`
  instrumentation) because its HTTP reads happen inside a Worker. This is
  noted in `bench/run-bench.mjs` and in `duckdbWasmNetwork` in the results
  JSON; it's an aggregate across all queries in a run, not attributable
  to one query.
- **`count=1` for `"contra costa"` across every approach** is consistent
  (good — the approaches agree on results), but hasn't been independently
  verified against an authoritative source; it's presented only as an
  internal-consistency check between approaches, not a correctness claim
  about geoBoundaries coverage.
- **Provisional index, not the shipped artifact.** This index is built
  from the (possibly imperfect) tge-labs mirror for benchmark purposes
  only; the real geoBoundaries catalog + sidecar being built separately
  may have different row counts, schema details, or fixes for the
  null-name issue found here.

## Upstream-advocacy notes

- The 37 NULL-`shapeName` rows in the tge-labs ADM2 mirror (Turkmenistan +
  a few Japan units) are worth reporting alongside the already-known bad
  ADM1 file.
- The raw ADM2 source file (97 MB, single row group, no usable
  statistics) is confirmed — via the duckdb-wasm baseline's full
  re-download-per-query behavior — to be unusable for interactive query
  patterns directly from source.coop. This is now demonstrated with live
  numbers (not just the E0 recon's qualitative description), useful
  ammunition for the mirror/sidecar pitch to geoBoundaries and/or
  source.coop.
