#!/usr/bin/env node
// Gazetteer conformance checker (github.com/cholmes/cng-map-widgets, issue #1).
//
// A JSON Schema can check that a STAC Collection declares the right
// `gazetteer:*` fields. It cannot check the thing that actually makes the
// format work: that `name_norm` ascends byte-wise on its UTF-8 encoding, and
// that it was produced by the declared normalization. This tool checks that,
// against the real parquet data of a live catalog -- not just its metadata.
//
// Usage: node tools/gazetteer-conformance.mjs <url> [options]
// See tools/README.md.
//
// Accepts two document shapes (the catalogs are mid-migration, issue #1):
//  - a legacy manifest: top-level `spec` === 'cnmw-index/1.0' | 'cng-index/1.0'
//  - a STAC Collection: `type` === 'Collection' with an asset whose `roles`
//    include 'gazetteer-index'
//
// Technical notes this file depends on (see AGENTS.md "Pitfalls" #1 and #5):
//  - hyparquet needs `geoparquet: false` on the metadata call and `utf8: false`
//    on every read call to return raw strings/bytes instead of mangling them.
//  - `parquetMetadataAsync(file, opts)` -- the second argument is ALWAYS an
//    options object; a bare number is silently ignored.
//  - parquet INT64 (row counts) decodes as BigInt; coerce with Number().

import { normalizeName } from '@cng/spec';

