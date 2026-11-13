// @cnmw/download-core -- sinks (design doc §3.4).

import { CnmwError } from '@cnmw/spec';

/**
 * One run's writable, with the lifecycle every sink owes its caller
 * written down once instead of re-derived in each sink.
 *
 * INVARIANT: **one writable per run -- opened once, closed exactly once,
 * never touched after an abort.**
 *
 * `close()` is not bookkeeping. For `fileSystemSink` it is *the commit*:
 * Chrome streams a picker-chosen `foo.parquet` into a sibling
 * `foo.parquet.crswap` and only swaps that over the real file when the
 * writable closes. A writable that is merely dropped on the floor leaves
 * every byte in a swap file the browser then discards, so the user keeps
 * the zero-byte file the picker created -- while `DownloadResult.bytes`
 * cheerfully reports the full size, because the format writer really did
 * produce those bytes and handed them over. That was the bug (a 7.3 MB
 * "Saved" card over a 0-byte file); `test/browser/filesystem-sink.verify.mjs`
 * is what keeps it from coming back.
 *
 * Both of this repo's calling conventions are tolerated, because it has
 * both: `download-core`'s `download()` leaves the closing to
 * `sink.close()` (no format plugin touches `ctx.writer.close()`), while
 * `raster-core`'s `downloadRaster()` closes the writer itself and *then*
 * calls `sink.close()`. Whoever closes first commits; the second call is
 * a no-op rather than a `TypeError` on an already-closed writer.
 *
 * @param {{ write?(chunk: Uint8Array): void|Promise<void>, close?(): void|Promise<void>, abort?(reason?: unknown): void|Promise<void> }} underlying
 */
function managedWritable(underlying) {
  /** @type {'open'|'closed'|'aborted'} */
  let phase = 'open';
  const writer = new WritableStream({
    write: underlying.write,
    async close() {
      phase = 'closed';
      await underlying.close?.();
    },
    async abort(reason) {
      phase = 'aborted';
      await underlying.abort?.(reason);
    },
  }).getWriter();

  return {
    writer,
    get phase() {
      return phase;
    },
    /** Close exactly once; a no-op once the stream has closed or aborted. */
    async close() {
      if (phase !== 'open') return;
      await writer.close();
    },
    /** Abort exactly once, and never after a close. */
    async abort(reason) {
      if (phase !== 'open') return;
      try {
        await writer.abort(reason);
      } catch {
        // The stream was already errored (e.g. blobSink's quota refusal
        // threw out of `write`). Nothing left to unwind.
      }
    },
  };
}

/** The guard against a *second* `open()` on a sink that already has a writable. */
function refuseSecondOpen(kind, managed) {
  if (!managed) return;
  throw new CnmwError(
    `${kind} sink: open() was called twice. A sink backs exactly one run and hands out exactly one writable -- re-opening would start a second, empty write to the same destination (on the File System Access API, a fresh swap file that commits over the bytes just written). Create a new sink per download.`,
    'SINK_UNSUPPORTED',
    { context: { kind, phase: managed.phase } },
  );
}

/** In-memory sink: collects every chunk written, for tests and small downloads. */
export function memorySink() {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let managed = null;
  return {
    kind: 'memory',
    chunks,
    async open() {
      refuseSecondOpen('memory', managed);
      managed = managedWritable({ write: (chunk) => void chunks.push(chunk) });
      return managed.writer;
    },
    async close() {
      await managed?.close();
    },
    async abort(reason) {
      await managed?.abort(reason);
      chunks.length = 0;
    },
  };
}

/** Buffers, then exposes a `Blob` (design doc: the no-File-System-Access fallback). Refuses above `maxBytes` with `SINK_QUOTA_EXCEEDED`. @param {{ maxBytes?: number }} [opts] */
export function blobSink(opts = {}) {
  const maxBytes = opts.maxBytes ?? 256 * 1024 ** 2;
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  let mediaType = 'application/octet-stream';
  let managed = null;
  return {
    kind: 'blob',
    get blob() {
      return new Blob(chunks, { type: mediaType });
    },
    async open(meta) {
      refuseSecondOpen('blob', managed);
      mediaType = meta.mediaType;
      managed = managedWritable({
        write(chunk) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            throw new CnmwError(
              'Too large to buffer in memory; use a browser that supports direct-to-disk saving.',
              'SINK_QUOTA_EXCEEDED',
              { context: { maxBytes } },
            );
          }
          chunks.push(chunk);
        },
      });
      return managed.writer;
    },
    async close() {
      await managed?.close();
    },
    async abort(reason) {
      await managed?.abort(reason);
      chunks.length = 0;
      total = 0;
    },
  };
}

