#!/usr/bin/env node
// E13 -- measure what a `render` column buys. Run build.mjs first.
//
//   1. bytes     what the three columns add to the index, and to what a search loads
//   2. coverage  what the registry's collections draw as
//   3. agreement does `render` say what the collection's own JSON says, fetched live now?
//   4. time      from "result chosen" to "LayerSpec in hand", with the column and without
//
// Every number printed is measured here; how is said beside it.
//
// Usage: node experiments/e13-render-column/measure.mjs [--sample 60] [--seed 13]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import MiniSearch from 'minisearch';
import { setHyparquetModules } from '../../packages/extract-core/src/index.js';
import { CatalogIndex, layersFromCollection, layersFromRender, setMinisearchModules } from '../../packages/stac/src/index.js';

setHyparquetModules({ hyparquet, compressors });
setMinisearchModules({ MiniSearch });

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const SAMPLE = arg('sample', 60);
const SEED = arg('seed', 13);
const OUT = new URL('./out/', import.meta.url);
for (const name of ['collections.parquet', 'collections.render.parquet', 'coverage.json']) {
  if (!existsSync(new URL(name, OUT))) throw new Error(`out/${name} is missing: run build.mjs first`);
}
const results = { measured: new Date().toISOString(), sample: SAMPLE, seed: SEED };
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
const kb = (n) => `${(n / 1e3).toFixed(0)} KB`;
const pct = (a, b) => `${((100 * a) / b).toFixed(1)}%`;

// --- 1. bytes -------------------------------------------------------------------------------
function columnSizes(path) {
  const file = readFileSync(new URL(path, OUT));
  const metadata = hyparquet.parquetMetadata(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), { geoparquet: false });
  const sizes = {};
  for (const rg of metadata.row_groups) for (const col of rg.columns) {
    const top = col.meta_data.path_in_schema[0];
    sizes[top] ??= { compressed: 0, uncompressed: 0 };
    sizes[top].compressed += Number(col.meta_data.total_compressed_size);
    sizes[top].uncompressed += Number(col.meta_data.total_uncompressed_size);
  }
  return { bytes: file.byteLength, sizes, codec: metadata.row_groups[0].columns[0].meta_data.codec };
}
const live = columnSizes('collections.parquet');
const built = columnSizes('collections.render.parquet');
const LIGHT = ['type', 'id', 'href', 'title', 'description', 'license', 'keywords', 'parents', 'bbox', 'start_datetime', 'end_datetime', 'portolan_registry:id'];
const NEW = ['render', 'thumbnail', 'attribution'];
const sum = (file, names, field) => names.reduce((n, c) => n + (file.sizes[c]?.[field] ?? 0), 0);
console.log('\n== 1. bytes ==');
console.log(`live index: ${mb(live.bytes)} (${live.codec}); original ${mb(live.sizes.original.compressed)}, links ${mb(live.sizes.links.compressed)}, what a search loads ${mb(sum(live, LIGHT, 'compressed'))}`);
console.log(`built index: ${mb(built.bytes)} (${built.codec}); the same search columns ${mb(sum(built, LIGHT, 'compressed'))}`);
for (const c of NEW) console.log(`  ${c.padEnd(12)} ${kb(built.sizes[c].compressed).padStart(8)} compressed (${built.codec}), ${kb(built.sizes[c].uncompressed).padStart(8)} uncompressed`);

// --- load both through CatalogIndex, from disk, counting what is read ---------------------------
function fileFetch(path) {
  const bytes = readFileSync(new URL(path, OUT));
  const stats = { requests: 0, bytes: 0 };
  const fetchImpl = async (url, init = {}) => {
    const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init.headers ?? {}).get('Range') ?? '');
    if (!range) return new Response(null, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
    const start = Number(range[1]);
    const end = range[2] === '' ? bytes.byteLength : Number(range[2]) + 1;
    stats.requests += 1;
    if (!(start === 0 && end === 1)) stats.bytes += end - start;
    return new Response(bytes.subarray(start, end), { status: 206, headers: { 'content-range': `bytes ${start}-${end - 1}/${bytes.byteLength}`, 'content-length': String(end - start) } });
  };
  return { fetch: fetchImpl, stats };
}
async function load(path) {
  const { fetch: f, stats } = fileFetch(path);
  const index = new CatalogIndex(`https://local.invalid/${path}`, { fetch: f });
  const t0 = performance.now();
  await index.load();
  return { index, stats, ms: performance.now() - t0 };
}
const plain = await load('collections.parquet');
const rich = await load('collections.render.parquet');
console.log(`index.load(), live index:  ${plain.stats.requests} requests, ${mb(plain.stats.bytes)} read, ${plain.index.entries.length.toLocaleString()} collections, hasRender ${plain.index.hasRender}`);
console.log(`index.load(), built index: ${rich.stats.requests} requests, ${mb(rich.stats.bytes)} read, ${rich.index.entries.length.toLocaleString()} collections, hasRender ${rich.index.hasRender}`);
// A like-for-like estimate of the three columns under the live file's codec: the
// column's VALUES as JSON lines, zstd level 3. Not a parquet page, so a bound, not a size.
const zstd = (values) => zstdCompressSync(Buffer.from(values.map((v) => JSON.stringify(v ?? null)).join('\n'))).byteLength;
const zstdEstimate = { render: zstd(rich.index.entries.map((e) => e.render)), thumbnail: zstd(rich.index.entries.map((e) => e.thumbnail)), attribution: zstd(rich.index.entries.map((e) => e.attribution)) };
console.log(`  estimate under zstd (values as JSON lines, level 3): render ${kb(zstdEstimate.render)}, thumbnail ${kb(zstdEstimate.thumbnail)}, attribution ${kb(zstdEstimate.attribution)}`);
results.bytes = { live, built, liveLoad: plain.stats, builtLoad: rich.stats, zstdEstimate, searchColumnsLive: sum(live, LIGHT, 'compressed'), searchColumnsBuilt: sum(built, LIGHT, 'compressed') };

