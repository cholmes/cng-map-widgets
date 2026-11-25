#!/usr/bin/env node
// Build packages/maplibre/vendor/deck-stack.js -- deck.gl + luma.gl +
// Development Seed's deck.gl-raster as ONE ES module.
//
//   node tools/build-deck-bundle.mjs           build and write the bundle
//   node tools/build-deck-bundle.mjs --check   exit 1 if any committed output
//                                              differs from a fresh build
//
// Outputs (all committed):
//   deck-stack.js              the bundle
//   deck-stack.js.LEGAL.txt    licence comments esbuild lifted out of it
//   deck-stack.js.NOTICES.txt  every bundled package, its licence and text
//
// This is the only build step in the repo, and it exists for one reason:
// deck.gl-raster needs exactly one copy of @deck.gl/core and @luma.gl/core
// on the page (see packages/maplibre/src/deck-loader.js). The output is
// committed, so a consumer still needs no build of their own.
//
// Two things a naive `esbuild --bundle` gets wrong, both fixed here by
// rewriting one line of an upstream file:
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
//
// Both rewrites FAIL THE BUILD when they do not land, three ways: the exact
// source line must occur once in the file; each rewrite must have run the
// expected number of times (so a renamed or moved upstream file, which would
// simply never match the path filter, is caught); and the finished bundle is
// checked for what must and must not be in it.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'packages/maplibre/vendor');
const entry = path.join(vendorDir, 'deck-entry.js');
const outfile = path.join(vendorDir, 'deck-stack.js');
const legalFile = `${outfile}.LEGAL.txt`;
const noticesFile = `${outfile}.NOTICES.txt`;

const WORKER_LINE = 'new Worker(new URL("./worker.js", import.meta.url), { type: "module" })';
const LERC_LINE = 'await lerc.load();';

// Resolve everything the way the entry module would.
const require = createRequire(entry);

/** The package.json (and its directory) that owns a file, walking up. */
async function owningPackage(file) {
  let dir = path.dirname(file);
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) return { dir, pkg };
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`build-deck-bundle: no package.json above ${file}`);
    dir = parent;
  }
}

