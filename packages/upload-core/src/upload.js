// @cngeo/upload-core -- orchestration: dispatch to a GeometryReader, run
// the repair pipeline, combine (collect/dissolve), build the Area
// (design doc §3.3).
//
// What this module does NOT do (mirrors the "what an adapter must not
// do" boundary from §5.1, applied to a core package instead): it never
// hand-rolls geometry math outside `@cngeo/spec` -- `buildArea` owns
// bbox/antimeridian/simplification, this module only prepares the
// combined geometry and the provenance it is built from.

import { CngError, buildArea, bboxOfGeometry, bboxesIntersect } from '@cngeo/spec';
import { geoJsonReader } from './geojson-reader.js';
import { extractRawFeatures, detectDeclaredCrs } from './geojson-parse.js';
import { repairFeatures } from './repair.js';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB
const DEFAULT_MAX_FEATURES = 10_000;

/** @type {Map<string, import('./types.js').GeometryReader>} */
const readersById = new Map();
/** @type {Map<string, import('./types.js').GeometryReader>} */
const readersByExtension = new Map();
/** @type {Map<string, import('./types.js').GeometryReader>} */
const readersByMediaType = new Map();

function register(reader) {
  readersById.set(reader.id, reader);
  for (const ext of reader.extensions) readersByExtension.set(ext.toLowerCase(), reader);
  for (const mt of reader.mediaTypes) readersByMediaType.set(mt.toLowerCase(), reader);
}

// GeoJSON is built in (design doc §3.3); anything else comes through
// `registerReader()`.
register(geoJsonReader);

/**
 * Register an additional `GeometryReader` for `areaFromFile` to dispatch
 * to by extension or media type (the E4 "more formats" plugin seam:
 * shapefile-js, gdal3.js, etc. -- never imported by this package itself).
 * @param {import('./types.js').GeometryReader} reader
 */
export function registerReader(reader) {
  register(reader);
}