// --- 2. coverage ------------------------------------------------------------------------------
const coverage = JSON.parse(readFileSync(new URL('coverage.json', OUT), 'utf8'));
console.log('\n== 2. coverage ==');
console.log(`${coverage.collections.toLocaleString()} collection rows, ${coverage.catalogs.toLocaleString()} catalog rows; ${coverage.failed.length} could not be derived; ${coverage.layers.toLocaleString()} layers in all`);
const drawable = (coverage.byFirstKind['pmtiles-vector'] ?? 0) + (coverage.byFirstKind.cog ?? 0);
for (const [kind, n] of Object.entries(coverage.byFirstKind).sort((a, b) => b[1] - a[1])) console.log(`  ${kind.padEnd(16)} ${String(n).padStart(6)}  ${pct(n, coverage.collections)}`);
console.log(`  drawable as one layer today (pmtiles-vector or cog): ${drawable.toLocaleString()} = ${pct(drawable, coverage.collections)}`);
console.log(`  with a style: ${coverage.withStyle.toLocaleString()}; with a thumbnail: ${coverage.withThumbnail.toLocaleString()}`);
console.log('  kind combinations:', JSON.stringify(coverage.byKindSet));
console.log('  why unsupported:', JSON.stringify(Object.entries(coverage.unsupportedReasons).sort((a, b) => b[1] - a[1]).slice(0, 6)));
results.coverage = coverage;

// --- 3 and 4. agreement, and time, over a seeded sample -----------------------------------------
let seed = SEED;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pool = [...rich.index.entries];
const sample = [];
while (sample.length < Math.min(SAMPLE, pool.length)) sample.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);

// What has to match for the two to draw the same thing. For an `unsupported`
// layer that is its reason: the list of asset types found is deliberately not
// stored in `render` (the first run of this script counted that as a difference).
const essence = (layers) => layers.map((l) => ({ kind: l.kind, id: l.id, title: l.title, source: l.kind === 'unsupported' ? { reason: l.source?.reason } : l.source }));
const agreement = { same: 0, different: [], unreachable: [] };
const fetchMs = [];
const renderUs = [];
console.log(`\n== 3. agreement, ${sample.length} collections (seed ${SEED}) ==`);
for (const entry of sample) {
  const r0 = performance.now();
  const fromRender = layersFromRender(entry);
  renderUs.push((performance.now() - r0) * 1000);
  const t0 = performance.now();
  try {
    const res = await fetch(entry.href, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fromLive = layersFromCollection(await res.json(), { baseUrl: entry.href });
    fetchMs.push(performance.now() - t0);
    if (JSON.stringify(essence(fromRender)) === JSON.stringify(essence(fromLive))) agreement.same += 1;
    else agreement.different.push({ href: entry.href, render: essence(fromRender).map((l) => l.kind), live: essence(fromLive).map((l) => l.kind) });
  } catch (err) {
    agreement.unreachable.push({ href: entry.href, why: String(err.message).slice(0, 100) });
  }
}
console.log(`same layers: ${agreement.same}; different: ${agreement.different.length}; collection JSON unreachable: ${agreement.unreachable.length}`);
for (const d of agreement.different.slice(0, 8)) console.log(`  differs: ${d.href}  render ${JSON.stringify(d.render)} vs live ${JSON.stringify(d.live)}`);
for (const u of agreement.unreachable.slice(0, 8)) console.log(`  unreachable: ${u.href}  ${u.why}`);
results.agreement = agreement;

const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))];
console.log('\n== 4. time from "result chosen" to "LayerSpec in hand" ==');
console.log(`with render (layersFromRender, in memory): median ${quantile(renderUs, 0.5).toFixed(0)} µs, p90 ${quantile(renderUs, 0.9).toFixed(0)} µs, 0 requests`);
if (fetchMs.length) console.log(`without (fetch the collection JSON, then layersFromCollection): median ${quantile(fetchMs, 0.5).toFixed(0)} ms, p90 ${quantile(fetchMs, 0.9).toFixed(0)} ms, max ${Math.max(...fetchMs).toFixed(0)} ms, 1 request each (n=${fetchMs.length}, Node, this connection, sequential)`);
results.time = { renderUs: { median: quantile(renderUs, 0.5), p90: quantile(renderUs, 0.9) }, fetchMs: fetchMs.length ? { median: quantile(fetchMs, 0.5), p90: quantile(fetchMs, 0.9), max: Math.max(...fetchMs), n: fetchMs.length } : null };

// --- a search by kind, which only the built index can answer -------------------------------------
const byKind = await rich.index.search({ text: 'buildings', kinds: ['pmtiles-vector', 'cog'] });
const anyKind = await rich.index.search({ text: 'buildings' });
console.log(`\n"buildings": ${anyKind.total} collections; ${byKind.total} of them drawable. Kinds facet: ${JSON.stringify(anyKind.facets.kinds)}`);
results.kindSearch = { all: anyKind.total, drawable: byKind.total, facet: anyKind.facets.kinds };

writeFileSync(new URL('measure.json', OUT), JSON.stringify(results, null, 2));
console.log('\nwrote out/measure.json');