/** Wraps a caller-supplied `WritableStream`. @param {WritableStream<Uint8Array>} stream */
export function streamSink(stream) {
  let managed = null;
  return {
    kind: 'stream',
    async open() {
      refuseSecondOpen('stream', managed);
      // The caller's stream is driven through its own writer, and *this*
      // sink's writer is the guarded wrapper -- so the one-close invariant
      // holds for a host-supplied stream exactly as it does for a file.
      const inner = stream.getWriter();
      managed = managedWritable({
        write: (chunk) => inner.write(chunk),
        close: () => inner.close(),
        abort: (reason) => inner.abort(reason),
      });
      return managed.writer;
    },
    async close() {
      await managed?.close();
    },
    async abort(reason) {
      await managed?.abort(reason);
    },
  };
}

/**
 * File System Access API sink. `showSaveFilePicker` must be called from a
 * user gesture, *before* `download()` -- so the resolved handle is passed
 * in, never created here (design doc §3.4).
 * @param {{ handle?: FileSystemFileHandle, suggestedName?: string, keepPartial?: boolean }} [opts]
 */
export async function fileSystemSink(opts = {}) {
  if (typeof globalThis.showSaveFilePicker !== 'function' && !opts.handle) {
    throw new CnmwError('The File System Access API is not available in this browser.', 'SINK_UNSUPPORTED');
  }
  const handle = opts.handle;
  if (!handle) {
    throw new CnmwError('fileSystemSink requires a FileSystemFileHandle (call showSaveFilePicker from a user gesture first).', 'SINK_UNSUPPORTED');
  }
  let fsWritable = null;
  let managed = null;
  let wroteAnything = false;
  return {
    kind: 'filesystem',
    handle,
    async open() {
      // Exactly one `createWritable()` per sink, and so per run. A second
      // one would open a second swap file with the default
      // `keepExistingData: false` and commit emptiness over the first.
      refuseSecondOpen('filesystem', managed);
      fsWritable = await handle.createWritable();
      managed = managedWritable({
        write: (chunk) => {
          wroteAnything = true;
          return fsWritable.write(chunk);
        },
        close: () => fsWritable.close(),
        abort: (reason) => fsWritable.abort(reason),
      });
      return managed.writer;
    },
    async close() {
      // THE COMMIT, and the whole reason this method is not empty: closing
      // the writable is what swaps `<name>.crswap` over the real file. It
      // used to be a no-op on the (wrong) assumption that the format
      // plugin closed the writer -- none of them do, in any format
      // package, so every picker-path download committed nothing and the
      // user was left with the 0-byte file the save dialog had created.
      //
      // Deliberately NOT wrapped in try/catch: a commit that fails is the
      // one thing a download must never report as success.
      await managed?.close();
    },
    async abort(reason) {
      // Guarded by `managed`: never aborts a writable that already
      // committed, and never aborts twice.
      await managed?.abort(reason);
      // ...and never deletes a file that *did* commit. "Remove the partial
      // file" means the partial one; once the writable has closed cleanly
      // the bytes on disk are the user's finished download, and a late
      // `abort()` (a caller unwinding after its own `close()` succeeded)
      // must not take it away.
      const committed = managed?.phase === 'closed';
      if (wroteAnything && !committed && !opts.keepPartial) {
        try {
          const parent = await handle.getParent?.();
          if (parent?.removeEntry) await parent.removeEntry(handle.name);
        } catch {
          /* best-effort partial-file cleanup; not fatal */
        }
      }
    },
  };
}

/** `fileSystemSink` where available, else `blobSink` (design doc §3.4's default). @param {{ suggestedName?: string }} [opts] */
export async function autoSink(opts = {}) {
  if (typeof globalThis.showSaveFilePicker === 'function') {
    try {
      const handle = await globalThis.showSaveFilePicker({ suggestedName: opts.suggestedName });
      return fileSystemSink({ handle, suggestedName: opts.suggestedName });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new CnmwError('Save dialog was dismissed.', 'SINK_PERMISSION_DENIED', { cause: err });
      }
      // Any other picker failure: fall through to the Blob fallback.
    }
  }
  return blobSink();
}