function fileExtension(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

/** @param {File} file */
function findReader(file) {
  const byExt = readersByExtension.get(fileExtension(file.name));
  if (byExt) return byExt;
  const byType = file.type ? readersByMediaType.get(file.type.toLowerCase()) : undefined;
  if (byType) return byType;
  throw new CngError(
    `No registered reader for "${file.name}" (type "${file.type || 'unknown'}"). Register one with registerReader().`,
    'UPLOAD_UNSUPPORTED_FORMAT',
    { context: { filename: file.name, mediaType: file.type } },
  );
}

const CRS84_ALIASES = new Set([
  'epsg:4326',
  'ogc:crs84',
  'crs:84',
  'urn:ogc:def:crs:ogc:1.3:crs84',
  'urn:ogc:def:crs:epsg::4326',
  'urn:ogc:def:crs:epsg:6.6:4326',
]);

function isForeignCrs(declaredCrs) {
  if (!declaredCrs) return false;
  return !CRS84_ALIASES.has(declaredCrs.toLowerCase());
}

/**
 * Concatenate every kept feature's polygon(s) into one MultiPolygon
 * (design doc §1.4's `collect`: "the area is the set of these features",
 * no boolean operation, no failure mode on invalid input).
 * @param {Array<{geometry: import('@cngeo/spec').AreaGeometry}>} features
 * @returns {import('@cngeo/spec').AreaGeometry}
 */
function collectGeometry(features) {
  if (features.length === 1) return features[0].geometry;
  const coordinates = [];
  for (const f of features) {
    if (f.geometry.type === 'Polygon') coordinates.push(f.geometry.coordinates);
    else coordinates.push(...f.geometry.coordinates);
  }
  return { type: 'MultiPolygon', coordinates };
}

/** Pairwise bbox-overlap check across the kept features, for design doc §1.4's `overlapping-features` warning. */
function countOverlappingPairs(features) {
  const bboxes = features.map((f) => bboxOfGeometry(f.geometry));
  let count = 0;
  for (let i = 0; i < bboxes.length; i++) {
    for (let j = i + 1; j < bboxes.length; j++) {
      if (bboxesIntersect(bboxes[i], bboxes[j])) count++;
    }
  }
  return count;
}

/**
 * Shared tail of `areaFromFile`/`areaFromGeoJson`: raw features -> repair
 * -> combine -> `buildArea` -> `UploadResult`.
 * @param {{ rawFeatures: unknown[], declaredCrs: string|null, name: string, bytes: number, mediaType: string }} input
 * @param {import('./types.js').UploadOptions} options
 * @returns {Promise<import('./types.js').UploadResult>}
 */
async function buildUploadResult({ rawFeatures, declaredCrs, name, bytes, mediaType }, options = {}) {
  const maxFeatures = options.maxFeatures ?? DEFAULT_MAX_FEATURES;
  const onForeignCrs = options.onForeignCrs ?? 'reject';

  /** @type {import('./types.js').UploadWarning[]} */
  const warnings = [];

  const foreign = isForeignCrs(declaredCrs);
  if (foreign) {
    if (onForeignCrs === 'reject') {
      throw new CngError('Only EPSG:4326 (lon/lat) data is supported.', 'AREA_INVALID_CRS', {
        context: { declaredCrs },
      });
    }
    warnings.push({ code: 'assumed-4326', declared: declaredCrs });
  }

  if (rawFeatures.length === 0) {
    throw new CngError('No usable polygon in that file.', 'AREA_EMPTY');
  }

  // Distinguish "nothing areal was ever present" (points/lines only) from
  // "a polygon was present but degenerate after repair", per the error
  // table's two distinct codes -- computed before repair since repair
  // itself discards the type information once a ring is dropped.
  const potentiallyAreal = rawFeatures.filter((f) => {
    const g = f && typeof f === 'object' && 'geometry' in f ? f.geometry : f;
    return g && typeof g === 'object' && (g.type === 'Polygon' || g.type === 'MultiPolygon');
  }).length;

  const { features: kept, repairs } = repairFeatures(rawFeatures);
  if (kept.length === 0) {
    if (potentiallyAreal === 0) {
      throw new CngError('This file has points/lines; an area needs polygons.', 'AREA_UNSUPPORTED_GEOMETRY');
    }
    throw new CngError('No usable polygon in that file.', 'AREA_EMPTY');
  }

  if (kept.length > maxFeatures) {
    throw new CngError(`File has ${kept.length} usable features; the limit is ${maxFeatures}.`, 'UPLOAD_TOO_LARGE', {
      context: { limit: 'features', max: maxFeatures, actual: kept.length },
    });
  }

  if (repairs.length > 0) warnings.push({ code: 'repaired', repairs });

  const combine = kept.length === 1 ? 'single' : options.unionMode ?? 'collect';
  let geometry;
  if (combine === 'single') {
    geometry = kept[0].geometry;
  } else if (combine === 'dissolve') {
    if (typeof options.dissolver !== 'function') {
      throw new CngError(
        "unionMode 'dissolve' requires a dissolver function (options.dissolver) -- none was supplied.",
        'INTERNAL',
      );
    }
    geometry = options.dissolver(kept.map((f) => f.geometry));
  } else {
    geometry = collectGeometry(kept);
    const overlapCount = countOverlappingPairs(kept);
    if (overlapCount > 0) warnings.push({ code: 'overlapping-features', count: overlapCount });
  }

  // AreaFeatureRef (design doc §1.2): no publisher id for an upload, but
  // `properties` is carried through verbatim for a consumer that wants to
  // label output (also per §1.2 -- "never interpreted by any @cngeo package").
  const featureRefs = kept.map((f) => ({
    featureId: null,
    name: typeof f.properties?.name === 'string' ? f.properties.name : undefined,
    bbox: bboxOfGeometry(f.geometry),
    properties: f.properties,
  }));

  const area = buildArea({
    name,
    geometry,
    source: 'upload',
    features: featureRefs,
    combine,
    geometryVariant: 'full',
    filterVertexCeiling: options.filterVertexCeiling ?? 10_000,
    provenanceExtra: {
      upload: {
        filename: name,
        bytes,
        mediaType,
        featureCount: kept.length,
        declaredCrs,
        repairs,
      },
    },
  });

  if (area.provenance.simplification) {
    warnings.push(
      area.provenance.simplification.degradedToBbox
        ? { code: 'degraded-to-bbox', detail: area.provenance.simplification }
        : { code: 'simplified', detail: area.provenance.simplification },
    );
  }

  return { area, warnings };
}

/**
 * @param {File} file
 * @param {import('./types.js').UploadOptions} [options]
 * @returns {Promise<import('./types.js').UploadResult>}
 */
export async function areaFromFile(file, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (file.size > maxBytes) {
    throw new CngError(`File is ${file.size} bytes; the limit is ${maxBytes} bytes.`, 'UPLOAD_TOO_LARGE', {
      context: { limit: 'bytes', max: maxBytes, actual: file.size },
    });
  }
  const reader = findReader(file);
  const { features: rawFeatures, declaredCrs } = await reader.read(file, options.signal);
  return buildUploadResult(
    { rawFeatures, declaredCrs, name: file.name, bytes: file.size, mediaType: file.type || reader.mediaTypes[0] || 'application/octet-stream' },
    options,
  );
}

/**
 * @param {unknown} json
 * @param {{ name: string }} meta
 * @param {import('./types.js').UploadOptions} [options]
 * @returns {Promise<import('./types.js').UploadResult>}
 */
export async function areaFromGeoJson(json, meta, options = {}) {
  const rawFeatures = extractRawFeatures(json);
  const declaredCrs = detectDeclaredCrs(json);
  const text = (() => {
    try {
      return JSON.stringify(json);
    } catch {
      return '';
    }
  })();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (text.length > maxBytes) {
    throw new CngError(`Input is ${text.length} bytes; the limit is ${maxBytes} bytes.`, 'UPLOAD_TOO_LARGE', {
      context: { limit: 'bytes', max: maxBytes, actual: text.length },
    });
  }
  return buildUploadResult(
    { rawFeatures, declaredCrs, name: meta?.name ?? 'Uploaded area', bytes: text.length, mediaType: 'application/geo+json' },
    options,
  );
}

/**
 * Wire drag/drop and paste on `el`: a dropped/pasted file goes through
 * `areaFromFile`; pasted GeoJSON text goes through `areaFromGeoJson`.
 * @param {HTMLElement} el
 * @param {(result: import('./types.js').UploadResult) => void} onResult
 * @param {import('./types.js').UploadOptions & { onError?: (e: import('@cngeo/spec').CngError) => void }} [options]
 * @returns {import('./types.js').Unsubscribe}
 */
export function attachDropTarget(el, onResult, options = {}) {
  const onDragOver = (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  async function handleFile(file) {
    try {
      onResult(await areaFromFile(file, options));
    } catch (err) {
      options.onError?.(err);
    }
  }

  const onDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  };

  const onPaste = (e) => {
    const file = e.clipboardData?.files?.[0];
    if (file) {
      void handleFile(file);
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return; // not JSON -- silently ignore, this is a passive listener
    }
    areaFromGeoJson(json, { name: 'Pasted GeoJSON' }, options)
      .then(onResult)
      .catch((err) => options.onError?.(err));
  };

  el.addEventListener('dragover', onDragOver);
  el.addEventListener('drop', onDrop);
  el.addEventListener('paste', onPaste);

  return () => {
    el.removeEventListener('dragover', onDragOver);
    el.removeEventListener('drop', onDrop);
    el.removeEventListener('paste', onPaste);
  };
}
