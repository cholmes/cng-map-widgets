// @cngeo/spec -- the LayerSpec contract (`cng-layer/1.0`).
//
// A LayerSpec is plain JSON describing ONE thing a map can show: where its
// data is, what kind of thing it is, and what the map needs to credit. It
// is the seam between the packages that FIND layers (`@cngeo/stac`: a STAC
// collection, an imagery search, a catalog search) and the one that DRAWS
// them (`@cngeo/maplibre`'s LayerManager) -- the same role `Area` plays
// between the geocoder and the downloader.
//
// Like `Area`, it is versioned and serializable, so a layer stack can be
// saved, shared, or handed to another tool.
//
// `kind` is a closed list. Two kinds are deliberately NOT drawable:
//   'table'       -- parquet with no geometry: real data, nothing to map
//   'unsupported' -- something we recognise but cannot show (zarr, large
//                    untiled GeoParquet); `source.reason` says which
// They exist so a catalog search can say WHY a result has no map layer
// instead of showing nothing.

import { CngError } from './errors.js';

export const LAYER_SPEC = 'cng-layer/1.0';

/** Every kind a LayerSpec may carry. */
export const LAYER_KINDS = Object.freeze(['pmtiles-vector', 'cog', 'scenes', 'geojson', 'timeline', 'table', 'unsupported']);

/** The kinds a map can draw. `table` and `unsupported` are described, not drawn. */
export const RENDERABLE_KINDS = Object.freeze(['pmtiles-vector', 'cog', 'scenes', 'geojson', 'timeline']);

/**
 * @typedef {'pmtiles-vector'|'cog'|'scenes'|'geojson'|'timeline'|'table'|'unsupported'} LayerKind
 * @typedef {{ text?: string, license?: string, url?: string, shareAlike?: boolean, share_alike?: boolean }} LayerAttribution
 * @typedef {Object} LayerSpec
 * @property {'cng-layer/1.0'} spec
 * @property {string} id            Unique within one layer stack.
 * @property {string} title         Shown in a layer list. Defaults to `id`.
 * @property {LayerKind} kind
 * @property {Record<string, unknown>} source   Shape depends on `kind`; see README.
 * @property {Record<string, unknown>} [style]
 * @property {[number, number, number, number]} [bbox]   `[w, s, e, n]`, `w <= e`.
 * @property {[string|null, string|null]} [temporal]
 * @property {LayerAttribution[]} attribution
 * @property {string} [group]
 * @property {string} [thumbnail]
 */

function invalid(message, field) {
  return new CngError(message, 'LAYER_INVALID', { retryable: false, context: { field } });
}

function isAbsoluteUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function requireUrl(value, field) {
  if (!isAbsoluteUrl(value)) throw invalid(`LayerSpec ${field} must be an absolute http(s) URL, got ${JSON.stringify(value)}`, field);
}

/** Per-kind checks of `source`. Each throws LAYER_INVALID naming the field. */
const SOURCE_CHECKS = {
  'pmtiles-vector'(source) {
    requireUrl(source.url, 'source.url');
    if (!Array.isArray(source.layers) || source.layers.some((l) => typeof l !== 'string')) {
      throw invalid('A pmtiles-vector LayerSpec needs source.layers: the vector layer names in the archive', 'source.layers');
    }
    if (source.style !== undefined) requireUrl(source.style?.url, 'source.style.url');
  },
  cog(source) {
    requireUrl(source.url, 'source.url');
  },
  geojson(source) {
    if (source.data && typeof source.data === 'object') return;
    if (source.url !== undefined) return requireUrl(source.url, 'source.url');
    throw invalid('A geojson LayerSpec needs source.data (a GeoJSON object) or source.url', 'source');
  },
  scenes(source) {
    requireUrl(source.collectionUrl, 'source.collectionUrl');
    const kind = source.items?.kind;
    if (kind !== 'parquet' && kind !== 'partitioned') {
      throw invalid("A scenes LayerSpec needs source.items.kind: 'parquet' or 'partitioned'", 'source.items.kind');
    }
    if (kind === 'parquet') requireUrl(source.items.url, 'source.items.url');
  },
  timeline() {
    /* defined by @cngeo/timeline (Phase 4) */
  },
  table(source) {
    requireUrl(source.url, 'source.url');
  },
  unsupported(source) {
    if (typeof source.reason !== 'string' || !source.reason) {
      throw invalid('An unsupported LayerSpec must say why in source.reason', 'source.reason');
    }
  },
};

/**
 * Validate a LayerSpec and return a normalised copy: `title` defaulted to
 * `id`, `attribution` defaulted to `[]`. Throws `CngError` with code
 * `LAYER_INVALID` and `context.field` naming what is wrong.
 * @param {unknown} spec
 * @returns {LayerSpec}
 */
export function validateLayerSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw invalid('A LayerSpec must be an object', 'spec');
  const input = /** @type {Record<string, any>} */ (spec);

  if (input.spec !== LAYER_SPEC) throw invalid(`LayerSpec.spec must be '${LAYER_SPEC}', got ${JSON.stringify(input.spec)}`, 'spec');
  if (typeof input.id !== 'string' || !input.id) throw invalid('LayerSpec.id must be a non-empty string', 'id');
  if (!LAYER_KINDS.includes(input.kind)) {
    throw invalid(`LayerSpec.kind must be one of ${LAYER_KINDS.join(', ')}; got ${JSON.stringify(input.kind)}`, 'kind');
  }
  if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)) {
    throw invalid('LayerSpec.source must be an object', 'source');
  }
  SOURCE_CHECKS[input.kind](input.source);

  if (input.bbox !== undefined) {
    const b = input.bbox;
    const fine =
      Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n)) && b[0] <= b[2] && b[1] <= b[3];
    if (!fine) throw invalid('LayerSpec.bbox must be [w, s, e, n] with finite numbers, w <= e and s <= n', 'bbox');
  }
  if (input.temporal !== undefined) {
    const t = input.temporal;
    const fine = Array.isArray(t) && t.length === 2 && t.every((v) => v === null || typeof v === 'string');
    if (!fine) throw invalid('LayerSpec.temporal must be [start|null, end|null]', 'temporal');
  }
  if (input.attribution !== undefined && !Array.isArray(input.attribution)) {
    throw invalid('LayerSpec.attribution must be an array', 'attribution');
  }

  return /** @type {LayerSpec} */ ({
    ...input,
    title: typeof input.title === 'string' && input.title ? input.title : input.id,
    source: structuredClone(input.source),
    attribution: (input.attribution ?? []).map((a) => ({ ...a })),
    ...(input.bbox ? { bbox: [...input.bbox] } : {}),
    ...(input.temporal ? { temporal: [...input.temporal] } : {}),
  });
}

/**
 * A layer id reduced to characters safe inside a MapLibre layer or source
 * id and a CSS selector: letters, digits, `_` and `-`; every other run of
 * characters becomes one `-`.
 * @param {string} id
 */
export function layerSlug(id) {
  return String(id).replace(/[^A-Za-z0-9_-]+/g, '-');
}
