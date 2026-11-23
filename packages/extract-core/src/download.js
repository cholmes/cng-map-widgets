// @cngeo/extract-core -- `download()` / `DownloadHandle` (design doc §3.4,
// §3.5). Returns synchronously: "A handle that only existed after an await
// could not be cancelled during planning, which is exactly when a user
// changes their mind."

import { CngError, CancelledError, CeilingExceededError, fromAreaDocument } from '@cngeo/spec';
import { Emitter, LatestWinsStream } from './events.js';
import { planRequest, finalizeEstimate, schemaFor } from './estimate.js';
import { createHyparquetEngine } from './engine-hyparquet.js';
import { resolveFormat, getFormat, formatLoadState, formats } from './registry.js';
import { createGeoJsonFormat } from './formats/geojson.js';
import { createGeoParquetFormat } from './formats/geoparquet.js';
import { autoSink } from './sinks.js';
import { effectiveCeiling } from './ceiling.js';
import { RAW_FORMAT_ID, rawFormatDescriptor, planRaw, rawEstimate, runRaw, rawSuggestedFilename } from './raw.js';

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

/**
 * Registered formats whose OWN effective ceiling would accommodate this
 * plan -- the lever `CeilingExceededError.context.suggestedFormats` names
 * (design doc §7.3's example: "GeoParquet and GeoJSON ... have no such
 * limit"). Runs each candidate's SYNCHRONOUS `estimateBytes` against the
 * same plan/schema the breaching format used, and compares it to THAT
 * candidate's own `effectiveCeiling` -- never the breaching format's
 * `outputBytes` against another format's ceiling, which gives wrong
 * answers whenever formats differ in size by more than their memory
 * factors (the normal case). `formats()` lists a lazy descriptor without
 * loading it, and `LazyFormatDescriptor.estimateBytes` is documented to
 * work without `load()`, so this never fetches anything. `getFormat(id)`
 * is tried first so an eager (or already-loaded-lazy) format's real
 * `estimateBytes` is used -- `formats()`'s own eager listing strips that
 * field.
 * @param {Awaited<ReturnType<typeof planRequest>>} plan
 * @param {readonly { name: string, type: string }[]} schema
 * @param {{ avgGeometryBytes: number|null, geometryColumn: string }} estimateCtx
 * @param {{ kind: string }|null} sink
 * @param {import('./types.js').DownloadCoreOptions['ceiling']} overrides
 * @returns {string[]}
 */
function suggestedFormatsFor(plan, schema, estimateCtx, sink, overrides) {
  const fits = [];
  for (const entry of formats()) {
    const candidate = getFormat(entry.id) ?? entry;
    // A registered-but-not-a-decode-format descriptor (the raw-passthrough
    // entry registered under this same id, `rawFormatDescriptor` -- it has
    // no `estimateBytes` because it has no schema/rows model at all) is
    // never a byte-for-byte alternative for whatever format just breached,
    // so it is skipped here rather than crashing this loop for every
    // breach, on every format, forever.
    if (typeof candidate.estimateBytes !== 'function') continue;
    const candidateBytes = candidate.estimateBytes(schema, plan.rows, estimateCtx);
    const candidateCeiling = effectiveCeiling({ format: candidate, sink, overrides });
    if (
      plan.rows.max <= candidateCeiling.rows &&
      candidateBytes.max <= candidateCeiling.outputBytes &&
      plan.readBytes.max <= candidateCeiling.readBytes &&
      plan.selectedParts.length <= candidateCeiling.files
    ) {
      fits.push(entry.id);
    }
  }
  return fits;
}

