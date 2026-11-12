// @cnmw/spec -- the Area contract (design doc §1).

import { computeBBoxes } from './bbox.js';
import { simplifyToVertexCeiling } from './simplify.js';
import { CnmwError } from './errors.js';

/** @typedef {import('./bbox.js').BBox} BBox */
/** @typedef {GeoJSON.Polygon|GeoJSON.MultiPolygon} AreaGeometry */

/**
 * One attribution entry carried in `Area.provenance.attribution` (design
 * doc §1.2). **Additive typedef** (geocoder-core follow-up task 3): this
 * package never built or validated the shape before -- `buildArea` just
 * passed whatever array it was given straight through -- so this is
 * documentation only, not a new runtime check. `shareAlike` is the
 * canonical (camelCase) field name; a raw manifest entry spells it
 * `share_alike` (snake_case) instead, which is why
 * `@cnmw/geocoder-core`'s manifest ingestion normalizes to this shape
 * before it ever reaches `buildArea`.
 * @typedef {{
 *   text: string,
 *   url?: string,
 *   license?: string,
 *   shareAlike: boolean,
 * }} AreaAttribution
 */

export const AREA_VERSION = 1;

let idCounter = 0;
/** Generate a session-stable Area id (not a global identifier). */
export function generateAreaId() {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `area_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

/**
 * Build a valid `Area` from one or more contributing features, applying
 * §1.4's union-by-default (`collect`) and §1.3's filter-geometry
 * simplification.
 *
 * @param {{
 *   name: string,
 *   geometry: AreaGeometry,
 *   source: 'geocoder'|'upload'|'draw',
 *   features: Array<Record<string, unknown>>,
 *   combine?: 'single'|'collect'|'dissolve',
 *   geometryVariant?: 'full'|'display-simplified'|'unknown',
 *   attribution?: AreaAttribution[],
 *   provenanceExtra?: Record<string, unknown>,
 *   filterVertexCeiling?: number,
 *   displayVertexCeiling?: number,
 *   areaDeltaWarnRatio?: number,
 *   areaDeltaMaxRatio?: number,
 *   maxSyncInputVertices?: number,
 * }} input
 * @returns {import('./types.js').Area}
 */
export function buildArea(input) {
  const {
    name,
    geometry,
    source,
    features,
    combine = 'single',
    geometryVariant = 'unknown',
    attribution = [],
    provenanceExtra = {},
    filterVertexCeiling = 10_000,
    displayVertexCeiling = 200_000,
    areaDeltaWarnRatio = 0.01,
    areaDeltaMaxRatio = 0.05,
    // Opt-in cheap/"interim" mode (fix history, "Canada ADM0 select()
    // blocks the main thread for ~24s"): when set, both simplification
    // passes below skip the O(m^2) sync search once their input exceeds
    // this many vertices and degrade straight to bbox instead -- see
    // `simplify.js`'s `MAX_SYNC_SIMPLIFY_VERTICES` for the measurements
    // behind the default a caller typically passes here. `undefined` (the
    // default): no guard, run the sync search regardless of input size --
    // the original behavior, still used by callers with no interactive-
    // latency budget (e.g. `@cnmw/upload-core`). `@cnmw/geocoder-core`'s
    // `select()` passes `MAX_SYNC_SIMPLIFY_VERTICES` for its synchronous
    // (non-"both"-upgrade) builds.
    maxSyncInputVertices,
  } = input;

  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    throw new CnmwError('An Area needs polygon geometry.', 'AREA_UNSUPPORTED_GEOMETRY', {
      context: { type: geometry.type },
    });
  }

  const { bbox, bboxes, crossesAntimeridian } = computeBBoxes(geometry);

  const displayResult = simplifyToVertexCeiling(geometry, {
    vertexCeiling: displayVertexCeiling,
    areaDeltaMaxRatio: 1, // display never degrades to bbox; just caps vertices
    maxSyncInputVertices,
  });
  const displayGeometry = displayResult.geometry;

  const filterResult = simplifyToVertexCeiling(displayGeometry, {
    vertexCeiling: filterVertexCeiling,
    areaDeltaMaxRatio,
    maxSyncInputVertices,
  });

  /** @type {AreaGeometry|null} */
  let filterGeometry = filterResult.degradedToBbox ? null : filterResult.geometry;
  /** @type {import('./types.js').AreaSimplification|undefined} */
  let simplification;
  if (filterResult.method !== 'none' || filterResult.degradedToBbox) {
    simplification = {
      method: filterResult.method,
      toleranceDeg: filterResult.toleranceDeg,
      inputVertices: filterResult.inputVertices,
      outputVertices: filterResult.outputVertices,
      areaDeltaRatio: filterResult.areaDeltaRatio,
      degradedToBbox: filterResult.degradedToBbox,
    };
  }

  const area = {
    type: 'Area',
    version: AREA_VERSION,
    id: generateAreaId(),
    name,
    crs: 'EPSG:4326',
    bbox,
    bboxes,
    crossesAntimeridian,
    geometry: displayGeometry,
    filterGeometry,
    vertexCount: {
      display: displayResult.outputVertices,
      filter: filterGeometry ? filterResult.outputVertices : 0,
    },
    provenance: {
      source,
      createdAt: new Date().toISOString(),
      features,
      combine,
      geometryVariant,
      ...(simplification ? { simplification } : {}),
      attribution,
      ...provenanceExtra,
    },
  };

  void areaDeltaWarnRatio; // reserved: callers may inspect simplification.areaDeltaRatio themselves
  return area;
}

/**
 * Validate the shape of an `Area` object (not a JSON Schema, but the same
 * checks: required fields, polygon-only geometry, EPSG:4326, consistent
 * bboxes). Throws `CnmwError` on the first violation found.
 * @param {unknown} area
 * @returns {import('./types.js').Area}
 */
export function validateArea(area) {
  if (typeof area !== 'object' || area === null) {
    throw new CnmwError('Area must be an object.', 'AREA_INVALID_CRS');
  }
  const a = /** @type {Record<string, unknown>} */ (area);
  if (a.type !== 'Area') {
    throw new CnmwError('Area.type must be the literal "Area".', 'AREA_EMPTY');
  }
  if (a.crs !== 'EPSG:4326') {
    throw new CnmwError('Only EPSG:4326 (lon/lat) data is supported.', 'AREA_INVALID_CRS', {
      context: { crs: a.crs },
    });
  }
  const geometry = /** @type {AreaGeometry|undefined} */ (a.geometry);
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    throw new CnmwError('This file has points/lines; an area needs polygons.', 'AREA_UNSUPPORTED_GEOMETRY');
  }
  if (!Array.isArray(a.bboxes) || a.bboxes.length < 1) {
    throw new CnmwError('Area.bboxes must have at least one entry.', 'AREA_EMPTY');
  }
  return /** @type {import('./types.js').Area} */ (area);
}

const PROP_PREFIX = 'area:';

/** camelCase -> snake_case. */
function toSnake(key) {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
/** snake_case -> camelCase. */
function toCamel(key) {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function deepSnake(value) {
  if (Array.isArray(value)) return value.map(deepSnake);
  if (value && typeof value === 'object' && !isGeoJsonGeometry(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[toSnake(k)] = deepSnake(v);
    return out;
  }
  return value;
}
function deepCamel(value) {
  if (Array.isArray(value)) return value.map(deepCamel);
  if (value && typeof value === 'object' && !isGeoJsonGeometry(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[toCamel(k)] = deepCamel(v);
    return out;
  }
  return value;
}
function isGeoJsonGeometry(v) {
  return typeof v.type === 'string' && 'coordinates' in v;
}

/**
 * Convert an `Area` to its wire form: a GeoJSON Feature with namespaced
 * `area:*` properties (design doc §1.6).
 * @param {import('./types.js').Area} area
 * @returns {GeoJSON.Feature}
 */
export function toAreaDocument(area) {
  const { geometry, bbox, type, ...rest } = area;
  void type;
  const properties = {};
  for (const [key, value] of Object.entries(rest)) {
    properties[`${PROP_PREFIX}${toSnake(key)}`] = key === 'provenance' ? deepSnake(value) : value;
  }
  // filterGeometry gets its own namespaced key per the §1.6 example.
  properties[`${PROP_PREFIX}filter_geometry`] = area.filterGeometry;
  return {
    type: 'Feature',
    bbox: area.bbox,
    geometry,
    properties,
  };
}

/**
 * Parse an Area wire document back into an `Area`.
 * @param {GeoJSON.Feature} doc
 * @returns {import('./types.js').Area}
 */
export function fromAreaDocument(doc) {
  const props = doc.properties || {};
  const area = { type: 'Area', geometry: doc.geometry, bbox: doc.bbox };
  for (const [key, value] of Object.entries(props)) {
    if (!key.startsWith(PROP_PREFIX)) continue;
    const camel = toCamel(key.slice(PROP_PREFIX.length));
    area[camel] = camel === 'provenance' ? deepCamel(value) : value;
  }
  return validateArea(area);
}
