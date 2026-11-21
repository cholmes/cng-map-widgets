// @cngeo/format-flatgeobuf -- pinned CDN URL + test-injection seam, the
// same pattern as @cngeo/format-gpkg/src/cdn.js and download-core's own
// cdn.js. flatgeobuf's `geojson` submodule (not its full `.` export,
// which also pulls in the generic Arrow-adjacent machinery this plugin
// never touches) is what actually serializes a FeatureCollection; jsdelivr's
// `+esm` wraps its `dist/esm/geojson.js` into real ESM (measured: 37,603
// bytes raw / 10,074 bytes gzip -- see experiments/e10-heavy-formats/RESULTS.md).
export const CDN = {
  flatgeobufGeojson: 'https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/dist/esm/geojson.js/+esm',
};

/** Measured, experiments/e10-heavy-formats/RESULTS.md. */
export const APPROX_BYTES = { min: 9_500, max: 11_000, estimate: 10_100 };

/** @type {any} */
let testOverride = null;

/** Supply the already-imported `flatgeobuf/geojson` module (or npm-installed
 *  equivalent) in place of the dynamic CDN import -- used by this
 *  package's own tests (plain Node ESM cannot `import()` an absolute
 *  https: URL). */
export function setFlatGeobufModule(mod) {
  testOverride = mod;
}

export function clearFlatGeobufModule() {
  testOverride = null;
}

let modulePromise = null;
/** Lazily loads the `flatgeobuf/geojson` module, returning `{ serialize, deserialize }`. */
export async function loadFlatGeobuf() {
  if (testOverride) return testOverride;
  if (!modulePromise) modulePromise = import(/* @vite-ignore */ CDN.flatgeobufGeojson);
  return modulePromise;
}
