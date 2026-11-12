// @cnmw/upload-core -- shared GeoJSON-value extraction, used by both the
// built-in `geojson-reader.js` (File -> text -> JSON) and `areaFromGeoJson`
// (an already-parsed JS value, e.g. pasted into `attachDropTarget`).

/**
 * Normalize any legal top-level GeoJSON value into a flat array of
 * `{ geometry, properties }` records, deliberately loose (a bare
 * `Geometry`, a `GeometryCollection`, a single `Feature`, or a
 * `FeatureCollection` are all accepted) -- the repair pipeline is what
 * decides which of these are usable, not this step.
 * @param {unknown} json
 * @returns {Array<{ geometry: unknown, properties: Record<string, unknown> }>}
 */
export function extractRawFeatures(json) {
  if (!json || typeof json !== 'object') return [];
  const value = /** @type {Record<string, unknown>} */ (json);
  if (value.type === 'FeatureCollection') {
    return (Array.isArray(value.features) ? value.features : []).map((f) => ({
      geometry: f && typeof f === 'object' ? f.geometry : null,
      properties: (f && typeof f === 'object' && f.properties) || {},
    }));
  }
  if (value.type === 'Feature') {
    return [{ geometry: value.geometry, properties: value.properties || {} }];
  }
  if (value.type === 'GeometryCollection') {
    return (Array.isArray(value.geometries) ? value.geometries : []).map((g) => ({ geometry: g, properties: {} }));
  }
  if (typeof value.type === 'string' && 'coordinates' in value) {
    return [{ geometry: value, properties: {} }]; // bare Geometry
  }
  return [];
}

/**
 * Pre-RFC-7946 GeoJSON's legacy top-level `crs` member
 * (`{ type: 'name', properties: { name: '...' } }`). RFC 7946 dropped it
 * in favor of "always WGS84", but plenty of real files still carry it --
 * `UploadProvenance.declaredCrs` surfaces it verbatim either way.
 * @param {unknown} json
 * @returns {string|null}
 */
export function detectDeclaredCrs(json) {
  if (!json || typeof json !== 'object') return null;
  const crs = /** @type {{ crs?: { properties?: { name?: unknown } } }} */ (json).crs;
  const name = crs?.properties?.name;
  return typeof name === 'string' ? name : null;
}
