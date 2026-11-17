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

`cnmw` survives in the source on purpose. It appears in three unrelated
families, and only the first was renamed to `cng`:

| Family | Example | Status |
|---|---|---|
| npm scope | `@cng/geocoder-core` | renamed from `@cnmw` 2026-11-17 |
| **wire format** | `cnmw-index/1.0`, `cnmw-dataset/1.0`, `cnmw:catalog_version` | **frozen** |
| **DOM / CSS / source ids** | `cnmw-area-display`, `cnmw-geocoder`, `cnmw-attribution` | **frozen** |

The wire-format strings appear in **live published catalogs** on
`data.source.coop`; `packages/geocoder-core/src/index-loader.js` rejects any
manifest whose `spec` is not exactly `cnmw-index/1.0`. Renaming them would
break every published gazetteer on contact. The DOM ids are asserted on by
`examples/*/verify.mjs` and documented in AGENTS.md.

Background:
[the publishing design](docs/superpowers/specs/2026-11-17-cng-map-widgets-publish-design.md).

## House style

- Plain ESM with JSDoc. No TypeScript, no build step, no bundler — that
  constraint is the point of the project, not an accident.
- Error `code` values are API; messages are not. Add codes to the taxonomy in
  [`packages/spec`](packages/spec/README.md#errors), don't invent them inline.
- New dependencies in the browser path need a very good reason. Pinned,
  exact-version CDN URLs only (see any `src/cdn.js`).
- Tests go next to the package they test, run by `node --test`.
