# Draft — a change to `portolan-registry/scripts/registry/catalog_index.py`

**Status: a draft, not proposed, and NOT RUN.** Written against the file as it
stood in a local clone on 2026-11-25 (519 lines; `SCHEMA` at line 91,
`build_row` at line 231, `write_index` at line 503). It has not been executed,
the registry's tests have not been run against it, and nothing has been
pushed or opened. Evidence for the change: [`RESULTS.md`](RESULTS.md). The
column definitions: [`spec-paragraph.md`](spec-paragraph.md).

## What changes

Three columns are added to the index, all derived from the collection
document the walk already holds when it builds a row. No extra request.

1. **`SCHEMA`** gains three fields, after `keywords` and before the registry
   column, so the published layout's order is otherwise untouched.
2. **`build_row`** fills them for a collection and leaves them null for a
   catalog.
3. A new module, `registry/render.py`, holds the derivation: a Python port of
   the five rules in `cng-map-widgets`'
   `packages/stac/src/layers-from-collection.js`.

`write_index` needs no change: the new columns are small and the file stays
one row group.

## The sketch

```python
# registry/catalog_index.py

_RENDER = pa.struct(
    [
        ("kind", pa.string()),
        ("id", pa.string()),
        ("title", pa.string()),
        ("url", pa.string()),
        ("style", pa.string()),
        ("layers", pa.list_(pa.string())),
        ("display_asset", pa.string()),
        ("items", pa.string()),
        ("reason", pa.string()),
    ]
)
_ATTRIBUTION = pa.struct(
    [("text", pa.string()), ("license", pa.string()), ("url", pa.string()), ("share_alike", pa.bool_())]
)

SCHEMA = pa.schema(
    [
        # ... unchanged, through ...
        ("keywords", pa.list_(pa.string())),
        ("render", pa.list_(_RENDER)),
        ("thumbnail", pa.string()),
        ("attribution", pa.list_(_ATTRIBUTION)),
        (REGISTRY_ID, pa.string()),
    ]
)


def build_row(catalog_id: str, url: str, doc: Mapping[str, Any], parents: Sequence[Row]) -> Row:
    ...
    row: Row = {
        ...
        "keywords": None,
        "render": None,
        "thumbnail": None,
        "attribution": None,
        REGISTRY_ID: catalog_id,
    }
    if is_collection:
        ...
        try:
            row.update(render_columns(doc, url))
        except Exception:  # a document this cannot read is still indexed
            pass
    return row
```

```python
# registry/render.py -- how a collection is drawn, from its own document.
#
# The rules, in order. A collection can yield more than one entry.
#
#   1. pmtiles-vector  a `rel: "pmtiles"` link, else a PMTiles asset
#                      (type application/vnd.pmtiles, or a .pmtiles href).
#                      style: the asset with roles `style` and `default`,
#                      else the only `style` asset. layers: the link's
#                      `pmtiles:layers`, else the collection's.
#   2. scenes          an imagery item table: a `collection-mirror` parquet
#                      asset; or `table:columns` naming `stac_version` and
#                      `assets`, over `partition:scheme` or a `data` parquet.
#                      display_asset: the `item_assets` entry with role
#                      `visual`, else keyed `visual` or `image`.
#   3. cog             each collection-level asset whose type carries
#                      `profile=cloud-optimized`.
#   4. table           a `data` parquet with no geometry column.
#   5. unsupported     anything else, with a reason.
#
# Every href is resolved against the collection's URL, and only http(s)
# counts: an asset published at s3:// is not something a browser can draw.

def render_columns(doc: Mapping[str, Any], url: str) -> Row:
    entries = _entries(doc, url)                      # the five rules
    title = _text(doc.get("title")) or doc["id"]
    for entry in entries:
        if entry["title"] == title:
            entry["title"] = None                     # stored only when it differs
    return {
        "render": entries or None,
        "thumbnail": _thumbnail(doc, url),            # the asset with role `thumbnail`, else the link
        "attribution": _attribution(doc),             # the provider with role `licensor`, else `producer`, and the license
    }
```

`_entries` is about 120 lines in JavaScript and would be about the same in
Python. It is not written out here on purpose: a port that has not been run
against the registry's own fixtures would be a guess. The JavaScript version
is the tested reference (six real collection documents, and all 7,049 in the
registry on 2026-11-25 with no failure).

## What to check before this is real

- **Agreement with the reference.** Run the Python port over the same index
  and compare its `render` column with `build.mjs`'s
  `out/collections.render.parquet`. They should be identical; E13's
  comparison harness (`measure.mjs`, section 3) is the model.
- **`same_rows` and the nightly diff.** The index is rewritten only when rows
  change (`same_rows`, line 498). `render` is a function of `original`, so it
  changes exactly when `original` does — but a change to the *rules* changes
  every row at once. That is one large commit on `bot/catalog-index`, by
  design; say so in the changelog.
- **`read_index`** returns `None` for "another layout" (line 479). Adding
  columns is another layout: the first build after this change starts from
  nothing, as intended, and should be watched.
- **The comment at line 50** says the file is about 9 MB. It is 20.4 MB now;
  these columns add about 0.45 MB as zstd parquet (measured with DuckDB; see RESULTS.md).
- **Clients that read the index today** (the Portolan browser, DuckDB users):
  three extra nullable columns should break none of them, but nobody has
  checked.
