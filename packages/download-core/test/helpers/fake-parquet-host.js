// Test-only: build a real, multi-row-group parquet file in memory and
// serve it through a fake `fetch` whose per-request latency the test
// chooses.
//
// Everything downstream of this is the production stack: hyparquet's
// `asyncBufferFromUrl` (Range requests), `openParquetFile`'s footer read
// and `decodeRowGroups`, `readRows`, and the engine's own worker pool. The
// only thing faked is the network, which is exactly the thing a unit test
// has to control to say anything about concurrency, ordering, or request
// counts.

import './hyparquet-setup.js';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { openParquetFile } from '../../src/parquet-io.js';

/** WKB for a tiny axis-aligned square polygon around (x, y). */
export function squareWkb(x, y, size = 0.01) {
  const ring = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + ring.length * 16);
  const view = new DataView(buf);
  let o = 0;
  view.setUint8(o, 1); // little-endian
  o += 1;
  view.setUint32(o, 3, true); // Polygon
  o += 4;
  view.setUint32(o, 1, true); // one ring
  o += 4;
  view.setUint32(o, ring.length, true);
  o += 4;
  for (const [cx, cy] of ring) {
    view.setFloat64(o, cx, true);
    o += 8;
    view.setFloat64(o, cy, true);
    o += 8;
  }
  return new Uint8Array(buf);
}

/**
 * Build a parquet buffer of `groups * rowsPerGroup` rows with columns
 * `id` (`"g<group>-r<row>"`), `n` (a row-group-monotone int), `cat` (a
 * string with one value per row group) and `geometry` (WKB squares whose x
 * is the row-group index, so a row group's geometry sits in its own
 * longitude band).
 */
export function buildParquet({ groups = 8, rowsPerGroup = 10 } = {}) {
  const id = [];
  const n = [];
  const cat = [];
  const geometry = [];
  for (let g = 0; g < groups; g++) {
    for (let r = 0; r < rowsPerGroup; r++) {
      id.push(`g${g}-r${r}`);
      n.push(g * 100 + r);
      cat.push(`cat-${g}`);
      geometry.push(squareWkb(g, 0.5));
    }
  }
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: 'id', data: id, type: 'STRING', nullable: true },
      { name: 'n', data: n, type: 'INT32', nullable: true },
      { name: 'cat', data: cat, type: 'STRING', nullable: true },
      { name: 'geometry', data: geometry, type: 'BYTE_ARRAY', nullable: true },
    ],
    rowGroupSize: rowsPerGroup,
    createdBy: '@cnmw/download-core test',
  });
  return new Uint8Array(buffer);
}

/**
 * A `fetch` that serves `bytes` over HTTP Range semantics.
 * @param {Uint8Array} bytes
 * @param {{ delayMs?: (n: number) => number, log?: object[] }} [opts]
 *   `delayMs(requestOrdinal)` picks each request's latency, so a test can
 *   make later reads finish *first*. `log` collects `{ ordinal, start,
 *   end, at }` per request.
 */
export function rangeFetch(bytes, opts = {}) {
  let ordinal = 0;
  const log = opts.log ?? [];
  return async function fakeFetch(url, init = {}) {
    const mine = ordinal++;
    const range = init.headers?.get?.('Range') ?? null;
    if (init.method === 'HEAD' || !range) {
      return new Response(null, { status: 200, headers: { 'content-length': String(bytes.byteLength), 'accept-ranges': 'bytes' } });
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] === '' ? bytes.byteLength : Number(m[2]) + 1;
    log.push({ ordinal: mine, start, end, at: performance.now() });
    const delay = opts.delayMs?.(mine) ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const slice = bytes.slice(start, end);
    return new Response(slice, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end - 1}/${bytes.byteLength}`, 'content-length': String(slice.byteLength) },
    });
  };
}

/**
 * Open a `buildParquet()` buffer as a real `openParquetFile` handle whose
 * reads go through `rangeFetch`.
 * @param {{ groups?: number, rowsPerGroup?: number, delayMs?: (n: number) => number, signal?: AbortSignal, log?: object[] }} [opts]
 */
export async function openFakeHostedParquet(opts = {}) {
  const bytes = buildParquet(opts);
  const log = opts.log ?? [];
  const handle = await openParquetFile('https://example.invalid/test.parquet', rangeFetch(bytes, { delayMs: opts.delayMs, log }), {
    signal: opts.signal,
  });
  return { handle, bytes, log };
}

/**
 * The minimal `enginePlan` shape `createHyparquetEngine().run()` consumes,
 * built straight from a handle -- so an engine test needs no dataset
 * resolution, no network enumeration and no `planRequest`.
 * @param {{ handle: any, filter?: object, area?: object|null, readColumns?: string[], outputColumns?: string[], rowGroups?: number[] }} opts
 */
export function enginePlanFor(opts) {
  const { handle } = opts;
  const rowGroups = opts.rowGroups ? opts.rowGroups.map((i) => handle.rowGroups[i]) : handle.rowGroups;
  const readColumns = opts.readColumns ?? ['id', 'n', 'cat', 'geometry'];
  return {
    dataset: { id: 'test' },
    area: opts.area ?? null,
    filter: opts.filter ?? { spec: 'cnmw-filter/1.0', spatial: { mode: 'bbox' } },
    plan: {
      readColumns,
      outputColumns: opts.outputColumns ?? readColumns,
      geometryColumn: 'geometry',
      covering: { kind: 'none' },
      perPart: [{ part: { url: handle.url }, handle, selectedRowGroups: rowGroups }],
    },
  };
}
