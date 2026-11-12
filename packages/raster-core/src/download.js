// @cnmw/raster-core -- `downloadRaster()`, the raster twin of
// download-core's `download()`.
//
// Same shape on purpose: returns synchronously so planning can be
// cancelled, resolves `estimate` even when the ceiling is breached, gates
// on `acceptCeiling()`, emits the same event names, and writes through the
// same `Sink` interface (so the File System Access / Blob / memory sinks
// are shared verbatim, not reimplemented).
//
// Three deliberate differences, each forced by what a raster is:
//   1. No `pause`/`resume`. A clip is a handful of coalesced range reads and
//      one buffer write; there is no long row stream to suspend.
//   2. Output is NOT streaming. A classic TIFF's IFD must know its strip
//      offsets, and the window has to be in RAM anyway (that is what the
//      `decodedBytes` ceiling is about), so the file is built whole and
//      written in one chunk. `streaming: false`, exactly like the sql.js
//      GeoPackage path, which is why the blob-sink ceiling applies.
//   3. The ceiling that matters is memory, not rows.

import { CnmwError, CancelledError } from '@cnmw/spec';
import { planRasterClip } from './plan.js';
import { writeGeoTiff } from './geotiff-writer.js';

let counter = 0;

/** Minimal event emitter, same contract as download-core's (sync, in order). */
function emitter() {
  const map = new Map();
  return {
    on(event, fn) {
      if (!map.has(event)) map.set(event, new Set());
      map.get(event).add(fn);
      return () => map.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of map.get(event) ?? []) {
        try {
          fn(payload);
        } catch {
          /* a throwing handler must not stop the others (design doc §3.5) */
        }
      }
    },
  };
}

/**
 * @param {object} descriptor from describeRasterDataset/describeRasterUrl
 * @param {import('@cnmw/spec').Area|null} area
 * @param {{ bands?: readonly string[], resolution?: any, compression?: 'none'|'deflate', bbox?: readonly number[] }} filter
 * @param {{ filename?: string, format?: 'geotiff' }} output
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal, sink?: any, acceptCeiling?: boolean, ceiling?: object }} [options]
 */
