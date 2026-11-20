# Contributing

Thanks for looking. This is an experimental repo — the APIs are not frozen
and nothing is on npm yet — so the most useful contributions right now are
bug reports from real use, and fixes with a test that failed first.

## Running it

```bash
git clone https://github.com/cholmes/cng-map-widgets.git
cd cng-map-widgets
npm install          # only to run the tests; the library itself needs nothing
python3 serve.py     # then open http://localhost:8000/examples/
```

> ### Do not use `python3 -m http.server`
>
> It answers a `Range` request with **`200` and the whole file**. Nothing
> errors. Every range read silently degrades into a full download — which,
> against the 409 MB Overture index, means the page appears to hang rather
> than fail. `serve.py` is a few lines of stdlib that implements `206`
> properly. `npx serve` also works.

## Verifying

```bash
npm test                              # 711 unit tests, no network
node docs/verify-snippets.mjs         # every snippet in every doc, live data
node docs/verify-snippets.mjs agents  # just AGENTS.md's recipes

python3 serve.py 8000 &
node examples/quickstart/verify.mjs 8000
node examples/download-demo/verify.mjs 8000
```

`npm test` is what CI runs. The `verify-*` scripts hit third-party object
storage, so they are **deliberately not in CI** — a red badge there would
report someone else's uptime, not this code. Run them locally before a
change that touches data access.

If you add a widget to a page, copy the shape of an
[`examples/*/verify.mjs`](examples/): navigate, wait on a visible status
string, assert on the actual map source data
(`map.getSource('cng-area-display')._data`) rather than a screenshot, and
fail on any console error. That pattern caught every real bug in this repo's
history.

## AGENTS.md is executable

[`AGENTS.md`](AGENTS.md) is the agent-facing contract, and every snippet in
it is run against live published data by
[`docs/verify-snippets.mjs`](docs/verify-snippets.mjs). **If you change a
snippet, change it there too** — or the next run fails.

## Identifier naming

Everything in this repo uses the `cng` prefix: the npm scope (`@cng/*`), the
error class (`CngError`/`isCngError`), the CSS custom properties
(`--cng-*`), the CSS classes and DOM ids (`.cng-geocoder`,
`#cng-geocoder-style`), the map source ids (`cng-area-display`,
`cng-area-filter`), the demo test hooks (`window.__cngDemo`), and the
versioned argument shapes (`cng-dataset/1.0`, `cng-filter/1.0`,
`cng-output/1.0`, `cng-request/1.0`, `cng-raster-dataset/1.0`).

All of it was `cnmw` until 2026-11-17/20. If you find a stray `cnmw`
anywhere **except** the one case below, it is a miss — please rename it.

### The one exception, and it is temporary

`cnmw-index/1.0` is still accepted, because it is the `spec` value inside
gazetteer manifests **published on `data.source.coop`** —
`packages/geocoder-core/src/index-loader.js` validates against it, and the
live demo site runs deployed code. Flipping the validator and the catalogs
independently breaks one or the other, so the rollout is: accept both →
republish the catalogs → drop the old.

Tracking: [#1](https://github.com/cholmes/cng-map-widgets/issues/1), which
also proposes replacing this manifest entirely with a pair of STAC
extensions, at which point the `spec` field goes away in favour of an
extension URI in `stac_extensions[]`.

### Things to be careful with, even though they are now `cng`

Renaming these again would break consumers silently, with no test failure:

- **The CSS surface is public API.** `packages/maplibre/README.md` tells host
  pages to theme the control by targeting `.cng-geocoder` and its children
  and by redeclaring any `--cng-*` token. Almost none of it is covered by a
  test — only `.cng-attribution` and the `cng-area-display` source id are
  asserted anywhere. This is the quietest breakage in the repo.
- **`Symbol.for('cng.spec')`** is how two copies of `@cng/spec` recognise
  each other across versions. Change it and they stop agreeing, silently.
- **The versioned argument shapes** (`cng-filter/1.0` and friends) are
  documented in AGENTS.md and README.md as literal values users copy into
  their own request objects. They are not a published wire format — nobody
  else serves one — but they are a copy-paste API.

## House style

- Plain ESM with JSDoc. No TypeScript, no build step, no bundler — that
  constraint is the point of the project, not an accident.
- Error `code` values are API; messages are not. Add codes to the taxonomy in
  [`packages/spec`](packages/spec/README.md#errors), don't invent them inline.
- New dependencies in the browser path need a very good reason. Pinned,
  exact-version CDN URLs only (see any `src/cdn.js`).
- Tests go next to the package they test, run by `node --test`.
