// A small item table shaped like a scene index, for tests that go through the
// whole planner (not just the engine): a time column, an INT64 column, flat
// bbox covering columns, and geometry LAST so a read that does not need it
// cannot touch it by accident of range coalescing.
//
// 4 row groups x 3 rows. Row (g, r):
//   id        `g{g}-r{r}`
//   n         g * 100 + r                       INT32
//   big       5_000_000_000 + g * 10 + r        INT64  (decodes as BigInt)
//   datetime  2025-06-(1 + g * 5 + r)           string
//   geometry  the unit square at x = g * 10     (so each group has its own longitude)

import { parquetWriteBuffer } from 'hyparquet-writer';
import { rangeFetch, squareWkb } from './fake-parquet-host.js';

export const SCENES_URL = 'https://example.invalid/scenes.parquet';

/** @param {{ groups?: number, rowsPerGroup?: number, tag?: string }} [opts] `tag` prefixes every id, to tell two builds apart. */
export function buildScenes({ groups = 4, rowsPerGroup = 3, tag = '' } = {}) {
  const cols = { id: [], n: [], big: [], datetime: [], xmin: [], ymin: [], xmax: [], ymax: [], geometry: [] };
  for (let g = 0; g < groups; g++) {
    for (let r = 0; r < rowsPerGroup; r++) {
      cols.id.push(`${tag}g${g}-r${r}`);
      cols.n.push(g * 100 + r);
      cols.big.push(5_000_000_000n + BigInt(g * 10 + r));
      cols.datetime.push(`2025-06-${String(1 + g * 5 + r).padStart(2, '0')}T00:00:00Z`);
      cols.xmin.push(g * 10);
      cols.ymin.push(0);
      cols.xmax.push(g * 10 + 1);
      cols.ymax.push(1);
      cols.geometry.push(squareWkb(g * 10, 0, 1));
    }
  }
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: 'id', data: cols.id, type: 'STRING', nullable: true },
      { name: 'n', data: cols.n, type: 'INT32', nullable: true },
      { name: 'big', data: cols.big, type: 'INT64', nullable: true },
      { name: 'datetime', data: cols.datetime, type: 'STRING', nullable: true },
      { name: 'xmin', data: cols.xmin, type: 'DOUBLE', nullable: true },
      { name: 'ymin', data: cols.ymin, type: 'DOUBLE', nullable: true },
      { name: 'xmax', data: cols.xmax, type: 'DOUBLE', nullable: true },
      { name: 'ymax', data: cols.ymax, type: 'DOUBLE', nullable: true },
      { name: 'geometry', data: cols.geometry, type: 'BYTE_ARRAY', nullable: true },
    ],
    rowGroupSize: rowsPerGroup,
    createdBy: '@cngeo/extract-core test',
  });
  return new Uint8Array(buffer);
}

/** The dataset descriptor for `buildScenes()` served at `SCENES_URL`. `covering: false` declares no bbox columns. */
export function scenesDataset({ covering = true } = {}) {
  return {
    spec: 'cng-dataset/1.0',
    id: 'scenes',
    source: { kind: 'parquet', url: SCENES_URL },
    table: {
      geometryColumn: 'geometry',
      geometryEncoding: 'WKB',
      crs: 'OGC:CRS84',
      bbox: covering ? { kind: 'columns', xmin: 'xmin', ymin: 'ymin', xmax: 'xmax', ymax: 'ymax' } : { kind: 'none' },
      timeColumn: 'datetime',
      columns: ['id', 'n', 'big', 'datetime', 'xmin', 'ymin', 'xmax', 'ymax', 'geometry'].map((name) => ({ name, type: 'unknown' })),
    },
    attribution: [{ text: 'Test scenes', license: 'CC0-1.0', shareAlike: false }],
  };
}

/**
 * Serve one file at `SCENES_URL` over Range semantics, logging every request.
 * `replace(bytes)` swaps the file, as a publisher rewriting it would.
 * @param {Uint8Array} bytes
 * @param {{ delayMs?: (ordinal: number) => number }} [opts]
 */
export function scenesHost(bytes, opts = {}) {
  let current = bytes;
  let server = rangeFetch(current, opts);
  const log = [];
  const fetch = async (url, init = {}) => {
    const range = init.headers?.get?.('Range') ?? null;
    const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
    log.push({
      url: String(url),
      method: init.method ?? 'GET',
      start: m ? Number(m[1]) : null,
      end: m ? (m[2] === '' ? current.byteLength : Number(m[2]) + 1) : null,
    });
    if (String(url) !== SCENES_URL) return new Response(null, { status: 404 });
    return server(url, init);
  };
  return {
    fetch,
    log,
    get bytes() {
      return current;
    },
    replace(next) {
      current = next;
      server = rangeFetch(current, opts);
    },
    /** Range reads that are not the footer read (which runs to the end of the file). */
    dataReads: () => log.filter((e) => e.start !== null && e.end < current.byteLength),
    reset: () => log.splice(0),
  };
}
