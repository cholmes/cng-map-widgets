// @cnmw/geocoder-core -- the cancellation primitive behind progressive
// select()'s "a new select() supersedes the pending background upgrade"
// rule (design doc task). Extracted into its own dependency-free module
// so it can be unit-tested without geocoder-core's hyparquet/CDN
// dependency (`Geocoder#select()` itself can only be exercised against a
// real network + a browser-capable dynamic `import()` of an `https:` URL,
// which `node --test` cannot do -- see the test file for the full
// explanation).

/**
 * One generation counter + one "current background controller" slot.
 * `next()` is called synchronously at the top of every `select()`: it
 * aborts whatever background upgrade was still pending (if any) and
 * returns a new generation number for the caller to stamp its own work
 * with. `isCurrent(generation)` lets a background task notice, at any
 * `await` boundary, that it has been superseded and should stop (silently
 * dropping its result rather than emitting it).
 */
export class GenerationGuard {
  constructor() {
    this._generation = 0;
    this._controller = null;
  }

  /** Current generation number (read-only). */
  get generation() {
    return this._generation;
  }

  /**
   * Start a new generation: abort and clear whatever controller was
   * attached to the previous one, then return the new generation number.
   * @returns {number}
   */
  next() {
    this._controller?.abort();
    this._controller = null;
    this._generation += 1;
    return this._generation;
  }

  /**
   * Associate an `AbortController` with the *current* generation's
   * pending background work, so the next `next()` (or `cancelAll()`)
   * aborts it.
   * @param {AbortController} controller
   */
  attach(controller) {
    this._controller = controller;
  }

  /**
   * Clear the attached controller once its background work has finished
   * normally (so a later `next()` doesn't abort a controller that no
   * longer corresponds to anything in flight). No-op if `controller` is
   * not the currently-attached one (i.e. it was already superseded).
   * @param {AbortController} controller
   */
  detach(controller) {
    if (this._controller === controller) this._controller = null;
  }

  /**
   * @param {number} generation
   * @returns {boolean} true if `generation` is still the current one.
   */
  isCurrent(generation) {
    return generation === this._generation;
  }

  /** Abort any pending background work and bump the generation, so no previously-issued generation is current. */
  cancelAll() {
    this._controller?.abort();
    this._controller = null;
    this._generation += 1;
  }
}
