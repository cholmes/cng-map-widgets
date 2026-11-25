# Test fixtures

Real STAC collection documents, saved **verbatim** on 2026-11-25. Each one
stands for a different way a published collection says how to show itself.
They are test inputs, not a mirror: do not edit them to make a test pass. To
refresh one, re-download it and update the tests to whatever changed.

| file | source | what it stands for |
|---|---|---|
| `unosat-damage-sites.collection.json` | `https://data.source.coop/portolan-mirrors/unosat/tropical-cyclones/2018/tc20180209ton/tc20180209ton-damage-sites/collection.json` | vector data with PMTiles (a `rel:"pmtiles"` link) and a default style |
| `worldpop-jamaica-children-5-9.collection.json` | `https://storage.googleapis.com/carto-open-catalogs/worldpop-jamaica/main/children-5-9/collection.json` | one collection-level COG, beside a non-COG source TIFF |
| `naip.collection.json` | `https://nthh.github.io/data-publications/naip/collection.json` | imagery scenes in a `data`-role STAC-GeoParquet table (two candidate parquet assets), plus a national overview COG |
| `oam-cc-by-4-0.collection.json` | `https://data.source.coop/geospatialjeff/oam-portolan/oam-cc-by-4-0/collection.json` | imagery scenes behind a `collection-mirror` asset; the picture asset has role `data` only |
| `sentinel-2-c1-l2a.collection.json` | `https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json` | imagery scenes over hive partitions, with no item-table asset at all; share-alike licence |
| `gmw-country-change.collection.json` | `https://data.source.coop/portolan-mirrors/global-mangrove-watch/country-statistics/country-change/collection.json` | a parquet table with no geometry |
