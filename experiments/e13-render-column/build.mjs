#!/usr/bin/env node
// E13 -- build a catalog index that says how each collection is drawn.
//
// Reads the live Portolan registry index (the ONE place this project reads
// its `original` column: every collection's whole JSON), runs
// `layersFromCollection` over each, and writes
//
//   out/collections.render.parquet   the index's own columns, minus `original`
//                                    and `links`, plus `render`, `thumbnail`
//                                    and `attribution`
//   out/coverage.json                what was found, counted
//
// Nothing is uploaded and `out/` is not committed. measure.mjs reads both.
//
// Usage: node experiments/e13-render-column/build.mjs [--refresh] [index-url]

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { layersFromCollection, renderFromLayers, RENDER_FIELDS } from '../../packages/stac/src/index.js';

const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const INDEX_URL = args.find((a) => /^https?:/.test(a)) ?? 'https://registry.portolan-sdi.org/v0.1/collections.parquet';
const OUT = new URL('./out/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const LIVE = new URL('collections.parquet', OUT);

// --- 1. the live index, whole ------------------------------------------------------------
if (refresh || !existsSync(LIVE)) {
  const t0 = performance.now();
  // `Accept-Encoding: identity`: GitHub Pages would otherwise send a gzip
  // encoding, which is fine for a whole download but makes the byte count misleading.
  const res = await fetch(INDEX_URL, { headers: { 'Accept-Encoding': 'identity' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${INDEX_URL}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(LIVE, bytes);
  writeFileSync(new URL('collections.source.json', OUT), JSON.stringify({ url: INDEX_URL, bytes: bytes.byteLength, lastModified: res.headers.get('last-modified'), fetched: new Date().toISOString() }, null, 2));
  console.log(`downloaded ${INDEX_URL}: ${bytes.byteLength.toLocaleString()} bytes in ${Math.round(performance.now() - t0)} ms`);
}
const live = readFileSync(LIVE);
const buffer = live.buffer.slice(live.byteOffset, live.byteOffset + live.byteLength);
const metadata = hyparquet.parquetMetadata(buffer, { geoparquet: false });
const KEEP = ['type', 'id', 'href', 'parents', 'geometry', 'bbox', 'start_datetime', 'end_datetime', 'description', 'license', 'title', 'keywords', 'portolan_registry:id'];
const rows = await hyparquet.parquetReadObjects({ file: buffer, metadata, columns: [...KEEP, 'original'], compressors, utf8: false });
console.log(`read ${rows.length.toLocaleString()} rows`);

// --- 2. what each collection draws as ------------------------------------------------------
const coverage = { rows: rows.length, catalogs: 0, collections: 0, failed: [], byFirstKind: {}, byKindSet: {}, layers: 0, withThumbnail: 0, withStyle: 0, unsupportedReasons: {} };
const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
const DRAW_ORDER = ['pmtiles-vector', 'cog', 'scenes', 'table', 'unsupported'];
const t1 = performance.now();
for (const row of rows) {
  row.render = null;
  row.thumbnail = null;
  row.attribution = null;
  if (row.type !== 'Collection') {
    coverage.catalogs += 1;
    delete row.original;
    continue;
  }
  coverage.collections += 1;
  try {
    const original = typeof row.original === 'string' ? JSON.parse(row.original) : row.original;
    const layers = layersFromCollection(original, { baseUrl: row.href });
    row.render = renderFromLayers(layers, { title: row.title ?? row.id });
    row.thumbnail = layers.find((l) => l.thumbnail)?.thumbnail ?? null;
    row.attribution = (layers[0]?.attribution ?? []).map((a) => ({ text: a.text ?? null, license: a.license ?? null, url: a.url ?? null, share_alike: Boolean(a.shareAlike ?? a.share_alike) }));
    coverage.layers += layers.length;
    if (row.thumbnail) coverage.withThumbnail += 1;
    if (row.render.some((r) => r.style)) coverage.withStyle += 1;
    const kinds = [...new Set(layers.map((l) => l.kind))].sort((a, b) => DRAW_ORDER.indexOf(a) - DRAW_ORDER.indexOf(b));
    bump(coverage.byFirstKind, kinds[0] ?? 'none');
    bump(coverage.byKindSet, kinds.join(' + ') || 'none');
    for (const l of layers) if (l.kind === 'unsupported') bump(coverage.unsupportedReasons, String(l.source?.reason ?? '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 90));
  } catch (err) {
    coverage.failed.push({ href: row.href, why: `${err.code ?? err.name}: ${String(err.message).slice(0, 120)}` });
    bump(coverage.byFirstKind, 'failed');
  }
  delete row.original;
}
coverage.derivationMs = Math.round(performance.now() - t1);
console.log(`derived render for ${coverage.collections.toLocaleString()} collections in ${coverage.derivationMs} ms (${coverage.failed.length} failed)`);

// --- 3. write the enriched index --------------------------------------------------------------
const str = (name) => ({ name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' });
const dbl = (name) => ({ name, type: 'DOUBLE', repetition_type: 'OPTIONAL' });
const ts = (name) => ({ name, type: 'INT64', repetition_type: 'OPTIONAL', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' } });
const group = (name, children) => [{ name, repetition_type: 'OPTIONAL', num_children: children.length }, ...children.flat()];
const list = (name, element) => [{ name, repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 }, { name: 'list', repetition_type: 'REPEATED', num_children: 1 }, ...[element].flat()];
const renderField = (name) => (name === 'layers' ? list('layers', str('element')) : str(name));
const columns = [
  str('type'), str('id'), str('href'),
  list('parents', group('element', [str('id'), str('href')])),
  { name: 'geometry', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' },
  group('bbox', [dbl('xmin'), dbl('ymin'), dbl('xmax'), dbl('ymax')]),
  ts('start_datetime'), ts('end_datetime'),
  str('description'), str('license'), str('title'),
  list('keywords', str('element')),
  str('portolan_registry:id'),
  list('render', group('element', RENDER_FIELDS.map(renderField))),
  str('thumbnail'),
  list('attribution', group('element', [str('text'), str('license'), str('url'), { name: 'share_alike', type: 'BOOLEAN', repetition_type: 'OPTIONAL' }])),
];
const nameOf = (c) => (Array.isArray(c) ? c[0].name : c.name);
const out = new Uint8Array(parquetWriteBuffer({
  columnData: columns.map((c) => ({ name: nameOf(c), data: rows.map((r) => r[nameOf(c)] ?? null) })),
  schema: [{ name: 'schema', num_children: columns.length }, ...columns.flat()],
  rowGroupSize: rows.length, // one row group, as the specification asks
  kvMetadata: [{ key: 'cng:experiment', value: 'e13-render-column' }, { key: 'cng:source', value: INDEX_URL }],
}));
writeFileSync(new URL('collections.render.parquet', OUT), out);
coverage.enrichedBytes = out.byteLength;
coverage.liveBytes = live.byteLength;
writeFileSync(new URL('coverage.json', OUT), JSON.stringify(coverage, null, 2));
console.log(`wrote out/collections.render.parquet: ${out.byteLength.toLocaleString()} bytes (the live index is ${live.byteLength.toLocaleString()})`);
console.log('by first kind:', JSON.stringify(coverage.byFirstKind));