export function downloadRaster(descriptor, area, filter = {}, output = {}, options = {}) {
  counter += 1;
  const id = `rdl_${Date.now().toString(36)}${counter.toString(36)}`;
  const events = emitter();
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason));
  }

  let state = 'planning';
  const setState = (next) => {
    state = next;
    events.emit('state', { state });
  };

  let resumeFromBlocked = null;
  let cancelRequested = false;
  let estimateSettled = false;
  let resolveEstimate, rejectEstimate, resolveResult, rejectResult;
  const estimatePromise = new Promise((res, rej) => {
    resolveEstimate = res;
    rejectEstimate = rej;
  });
  const resultPromise = new Promise((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  estimatePromise.catch(() => {});
  resultPromise.catch(() => {});

  // What the read actually costs is counted per source file by
  // `openRaster` (geotiff.js binds one fetch per file handle, so the
  // opener owns the traffic); summing those counters gives a true figure
  // whether this download opened the files or the page already had them.
  const netOf = (plan) => {
    let requests = 0;
    let bytes = 0;
    for (const url of new Set(plan.bands.map((b) => b.url))) {
      const n = plan.sources.get(url)?.net;
      if (n) {
        requests += n.requests;
        bytes += n.bytes;
      }
    }
    return { requests, bytes };
  };

  async function run() {
    const t0 = Date.now();
    try {
      const plan = await planRasterClip(descriptor, area, filter, {
        ...options,
        signal: controller.signal,
      });
      const netBefore = netOf(plan);
      const est = plan.estimate;
      resolveEstimate(est);
      estimateSettled = true;
      events.emit('estimate', est);
      for (const w of est.warnings) events.emit('warning', w);

      if (est.ceiling.exceeded && !options.acceptCeiling) {
        setState('blocked');
        const gate = new Promise((resolve) => {
          resumeFromBlocked = resolve;
        });
        events.emit('ceiling', { estimate: est });
        const proceed = await gate;
        if (!proceed || cancelRequested) throw new CancelledError('Cancelled while blocked on the ceiling.');
      }

      setState('running');
      events.emit('progress', { phase: 'planning' });

      // --- read -----------------------------------------------------------
      const arrays = [];
      for (let i = 0; i < plan.bands.length; i++) {
        if (controller.signal.aborted) throw new CancelledError();
        const band = plan.bands[i];
        const source = plan.sources.get(band.url);
        const image = await source._tiff.getImage(plan.level);
        const rasters = await image.readRasters({
          window: plan.window,
          samples: [band.sample],
          interleave: false,
          signal: controller.signal,
        });
        arrays.push(rasters[0]);
        const net = netOf(plan);
        events.emit('progress', {
          phase: 'reading',
          bandsDone: i + 1,
          bandsTotal: plan.bands.length,
          bytesRead: net.bytes - netBefore.bytes,
          requests: net.requests - netBefore.requests,
        });
      }
      if (controller.signal.aborted) throw new CancelledError();

      // --- write ----------------------------------------------------------
      events.emit('progress', { phase: 'writing', bandsTotal: plan.bands.length });
      const bytes = await writeGeoTiff({
        bands: arrays,
        width: plan.width,
        height: plan.height,
        origin: plan.origin,
        pixelSize: plan.pixelSize,
        epsg: plan.epsg,
        citation: plan.citation,
        nodata: plan.nodata,
        compression: plan.compression,
      });

      const filename = output.filename ?? defaultFilename(descriptor, plan);
      const sink = options.sink;
      if (!sink) {
        throw new CnmwError(
          'downloadRaster needs a sink (autoSink()/blobSink()/memorySink() from @cnmw/download-core).',
          'SINK_UNSUPPORTED',
        );
      }
      events.emit('progress', { phase: 'finalizing' });
      const writer = await sink.open({
        filename,
        mediaType: 'image/tiff; application=geotiff',
        estimatedBytes: bytes.byteLength,
      });
      try {
        await writer.write(bytes);
        await writer.close();
        await sink.close();
      } catch (err) {
        await sink.abort(String(err?.message ?? err));
        throw err;
      }

      const result = {
        bytes: bytes.byteLength,
        format: 'geotiff',
        filename,
        width: plan.width,
        height: plan.height,
        bands: plan.bands.map((b) => b.name),
        dtype: plan.dtype,
        nodata: plan.nodata,
        epsg: plan.epsg,
        compression: plan.compression,
        resolution: est.resolution,
        elapsedMs: Date.now() - t0,
        requests: netOf(plan).requests - netBefore.requests,
        readBytes: netOf(plan).bytes - netBefore.bytes,
        naiveBytes: est.naiveBytes,
        sink: sinkResultOf(sink),
        estimate: est,
        attribution: descriptor.attribution ?? [],
      };
      setState('done');
      events.emit('done', result);
      resolveResult(result);
    } catch (err) {
      const e = err instanceof CnmwError ? err : new CnmwError(err?.message ?? String(err), 'INTERNAL', { cause: err });
      if (e.code === 'CANCELLED') setState('cancelled');
      else {
        setState('failed');
        events.emit('error', e);
      }
      if (!estimateSettled) {
        estimateSettled = true;
        rejectEstimate(e);
      }
      rejectResult(e);
    }
  }

  run();

  return {
    id,
    get state() {
      return state;
    },
    estimate: estimatePromise,
    result: resultPromise,
    on: events.on,
    acceptCeiling() {
      if (state === 'blocked' && resumeFromBlocked) {
        const resolve = resumeFromBlocked;
        resumeFromBlocked = null;
        resolve(true);
      }
    },
    async cancel(reason) {
      cancelRequested = true;
      controller.abort(typeof reason === 'string' ? reason : 'cancelled');
      if (resumeFromBlocked) {
        const resolve = resumeFromBlocked;
        resumeFromBlocked = null;
        resolve(false);
      }
      await resultPromise.catch(() => {});
    },
  };
}

function defaultFilename(descriptor, plan) {
  const base = String(descriptor.id ?? 'clip').replace(/[^\w.-]+/g, '_').slice(0, 60);
  return `${base}_${plan.bands.map((b) => b.name).join('-')}_${plan.width}x${plan.height}.tif`;
}

function sinkResultOf(sink) {
  if (sink.kind === 'filesystem') return { kind: 'filesystem', handle: sink.handle };
  if (sink.kind === 'blob') return { kind: 'blob', blob: sink.blob };
  if (sink.kind === 'memory') return { kind: 'memory', chunks: sink.chunks };
  return { kind: 'stream' };
}