let hyparquet;
let compressors;
try {
  hyparquet = await import('hyparquet');
  ({ compressors } = await import('hyparquet-compressors'));
} catch (cause) {
  console.error('This tool needs hyparquet and hyparquet-compressors to read parquet files.');
  console.error('They are not in package.json, but are resolvable transitively in this repo today.');
  console.error('If this now fails, install them explicitly:\n\n  npm i -D hyparquet hyparquet-compressors\n');
  console.error(`(import failed: ${cause.message})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI

function usage() {
  console.error('Usage: node tools/gazetteer-conformance.mjs <url> [options]');
  console.error();
  console.error('  <url>              A STAC Collection or legacy index.json manifest URL.');
  console.error();
  console.error('Options:');
  console.error('  --max-groups=<n>   Max row groups to sample for the sort/normalization');
  console.error('                     checks (default 300). Groups beyond this are evenly');
  console.error('                     subsampled across the file, not skipped from one end.');
  console.error('  --edge-rows=<n>    Rows read from the start and end of each sampled row');
  console.error('                     group (default 5).');
  console.error('  --concurrency=<n>  Parallel range requests (default 12).');
}

function parseArgs(argv) {
  const positional = [];
  const options = { maxGroups: 300, edgeRows: 5, concurrency: 12 };
  for (const arg of argv) {
    const m = /^--(max-groups|edge-rows|concurrency)=(\d+)$/.exec(arg);
    if (m) {
      const key = { 'max-groups': 'maxGroups', 'edge-rows': 'edgeRows', concurrency: 'concurrency' }[m[1]];
      options[key] = Number(m[2]);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }
  return { url: positional[0], options };
}

const { url, options } = parseArgs(process.argv.slice(2));
if (!url) {
  usage();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Reporting

const results = [];
function report(status, message) {
  results.push({ status, message });
  console.log(`[${status}] ${message}`);
}

// ---------------------------------------------------------------------------
// Byte-wise UTF-8 comparison -- NOT JS default string comparison, NOT
// localeCompare. The sort guarantee is defined on the UTF-8 bytes.
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function toNumber(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Evenly spaced sample of `cap` indices out of `[0, total)`, always
 * including the first and last. Returns every index when total <= cap. */
function pickSampleIndices(total, cap) {
  if (total <= cap) return Array.from({ length: total }, (_, i) => i);
  if (cap <= 1) return [0];
  const picked = new Set();
  for (let i = 0; i < cap; i++) {
    picked.add(Math.round((i * (total - 1)) / (cap - 1)));
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * Walk a flat parquet `schema` array (thrift `SchemaElement[]`, `schema[0]`
 * the synthetic root) and return only its direct children, each flagged as
 * a struct (`num_children > 0`) or a leaf. A struct's children are flattened
 * inline immediately after it in the wire format, so a naive `.map(name)`
 * would list a struct's leaves as if they were top-level columns too.
 */
function topLevelSchemaColumns(schema) {
  function subtreeSize(index) {
    const numChildren = schema[index].num_children ?? 0;
    let size = 1;
    let seen = 0;
    while (seen < numChildren) {
      size += subtreeSize(index + size);
      seen += 1;
    }
    return size;
  }
  const out = [];
  let i = 1; // schema[0] is the synthetic root
  while (i < schema.length) {
    const el = schema[i];
    out.push({ name: el.name, isStruct: (el.num_children ?? 0) > 0 });
    i += subtreeSize(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Fetch the document and detect its shape.

let doc;
try {
  const res = await fetch(url);
  if (!res.ok) {
    report('FAIL', `Could not fetch ${url}: HTTP ${res.status}`);
    process.exit(1);
  }
  doc = await res.json();
} catch (cause) {
  report('FAIL', `Could not fetch or parse ${url} as JSON: ${cause.message}`);
  process.exit(1);
}

const LEGACY_SPECS = new Set(['cnmw-index/1.0', 'cng-index/1.0']);
const shape = LEGACY_SPECS.has(doc.spec) ? 'legacy' : doc.type === 'Collection' && doc.assets ? 'stac' : 'unknown';

/** @type {{ parquetUrl: string, featureIdColumn: string, declaredRowGroups: number|undefined, declaredRowCount: number|undefined, sourceIsDefaultable: boolean }} */
let resolved;

if (shape === 'legacy') {
  const idx = doc.index;
  if (!idx || typeof idx.url !== 'string') {
    report('FAIL', `Structure: legacy manifest (spec "${doc.spec}") has no "index.url".`);
    process.exit(1);
  }
  report('PASS', `Structure: legacy manifest (spec "${doc.spec}"), index.url = "${idx.url}".`);
  resolved = {
    parquetUrl: new URL(idx.url, url).toString(),
    featureIdColumn: idx.feature_id_column ?? 'feature_id',
    declaredRowGroups: idx.row_groups,
    declaredRowCount: doc.rows,
    sourceIsDefaultable: typeof doc.source === 'string',
  };
} else if (shape === 'stac') {
  const entries = Object.entries(doc.assets ?? {}).filter(([, asset]) => Array.isArray(asset.roles) && asset.roles.includes('gazetteer-index'));
  const primary = entries.find(([, asset]) => !asset.roles.includes('prominent')) ?? entries[0];
  if (!primary) {
    report('FAIL', 'Structure: STAC Collection has no asset with roles containing "gazetteer-index".');
    process.exit(1);
  }
  const [assetKey, asset] = primary;
  if (!asset.href) {
    report('FAIL', `Structure: asset "${assetKey}" (roles: ${JSON.stringify(asset.roles)}) has no "href".`);
    process.exit(1);
  }
  report('PASS', `Structure: STAC Collection, gazetteer-index asset "${assetKey}", href = "${asset.href}".`);
  resolved = {
    parquetUrl: new URL(asset.href, url).toString(),
    featureIdColumn: asset['gazetteer:feature_id_column'] ?? 'feature_id',
    declaredRowGroups: asset['gazetteer:row_groups'],
    declaredRowCount: asset['table:row_count'],
    sourceIsDefaultable: false, // no manifest-level default-source concept in the STAC shape
  };
} else {
  report(
    'FAIL',
    'Structure: document is neither a recognized legacy manifest (top-level "spec" of ' +
      '"cnmw-index/1.0" or "cng-index/1.0") nor a STAC Collection ("type": "Collection" with "assets"). ' +
      `Got spec=${JSON.stringify(doc.spec)}, type=${JSON.stringify(doc.type)}.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2 & 3 & 6. Open the parquet file, read its footer, check columns and
// declared counts.

let file;
let metadata;
try {
  file = await hyparquet.asyncBufferFromUrl({ url: resolved.parquetUrl, requestInit: { cache: 'no-store' } });
  metadata = await hyparquet.parquetMetadataAsync(file, { initialFetchSize: 65_536, geoparquet: false });
} catch (cause) {
  report('FAIL', `Could not read parquet footer at ${resolved.parquetUrl}: ${cause.message}`);
  process.exit(1);
}

const topLevel = topLevelSchemaColumns(metadata.schema);
const topLevelNames = new Set(topLevel.map((c) => c.name));

// --- Check 2: required columns ---
const REQUIRED = ['name', 'name_norm', 'level', 'bbox', resolved.featureIdColumn];
const missingRequired = [];
for (const col of REQUIRED) {
  if (col === 'bbox') continue; // handled specially below (struct or flat)
  if (!topLevelNames.has(col)) missingRequired.push(col);
}
const bboxStruct = topLevel.find((c) => c.name === 'bbox' && c.isStruct);
const flatBboxCols = ['xmin', 'ymin', 'xmax', 'ymax'];
const hasFlatBbox = flatBboxCols.every((c) => topLevelNames.has(c));
if (bboxStruct) {
  report('PASS', 'Required columns: "bbox" found as a STRUCT column (xmin/ymin/xmax/ymax children).' + (hasFlatBbox ? ' (Flat xmin/ymin/xmax/ymax top-level columns also present, redundantly.)' : ''));
} else if (hasFlatBbox) {
  report('PASS', 'Required columns: "bbox" found as four flat top-level columns (xmin, ymin, xmax, ymax).');
} else {
  missingRequired.push('bbox (neither a struct column nor flat xmin/ymin/xmax/ymax columns)');
}
if (missingRequired.length === 0) {
  report('PASS', `Required columns present: name, name_norm, level, bbox, ${resolved.featureIdColumn} (feature-id column).`);
} else {
  report('FAIL', `Required columns missing: ${missingRequired.join(', ')}.`);
}

// --- Check 3: recommended columns ---
const RECOMMENDED = ['country', 'country_name', 'parent_name', 'area_km2', 'source'];
const missingRecommended = RECOMMENDED.filter((c) => !topLevelNames.has(c));
for (const col of missingRecommended) {
  if (col === 'source' && resolved.sourceIsDefaultable) {
    report('WARN', `Recommended column "source" is absent from the parquet, but the manifest's top-level "source" field defaults it for every row (allowed per the manifest contract).`);
  } else {
    report('WARN', `Recommended column "${col}" is absent.`);
  }
}
if (missingRecommended.length === 0) report('PASS', `All recommended columns present: ${RECOMMENDED.join(', ')}.`);

// --- Check 6: declared counts vs the footer ---
const actualRowGroups = metadata.row_groups.length;
if (resolved.declaredRowGroups === undefined) {
  report('WARN', `Row-group count not declared; footer reports ${actualRowGroups} row groups.`);
} else if (Number(resolved.declaredRowGroups) === actualRowGroups) {
  report('PASS', `Declared row-group count (${resolved.declaredRowGroups}) matches the footer (${actualRowGroups}).`);
} else {
  report('FAIL', `Declared row-group count (${resolved.declaredRowGroups}) does NOT match the footer (${actualRowGroups}).`);
}

const actualRowCount = metadata.row_groups.reduce((sum, rg) => sum + Number(rg.num_rows), 0);
if (resolved.declaredRowCount === undefined) {
  report('WARN', `Row count not declared; footer reports ${actualRowCount} rows.`);
} else if (Number(resolved.declaredRowCount) === actualRowCount) {
  report('PASS', `Declared row count (${resolved.declaredRowCount}) matches the footer (${actualRowCount}).`);
} else {
  report('FAIL', `Declared row count (${resolved.declaredRowCount}) does NOT match the footer (${actualRowCount}).`);
}

// ---------------------------------------------------------------------------
// 4 & 5. Read actual rows: the sort guarantee, and the normalization
// round-trip. Both reuse the same sampled reads -- sampling intelligently
// (not reading all N million rows) is the whole point on a 409 MB / 9.4M-row
// index.

const rowGroupBounds = (() => {
  const bounds = [];
  let start = 0;
  for (const rg of metadata.row_groups) {
    const n = Number(rg.num_rows);
    bounds.push({ start, end: start + n, numRows: n });
    start += n;
  }
  return bounds;
})();

const sampledGroupIdx = pickSampleIndices(rowGroupBounds.length, options.maxGroups);

/** @type {{ idx: number, pos: 'first'|'last'|'whole', rowStart: number, rowEnd: number }[]} */
const reads = [];
for (const idx of sampledGroupIdx) {
  const b = rowGroupBounds[idx];
  if (b.numRows <= options.edgeRows * 2) {
    reads.push({ idx, pos: 'whole', rowStart: b.start, rowEnd: b.end });
  } else {
    reads.push({ idx, pos: 'first', rowStart: b.start, rowEnd: b.start + options.edgeRows });
    reads.push({ idx, pos: 'last', rowStart: b.end - options.edgeRows, rowEnd: b.end });
  }
}

const perGroup = new Map(); // idx -> { first: [{row, absIndex}], last: [...] }
let cursor = 0;
let readErrors = 0;
async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= reads.length) return;
    const r = reads[i];
    let rows;
    try {
      rows = await hyparquet.parquetReadObjects({
        file,
        metadata,
        columns: ['name', 'name_norm'],
        rowStart: r.rowStart,
        rowEnd: r.rowEnd,
        utf8: false,
        compressors,
      });
    } catch (cause) {
      readErrors += 1;
      console.error(`  (row read failed for group ${r.idx} [${r.rowStart}, ${r.rowEnd}): ${cause.message})`);
      continue;
    }
    const withIdx = rows.map((row, j) => ({ row, absIndex: r.rowStart + j }));
    let entry = perGroup.get(r.idx);
    if (!entry) {
      entry = {};
      perGroup.set(r.idx, entry);
    }
    if (r.pos === 'whole') {
      entry.first = withIdx;
      entry.last = withIdx;
    } else {
      entry[r.pos] = withIdx;
    }
  }
}
const workerCount = Math.max(1, Math.min(options.concurrency, reads.length));
await Promise.all(Array.from({ length: workerCount }, worker));

