// Test-only: inject the npm-installed sql.js package (a devDependency) in
// place of this package's dynamic CDN import -- see ../../src/cdn.js's
// module doc comment for why plain `node --test` needs this (Node ESM
// cannot `import()` an absolute https: URL). Import this module's
// `initializedSqlJs` before any test that calls `createGpkgFormat`.

import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

export const initializedSqlJs = initSqlJs({ wasmBinary: readFileSync(wasmPath) });
