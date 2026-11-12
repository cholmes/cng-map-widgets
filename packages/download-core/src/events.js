// @cnmw/download-core -- the one event mechanism (design doc §3.5).
// Local copy of @cnmw/geocoder-core's Emitter (not exported from that
// package's public surface); duplicated rather than cross-imported to keep
// the two packages' runtime coupling limited to @cnmw/spec, per §3.1's
// singleton rationale.

/**
 * A "latest-wins" async iterable (design doc §3.5: "drops intermediate
 * values under backpressure... a progress bar wants the newest number, not
 * every number"). Multiple `push()` calls between two consumer pulls only
 * ever yield the most recent one.
 */
export class LatestWinsStream {
  constructor() {
    this._deferred = null;
    this._latest = undefined;
    this._has = false;
    this._done = false;
  }

  /** @param {unknown} value */
  push(value) {
    this._latest = value;
    this._has = true;
    this._wake();
  }

  end() {
    this._done = true;
    this._wake();
  }

  _wake() {
    if (this._deferred) {
      const d = this._deferred;
      this._deferred = null;
      d();
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this._has) {
        this._has = false;
        yield this._latest;
        continue;
      }
      if (this._done) return;
      await new Promise((resolve) => {
        this._deferred = resolve;
      });
    }
  }
}

export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  /**
   * @param {string} event
   * @param {(payload: unknown) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this._handlers.get(event)?.delete(handler);
  }

  /** @param {string} event @param {unknown} payload */
  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        if (event === 'error') continue;
        this.emit('error', err);
      }
    }
  }
}
