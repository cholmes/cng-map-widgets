// @cngeo/maplibre -- what a PMTiles archive says about its own time axis.
//
// Pure: it takes the archive's metadata object and answers questions about
// it. Nothing here touches a map, the network or the DOM.
//
// The rule this file exists to enforce is that the viewer never guesses. The
// time axis is DECLARED by the archive; inferring it from a sampled feature
// has produced bugs, because MVT omits zero-valued attributes and a sampled
// cell therefore carries only the buckets in which something happened there.
//
// Ported from firms-catalog's apps/firms-explorer/archives.js.

import { CngError } from '@cngeo/spec';
import { bucketsBetween } from './days.js';

/**
 * PMTiles metadata values arrive as objects or as JSON strings, depending on
 * which tool wrote them. Accept both and never throw: a malformed block should
 * cost the feature that reads it, not the whole layer.
 */
export function parseJSONish(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The `vector_layers` array, whichever of the two places it was written to. */
export function vectorLayers(metadata) {
  if (Array.isArray(metadata?.vector_layers)) return metadata.vector_layers;
  const json = parseJSONish(metadata?.json);
  return Array.isArray(json?.vector_layers) ? json.vector_layers : [];
}

/**
 * The bucket keys a layer declares columns for, sorted. A bucket column is the
 * prefix plus six digits (`YYYYMM`) or eight (`YYYYMMDD`); `count_d` and
 * `count_modis` are counts but not time buckets, and the digit test is what
 * separates them.
 * @param {object} metadata
 * @param {{ layer: string, prefix?: string }} options
 * @returns {string[]}
 */
export function bucketColumns(metadata, { layer, prefix = 'count_' } = {}) {
  const found = vectorLayers(metadata).find((l) => l?.id === layer);
  if (!found) return [];
  return Object.keys(found.fields ?? {})
    .filter((name) => name.startsWith(prefix) && /^(\d{6}|\d{8})$/.test(name.slice(prefix.length)))
    .map((name) => name.slice(prefix.length))
    .sort();
}

function declaredAxis(metadata) {
  for (const key of ['cng:timeline', 'firms:timeline']) {
    const d = parseJSONish(metadata?.[key]);
    if (!d || (d.unit !== 'day' && d.unit !== 'month')) continue;
    const width = d.unit === 'month' ? 6 : 8;
    const ok = (k) => typeof k === 'string' && k.length === width && /^\d+$/.test(k);
    if (!ok(d.min) || !ok(d.max) || d.min > d.max) continue;
    return { unit: d.unit, min: d.min, max: d.max, buckets: typeof d.buckets === 'number' ? d.buckets : bucketsBetween(d.min, d.max, d.unit) };
  }
  return null;
}

/**
 * An archive's time axis: `{ declared, unit, min, max, buckets, columns, layer }`.
 *
 * The archive's own declaration (`cng:timeline`, then `firms:timeline`:
 * `{ unit, min, max, buckets? }`) is authoritative. Without one the axis is
 * rebuilt from the layer's DECLARED FIELD LIST, which is safe in a way that
 * sampling a feature is not: `vector_layers[].fields` is written from the
 * whole table, so a month that is zero in one cell still appears. `declared`
 * says which happened.
 *
 * @param {object} metadata  From `PMTiles.getMetadata()`.
 * @param {{ layer?: string, prefix?: string }} [options]
 *   `layer`: the vector layer whose columns are buckets. Default: the first that has any.
 * @throws {CngError} `TIMELINE_INVALID` when the archive gives no axis either way.
 */
export function timelineFromMetadata(metadata, { layer, prefix = 'count_' } = {}) {
  const layers = vectorLayers(metadata);
  const chosen = layer ?? layers.find((l) => bucketColumns(metadata, { layer: l?.id, prefix }).length > 0)?.id ?? null;
  const columns = chosen ? bucketColumns(metadata, { layer: chosen, prefix }) : [];
  const declared = declaredAxis(metadata);
  if (declared) return { declared: true, ...declared, columns, layer: chosen };
  if (!columns.length) {
    throw new CngError(`The archive says nothing about time: no "cng:timeline" declaration, and no vector layer with "${prefix}YYYYMMDD" or "${prefix}YYYYMM" columns.`, 'TIMELINE_INVALID', {
      retryable: false,
      context: { layers: layers.map((l) => l?.id), prefix },
    });
  }
  const width = columns[0].length;
  // Mixed widths mean two units in one layer, which there is no correct axis for. Refuse rather than pick.
  if (columns.some((c) => c.length !== width)) {
    throw new CngError(`Layer "${chosen}" has both daily and monthly "${prefix}" columns: there is no one time axis for it.`, 'TIMELINE_INVALID', { retryable: false, context: { layer: chosen } });
  }
  return { declared: false, unit: width === 6 ? 'month' : 'day', min: columns[0], max: columns[columns.length - 1], buckets: columns.length, columns, layer: chosen };
}

/** A vector layer's zoom range as the archive states it; null when the archive has no such layer. */
export function layerZooms(metadata, layerId) {
  const found = vectorLayers(metadata).find((l) => l?.id === layerId);
  if (!found) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { minzoom: num(found.minzoom), maxzoom: num(found.maxzoom) };
}
