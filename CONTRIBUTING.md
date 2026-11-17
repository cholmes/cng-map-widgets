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
(`map.getSource('cnmw-area-display')._data`) rather than a screenshot, and
fail on any console error. That pattern caught every real bug in this repo's
history.

## AGENTS.md is executable

[`AGENTS.md`](AGENTS.md) is the agent-facing contract, and every snippet in
it is run against live published data by
[`docs/verify-snippets.mjs`](docs/verify-snippets.mjs). **If you change a
snippet, change it there too** — or the next run fails.

## Strings you must not rename

`cnmw` survives in the source on purpose. It appears in several unrelated
families, and only two were renamed to `cng`:

| Family | Example | Status |
|---|---|---|
| npm scope | `@cng/geocoder-core` | renamed from `@cnmw` 2026-11-17 |
| error class | `CngError`, `isCngError` | renamed from `CnmwError` 2026-11-17 |
| **published wire format** | `cnmw-index/1.0`, `cnmw:catalog_version` | **frozen** |
| **client-side spec strings** | `cnmw-dataset/1.0`, `cnmw-filter/1.0`, `cnmw-output/1.0`, `cnmw-request/1.0`, `cnmw-raster-dataset/1.0` | **frozen** |
| **cross-version registry key** | `Symbol.for('cnmw.spec')` | **frozen** |
| **CSS custom properties** | all 14 `--cnmw-*` theming tokens | **frozen — public API** |
| **CSS classes & DOM ids** | all 35 `.cnmw-*` classes, `#cnmw-geocoder-style` | **frozen — public API** |
| **map source ids** | `cnmw-area-display`, `cnmw-area-filter` | **frozen** |
| **demo test hooks** | `window.__cnmwDemo`, `__cnmwLastResult`, … | **frozen** |

Why each one matters:

- **`cnmw-index/1.0` and `cnmw:catalog_version` are the only two that appear
  in data we do not control.** They are in live published catalogs on
  `data.source.coop` right now — `packages/geocoder-core/src/index-loader.js`
  rejects any manifest whose `spec` is not exactly `cnmw-index/1.0`. Renaming
  either breaks every published gazetteer on contact.
- The **client-side spec strings** never travel to object storage, but they
  are documented in AGENTS.md and README.md as literal values users copy into
  their own `DownloadRequest` objects, and `dataset-resolve.js` /
  `raster-core/src/plan.js` validate them. Renaming silently invalidates
  every request object anyone has written.
- **`Symbol.for('cnmw.spec')`** is how two copies of `@cng/spec` recognise
  each other across versions. Change it and they stop agreeing — silently.
- **The CSS surface is public API, and nothing tests it.** The control's CSS
  is injected as a string, and `packages/maplibre/README.md` tells host pages
  to theme it by "targeting `.cnmw-geocoder` and its children" and by
  redeclaring any `--cnmw-*` token. Rename those and every host page's theme
  overrides stop applying, with **no test failure** — only `.cnmw-attribution`
  and the `cnmw-area-display` source id are asserted anywhere. This is the
  most dangerous family in the table precisely because it is the quietest.

If you are tempted to "finish the rename", this table is why it is already
finished.

## House style

- Plain ESM with JSDoc. No TypeScript, no build step, no bundler — that
  constraint is the point of the project, not an accident.
- Error `code` values are API; messages are not. Add codes to the taxonomy in
  [`packages/spec`](packages/spec/README.md#errors), don't invent them inline.
- New dependencies in the browser path need a very good reason. Pinned,
  exact-version CDN URLs only (see any `src/cdn.js`).
- Tests go next to the package they test, run by `node --test`.
