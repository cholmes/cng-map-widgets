// @cng/geocoder-core -- the one event mechanism (design doc §3.5):
// `on(event, handler) => unsubscribe`. Handlers run synchronously in
// registration order; a throwing handler is caught and reported via the
// 'error' event rather than stopping the others (unless the throwing
// handler *was* the 'error' handler, to avoid infinite recursion).

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
        if (event === 'error') continue; // never recurse on an error handler throwing
        this.emit('error', err);
      }
    }
  }
}