// --- Check 4: THE SORT GUARANTEE ---
// Decode name_norm bytes to UTF-8, decoded as BYTE_ARRAY (no utf8:false
// mangling since utf8:false was passed), so Node's native UTF-8 decode of
// those bytes equals byte order for comparison purposes via Buffer.compare
// below -- we re-encode the decoded string back to UTF-8 bytes for the
// comparison itself, so the comparison is genuinely byte-wise, not a
// default JS string compare.
let totalRowsChecked = 0;
let firstViolation = null;
let prevValue = null;
let prevAbsIndex = null;

for (const idx of sampledGroupIdx) {
  const entry = perGroup.get(idx);
  if (!entry) continue; // read failed; already logged
  const blocks = entry.first === entry.last ? [entry.first] : [entry.first, entry.last];
  for (const block of blocks) {
    for (const { row, absIndex } of block) {
      const value = row.name_norm;
      if (typeof value !== 'string') continue;
      totalRowsChecked += 1;
      if (prevValue !== null && !firstViolation && byteCompare(prevValue, value) > 0) {
        firstViolation = { prevAbsIndex, prevValue, absIndex, value };
      }
      prevValue = value;
      prevAbsIndex = absIndex;
    }
  }
}

if (firstViolation) {
  report(
    'FAIL',
    `Sort guarantee: name_norm does NOT ascend byte-wise. First violation between sampled row ${firstViolation.prevAbsIndex} ` +
      `(${JSON.stringify(firstViolation.prevValue)}) and sampled row ${firstViolation.absIndex} (${JSON.stringify(firstViolation.value)}).`
  );
} else {
  report(
    'PASS',
    `Sort guarantee: name_norm ascends byte-wise (Buffer.compare on UTF-8 bytes) across ${totalRowsChecked} sampled rows ` +
      `from ${sampledGroupIdx.length} of ${rowGroupBounds.length} row groups ` +
      `(${sampledGroupIdx.length < rowGroupBounds.length ? 'a sample: first/last ' + options.edgeRows + ' rows of each sampled group, evenly spaced across the file, plus the boundary between each consecutive sampled group' : 'every row group boundary, first/last ' + options.edgeRows + ' rows each'}).`
  );
}

