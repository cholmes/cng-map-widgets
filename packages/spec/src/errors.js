// @cngeo/spec -- error taxonomy (design doc §3.5).
//
// One base class, a stable string `code`, and a `retryable` flag. The
// `code` is the API: messages are for humans and may be reworded, codes
// may not.

/**
 * @typedef {'AREA_INVALID_CRS'|'AREA_UNSUPPORTED_GEOMETRY'|'AREA_EMPTY'|
 *   'AREA_VERTEX_CEILING'|'AREA_ANTIMERIDIAN_CLIP'|'UPLOAD_TOO_LARGE'|
 *   'UPLOAD_UNSUPPORTED_FORMAT'|'UPLOAD_PARSE_ERROR'|
 *   'INDEX_FETCH_FAILED'|'INDEX_SCHEMA_MISMATCH'|'INDEX_VERSION_MISMATCH'|
 *   'INDEX_TOO_LARGE'|'INDEX_MULTI_SOURCE_UNSUPPORTED'|
 *   'RANGE_NOT_SUPPORTED'|'GEOMETRY_NOT_FOUND'|
 *   'DATASET_UNRESOLVED'|'DATASET_UNSUPPORTED'|'DATASET_NO_GEOMETRY_COLUMN'|
 *   'DATASET_CRS_UNSUPPORTED'|'FILTER_UNKNOWN_COLUMN'|
 *   'FILTER_UNSUPPORTED_PREDICATE'|'FILTER_REQUIRES_ENGINE'|
 *   'CEILING_EXCEEDED'|'FORMAT_UNAVAILABLE'|'FORMAT_CAPABILITY'|
 *   'FORMAT_LOAD_FAILED'|
 *   'DECK_LOAD_FAILED'|'DECK_MODULES_INVALID'|
 *   'LAYER_INVALID'|'LAYER_UNSUPPORTED'|'LAYER_LOAD_FAILED'|
 *   'SCENE_ASSETS_UNAVAILABLE'|'CATALOG_INDEX_INVALID'|'TIMELINE_INVALID'|
 *   'SINK_PERMISSION_DENIED'|'SINK_QUOTA_EXCEEDED'|'SINK_UNSUPPORTED'|
 *   'NETWORK'|'CORS'|'HTTP_STATUS'|'CANCELLED'|'INTERNAL'|
 *   'GEOCODER_NOT_LOADED'} CngErrorCode
 */

/** Codes that are retryable by default (a consumer may override per-throw). */
const RETRYABLE_DEFAULTS = new Set([
  'INDEX_FETCH_FAILED',
  'DATASET_UNRESOLVED',
  'SINK_PERMISSION_DENIED',
  'NETWORK',
  // A lazy format plugin's CDN fetch is a network request under a new
  // name (design doc §3.4 amendment, lazy format loading): the same
  // transient-failure shape as INDEX_FETCH_FAILED/NETWORK, so it gets the
  // same default.
  'FORMAT_LOAD_FAILED',
  // @cngeo/maplibre's lazy import of the deck.gl bundle: one more network
  // fetch under its own name. (Its sibling DECK_MODULES_INVALID is not
  // retryable: the same modules fail the same way.)
  'DECK_LOAD_FAILED',
  // A layer's style, tiles or collection document could not be fetched.
  // (LAYER_INVALID and LAYER_UNSUPPORTED describe the layer itself and
  // are not retryable.)
  'LAYER_LOAD_FAILED',
]);

export class CngError extends Error {
  /**
   * @param {string} message
   * @param {CngErrorCode} code
   * @param {{ retryable?: boolean, context?: Record<string, unknown>, cause?: unknown }} [opts]
   */
  constructor(message, code, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CngError';
    /** @type {string} */
    this.code = code;
    /** @type {boolean} */
    this.retryable = opts.retryable ?? RETRYABLE_DEFAULTS.has(code);
    /** @type {Record<string, unknown>|undefined} */
    this.context = opts.context;
  }
}

export class CancelledError extends CngError {
  /** @param {string} [message] @param {{context?: Record<string, unknown>}} [opts] */
  constructor(message = 'Operation cancelled', opts = {}) {
    super(message, 'CANCELLED', { retryable: false, ...opts });
    this.name = 'CancelledError';
  }
}

export class CeilingExceededError extends CngError {
  /** @param {string} [message] @param {{context?: Record<string, unknown>}} [opts] */
  constructor(message = 'Ceiling exceeded', opts = {}) {
    super(message, 'CEILING_EXCEEDED', { retryable: false, ...opts });
    this.name = 'CeilingExceededError';
  }
}

/** @param {unknown} e @returns {e is CngError} */
export function isCngError(e) {
  return e instanceof CngError;
}
