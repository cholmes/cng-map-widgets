#!/usr/bin/env node
// Writes data/index.json -- the manifest beside the index (design doc
// §6.4). Plain Node (no deps): stats the parquet files build-data.sql
// just produced, counts rows/row-groups via duckdb, and computes a
// sha-256 checksum of the index parquet.
//
// Usage: node build-manifest.mjs   (run after `duckdb -c ".read build-data.sql"`)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');

function duckdbJson(sql) {
  const out = execFileSync('duckdb', ['-json', '-c', sql], { encoding: 'utf8' });
  return JSON.parse(out);
}

function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return `1220${hash.digest('hex')}`; // multihash-ish prefix, matching the design doc example's style
}

function fileInfo(relPath) {
  const abs = path.join(dataDir, relPath);
  return { size: statSync(abs).size };
}

const CATALOG_VERSION = 'geoboundaries-cgaz-provisional-2026-11-12';

const indexRowGroups = duckdbJson(
  `SELECT count(DISTINCT row_group_id) AS n FROM parquet_metadata('${dataDir}/index.parquet')`,
)[0].n;
const indexRows = duckdbJson(`SELECT count(*) AS n FROM '${dataDir}/index.parquet'`)[0].n;

const adm0Rows = duckdbJson(`SELECT count(*) AS n FROM '${dataDir}/adm0-boundaries.parquet'`)[0].n;
const adm2Rows = duckdbJson(`SELECT count(*) AS n FROM '${dataDir}/adm2-boundaries.parquet'`)[0].n;

const manifest = {
  spec: 'cnmw-index/1.0',
  source: 'geoboundaries-cgaz-provisional',
  index_version: new Date().toISOString(),
  catalog_version: CATALOG_VERSION,
  rows: indexRows,
  levels: [0, 2],
  stats_truncated: false,
  dropped_unnamed: null,
  index: {
    url: './index.parquet',
    size: fileInfo('index.parquet').size,
    checksum: sha256(path.join(dataDir, 'index.parquet')),
    row_groups: indexRowGroups,
  },
  boundaries: [
    {
      level: 0,
      feature_id_column: 'feature_id',
      geometry_column: 'geometry',
      full: { url: './adm0-boundaries.parquet', size: fileInfo('adm0-boundaries.parquet').size, row_count: adm0Rows },
      display: { url: './adm0-boundaries.parquet', size: fileInfo('adm0-boundaries.parquet').size, row_count: adm0Rows },
    },
    {
      level: 2,
      feature_id_column: 'feature_id',
      geometry_column: 'geometry',
      full: { url: './adm2-boundaries.parquet', size: fileInfo('adm2-boundaries.parquet').size, row_count: adm2Rows },
      display: { url: './adm2-boundaries.parquet', size: fileInfo('adm2-boundaries.parquet').size, row_count: adm2Rows },
    },
  ],
  attribution: [
    {
      text: 'Boundaries: geoBoundaries CGAZ (provisional mirror, tge-labs)',
      license: 'CC-BY-4.0',
      url: 'https://www.geoboundaries.org/',
      share_alike: false,
    },
  ],
  notes:
    'PROVISIONAL demo data. display === full (no separate display-simplified ' +
    'file in this provisional build -- see examples/geocoder-demo/build-data.sql).',
};

writeFileSync(path.join(dataDir, 'index.json'), JSON.stringify(manifest, null, 2));
console.log('Wrote', path.join(dataDir, 'index.json'));
console.log(JSON.stringify(manifest, null, 2));
