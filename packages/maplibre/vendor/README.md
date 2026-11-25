# vendor/

| file | what it is |
|---|---|
| `deck-stack.js` | **Generated, committed.** deck.gl + luma.gl + Development Seed's deck.gl-raster as one ES module. Loaded at runtime by `../src/deck-loader.js`. |
| `deck-stack.js.LEGAL.txt` | **Generated, committed.** The licence comments esbuild lifted out of the bundle. |
| `deck-stack.js.NOTICES.txt` | **Generated, committed.** Every package whose code is in the bundle, with its licence and licence text. Ships with the bundle because MIT, BSD and ISC require the notice to travel with the code. |
| `deck-entry.js` | The bundle's source: the list of what it exports. Not loaded at runtime. |

Do not edit `deck-stack.js`. To change what it contains, edit `deck-entry.js`
(and `DECK_REQUIRED_EXPORTS` in `../src/deck-loader.js`), or the pinned
versions in `../package.json`, then:

```bash
npm run build:deck     # rebuild
npm run check:deck     # exit 1 if the committed bundle is stale
node experiments/e12-deck-bundle/verify.mjs 8123   # prove it still draws (needs serve.py + network)
```

Then update `APPROX_BYTES` in `../src/deck-loader.js` with the new gzip size.

## Why a committed bundle in a no-build repo

deck.gl-raster needs exactly one copy of `@deck.gl/core` and `@luma.gl/core`
on the page; two copies break rendering silently and leak GPU textures. The
per-package CDN builds every other dependency here uses cannot guarantee that
for deck.gl. One bundle can. It is committed, not built in CI only, because
these packages are also consumed as raw files from GitHub Pages and jsDelivr's
`gh@tag` endpoint, where a CI artifact would not exist.

Consumers still need no build step. A host that already bundles deck.gl calls
`setDeckModules()` with its own copy and never loads this file.

Measurements and the full reasoning: `experiments/e12-deck-bundle/RESULTS.md`.
