#!/usr/bin/env node
// E14 Gate C: what does an imagery search cost through TODAY's
// @cngeo/extract-core, on the three collections the imagery widget targets?
//
//   node experiments/e14-search-cost/measure.mjs [--runs 3]
//
// Live data, Node 22, hyparquet injected as AGENTS.md §Setup describes.
// Nothing here is a benchmark of the network; it is here to size three
// decisions in Phase 2: the footer cache, streaming results, and how a
// scene's `assets` get resolved.

import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { setHyparquetModules, resolveDataset, estimate, createHyparquetEngine } from '../../packages/extract-core/src/index.js';
import { areaFromGeoJson } from '../../packages/upload-core/src/index.js';

setHyparquetModules({ hyparquet, compressors });

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;
const now = () => performance.now();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const box = ([w, s, e, n]) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });

const DATASETS = [
  {
    name: 'Sentinel-2 C1 L2A',
    descriptor: { spec: 'cng-dataset/1.0', id: 's2', source: { kind: 'portolan-collection', url: 'https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json' } },
    footerOf: 'https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=2025/items.parquet',
    bbox: [36.6, -1.5, 37.1, -1.1], // Nairobi
    time: { start: '2025-06-01T00:00:00Z', end: '2025-07-01T00:00:00Z', closed: '[)' },
    columns: ['id', 'datetime', 'eo:cloud_cover'],
  },
  {
    name: 'NAIP',
    // Hand-written: resolveDataset() does not recognise this item table yet (Phase 2).
    descriptor: { spec: 'cng-dataset/1.0', id: 'naip', source: { kind: 'parquet', url: 'https://data.source.coop/nthh/naip/stac/naip.parquet' } },
    footerOf: 'https://data.source.coop/nthh/naip/stac/naip.parquet',
    bbox: [-122.55, 37.65, -122.25, 37.9], // San Francisco
    time: { start: '2024-01-01T00:00:00Z', end: '2025-01-01T00:00:00Z', closed: '[)' },
    columns: ['id', 'datetime', 'naip:state'],
  },
  {
    name: 'OpenAerialMap (CC-BY-4.0)',
    descriptor: { spec: 'cng-dataset/1.0', id: 'oam', source: { kind: 'parquet', url: 'https://data.source.coop/geospatialjeff/oam-portolan/oam-cc-by-4-0/items.parquet' } },
    footerOf: 'https://data.source.coop/geospatialjeff/oam-portolan/oam-cc-by-4-0/items.parquet',
    bbox: [39.1, -7.0, 39.4, -6.6], // Dar es Salaam
    // No time filter: these rows carry start/end_datetime with a null
    // `datetime`, which today's single-time-column filter would drop entirely.
    time: null,
    columns: ['id', 'start_datetime', 'gsd'],
  },
];

/** Footer facts for one file: size, row groups, and what the `assets` column is. */
async function footerFacts(url) {
  const t0 = now();
  const file = await hyparquet.asyncBufferFromUrl({ url, requestInit: { cache: 'no-store' } });
  const metadata = await hyparquet.parquetMetadataAsync(file, { initialFetchSize: 65_536, geoparquet: false });
  const ms = now() - t0;
  const groups = metadata.row_groups;
  const assetsChunks = groups.map((g) => g.columns.filter((c) => c.meta_data.path_in_schema[0] === 'assets'));
  const assetsBytes = assetsChunks.map((cs) => cs.reduce((n, c) => n + Number(c.meta_data.total_compressed_size), 0));
  const assetsLeaves = assetsChunks[0]?.length ?? 0;
  const firstLeaf = assetsChunks[0]?.[0];
  const allChunks = groups.flatMap((g) => g.columns);
  const withOffsetIndex = allChunks.filter((c) => c.offset_index_offset !== undefined && c.offset_index_offset !== null).length;
  const rows = groups.map((g) => Number(g.num_rows));
  return {
    footerReadMs: Math.round(ms),
    fileBytes: file.byteLength,
    footerBytes: metadata.metadata_length,
    rowGroups: groups.length,
    rows: rows.reduce((a, b) => a + b, 0),
    medianRowsPerGroup: median(rows),
    assets: assetsLeaves
      ? {
          shape: assetsLeaves === 1 ? `one leaf column, physical type ${firstLeaf.meta_data.type}` : `struct, ${assetsLeaves} leaf columns`,
          medianCompressedBytesPerGroup: median(assetsBytes),
          compressedBytesPerRow: Math.round(median(assetsBytes) / median(rows)),
          totalCompressedBytes: assetsBytes.reduce((a, b) => a + b, 0),
        }
      : null,
    offsetIndex: `${withOffsetIndex} of ${allChunks.length} column chunks`,
  };
}

async function searchOnce(ds, area) {
  const filter = {
    spec: 'cng-filter/1.0',
    area: { ref: 'area' },
    spatial: { mode: 'intersects' },
    ...(ds.time ? { time: ds.time } : {}),
    columns: { include: ds.columns },
    limit: 200,
  };
  const out = {};
  let t = now();
  const dataset = ds.descriptor.source.kind === 'portolan-collection' ? await resolveDataset(ds.descriptor) : ds.descriptor;
  out.resolveMs = now() - t;

  t = now();
  const est1 = await estimate(dataset, area, filter);
  out.estimate1Ms = now() - t;
  t = now();
  await estimate(dataset, area, filter);
  out.estimate2Ms = now() - t;

  const engine = createHyparquetEngine();
  t = now();
  const plan = await engine.plan(dataset, area, filter, {});
  out.planMs = now() - t;
  t = now();
  let rows = 0;
  await engine.run(plan, async (batch) => { rows += batch.rows; }, {});
  out.runMs = now() - t;

  out.facts = {
    files: est1.files,
    rowGroups: est1.rowGroups,
    requests: est1.requests,
    readBytes: est1.readBytes?.estimate,
    rowsReturned: rows,
    bboxBasis: est1.prune.find((p) => p.stage === 'row-group-bbox')?.basis,
    warnings: est1.warnings.map((w) => w.code),
  };
  return out;
}

const report = [];
for (const ds of DATASETS) {
  console.error(`\n== ${ds.name} ==`);
  const entry = { name: ds.name };
  try {
    entry.footer = await footerFacts(ds.footerOf);
    console.error('footer:', JSON.stringify(entry.footer));
    const { area } = await areaFromGeoJson(box(ds.bbox), { name: ds.name });
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const s = await searchOnce(ds, area);
      samples.push(s);
      console.error(`run ${i + 1}: resolve ${Math.round(s.resolveMs)} estimate ${Math.round(s.estimate1Ms)}/${Math.round(s.estimate2Ms)} plan ${Math.round(s.planMs)} run ${Math.round(s.runMs)} ms`);
    }
    const med = (k) => Math.round(median(samples.map((s) => s[k])));
    entry.medianMs = { resolve: med('resolveMs'), estimateFirst: med('estimate1Ms'), estimateSecond: med('estimate2Ms'), plan: med('planMs'), run: med('runMs') };
    entry.facts = samples[0].facts;
    entry.filter = { bbox: ds.bbox, time: ds.time, columns: ds.columns };
  } catch (err) {
    entry.error = `${err?.code ?? err?.name}: ${err?.message}`;
    console.error('ERROR', entry.error);
  }
  report.push(entry);
}

console.log(JSON.stringify({ date: new Date().toISOString(), runs, node: process.version, report }, null, 2));