/** Version of an installed package, as resolved from `from`. */
async function versionOf(name, from = require) {
  const { pkg } = await owningPackage(from.resolve(name));
  if (pkg.name !== name) throw new Error(`build-deck-bundle: resolving ${name} landed in ${pkg.name}`);
  return pkg.version;
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
const lercVersion = await versionOf('lerc', geotiffRequire);
const LERC_WASM_URL = `https://cdn.jsdelivr.net/npm/lerc@${lercVersion}/lerc-wasm.wasm`;

const common = {
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  metafile: true,
  logLevel: 'warning',
  // lerc's ES build does `await import("module")` inside a Node-only branch
  // (`process.versions.node`). It never runs in a browser; leave it unresolved.
  external: ['module'],
};

async function buildAll() {
  const hits = { lercInWorker: 0, lercInMain: 0, worker: 0 };

  /** Fix 2: point the LERC codec at a pinned wasm URL. */
  const lercPlugin = (counter) => ({
    name: 'cng-lerc-wasm',
    setup(b) {
      b.onLoad({ filter: /[\\/]@developmentseed[\\/]geotiff[\\/]dist[\\/]codecs[\\/]lerc\.js$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        hits[counter]++;
        return {
          contents: replaceOnce(source, LERC_LINE, `await lerc.load({ locateFile: () => ${JSON.stringify(LERC_WASM_URL)} });`, args.path),
          loader: 'js',
        };
      });
    },
  });

  // The decode worker, as a module-worker script in a string. ESM, not IIFE:
  // the LZW decoder initialises its wasm with a top-level await.
  const worker = await build({
    ...common,
    entryPoints: [require.resolve('@developmentseed/geotiff/pool/worker')],
    format: 'esm',
    legalComments: 'none',
    plugins: [lercPlugin('lercInWorker')],
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
        hits.worker++;
        return {
          contents:
            'import { cngWorkerUrl } from "cng-deck-worker";\n' +
            replaceOnce(source, WORKER_LINE, 'new Worker(cngWorkerUrl(), { type: "module" })', args.path),
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
        `deck.gl-raster ${versions.raster}. GENERATED by tools/build-deck-bundle.mjs -- do not edit. ` +
        'Third-party licences: deck-stack.js.NOTICES.txt',
    },
    plugins: [workerPlugin, lercPlugin('lercInMain')],
  });

  const files = new Map(main.outputFiles.map((f) => [f.path, Buffer.from(f.contents)]));
  const bundleText = files.get(outfile)?.toString('utf8');
  if (!bundleText) throw new Error(`build-deck-bundle: esbuild produced no ${outfile}`);

  // --- Did both rewrites really land? ---------------------------------------
  const problems = [];
  if (hits.worker !== 1) problems.push(`the decode-worker rewrite ran ${hits.worker} times, expected 1 (did geotiff's dist/pool/pool.js move?)`);
  if (hits.lercInWorker !== 1) problems.push(`the LERC rewrite ran ${hits.lercInWorker} times in the worker build, expected 1 (did geotiff's dist/codecs/lerc.js move?)`);
  if (hits.lercInMain !== 1) problems.push(`the LERC rewrite ran ${hits.lercInMain} times in the main build, expected 1`);
  if (!workerSource.includes(LERC_WASM_URL)) problems.push('the worker source does not contain the pinned LERC wasm URL');
  if (!bundleText.includes(LERC_WASM_URL)) problems.push('the bundle does not contain the pinned LERC wasm URL');
  if (bundleText.includes('./worker.js')) problems.push('the bundle still refers to "./worker.js": a decode worker would be started from a URL that does not exist');
  if (!bundleText.includes('createObjectURL')) problems.push('the bundle never creates a Blob URL for the decode worker');
  if (problems.length) throw new Error(`build-deck-bundle: the build is not usable:\n  - ${problems.join('\n  - ')}`);

  files.set(noticesFile, Buffer.from(await notices([worker.metafile, main.metafile]), 'utf8'));
  return { files, versions };
}

/**
 * Every package whose code is in the bundle, with its licence and licence
 * text. esbuild's own `legalComments` lifts only `/*!` banners, which most of
 * these packages do not carry -- and MIT, BSD and ISC all require the notice
 * to travel with the code.
 */
async function notices(metafiles) {
  const inputs = new Set();
  // `outputs[].inputs[].bytesInOutput`, not `meta.inputs`: the latter lists
  // every file esbuild READ, including whole packages tree-shaking removed.
  for (const meta of metafiles) {
    for (const output of Object.values(meta.outputs)) {
      for (const [file, info] of Object.entries(output.inputs)) {
        if (info.bytesInOutput > 0 && file.includes('node_modules')) inputs.add(path.resolve(root, file));
      }
    }
  }
  const packages = new Map();
  for (const file of inputs) {
    const { dir, pkg } = await owningPackage(file);
    packages.set(`${pkg.name}@${pkg.version}`, { dir, pkg });
  }
  const sections = [];
  for (const key of [...packages.keys()].sort()) {
    const { dir, pkg } = packages.get(key);
    const names = (await readdir(dir)).filter((n) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(n)).sort();
    const texts = [];
    for (const name of names) texts.push((await readFile(path.join(dir, name), 'utf8')).replace(/\r\n/g, '\n').trim());
    const licence = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see package');
    const home = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? pkg.homepage ?? '');
    sections.push(
      `${'='.repeat(78)}\n${key}\nLicence: ${licence}${home ? `\nSource: ${home}` : ''}\n${'='.repeat(78)}\n\n` +
        (texts.length ? texts.join('\n\n') : `(This package ships no licence file. Its package.json declares: ${licence}.)`),
    );
  }
  return (
    'Third-party software in deck-stack.js\n' +
    '=====================================\n\n' +
    'deck-stack.js bundles code from the packages below. GENERATED by\n' +
    'tools/build-deck-bundle.mjs from the list of files esbuild actually\n' +
    `included -- do not edit. ${sections.length} packages.\n\n` +
    sections.join('\n\n\n') +
    '\n'
  );
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rel = (file) => path.relative(root, file);

const { files, versions } = await buildAll();

if (process.argv.includes('--check')) {
  const stale = [];
  for (const [file, fresh] of files) {
    let committed;
    try {
      committed = await readFile(file);
    } catch {
      stale.push(`${rel(file)} is missing`);
      continue;
    }
    if (sha(committed) !== sha(fresh)) stale.push(`${rel(file)} is out of date (committed ${sha(committed).slice(0, 12)}, fresh build ${sha(fresh).slice(0, 12)})`);
  }
  if (stale.length) {
    console.error(`${stale.join('\n')}\nRun: npm run build:deck`);
    process.exit(1);
  }
  console.log(`${[...files.keys()].map(rel).join(', ')}: up to date (bundle ${sha(files.get(outfile)).slice(0, 12)}).`);
} else {
  for (const [file, contents] of files) {
    await writeFile(file, contents);
    console.log(`wrote ${rel(file)}: ${contents.length.toLocaleString()} bytes, sha256 ${sha(contents).slice(0, 12)}`);
  }
  console.log('versions:', JSON.stringify(versions));
}
