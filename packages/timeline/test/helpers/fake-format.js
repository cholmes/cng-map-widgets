// A ChunkFormat that opens nothing and draws nothing, and remembers what it
// was asked. It is the proof that a second format plugs in: everything the
// orchestrator knows about a format is in this file's shape.

/** A clock a test moves by hand. */
export function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    timers: {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = ++seq;
        pending.set(id, { at: now + Math.max(0, ms), fn, id });
        return id;
      },
      clearTimeout: (id) => pending.delete(id),
    },
    /** Move time on, running what falls due, in order. */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.values()].filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        pending.delete(due.id);
        now = due.at;
        due.fn();
      }
      now = until;
    },
    pending: () => pending.size,
  };
}

/** Let promise callbacks run. */
export const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/**
 * @param {{ manual?: boolean, fail?: Set<string>|string[], histograms?: Record<string, Record<string, number>>,
 *   settleOnMount?: boolean, onSetWindow?: (record, window) => void }} [options]
 *   `manual`: `open()` waits for `release(id)` / `reject(id, error)`.
 */
export function fakeFormat(options = {}) {
  const fail = new Set(options.fail ?? []);
  const opened = []; // every open() call, by chunk id, in order
  const waiting = new Map(); // id -> { resolve, reject, signal }
  const mounts = new Map(); // id -> record (the latest mount of that chunk)
  const everMounted = [];
  const format = {
    async open(chunk, { signal } = {}) {
      opened.push(chunk.id);
      if (options.manual) {
        await new Promise((resolve, reject) => {
          waiting.set(chunk.id, { resolve, reject, signal });
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      if (fail.has(chunk.id)) throw new Error(`HTTP 404 for ${chunk.url}`);
      return { unit: chunk.unit, opened: chunk.id };
    },
    mount(ctx) {
      const record = {
        id: ctx.chunk.id,
        ctx,
        windows: [], // every setWindow() argument, in order
        frozen: false,
        destroyed: false,
        histogramCalls: 0,
        histogram: options.histograms?.[ctx.chunk.id] ?? {},
        get window() {
          return record.windows.at(-1) ?? null;
        },
      };
      mounts.set(ctx.chunk.id, record);
      everMounted.push(record);
      if (options.settleOnMount) ctx.settled(true);
      return {
        setWindow(window) {
          record.frozen = false;
          record.windows.push(window);
          options.onSetWindow?.(record, window);
        },
        histogram(viewport) {
          record.histogramCalls += 1;
          record.viewport = viewport;
          return record.histogram;
        },
        freeze() {
          record.frozen = true;
        },
        destroy() {
          record.destroyed = true;
        },
      };
    },
  };
  return {
    format,
    opened,
    mounts,
    everMounted,
    waiting,
    release(id) {
      waiting.get(id)?.resolve();
      waiting.delete(id);
    },
    reject(id, error) {
      waiting.get(id)?.reject(error);
      waiting.delete(id);
    },
    fail,
  };
}
