# tools/

## `gazetteer-conformance.mjs`

Checks whether a published gazetteer catalog actually works, not just whether
it declares the right fields. A JSON Schema (or the STAC `gazetteer`
extension's validator) can confirm a Collection has the right
`gazetteer:*` keys; it cannot confirm that `name_norm` really ascends
byte-wise on its UTF-8 encoding, or that it was produced by the declared
normalization. This tool reads the actual parquet data and checks that.
See [issue #1](https://github.com/cholmes/cng-map-widgets/issues/1), "What a
JSON Schema cannot enforce."

### Usage

```bash
node tools/gazetteer-conformance.mjs <url> [options]
```

`<url>` is either:

- a legacy manifest (`index.json`, top-level `"spec": "cnmw-index/1.0"` or
  `"cng-index/1.0"`), or
- a STAC Collection declaring the gazetteer extension (an asset with
  `"roles": ["gazetteer-index"]`).

Both shapes are supported because the catalogs are mid-migration (issue #1).

```bash
node tools/gazetteer-conformance.mjs \
  https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json
```

Options:

- `--max-groups=<n>` -- max row groups sampled for the sort/normalization
  checks (default 300). Below this, every row group is read; above it, groups
  are evenly subsampled across the whole file rather than just the start.
- `--edge-rows=<n>` -- rows read from the start and end of each sampled row
  group (default 5).
- `--concurrency=<n>` -- parallel range requests (default 12).

Exits non-zero if any check FAILs. WARN does not fail the run.

### What it checks

1. **Structure** -- the document is a recognized manifest or Collection shape.
2. **Required index columns** -- `name`, `name_norm`, `level`, `bbox`, and the
   feature-id column (by whatever name it's declared under). `bbox` may be a
   struct or four flat `xmin`/`ymin`/`xmax`/`ymax` columns; either is
   accepted.
3. **Recommended columns** -- `country`, `country_name`, `parent_name`,
   `area_km2`, `source` (WARN only).
4. **The sort guarantee** -- `name_norm` ascends compared byte-wise on its
   UTF-8 encoding (`Buffer.compare`, not JS `<` or `localeCompare`). On a
   large file this samples row groups rather than reading every row: the
   first/last `--edge-rows` rows of up to `--max-groups` row groups, evenly
   spaced across the file, checking ascent within each sampled block and
   across every consecutive sampled boundary. The report says exactly how
   many rows were checked and whether it was a full or sampled pass.
5. **Normalization round-trip** -- for every sampled row,
   `normalizeName(name)` (imported straight from `@cngeo/spec`, the normative
   implementation) must equal the stored `name_norm`. A handful of mismatches
   is a FAIL: this is exactly what silently breaks prefix search.
6. **Declared counts** -- row-group count and row count, if the document
   declares them, against the parquet footer.

### Requirements

Needs `hyparquet` and `hyparquet-compressors`. They aren't in this repo's
`package.json`, but are resolvable transitively today; if that stops being
true, install them explicitly:

```bash
npm i -D hyparquet hyparquet-compressors
```

### Performance

Tested live against all three published catalogs (2026-11-20):

| catalog | index size | rows | row groups | runtime |
|---|---|---|---|---|
| geoBoundaries | 3.9 MB | 52,398 | 35 | ~8s (every row group checked, none skipped) |
| Overture divisions | 409 MB | 5,604,021 | 876 | ~27s (300/876 row groups sampled) |
| Who's On First | 604 MB | 9,478,998 | 741 | ~30s (300/741 row groups sampled) |

Metadata (the footer) is always read in full -- that's what makes the
sampling possible. Row data is only ever range-read for the sampled groups.