/**
 * @param {import('./types.js').DatasetDescriptor} dataset
 * @param {import('@cngeo/spec').Area|null} area
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
  // `result` is a *slot*, not a single promise (design doc §3.4, amended
  // 2026-11-12 "blocked handles reject"). The run that is currently in
  // flight owns one deferred; a ceiling breach settles it (rejected with
  // `CeilingExceededError`) and `acceptCeiling()` installs a fresh one for
  // the continued run. `handle.result` is therefore a getter that always
  // hands back the promise for whatever run is live now.
  let current = newResultDeferred();
  // Always resolves, never rejects, once `run()` has fully finished (its
  // `finally` has run: sink closed/aborted, progress stream ended). What
  // `cancel()` awaits -- it must not await `current.promise`, which may
  // already be the settled ceiling rejection while the run is still
  // tearing down.
  let markRunSettled;
  const runSettled = new Promise((resolve) => {
    markRunSettled = resolve;
  });
  estimatePromise.catch(() => {});

  // Hoisted above `run()`'s `try` (not a `const` inside it) so the outer
  // `catch` below can abort it: a sink created during planning (see its
  // new creation point below) must still be cleaned up if anything after
  // that point throws, including a cancel while blocked on the ceiling
  // gate -- `sink.abort()` is a safe no-op before `sink.open()` has ever
  // been called (sinks.js's `managedWritable` guards it), so this never
  // risks aborting a commit that already happened.
  let sink;

  /**
   * The raw-passthrough run. Shares `run()`'s closure (`sink`, `current`,
   * `setState`, `resumeFromBlocked`, `cancelRequested`, the estimate
   * deferred) and its caller's try/catch/finally -- a throw from in here
   * is handled by the exact same `sink.abort()` / `current.reject()` /
   * `setState('failed'|'cancelled')` logic `run()`'s own catch already
   * has, so this function does not duplicate any of that.
   */
  /**
   * A cancel that landed while planning, or while a save dialog was open,
   * found no ceiling gate to release (`cancel()` only resolves a gate that
   * already exists) and is now awaiting `runSettled`. Planning does not
   * always notice the abort itself -- a custom `fetch` may ignore the
   * signal, and `autoSink`'s picker knows nothing of it -- so without
   * this check the run would go on to arm the gate and sit `blocked`
   * with `cancel()` never resolving, or open the sink and download.
   */
  function throwIfCancelRequested() {
    if (cancelRequested || controller.signal.aborted) throw new CancelledError('Download cancelled during planning.');
  }

  async function runRawDownload() {
    const rawPlan = await planRaw(dataset, area, filter, { fetch: options.fetch, signal: controller.signal, ceiling: options.ceiling });

    // Mirrors the normal path's design doc §7.8 ordering: the sink is
    // created BEFORE the ceiling gate (and before `rawEstimate`, which
    // reads `sink.kind` through `effectiveCeiling`) so the ceiling sees
    // the REAL sink kind rather than a guess.
    sink = options.sink ?? (await autoSink({ suggestedName: output.filename ?? rawSuggestedFilename(rawPlan) }));

    const est = options.estimateOverride ?? (await rawEstimate(rawPlan, filter, { ...options, sink }));

    throwIfCancelRequested();
    resolveEstimate(est);
    estimateSettled = true;
    emitter.emit('estimate', est);
    for (const w of est.warnings) emitter.emit('warning', w);

    if (est.ceiling.exceeded && !options.acceptCeiling) {
      // Same ordering rule as the decoded path's gate below: reject
      // `current` BEFORE any event fires, so a synchronous
      // `acceptCeiling()` inside a handler resolves the right deferred.
      // There is no `suggestedFormatsFor` equivalent here -- raw
      // passthrough has no schema/rows model another format's
      // `estimateBytes` could be compared against, and it only ever
      // applies to the small set of source kinds `planRaw` itself
      // supports -- so `suggestedFormats` is always empty on this path.
      current.reject(
        new CeilingExceededError(
          `Estimated ${est.outputBytes.estimate.toLocaleString()} output bytes exceeds the ceiling (${est.ceiling.breaches.join(', ')}). Call acceptCeiling() for the continued run, or cancel().`,
          { context: { breaches: est.ceiling.breaches, limits: est.ceiling.limits, estimate: est, suggestedFormats: [] } },
        ),
      );
      const gate = new Promise((resolve) => {
        resumeFromBlocked = resolve;
      });
      setState('blocked');
      emitter.emit('ceiling', { estimate: est });
      const proceed = await gate;
      if (!proceed || cancelRequested) {
        throw new CancelledError('Download cancelled while blocked on the ceiling.');
      }
    }

    setState('running');
    emitter.emit('progress', { phase: 'planning' });

    const filename = output.filename ?? rawSuggestedFilename(rawPlan);
    const mediaType = rawPlan.selected.length > 1 ? 'application/zip' : rawFormatDescriptor.mediaType;
    const writer = await sink.open({ filename, mediaType, estimatedBytes: est.outputBytes.estimate });

    const runResult = await runRaw(rawPlan, writer, {
      fetch: options.fetch,
      signal: controller.signal,
      async onProgress(p) {
        emitter.emit('progress', p);
        progressStream.push(p);
        if (pausePromise) await pausePromise;
        if (controller.signal.aborted) throw new CancelledError();
      },
    });

    emitter.emit('progress', { phase: 'finalizing' });
    await sink.close();

    // Decision 2: `rows` is the summed declared `rowCount` only when every
    // selected part declared one (`rawEstimate`'s `est.rows`, a `Bounded`,
    // is already exactly that or `null`); otherwise `null`, documented as
    // "not counted on the raw path". `truncated` is always `false` --
    // there is no `filter.limit` concept on a whole-file copy.
    const result = {
      rows: est.rows ? est.rows.estimate : null,
      bytes: runResult.bytes,
      format: output.format,
      filename,
      elapsedMs: est.elapsedMs,
      requests: rawPlan.selected.length,
      readBytes: runResult.readBytes,
      sink: sinkResultOf(sink),
      estimate: est,
      truncated: false,
      attribution: rawPlan.resolved?.attribution ?? [],
      formatWarnings: [],
    };
    setState('done');
    emitter.emit('done', result);
    current.resolve(result);
  }

  async function run() {
    try {
      // One microtask tick before anything else: `download()` returns the
      // handle synchronously (so it can be cancelled during planning,
      // §3.4), and `run()` is kicked off before that return -- without
      // this yield, a synchronous-tick emission below (e.g.
      // 'loading-format') would fire before a caller who attaches
      // `handle.on(...)` right after `download()` returns has had the
      // chance to. Every event this handle ever emits is therefore safe
      // to listen for *after* `download()` returns, which is the only
      // sequencing a caller can actually act on.
      await Promise.resolve();

      // Raw GeoParquet passthrough (Task 6/7, format id `parquet-raw`):
      // a completely separate run, before any of the normal
      // format-resolution / `engine.plan()` / hyparquet pipeline below,
      // because the whole point of this path is that NO footer is ever
      // read and NO row is ever decoded. `planRaw`/`rawEstimate` are its
      // own planning half (raw.js); `runRaw` is its own execution half.
      // Everything else -- state machine, ceiling gate, sink lifecycle,
      // cancel/abort -- is shared with the code below it.
      if (output.format === RAW_FORMAT_ID) {
        await runRawDownload();
        return;
      }

      // Design doc §3.4 amendment (lazy format loading): resolve the
      // format *inside* run(), not synchronously before the handle is
      // returned, so a lazy format's CDN fetch (e.g. the ~340KB sql.js
      // wasm @cngeo/format-gpkg loads on demand) only starts once a
      // download for that format id actually begins -- never merely
      // because the format was registered or listed. `getFormat` first:
      // avoids the 'loading-format' progress event and its emitter
      // round-trip for the common case (an already-loaded/eager format).
      let format = getFormat(output.format) ?? builtinFormat(output.format);
      if (!format) {
        if (formatLoadState(output.format) === 'unknown') {
          throw new CngError(`No format plugin registered for "${output.format}".`, 'FORMAT_UNAVAILABLE', {
            context: { format: output.format },
          });
        }
        emitter.emit('progress', { phase: 'loading-format', format: output.format });
        progressStream.push({ phase: 'loading-format', format: output.format });
        format = await resolveFormat(output.format); // throws FORMAT_LOAD_FAILED on failure
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
      // `estimateBytes`'s third argument (design doc §3.4, item-7
      // amendment) is additive: a plugin that ignores it keeps working,
      // and this is the number that flows into `est.outputBytes` and from
      // there into the `outputBytes` ceiling check inside
      // `finalizeEstimate`.
      const estimateCtx = { avgGeometryBytes: plan.avgGeometryBytes ?? null, geometryColumn: plan.geometryColumn };

      // Design doc §7.8: the sink is created BEFORE the ceiling gate (it
      // used to be created after), so `effectiveCeiling` (inside
      // `finalizeEstimate`, via `options.sink` below) sees the REAL sink
      // kind instead of guessing one -- guessing 'filesystem' while
      // `autoSink` silently fell back to `blobSink` would have been
      // exactly the anti-goal this ceiling exists to avoid. The cost is
      // that a save dialog can now appear just before a refusal; that is
      // recoverable, since `acceptCeiling()` continues on the same handle.
      sink = options.sink ?? (await autoSink({ suggestedName: output.filename }));

      // Ruling R17 (whole-branch review fix-wave re-review): `format` here
      // comes from `getFormat()`/`builtinFormat()`/`resolveFormat()`, none
      // of which validate that a registered format declares
      // `estimateBytes` -- `registerFormat` itself performs no such check
      // (and must not: `rawFormatDescriptor` is registered through it
      // deliberately WITHOUT one, since its size comes from part metadata,
      // not a schema+rows model -- see raw.js). So a misregistered
      // third-party plugin reaching this line with no `estimateBytes`
      // would otherwise throw a bare `TypeError` here, one line before
      // `finalizeEstimate`'s own `FORMAT_CAPABILITY` guard ever gets a
      // chance to run. Skipped entirely when `options.estimateOverride` is
      // given, matching the `??` below: that path never needs
      // `format.estimateBytes` at all.
      if (options.estimateOverride === undefined && typeof format.estimateBytes !== 'function') {
        throw new CngError(`Format "${format.id ?? output.format}" has no estimateBytes.`, 'FORMAT_CAPABILITY', { context: { formatId: format.id ?? output.format } });
      }
      const est = options.estimateOverride ?? (await finalizeEstimate(plan, area, filter, { ...options, output, sink, formatOverride: format, outputBytesOverride: format.estimateBytes(schema, plan.rows, estimateCtx) }));

      throwIfCancelRequested();
      resolveEstimate(est);
      estimateSettled = true;
      emitter.emit('estimate', est);
      for (const w of est.warnings) emitter.emit('warning', w);

      if (est.ceiling.exceeded && !options.acceptCeiling) {
        // Reject the *current* `result` promise FIRST, before any event
        // fires (design doc §3.4: "Rejects with `CeilingExceededError` if
        // the handle is `blocked` and neither `acceptCeiling()` nor
        // `acceptCeiling: true` was given"). Order matters twice over:
        //
        //  - Events are synchronous (§3.5), so a `state`/`ceiling` handler
        //    may call `acceptCeiling()` *during* the emit -- which installs
        //    a fresh deferred. Rejecting after that would reject the
        //    continued run's promise instead of the blocked one.
        //  - A rejection handler only runs as a microtask, so by the time
        //    any `.catch()` observes this error, the synchronous
        //    `setState('blocked')` below has already happened and
        //    `handle.state` reads `'blocked'`, as a caller expects.
        const suggestedFormats = suggestedFormatsFor(plan, schema, estimateCtx, sink, options.ceiling);
        current.reject(
          new CeilingExceededError(
            `Estimated ${est.rows.estimate.toLocaleString()} rows / ${est.outputBytes.estimate.toLocaleString()} output bytes exceeds the ceiling (${est.ceiling.breaches.join(', ')}). Call acceptCeiling() for the continued run, or cancel().`,
            { context: { breaches: est.ceiling.breaches, limits: est.ceiling.limits, estimate: est, suggestedFormats } },
          ),
        );
        // The gate is armed *before* `setState`/`emit` so a handler that
        // calls `acceptCeiling()` synchronously (events run synchronously,
        // design doc §3.5) resolves a gate that already exists -- for the
        // 'state' event too, not just 'ceiling'.
        const gate = new Promise((resolve) => {
          resumeFromBlocked = resolve;
        });
        setState('blocked');
        emitter.emit('ceiling', { estimate: est });
        const proceed = await gate;
        if (!proceed || cancelRequested) {
          throw new CancelledError('Download cancelled while blocked on the ceiling.');
        }
      }

      setState('running');
      emitter.emit('progress', { phase: 'planning' });

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
        // Additive (GitHub issue #4): the source files' own Parquet schema,
        // so a format that can write nested types (`geoparquet`) keeps a
        // struct a struct instead of inferring a JSON string. A format
        // that ignores it is unaffected.
        sourceSchema: unionSourceSchemas((plan.perPart ?? []).map((p) => p.handle?.metadata?.schema)),
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
            // design doc §3.4's `DownloadCoreOptions.maxConcurrentRequests`,
            // handed to the engine rather than read by it off the options
            // object, because an alternative engine (`@cngeo/engine-duckdb`)
            // gets the same budget through the same `run()` ctx. Left
            // `undefined` when the caller said nothing, so the engine's own
            // default (12, see engine-hyparquet.js) applies.
            maxConcurrentRequests: options.maxConcurrentRequests,
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
      // `warnings` is an additive, optional field on `FormatWriter.close()`'s
      // result (design doc §3.4 amendment): a format plugin's own
      // honesty mechanism for the limits only it knows about (e.g.
      // @cngeo/format-shapefile's 10-char field name truncation, one
      // shape type per file, ~2GiB size ceiling -- see that package's
      // README). Re-emitted through the same 'warning' event
      // EstimateWarning already uses, and carried on the DownloadResult,
      // so neither channel needs a format-specific special case.
      const { rows, bytes, warnings: formatWarnings = [] } = await formatWriter.close();
      await sink.close();
      for (const w of formatWarnings) emitter.emit('warning', w);

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
        formatWarnings,
      };
      setState('done');
      emitter.emit('done', result);
      current.resolve(result);
    } catch (err) {
      const cngErr = err instanceof CngError ? err : new CngError(err?.message ?? String(err), 'INTERNAL', { cause: err });
      if (cngErr.code === 'CANCELLED') {
        setState('cancelled');
      } else {
        setState('failed');
        emitter.emit('error', cngErr);
      }
      if (!estimateSettled) {
        estimateSettled = true;
        rejectEstimate(cngErr);
      }
      // Covers every throw from here on out that the inner (engine.run)
      // catch does not already handle -- planning failing after the sink
      // was created, and a cancel while blocked on the ceiling gate among
      // them. Safe even when `sink` was never assigned (planning failed
      // before reaching its creation) or `sink.open()` was never called
      // (blocked/cancelled before `setState('running')`): `sink.abort()`
      // is a no-op in both cases (sinks.js's `managedWritable` guard), so
      // this can never abort a commit that already happened, nor double
      // an abort the inner catch already performed.
      //
      // That is true of this package's own sinks. A host-supplied
      // `options.sink` promises no such thing -- its `abort()` may throw
      // on a writer it never created -- and a throw here would skip the
      // `current.reject` below and leave `handle.result` pending forever.
      try {
        await sink?.abort(cancelReason ?? cngErr.message);
      } catch {
        // The run has already failed with `cngErr`; that is the error to report.
      }
      // A no-op when the ceiling gate already rejected this deferred and
      // the caller then cancelled instead of accepting: the handle's
      // `state` becomes `'cancelled'`, but the promise a caller is holding
      // stays rejected with the `CEILING_EXCEEDED` it was first given
      // rather than switching error codes underneath them.
      current.reject(cngErr);
    } finally {
      progressStream.end();
      markRunSettled();
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
    /**
     * The live run's completion promise. Rejects with
     * `CeilingExceededError` the moment the handle goes `blocked` -- it
     * never just waits (design doc §3.4). `acceptCeiling()` installs, and
     * returns, a *fresh* promise for the continued run, which is what this
     * getter hands back from then on; a promise captured before the breach
     * stays rejected, as promises must.
     */
    get result() {
      return current.promise;
    },
    progress: progressStream,
    on(event, fn) {
      return emitter.on(event, fn);
    },
    /**
     * The refusal override (design call #3): an explicit, auditable act.
     * Returns the continued run's `Promise<DownloadResult>` -- the same
     * promise `handle.result` returns from here on -- because the one the
     * caller was holding has already rejected with `CeilingExceededError`.
     * Idempotent: called when the handle is not `blocked` it changes
     * nothing and simply returns the current `result`.
     * @returns {Promise<import('./types.js').DownloadResult>}
     */
    acceptCeiling() {
      if (state === 'blocked' && resumeFromBlocked) {
        current = newResultDeferred();
        const resolve = resumeFromBlocked;
        resumeFromBlocked = null;
        resolve(true);
      }
      return current.promise;
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
      // `runSettled`, not `current.promise`: while `blocked`, `current` is
      // already the settled ceiling rejection, so awaiting it would return
      // before the run had actually torn down.
      await runSettled;
    },
  };
  return handle;
}

