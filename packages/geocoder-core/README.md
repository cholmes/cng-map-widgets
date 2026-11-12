# @cnmw/geocoder-core

Type a place name, get a boundary. Framework-agnostic, no DOM, no map library,
**no server** — it reads a published *cloud-native gazetteer* (a names index
parquet plus a small JSON manifest, on object storage) directly from the
browser with HTTP range requests.

This is place-name and boundary lookup over gazetteer data, not address
geocoding. "Contra Costa County" works; "1600 Pennsylvania Ave" does not.

```js
const geocoder = new Geocoder({ indexUrl: 'https://…/names/index.json' });
const results = await geocoder.search('contra costa');   // ranked, ~1 ms warm
const area = await geocoder.select(results[0]);          // -> an Area
```

The `Area` it returns is the same object `@cnmw/upload-core` produces and
`@cnmw/download-core` consumes. That is the whole point.

- **Status:** experimental, pre-npm. See the [root README](../../README.md).
- **Normative design:** [`docs/design/widgets-architecture.md`](../../docs/design/widgets-architecture.md) §3.2 (API), §6 (index file interface).
- **UI:** this package has none. Use [`@cnmw/maplibre`](../maplibre/README.md) or [`@cnmw/openlayers`](../openlayers/README.md).
- **License:** MIT (code). **The data has its own license** — the manifest tells you which, and `Area.provenance.attribution` carries what you must display.

---

## Install / import

Nothing is published to npm yet. Point an import map at the source:

```html
<script type="importmap">
{
  "imports": {
    "@cnmw/spec": "/packages/spec/src/index.js",
    "@cnmw/geocoder-core": "/packages/geocoder-core/src/index.js"
  }
}
</script>
<script type="module">
  import { Geocoder } from '@cnmw/geocoder-core';
</script>
```

