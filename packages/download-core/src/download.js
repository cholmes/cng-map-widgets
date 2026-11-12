// @cnmw/download-core -- `download()` / `DownloadHandle` (design doc §3.4,
// §3.5). Returns synchronously: "A handle that only existed after an await
// could not be cancelled during planning, which is exactly when a user
// changes their mind."

import { CnmwError, CancelledError, fromAreaDocument } from '@cnmw/spec';
import { Emitter, LatestWinsStream } from './events.js';
import { planRequest, finalizeEstimate } from './estimate.js';
import { createHyparquetEngine } from './engine-hyparquet.js';
import { getFormat } from './registry.js';
import { createGeoJsonFormat } from './formats/geojson.js';
import { createGeoParquetFormat } from './formats/geoparquet.js';
import { autoSink } from './sinks.js';

/** Fallback when a caller imports download.js directly without index.js's default registration. */
function builtinFormat(id) {
  if (id === 'geojson') return createGeoJsonFormat();
  if (id === 'geoparquet') return createGeoParquetFormat();
  return undefined;
}

let idCounter = 0;
function generateHandleId() {
  idCounter += 1;
  return `dl_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function schemaFor(plan) {
  const declared = new Map((plan.table.columns ?? []).map((c) => [c.name, c]));
  return plan.outputColumns.map((name) => declared.get(name) ?? { name, type: 'unknown' });
}

/**
 * @param {import('./types.js').DatasetDescriptor} dataset
 * @param {import('@cnmw/spec').Area|null} area
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('./types.js').OutputRequest} output
 * @param {import('./types.js').DownloadCoreOptions & { sink?: import('./types.js').Sink, acceptCeiling?: boolean }} [options]
 * @returns {import('./types.js').DownloadHandle}
 */
export function download(dataset, area, filter, output, options = {}) {
  const id = generateHandleId();
  const emitter = new Emitter();
  const progressStream = new LatestWinsStream();
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason));
  }

  const engine = options.engine ?? createHyparquetEngine();
  const format = getFormat(output.format) ?? builtinFormat(output.format);

  /** @type {'planning'|'blocked'|'running'|'paused'|'done'|'cancelled'|'failed'} */
  let state = 'planning';
  function setState(next) {
    state = next;
    emitter.emit('state', { state });
  }

  let resumeFromBlocked = null; // resolves the blocked-gate; set while state === 'blocked'
  let pausePromise = null;
  let resumeFromPause = null;
  let cancelRequested = false;
  let cancelReason;
  let keepPartialOnCancel = false;

  let estimateSettled = false;
  let resolveEstimate, rejectEstimate;
  const estimatePromise = new Promise((res, rej) => {
    resolveEstimate = res;
    rejectEstimate = rej;
  });
  let resolveResult, rejectResult;
  const resultPromise = new Promise((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  // A rejected `result` with no listener yet is expected whenever a
  // download is `blocked` or fails; don't let Node/the browser log it as
  // unhandled before a consumer has a chance to attach a handler.
  resultPromise.catch(() => {});
  estimatePromise.catch(() => {});

  async function run() {
    try {
      if (!format) {
        throw new CnmwError(`No format plugin registered for "${output.format}".`, 'FORMAT_UNAVAILABLE', {
          context: { format: output.format },
        });
      }

      const enginePlan = await engine.plan(dataset, area, filter, { fetch: options.fetch, signal: controller.signal });
      const plan = enginePlan.plan;
      // Test-only seam: a fake engine's `plan` can skip the (network-bound)
      // real planRequest/finalizeEstimate pipeline by supplying a
      // ready-made Estimate directly. Exercises the state machine
      // (planning/blocked/running/.../done, acceptCeiling, cancel) without
      // a real parquet file -- the pruning/estimate *math* has its own
      // dedicated unit tests (prune.test.js, bounded.test.js).
      const schema = schemaFor(plan);
      const est = options.estimateOverride ?? (await finalizeEstimate(plan, area, filter, { ...options, outputBytesOverride: format.estimateBytes(schema, plan.rows) }));

      if (!format.streaming && est.outputBytes.max > (options.ceiling?.blobBytes ?? 256 * 1024 ** 2)) {
        est.ceiling.breaches = [...new Set([...est.ceiling.breaches, 'blobBytes'])];
        est.ceiling.exceeded = true;
      }

      resolveEstimate(est);
      estimateSettled = true;
      emitter.emit('estimate', est);
      for (const w of est.warnings) emitter.emit('warning', w);

      if (est.ceiling.exceeded && !options.acceptCeiling) {
        setState('blocked');
        // The gate is armed *before* emitting 'ceiling' so a handler that
        // calls `acceptCeiling()` synchronously (events run synchronously,
        // design doc §3.5) resolves a gate that already exists.
        const gate = new Promise((resolve) => {
          resumeFromBlocked = resolve;
        });
        emitter.emit('ceiling', { estimate: est });
        const proceed = await gate;
        if (!proceed || cancelRequested) {
          throw new CancelledError('Download cancelled while blocked on the ceiling.');
        }
      }

      setState('running');
      emitter.emit('progress', { phase: 'planning' });

      const sink = options.sink ?? (await autoSink({ suggestedName: output.filename }));
      const writer = await sink.open({
        filename: output.filename ?? `download.${format.extension}`,
        mediaType: format.mediaType,
        estimatedBytes: est.outputBytes.estimate,
      });

      const formatWriter = await format.open({
        writer,
        schema,
        geometryColumn: plan.geometryColumn,
        crs: plan.table.crs ?? 'OGC:CRS84',
        options: output.options ?? {},
        attribution: plan.resolved.attribution ?? [],
        signal: controller.signal,
      });

      let runResult;
      try {
        runResult = await engine.run(
          enginePlan,
          async (batch) => {
            await formatWriter.writeBatch(batch);
            emitter.emit('progress', { phase: 'writing', rowsWritten: batch.rows, bytesWritten: 0 });
          },
          {
            fetch: options.fetch,
            signal: controller.signal,
            limit: filter.limit,
            async onProgress(p) {
              emitter.emit('progress', p);
              progressStream.push(p);
              if (pausePromise) await pausePromise;
              if (controller.signal.aborted) throw new CancelledError();
            },
          },
        );
      } catch (err) {
        await formatWriter.abort(err?.message);
        await sink.abort(cancelReason);
        throw err;
      }

      emitter.emit('progress', { phase: 'finalizing' });
      const { rows, bytes } = await formatWriter.close();
      await sink.close();

      const result = {
        rows,
        bytes,
        format: output.format,
        filename: output.filename ?? `download.${format.extension}`,
        elapsedMs: est.elapsedMs,
        requests: runResult.requests,
        readBytes: runResult.readBytes,
        sink: sinkResultOf(sink),
        estimate: est,
        truncated: filter.limit !== undefined && rows >= filter.limit,
        attribution: plan.resolved.attribution ?? [],
      };
      setState('done');
      emitter.emit('done', result);
      resolveResult(result);
    } catch (err) {
      const cnmwErr = err instanceof CnmwError ? err : new CnmwError(err?.message ?? String(err), 'INTERNAL', { cause: err });
      if (cnmwErr.code === 'CANCELLED') {
        setState('cancelled');
      } else {
        setState('failed');
        emitter.emit('error', cnmwErr);
      }
      if (!estimateSettled) {
        estimateSettled = true;
        rejectEstimate(cnmwErr);
      }
      rejectResult(cnmwErr);
    } finally {
      progressStream.end();
    }
  }

  // Kick off planning immediately (synchronously-returned handle, §3.4).
  run();

  const handle = {
    id,
    get state() {
      return state;
    },
    estimate: estimatePromise,
    result: resultPromise,
    progress: progressStream,
    on(event, fn) {
      return emitter.on(event, fn);
    },
    acceptCeiling() {
      if (state === 'blocked' && resumeFromBlocked) {
        const resolve = resumeFromBlocked;
        resumeFromBlocked = null;
        resolve(true);
      }
    },
    pause() {
      if (state !== 'running') return;
      setState('paused');
      pausePromise = new Promise((resolve) => {
        resumeFromPause = resolve;
      });
    },
    resume() {
      if (state !== 'paused') return;
      setState('running');
      resumeFromPause?.();
      pausePromise = null;
    },
    async cancel(reason) {
      cancelRequested = true;
      cancelReason = typeof reason === 'string' ? reason : reason?.reason;
      keepPartialOnCancel = typeof reason === 'object' && reason?.keepPartial === true;
      void keepPartialOnCancel; // surfaced to sinks via their own `keepPartial` open-option (design doc §3.4); recorded here for callers that only learn it at cancel time.
      controller.abort(cancelReason ?? 'cancelled');
      if (resumeFromBlocked) {
        const resolve = resumeFromBlocked;
        resumeFromBlocked = null;
        resolve(false);
      }
      if (resumeFromPause) {
        const resolve = resumeFromPause;
        resumeFromPause = null;
        resolve();
      }
      await resultPromise.catch(() => {});
    },
  };
  return handle;
}

function sinkResultOf(sink) {
  if (sink.kind === 'filesystem') return { kind: 'filesystem', handle: sink.handle };
  if (sink.kind === 'blob') return { kind: 'blob', blob: sink.blob };
  if (sink.kind === 'memory') return { kind: 'memory', chunks: sink.chunks };
  return { kind: 'stream' };
}

/**
 * Convenience: build a `DownloadHandle` from a serialized `DownloadRequest`
 * (design doc §2.3/§3.4). `request.filter.area` is honored when it is an
 * inline `AreaDocument`; `{ ref: 'area' }` defers to the `area` argument.
 * @param {import('./types.js').DownloadRequest} request
 * @param {import('@cnmw/spec').Area|null} area
 * @param {import('./types.js').DownloadCoreOptions & { sink?: import('./types.js').Sink, acceptCeiling?: boolean }} [options]
 */
export function downloadRequest(request, area, options = {}) {
  let resolvedArea = area;
  if (request.filter.area && !('ref' in request.filter.area)) {
    resolvedArea = fromAreaDocument(request.filter.area);
  }
  return download(request.dataset, resolvedArea, request.filter, request.output, options);
}