/**
 * One run's `result` deferred. Pre-attaching a no-op `catch` is load-bearing:
 * a rejected `result` with no listener yet is the *normal* path whenever a
 * download is blocked on the ceiling or fails during planning, and Node (or
 * the browser console) would otherwise report it as an unhandled rejection
 * before a consumer has had a chance to attach a handler.
 */
function newResultDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * One flat hyparquet `SchemaElement[]` covering every top-level column any
 * of the given footer schemas declares -- the first part to declare a
 * column decides its shape. Parts of one dataset normally agree; this only
 * matters when a later part carries a column an earlier one lacks.
 * Returns `undefined` when no schema is available at all, which a format
 * reads as "infer".
 * @param {(import('hyparquet').SchemaElement[]|undefined)[]} schemas
 * @returns {import('hyparquet').SchemaElement[]|undefined}
 */
export function unionSourceSchemas(schemas) {
  /** @type {Map<string, import('hyparquet').SchemaElement[]>} */
  const columns = new Map();
  for (const schema of schemas) {
    if (!Array.isArray(schema)) continue;
    let i = 1; // [0] is the root
    while (i < schema.length) {
      const start = i;
      i = subtreeEnd(schema, i);
      if (!columns.has(schema[start].name)) columns.set(schema[start].name, schema.slice(start, i));
    }
  }
  if (columns.size === 0) return undefined;
  return [{ name: 'root', num_children: columns.size }, ...[...columns.values()].flat()];
}

/** Index one past the subtree rooted at `i` in a flat, depth-first schema. */
function subtreeEnd(schema, i) {
  let next = i + 1;
  for (let c = 0; c < (schema[i].num_children ?? 0); c++) next = subtreeEnd(schema, next);
  return next;
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
 * @param {import('@cngeo/spec').Area|null} area
 * @param {import('./types.js').DownloadCoreOptions & { sink?: import('./types.js').Sink, acceptCeiling?: boolean }} [options]
 */
export function downloadRequest(request, area, options = {}) {
  let resolvedArea = area;
  if (request.filter.area && !('ref' in request.filter.area)) {
    resolvedArea = fromAreaDocument(request.filter.area);
  }
  return download(request.dataset, resolvedArea, request.filter, request.output, options);
}
