// @cnmw/download-core -- sinks (design doc §3.4).

import { CnmwError } from '@cnmw/spec';

/**
 * @param {{ write?(chunk: Uint8Array): void|Promise<void>, close?(): void|Promise<void>, abort?(reason?: unknown): void|Promise<void> }} underlying
 * @returns {WritableStreamDefaultWriter<Uint8Array>}
 */
function writerFrom(underlying) {
  return new WritableStream(underlying).getWriter();
}

/** In-memory sink: collects every chunk written, for tests and small downloads. */
export function memorySink() {
  /** @type {Uint8Array[]} */
  const chunks = [];
  return {
    kind: 'memory',
    chunks,
    async open() {
      return writerFrom({ write: (chunk) => void chunks.push(chunk) });
    },
    async close() {},
    async abort() {
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
  return {
    kind: 'blob',
    get blob() {
      return new Blob(chunks, { type: mediaType });
    },
    async open(meta) {
      mediaType = meta.mediaType;
      return writerFrom({
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
    },
    async close() {},
    async abort() {
      chunks.length = 0;
      total = 0;
    },
  };
}

/** Wraps a caller-supplied `WritableStream`. @param {WritableStream<Uint8Array>} stream */
export function streamSink(stream) {
  let writer;
  return {
    kind: 'stream',
    async open() {
      writer = stream.getWriter();
      return writer;
    },
    async close() {
      await writer?.close();
    },
    async abort(reason) {
      await writer?.abort(reason);
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
  let wroteAnything = false;
  return {
    kind: 'filesystem',
    handle,
    async open() {
      fsWritable = await handle.createWritable();
      return writerFrom({
        write: (chunk) => {
          wroteAnything = true;
          return fsWritable.write(chunk);
        },
        close: () => fsWritable.close(),
        abort: (reason) => fsWritable.abort(reason),
      });
    },
    async close() {
      // writerFrom's close() already closed fsWritable.
    },
    async abort() {
      try {
        await fsWritable?.abort();
      } catch {
        /* already closed/aborted */
      }
      if (wroteAnything && !opts.keepPartial) {
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