// --- Check 5: normalization round-trip ---
const mismatches = [];
let normalizedChecked = 0;
for (const idx of sampledGroupIdx) {
  const entry = perGroup.get(idx);
  if (!entry) continue;
  const seen = new Set();
  const blocks = entry.first === entry.last ? [entry.first] : [entry.first, entry.last];
  for (const block of blocks) {
    for (const { row, absIndex } of block) {
      if (seen.has(absIndex)) continue; // dedupe the 'whole' case
      seen.add(absIndex);
      if (typeof row.name !== 'string' || typeof row.name_norm !== 'string') continue;
      normalizedChecked += 1;
      const computed = normalizeName(row.name);
      if (computed !== row.name_norm) {
        mismatches.push({ absIndex, name: row.name, stored: row.name_norm, computed });
      }
    }
  }
}

if (mismatches.length > 0) {
  report('FAIL', `Normalization round-trip: ${mismatches.length} of ${normalizedChecked} sampled rows have normalizeName(name) !== stored name_norm.`);
  for (const m of mismatches.slice(0, 10)) {
    console.log(`       row ${m.absIndex}: name=${JSON.stringify(m.name)} stored=${JSON.stringify(m.stored)} computed=${JSON.stringify(m.computed)}`);
  }
  if (mismatches.length > 10) console.log(`       ... and ${mismatches.length - 10} more.`);
} else {
  report('PASS', `Normalization round-trip: normalizeName(name) === stored name_norm for all ${normalizedChecked} sampled rows.`);
}

if (readErrors > 0) {
  report('WARN', `${readErrors} row-group range read(s) failed and were skipped; the sample above is smaller than requested.`);
}

// ---------------------------------------------------------------------------
// Summary

const failCount = results.filter((r) => r.status === 'FAIL').length;
const warnCount = results.filter((r) => r.status === 'WARN').length;
const passCount = results.filter((r) => r.status === 'PASS').length;
console.log();
console.log(`Summary: ${passCount} passed, ${warnCount} warned, ${failCount} failed.`);
process.exit(failCount > 0 ? 1 : 0);
