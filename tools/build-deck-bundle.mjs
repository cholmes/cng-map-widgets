#!/usr/bin/env node
// Build packages/maplibre/vendor/deck-stack.js -- deck.gl + luma.gl +
// Development Seed's deck.gl-raster as ONE ES module.
//
//   node tools/build-deck-bundle.mjs           build and write the bundle
//   node tools/build-deck-bundle.mjs --check   exit 1 if the committed bundle
//                                              differs from a fresh build
//
// This is the only build step in the repo, and it exists for one reason:
// deck.gl-raster needs exactly one copy of @deck.gl/core and @luma.gl/core
// on the page (see packages/maplibre/src/deck-loader.js). The output is
// committed, so a consumer still needs no build of their own.
//
// Two things a naive `esbuild --bundle` gets wrong, both fixed here by
// rewriting one line of an upstream file and FAILING THE BUILD if that line
// is no longer there (so an upstream change cannot silently un-fix it):
//
// 1. The COG decode worker. `defaultDecoderPool()` does
//      new Worker(new URL("./worker.js", import.meta.url), { type: "module" })
//    In a single-file bundle that URL points at a file that does not exist,
//    and even a real file fails when the bundle is served from another origin
//    (jsDelivr, GitHub Pages): browsers refuse a cross-origin Worker script.
//    So the worker is bundled separately to a string and started from a Blob
//    URL, which is same-origin by construction.
//
// 2. The LERC codec. `lerc.load()` locates `lerc-wasm.wasm` next to its own
//    module; from a bundle (and from a Blob worker) there is no "next to".
//    It is pointed at a pinned CDN URL instead.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'packages/maplibre/vendor');
const entry = path.join(vendorDir, 'deck-entry.js');
const outfile = path.join(vendorDir, 'deck-stack.js');
const legalFile = `${outfile}.LEGAL.txt`;

// Resolve everything the way the entry module would.
const require = createRequire(entry);

/** Version of an installed package, found by walking up from its resolved entry. */
async function versionOf(name) {
  let dir = path.dirname(require.resolve(name));
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) return pkg.version;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not find package.json for ${name}`);
    dir = parent;
  }
}

/** Replace exactly one occurrence, or fail the build naming what moved. */
function replaceOnce(source, needle, replacement, where) {
  const first = source.indexOf(needle);
  if (first === -1 || source.indexOf(needle, first + 1) !== -1) {
    throw new Error(
      `build-deck-bundle: expected exactly one occurrence of\n  ${needle}\nin ${where}. ` +
        'Upstream changed; re-read the file and update this rewrite.',
    );
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

const geotiffRequire = createRequire(require.resolve('@developmentseed/geotiff'));
const lercVersion = await (async () => {
  const lercEntry = geotiffRequire.resolve('lerc');
  let dir = path.dirname(lercEntry);
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'lerc') return pkg.version;
    } catch {
      /* keep walking */
    }
    dir = path.dirname(dir);
  }
})();
const LERC_WASM_URL = `https://cdn.jsdelivr.net/npm/lerc@${lercVersion}/lerc-wasm.wasm`;

/** Fix 2: point the LERC codec at a pinned wasm URL. */
const lercPlugin = {
  name: 'cng-lerc-wasm',
  setup(b) {
    b.onLoad({ filter: /[\\/]@developmentseed[\\/]geotiff[\\/]dist[\\/]codecs[\\/]lerc\.js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      return {
        contents: replaceOnce(
          source,
          'await lerc.load();',
          `await lerc.load({ locateFile: () => ${JSON.stringify(LERC_WASM_URL)} });`,
          args.path,
        ),
        loader: 'js',
      };
    });
  },
};

const common = {
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  logLevel: 'warning',
  // lerc's ES build does `await import("module")` inside a Node-only branch
  // (`process.versions.node`). It never runs in a browser; leave it unresolved.
  external: ['module'],
};

async function buildAll() {
  // The decode worker, as a module-worker script in a string. ESM, not IIFE:
  // the LZW decoder initialises its wasm with a top-level await.
  const worker = await build({
    ...common,
    entryPoints: [require.resolve('@developmentseed/geotiff/pool/worker')],
    format: 'esm',
    legalComments: 'none',
    plugins: [lercPlugin],
  });
  const workerSource = worker.outputFiles[0].text;

  /** Fix 1: start the decode worker from a Blob URL. */
  const workerPlugin = {
    name: 'cng-blob-worker',
    setup(b) {
      b.onResolve({ filter: /^cng-deck-worker$/ }, () => ({ path: 'cng-deck-worker', namespace: 'cng' }));
      b.onLoad({ filter: /.*/, namespace: 'cng' }, () => ({
        contents:
          `const source = ${JSON.stringify(workerSource)};\n` +
          'let url;\n' +
          'export function cngWorkerUrl() {\n' +
          "  return (url ??= URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));\n" +
          '}\n',
        loader: 'js',
      }));
      b.onLoad({ filter: /[\\/]@developmentseed[\\/]geotiff[\\/]dist[\\/]pool[\\/]pool\.js$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        return {
          contents:
            'import { cngWorkerUrl } from "cng-deck-worker";\n' +
            replaceOnce(
              source,
              'new Worker(new URL("./worker.js", import.meta.url), { type: "module" })',
              'new Worker(cngWorkerUrl(), { type: "module" })',
              args.path,
            ),
          loader: 'js',
        };
      });
    },
  };

  const versions = {
    deck: await versionOf('@deck.gl/core'),
    luma: await versionOf('@luma.gl/core'),
    raster: await versionOf('@developmentseed/deck.gl-raster'),
    geotiff: await versionOf('@developmentseed/geotiff'),
    loaders: await versionOf('@loaders.gl/mvt'),
    proj4: await versionOf('proj4'),
  };

  const main = await build({
    ...common,
    entryPoints: [entry],
    outfile,
    format: 'esm',
    legalComments: 'linked',
    define: { __CNG_DECK_VERSIONS__: JSON.stringify(versions) },
    banner: {
      js:
        `// @cngeo/maplibre vendor bundle: deck.gl ${versions.deck}, luma.gl ${versions.luma}, ` +
        `deck.gl-raster ${versions.raster}. GENERATED by tools/build-deck-bundle.mjs -- do not edit.`,
    },
    plugins: [workerPlugin, lercPlugin],
  });

  const files = new Map(main.outputFiles.map((f) => [f.path, f.contents]));
  return { files, versions };
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const { files, versions } = await buildAll();
const built = files.get(outfile);
if (!built) throw new Error(`build-deck-bundle: esbuild produced no ${outfile}`);

if (process.argv.includes('--check')) {
  let committed;
  try {
    committed = await readFile(outfile);
  } catch {
    console.error(`${path.relative(root, outfile)} is missing. Run: npm run build:deck`);
    process.exit(1);
  }
  if (sha(committed) !== sha(built)) {
    console.error(
      `${path.relative(root, outfile)} is out of date (committed ${sha(committed).slice(0, 12)}, ` +
        `fresh build ${sha(built).slice(0, 12)}). Run: npm run build:deck`,
    );
    process.exit(1);
  }
  console.log(`${path.relative(root, outfile)} is up to date (${sha(built).slice(0, 12)}).`);
} else {
  for (const [file, contents] of files) await writeFile(file, contents);
  console.log(`wrote ${path.relative(root, outfile)}: ${built.length.toLocaleString()} bytes, sha256 ${sha(built).slice(0, 12)}`);
  if (files.has(legalFile)) console.log(`wrote ${path.relative(root, legalFile)}`);
  console.log('versions:', JSON.stringify(versions));
}
