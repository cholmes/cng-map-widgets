// @cngeo/format-gpkg -- pinned sql.js CDN URL + a test-injection seam, the
// same pattern extract-core/src/cdn.js uses for hyparquet-writer (design
// doc §4.2). sql.js's `dist/sql-wasm.js` is a UMD/Emscripten factory, not
// native ESM, but jsdelivr's `+esm` endpoint wraps it into one (measured:
// `export { Module, default }`, the factory as `default` -- see
// experiments/e10-heavy-formats/RESULTS.md). `locateFile` below then
// points the factory at the *same* pinned version's `dist/` so it fetches
// the matching `.wasm` binary, exactly sql.js's documented browser usage.
//
// DEVIATION (documented, same reason as extract-core/src/cdn.js): plain
// Node ESM cannot `import()` an absolute https: URL, so this package's
// tests inject the npm-installed `sql.js` (a devDependency) via
// `setSqlJsModule` instead of exercising this CDN path directly.
export const CDN = {
  sqlJs: 'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/+esm',
  sqlJsWasmBase: 'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/',
};

/** Measured (experiments/e10-heavy-formats/RESULTS.md): sql-wasm.wasm
 *  659,806 bytes raw / 321,893 gzip -9; sql-wasm.js glue 48,788 / 17,352.
 *  Rounded for the UI label. */
export const APPROX_BYTES = { min: 330_000, max: 345_000, estimate: 339_000 };

/** @type {any} */
let testOverride = null;

/** Supply an already-initialized sql.js module ({ Database }) in place of
 *  the dynamic CDN import -- used by this package's own tests and
 *  available to a host that already loads sql.js for its own reasons. */
export function setSqlJsModule(mod) {
  testOverride = mod;
}

export function clearSqlJsModule() {
  testOverride = null;
}

let sqlJsPromise = null;
/** Lazily loads and initializes sql.js, returning `{ Database }`. */
export async function loadSqlJs() {
  if (testOverride) return testOverride;
  if (!sqlJsPromise) {
    sqlJsPromise = import(/* @vite-ignore */ CDN.sqlJs).then((mod) => {
      const initSqlJs = mod.default ?? mod;
      return initSqlJs({ locateFile: (file) => CDN.sqlJsWasmBase + file });
    });
  }
  return sqlJsPromise;
}