`hyparquet` is **not** in that map: this package `import()`s it itself from a
pinned, exact CDN URL (`src/cdn.js`). In Node or inside a bundler that already
has hyparquet, hand yours in instead — see
[Node and bundlers](#node-and-bundlers).

**Coming:** `npm i @cnmw/geocoder-core`, plus a CDN form
(`https://cdn.jsdelivr.net/npm/@cnmw/geocoder-core@0.1.0/src/index.js`).

## Size

| | files | raw | gzip | gzip, comments stripped | design-doc budget (§4.5) |
|---|---|---|---|---|---|
| `@cnmw/geocoder-core` src | 8 | 105.4 KiB | 32.5 KiB | **11.0 KiB** | ≤ 15 KB min+gz |
| `+ @cnmw/spec` | | | | 6.2 KiB | ≤ 10 KB |
| `+ hyparquet@1.33.0` | | 199.9 KiB | 46.9 KiB | — | 35 KB (measured at 1.26.0) |
| `+ hyparquet-compressors@1.1.3` | | | 69.1 KiB *(the jsdelivr `+esm` bundle, as fetched)* | — | 79 KB |

Measured with `cat src/*.js | gzip -9`; there is no minified build yet, so the
stripped column is the honest stand-in. **Measured on the wire:** the first
`load()` of the quickstart page pulls **30 files / ≈324 KB from
cdn.jsdelivr.net**, 27 of them hyparquet's own modules — because hyparquet is
loaded as its unbundled `src/index.js`. If that waterfall matters, repoint
`hyparquet` at a single prebundled file with one import-map line, or inject it
(below).

---

## Quickstart

```js
import { Geocoder } from '@cnmw/geocoder-core';

const geocoder = new Geocoder({
  // The published geoBoundaries gazetteer: 52,398 named admin units,
  // ADM0/1/2, CC-BY-4.0.
  indexUrl: 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json',
  limit: 8,
});

// Call load() on focus of your search box, not on page load: the index is
// 3.9 MB and most page views never search.
const info = await geocoder.load();
info.source;      // 'geoboundaries-cgaz'
info.rows;        // 52398
info.levels;      // [0, 1, 2]
info.strategy;    // 'full'  -- 3.9 MB is under fullLoadMaxBytes (5 MiB)
info.attribution[0].license;   // 'CC-BY-4.0'

const results = await geocoder.search('contra costa');
results[0].name;              // 'Contra Costa'
results[0].country;           // 'USA'
results[0].level;             // 2
results[0].countryName;       // 'United States'  -- dropdown context
results[0].rank.matchClass;   // 'exact'
results[0].areaKm2;           // 1966.971

const area = await geocoder.select(results[0]);
area.geometry.type;                        // 'Polygon'
area.provenance.geometryVariant;           // 'display-simplified'
area.vertexCount.display;                  // 41
area.provenance.geocoder.boundaryUrl;      // '…/adm2/cgaz_adm2_display.parquet'
area.provenance.attribution[0].license;    // 'CC-BY-4.0'
```

Measured against the live catalog from Node, cold: manifest + 3.9 MB index in
**≈3.8 s**, warm `search()` in **≈1 ms**, `select()` in **≈0.4–2.7 s** depending
on level. In a browser the same cold load measured **≈5.3 s** (the extra is the
hyparquet module waterfall). The design doc's budget is 1 s cold on broadband —
**that budget is not met today**; see [Gotchas](#gotchas).

---

## API reference

Verified by [`docs/verify-snippets.mjs`](../../docs/verify-snippets.mjs)
(`node docs/verify-snippets.mjs geocoder`) against the live published catalog.

### `new Geocoder(options?)`

| option | type | default | honored? | notes |
|---|---|---|---|---|
| `indexUrl` | `string` | `DEFAULT_INDEX_URL` | yes | The **manifest** URL (`index.json`), not the parquet. May be relative in a browser. |
| `loadStrategy` | `'full' \| 'range' \| 'auto'` | `'auto'` | yes | `auto` → `full` when `manifest.index.size <= fullLoadMaxBytes`, else `range`. |
| `fullLoadMaxBytes` | `number` | `5_242_880` | yes | |
| `limit` | `number` | `10` | yes | Default result count; overridable per call. |
| `minPrefixLength` | `number` | `1` | yes | Shorter queries return `[]` without touching the index. |
| `normalize` | `(string) => string` | `normalizeName` from `@cnmw/spec` | yes | **Must match the index builder's `name_norm`.** |
| `ranking` | `Partial<RankingOptions>` | see below | yes | Merged over the defaults. |
| `levels` | `number[]` | — | yes | Pre-filter, applied before ranking. |
| `countries` | `string[]` | — | yes | ISO-3166-1 alpha-3. |
| `diversity` | `DiversityOptions` | `{ dedupe: true, maxPerGroup: 3 }` | yes | |
| `geometry` | `GeometryResolverOptions` | `{ resolution: 'display' }` | yes | Defaults for `select()`. |
| `onVersionSkew` | `'error' \| 'warn' \| 'ignore'` | `'error'` | yes | |
| `fetch` | `typeof fetch` | `globalThis.fetch` | yes | Every request goes through this. |
| `signal` | `AbortSignal` | — | **no** | Pass a signal to `load()`/`search()`/`select()` instead. |
| `initialFetchSize` | `number` | — | **no** | The footer read size comes from the manifest's `footer_metadata_bytes`; this option is ignored. |
| `indexUrl` as an **array** | `string[]` | — | **no** | Multi-source search is designed but not implemented. An array silently falls back to `DEFAULT_INDEX_URL`. |

`RankingOptions`: `{ viewportBoost = 1, nearFactor = 2, matchClasses = ['exact',
'prefix', 'word-prefix'], exactLevelPromotion = 1, … }`. The comparator is
actively being tuned — read
[`src/ranking.js`](src/ranking.js)'s `compareRanked` doc comment and design doc
§3.2 for the normative order, and treat the exported constants
(`DEFAULT_EXACT_LEVEL_PROMOTION`, `DEFAULT_ALT_LEVEL_DEMOTION`,
`MATCH_CLASS_RANK`, `VIEWPORT_RANK`, `DEFAULT_DIVERSITY`) as the source of
truth for their defaults.

`DiversityOptions`: `{ dedupe = true, maxPerGroup = 3 }`. `dedupe` collapses
rows identical in `(nameNorm, country, level)` to the largest-`areaKm2` one,
annotated with `moreCount`. `maxPerGroup` caps rows per `(country, level)`
*before* the `limit` slice, so a capped group makes room for the next distinct
group instead of shrinking the list. `maxPerGroup: null` disables the cap.

`GeometryResolverOptions`: `{ resolution = 'display', filterVertexCeiling =
10_000, displayVertexCeiling = 200_000 }`. (`boundaryUrls` is in the design doc
but not implemented — boundary URLs come from the manifest.)

### Properties

| | type | notes |
|---|---|---|
| `geocoder.state` | `'idle' \| 'loading' \| 'ready' \| 'error'` | |
| `geocoder.info` | `IndexInfo \| null` | Populated once `load()` resolves. |
| `geocoder.attribution` | `object[]` | The manifest's `attribution`, verbatim (so `snake_case` keys — see [Gotchas](#gotchas)). |

### `load(signal?) => Promise<IndexInfo>`

Idempotent; concurrent calls share one promise. A failure clears the cached
promise so a retry is possible. **Call it on focus of the search box, not on
page load.**

`IndexInfo`: `{ url, source, indexVersion, catalogVersion, rows, levels, bytes,
strategy, attribution, loadMs, prominent? }`. `prominent` is present only when
the manifest declares a `prominent_index`, and `prominent.ready` is `false` if
that index itself failed to load (which never fails `load()`).

### `search(prefix, options?) => Promise<SearchResult[]>`

Calls `load()` if needed. Safe to call on every keystroke. `options`:
`{ viewport?, limit?, levels?, countries?, diversity?, signal? }`.

**A superseded search resolves to `[]` — it never rejects.** This removes the
single most common source of unhandled rejections in typeahead code:

```js
const stale = geocoder.search('par');
const fresh = geocoder.search('paris');
await stale;   // []  -- not a rejection
await fresh;   // the real results
```

**Two-wave search.** If the manifest declares a `prominent_index` (a small
eager-loaded subset — the Overture gazetteer ships one at 8.6 MiB / 108,919
rows against a 409 MB full index), `load()` resolves as soon as that subset is
ready and `search()` answers from it, tagging its `'results'` event
`wave: 'prominent'`. When the main index finishes in the background, the same
query re-runs and a second `'results'` event fires with `wave: 'final'` — but
only if it adds a row the first wave did not have. With no `prominent_index`
there is always exactly one wave, tagged `'final'`.

### `searchSync(prefix, options?) => SearchResult[]`

Zero-await typeahead. Requires `state === 'ready'` **and** a full-loaded index;
throws `GEOCODER_NOT_LOADED` otherwise. Worth its API surface because a warm
full-load search is a binary search over an in-memory array (E1 measured 0.0 ms
p50 / 0.1 ms p95), so a promise per keystroke *is* the per-keystroke cost.

```js
geocoder.searchSync('contra costa')[0].name;   // 'Contra Costa'
new Geocoder({ indexUrl }).searchSync('paris'); // throws GEOCODER_NOT_LOADED
```

### `select(result, options?) => Promise<Area>`

Fetches the geometry and builds the `Area`. `options` is
`GeometryResolverOptions & { onVersionSkew?, signal? }`.

| `resolution` | behaviour |
|---|---|
| `'display'` *(default)* | One read of the level's pre-simplified display file. Fast. `geometryVariant: 'display-simplified'`. |
| `'full'` | One read of the full-resolution file. `geometryVariant: 'full'`. |
| `'both'` | Returns the display `Area` immediately with `provenance.pendingUpgrade: true`, then fetches + simplifies the full-resolution geometry in the background and emits `'area:upgraded'` with a copy whose `filterGeometry` and `vertexCount.filter` reflect it. `Area.geometry` never changes. |

A level with no `display` file declared falls back to `'full'` for both
`'display'` and `'both'`. Calling `select()` again supersedes a pending
upgrade: the in-flight fetch/decode/simplify is aborted and its result dropped.

```js
const display = await geocoder.select(result);                          // 41 vertices
const full = await geocoder.select(result, { resolution: 'full' });     // 111 vertices
display.provenance.geocoder.boundaryUrl;  // '…/adm2/cgaz_adm2_display.parquet'
full.provenance.geocoder.boundaryUrl;     // '…/adm2/cgaz_adm2.parquet'
```

`'both'` is what keeps a 500,000-vertex ADM0 feature (Canada) from blocking the
main thread at all. Use it for anything interactive.

### `on(event, handler) => unsubscribe`

Handlers run synchronously in registration order. A throwing handler is caught
and reported via `'error'` rather than stopping the others.

| event | payload | when |
|---|---|---|
| `state` | `{ state }` | Every transition. |
| `load` | `IndexInfo` | Once, when the index is usable. |
| `results` | `{ query, results, elapsedMs, wave: 'prominent'\|'final' }` | Per answered `search()`. |
| `select` | `{ result, area, elapsedMs }` | Per `select()`, as soon as it returns. |
| `area:upgraded` | `{ result, area, elapsedMs }` | A background upgrade produced a better `filterGeometry`. |
| `index:upgraded` | `{ strategy, loadMs }` | The main index finished loading behind a `prominent_index`. |
| `warning` | `{ code, message, detail? }` | Tolerated skew, `PROMINENT_INDEX_FAILED`, `GEOMETRY_REF_MISMATCH`. |
| `error` | `CnmwError` | |

`load:progress` is in the design doc but **never emitted** by this build.

```js
const off = geocoder.on('load', (info) => console.log(info.rows));
geocoder.on('results', ({ query, results, wave }) => render(query, results, wave));
geocoder.on('select', ({ result }) => console.log('picked', result.name));
off();   // unsubscribe
```

### `close()`

Drops the in-memory index, invalidates in-flight searches, aborts pending
background upgrades, clears the boundary-handle cache, and returns `state` to
`'idle'`.

### `SearchResult`

| field | type | notes |
|---|---|---|
| `featureId` | `string` | The publisher's stable logical id (`shapeID` for geoBoundaries). Never a row offset. |
| `name` / `nameNorm` | `string` | Display name as published / the normalized sort key. |
| `level` | `number` | 0-based admin level. |
| `country` | `string` | ISO-3166-1 alpha-3. |
| `parentName` | `string?` | Overture's containing-unit name ("Rajasthan"). `undefined` if the index lacks the column. |
| `countryName` | `string?` | geoBoundaries' country display name ("United States"). The two sources are mutually exclusive on these columns. |
| `areaKm2` | `number?` | |
| `population` / `class` | `number?` / `string?` | **Reserved.** Passed through unconditionally; unpopulated on every index shipped so far. |
| `bbox` | `BBox` | `[xmin, ymin, xmax, ymax]`, flattened from the index's struct column. |
| `source` | `string` | From the row's `source` column, else the manifest's top-level `source`. |
| `score` | `number` | Derived `0..1`, **for display only** — the sort never reads it. |
| `rank` | `object` | Why it ranked where it did: `matchClass`, `level`, `effLevel`, `levelAdjusted`, `viewportRank`, `nameLength`, `areaKm2`, `isAlt`. |
| `moreCount` | `number?` | Set when dedupe collapsed N identical rows into this one. Render as "(+N more)". |
| `geometryRef` | `{ file, rowGroup, row }?` | Advisory fast-path pointer. **`row` is a `BigInt`.** |

Note the field is `rank.viewportRank`, not `rank.viewport` as the design doc
writes it.

### Filters and the viewport boost

```js
// Countries only, three of them.
const countries = await geocoder.search('a', { levels: [0], limit: 3 });

// One country's units at any level.
const swiss = await geocoder.search('zurich', { countries: ['CHE'] });
// -> Zürich ADM1, Zürich ADM2

// The viewport boost, which actually reorders:
await geocoder.search('contra', { limit: 5 });
// [0] 'Contralmirante Villar' (PER) -- ties Contra Costa on level, wins on area

await geocoder.search('contra', { viewport: [-122.6, 37.4, -121.7, 38.2], limit: 5 });
// [0] 'Contra Costa' (USA), rank.viewportRank 'inside',
//     rank.effLevel 2 -> rank.levelAdjusted 1
```

The boost is one admin level by default (`viewportBoost`), folded into
`levelAdjusted`. `viewportRank` is `inside` (the feature bbox's centre is in
the viewport), `overlap` (boxes intersect), `near` (intersects the viewport
scaled by `nearFactor`), or `outside`. Adapters supply the viewport
automatically; `viewportProvider(map)` is a one-liner over `map.getBounds()`.

### Pure helpers

These are exported for testing and for anyone reimplementing the search
(a QGIS plugin, a CLI):

| export | signature |
|---|---|
| `classifyMatch(nameNorm, queryNorm, allowedClasses)` | `=> 'exact'\|'prefix'\|'word-prefix'\|'substring'\|null` |
| `computeViewportRank(featureBBox, viewport, nearFactor)` | `=> 'inside'\|'overlap'\|'near'\|'outside'` |
| `rankRow(row, queryNorm, options)` | `=> rank \| null` |
| `compareRanked(a, b)` | the total-order comparator |
| `scoreOf(rank)` | `=> number` (0..1, display only) |
| `applyDiversity(sorted, options?)` | dedupe + per-group cap, **without** slicing to a limit |
| `dedupeByNameCountryLevel(sorted)` / `capPerCountryLevelGroup(rows, maxPerGroup)` | the two halves of it |
| `prefixRange(sortedArray, prefix)` | `=> [start, end)` — the whole full-load search |
| `findCandidateGroups(groups, prefix)` / `searchRangeIndex(handle, prefix)` | the range path |
| `resolveResolutionMode(requested, hasDisplay)` | the display→full fallback decision |
| `resolveJoinKey(manifestEntry, result)` / `geometryRefRowRange(ref, rowGroupRows)` / `firstMatch(items, concurrency, task)` | `select()`'s internals, unit-testable |
| `resolveGeometry(...)` / `openBoundaryFile(url, fetch, signal?, footerBytes?)` | the geometry fetch itself |
| `GenerationGuard` | the supersede-and-abort primitive |
| `CDN`, `loadHyparquet`, `setHyparquetModules`, `clearHyparquetModules` | the dependency seam |
| `DEFAULT_INDEX_URL`, `VERSION` | |

```js
import { classifyMatch, computeViewportRank, prefixRange } from '@cnmw/geocoder-core';

const allowed = ['exact', 'prefix', 'word-prefix'];
classifyMatch('paris', 'paris', allowed);                // 'exact'
classifyMatch('paris paris', 'paris', allowed);          // 'prefix' -- starts with, not equal
classifyMatch('saint andrew parish', 'paris', allowed);  // 'word-prefix'
classifyMatch('somewhere else', 'paris', allowed);       // null
classifyMatch('a paris b', 'paris', ['exact']);          // null -- class not allowed

const viewport = [-10, -10, 10, 10];
computeViewportRank([-1, -1, 1, 1], viewport, 2);        // 'inside'
computeViewportRank([9, 9, 30, 30], viewport, 2);        // 'overlap'
computeViewportRank([15, 0, 16, 1], viewport, 2);        // 'near'
computeViewportRank([100, 100, 101, 101], viewport, 2);  // 'outside'

prefixRange(['bag', 'baghdad', 'bago', 'zurich'], 'bag');   // [0, 3]
prefixRange(['bag', 'baghdad', 'bago', 'zurich'], 'zz');    // [4, 4]
```

---

## Node and bundlers

In a browser this package loads hyparquet by `import()`-ing a pinned absolute
CDN URL. Node has no network imports, and inside a bundler that URL is a
runtime-computed specifier no bundler can rewrite — so a host app that already
bundles hyparquet would end up running a second copy from the network.
`setHyparquetModules` is the seam for both cases. Call it **once, before the
first `load()`**:

```js
import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { Geocoder, setHyparquetModules } from '@cnmw/geocoder-core';

setHyparquetModules({ hyparquet, compressors });

const geocoder = new Geocoder({ indexUrl: 'https://…/names/index.json' });
await geocoder.load();        // now works in Node, or against the host's copy
```

`clearHyparquetModules()` restores the CDN path. The pinned versions this
package expects are in `src/cdn.js`: `hyparquet@1.33.0`,
`hyparquet-compressors@1.1.3`.

## The index contract, briefly

`indexUrl` points at a JSON manifest, not the parquet. You can read it yourself
— it is ~10 KB and documents the whole dataset:

```js
const manifest = await fetch(indexUrl).then((r) => r.json());
manifest.spec;                               // 'cnmw-index/1.0'
manifest.catalog_version;                    // 'geoboundaries-cgaz-2026-11-12'
manifest.index.feature_id_column;            // 'shape_id'  -- NOT 'feature_id'
manifest.index.footer_metadata_bytes;        // 75606 -- the exact footer read size
manifest.boundaries[0].index_key_column;     // 'country'  -- ADM0 has no shapeID at all
manifest.boundaries[0].feature_id_column;    // null
```

Required index columns: `name`, `name_norm`, `level`, `country`, `feature_id`
(renamable via `index.feature_id_column`), `source` (defaultable from the
manifest's top-level `source`), `bbox`. Optional and read when present:
`parent_name`, `parent_id`, `country_name`, `area_km2`, `geometry_ref`,
`class`, `population`. A missing required column throws
`INDEX_SCHEMA_MISMATCH` naming it — there is no silent coercion.

The sort guarantee matters: rows must be sorted ascending by `name_norm`
compared **byte-wise on its UTF-8 encoding**, so a JavaScript `a < b` agrees
with the file's order. A full load re-checks this and throws
`INDEX_SCHEMA_MISMATCH` if it is violated.

Full contract: design doc §6. Two live manifests to read:
[geoBoundaries](https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json)
(52,398 rows, CC-BY-4.0) and
[Overture](https://data.source.coop/portolan-mirrors/cn-gazetteer-overture/names/index.json)
(5.6M rows, multilingual, ODbL-1.0 — share-alike).

## How `select()` finds a geometry

1. **`geometry_ref` fast path.** The index row carries a `{file, row_group, row}`
   pointer into the boundary file. `geometryRefRowRange` re-derives the row
   group from `row` and the manifest's `row_group_rows` and refuses the ref
   outright if they disagree. The join-key verification read and the geometry
   read for that same row are issued **in parallel**; on a key mismatch the
   speculative geometry read is discarded and a `GEOMETRY_REF_MISMATCH` warning
   fires. The ref is advisory and never trusted without verification.
2. **Stats-pruning fallback.** Candidate row groups are narrowed by the
   boundary file's `country_column` and join-column statistics, then scanned
   with bounded concurrency (5 at a time, stop on first match).
3. **`GEOMETRY_NOT_FOUND`** if the key is absent entirely.

Why the fast path exists: the published catalog's boundary files are
Hilbert-sorted for compactness, not sorted by `(country, feature_id)`, so
statistics prune weakly (34 of 55 candidate groups survive for Canada's ADM0
row) and `select()` measured **5.6–28.2 s** live before `geometry_ref` landed.

Open file handles and parsed footers are cached per `Geocoder` instance, keyed
by boundary URL, and warmed by a background prefetch that runs once `load()`
resolves (display variants first, one at a time via `requestIdleCallback`). A
cached handle never carries a caller's `AbortSignal`, so one caller's abort can
never cancel another's read of the same file.

---

## Gotchas

**`DEFAULT_INDEX_URL` is `'./data/index.json'`.** It is a *development* default
pointing at a local build, not the published catalog. Always pass `indexUrl`
explicitly. (The design doc says the default should be the published URL; it
is not.)

**`indexUrl` must be a string.** The designed multi-source form
(`indexUrl: [url1, url2]`) is not implemented, and an array silently falls back
to `DEFAULT_INDEX_URL` rather than throwing. Pass one URL.

**The 1 s cold-load budget is not met.** 3.9 MB over the public path measured
≈3.8 s from Node and ≈5.3 s in a browser (the extra being hyparquet's 27-file
module waterfall). The design doc's falsifiable budget was < 1 s on broadband.
What would close it, roughly in order: a prebundled hyparquet (one fetch, not
27), a `prominent_index` on the geoBoundaries catalog (the Overture one already
has one), and `loadStrategy: 'range'` for a cold first keystroke. Warm
keystrokes are ~1 ms and well inside budget.

**`geometryRef.row` is a `BigInt`.** Parquet `INT64` decodes to `BigInt` in
hyparquet, so `JSON.stringify(searchResult)` **throws** `TypeError: Do not know
how to serialize a BigInt`. If you persist results, strip or stringify it:

```js
JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? String(v) : v));
```

This also bit the implementation: a naive `Number.isInteger(ref.row)` check
made the fast path never fire, which was the measured-slow behaviour it exists
to fix.

**Attribution keys are `snake_case`.** `geocoder.attribution` and
`Area.provenance.attribution` are the manifest's array passed through verbatim,
so entries have `share_alike`, not `shareAlike`. `@cnmw/download-core`'s
collection-derived attribution uses `shareAlike`. Read both:
`const shareAlike = a.shareAlike ?? a.share_alike;`. **This matters for ODbL
data** — checking only `shareAlike` on an Overture-sourced Area silently
reports no share-alike obligation.

**Version skew is currently inert against the live catalog.** The published
parquet files carry no `cnmw:catalog_version` footer key, so
`onVersionSkew: 'error'` neither errors nor warns — the check reads `null` and
no-ops. Feature identity is still safe, because resolution always re-locates
the row by key and never by a cached offset.

**Range reads must be `cache: 'no-store'`,** which this package does
internally. Chrome serializes concurrent reads of one URL behind its cache
lock: 2.1 s → 0.4 s for the same eight reads, measured.

**A host that answers `Range` with a 200 breaks the range path silently.**
`python3 -m http.server` does exactly this — it returns the whole file and the
range path degrades into "mysteriously slow" rather than an error. Use the
repo's `serve.py`, or `npx serve`.

**`searchSync` throws on the range path** even when `state === 'ready'`: it
needs the whole index in memory.

## Tests

```
node --test packages/geocoder-core/test/*.test.js
```

A dozen files: ranking order and diversity, the prominent-index two-wave path,
range-request pruning, `select()` resolution modes and the `geometry_ref` fast
path, join-key resolution, the generation guard, and index projection.

`Geocoder#load()`/`select()` cannot run end-to-end under `node --test` without
a network and a browser-capable `import()` of an `https:` URL, so the suite
substitutes fakes through an internal `options.__deps` seam (never public API)
and the real end-to-end path is covered by
[`examples/quickstart/verify.mjs`](../../examples/quickstart/verify.mjs),
[`examples/geocoder-demo/verify-live.mjs`](../../examples/geocoder-demo/verify-live.mjs)
and `docs/verify-snippets.mjs`.
