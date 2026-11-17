# Publishing cng-map-widgets as an open source repo

**Date:** 2026-11-17 · **Size:** small change · **Status:** approved 2026-11-17

## Intent and why

Move this from a private research repo to a public one under
`github.com/cholmes/cng-map-widgets`, with the example gallery live on
GitHub Pages so someone can *click* the demos before deciding whether to
clone anything. The widgets only make sense when seen running against
live data; a README full of code blocks undersells them.

Secondarily: rename and reframe. `cn-geocoding` names one widget, and the
project is already broader than that (upload, download, raster clip) and
intended to grow. The public name and description should not have to be
re-explained every time something non-geocoding ships.

## Goals

- `github.com/cholmes/cng-map-widgets`, public, MIT, cloneable and runnable
  with `python3 serve.py` and nothing else.
- `https://cholmes.github.io/cng-map-widgets/` lands on something useful and
  reaches every example in one click, all running against live catalogs.
- Project name and description reflect the whole library, not the geocoder.
- CI runs `npm test` on push and PR.

## Non-goals

- Publishing to npm. Still deliberately unpublished; the APIs are not
  frozen. The scope name is being settled now only because it is free to
  change today and expensive later.
- Any build step, bundler, or site generator. The repo's whole argument is
  that none is needed; the Pages site must be the repo, served.
- Rewriting docs. README and AGENTS.md are good; they get renames and
  working links, not a rewrite.
- A custom domain.

## Anti-goals

- A second, drifting copy of `packages/` existing anywhere for the sake of
  the website.
- Pages serving something that differs from what a cloner gets. If the demo
  works on Pages and not on a clone (or vice versa), the repo has lied.

## Constraints

- Examples import `../../packages/*` via relative import maps, so the site
  must serve `packages/` and `examples/` from one root with their current
  relative positions intact.
- Everything reads object storage over HTTP `Range`. GitHub Pages serves
  real range requests; `python3 -m http.server` does not, which is why
  `serve.py` exists and must stay documented.
- Live data lives on `data.source.coop` and is fetched cross-origin. Already
  works from localhost, so CORS is not a new risk at `github.io`.
- `data/` is gitignored; examples that reference `./data/index.json` are
  `?index=local` opt-in paths and must keep falling back to live URLs.

## Approaches considered

1. **Pages "deploy from a branch", `main` / root — chosen.** The repo *is*
   the site. No workflow, no copy, no build; a push is a deploy, and the
   site is byte-for-byte a clone. Needs a root `index.html` and `.nojekyll`.
2. **A Pages Actions workflow uploading the repo as an artifact.** Same
   site, plus the option to gate on tests or exclude `experiments/`. Rejected
   as premature: it buys a test gate that a plain CI workflow gives us
   anyway, at the cost of a deploy that can fail independently of the push.
   This is the right move later if a build step ever appears.
3. **A real `gh-pages` branch holding a copied site.** Rejected. Because the
   examples import `../../packages/*`, the branch would have to carry a
   second copy of the library, which would drift, and "view source" would
   show the copy rather than the repo — violating an anti-goal.

## Decisions

**Name and framing.** Repo, local directory, and `package.json` `name` all
become `cng-map-widgets`. The npm scope becomes `@cng/*`, replacing `@cnmw/*`. Scope and repo name
deliberately do not match: `@cng-map-widgets/download-core` would be 31
characters and "map-widgets" is wrong for `spec`, `download-core` and the
`format-*` packages, which are not map widgets. `cng` reads as
"cloud-native geospatial", a term with currency in this community, where
`cnmw` expands to nothing on sight. Both scopes are unpublished on npm
(verified 2026-11-17: zero packages under either), so this is free to do
now and a mass edit later — 37 cross-package bare imports plus every
example and doc.

**Only the npm scope is renamed.** `cnmw` appears in three unrelated
families in this codebase and merging them would be a serious bug:

1. `@cnmw/*` — the npm scope. Renamed to `@cng/*`.
2. `cnmw-index/1.0`, `cnmw-dataset/1.0`, `cnmw-filter/1.0`,
   `cnmw-output/1.0`, `cnmw-request/1.0`, `cnmw:catalog_version` — **wire
   format identifiers that appear in live published data.** Verified
   2026-11-17: the geoBoundaries manifest on `data.source.coop` carries
   `"spec": "cnmw-index/1.0"`, and `index-loader.js:60` hard-rejects any
   other value with `INDEX_SCHEMA_MISMATCH`. Renaming these would break
   every published catalog the instant it shipped. **Unchanged.**
3. `cnmw-geocoder`, `cnmw-area-display`, `cnmw-border`, and the rest of the
   CSS classes, DOM ids and map source names. `examples/*/verify.mjs`
   asserts on `map.getSource('cnmw-area-display')` and AGENTS.md documents
   that exact string. Renaming is cosmetic churn with real breakage risk.
   **Unchanged.**

So the rename is anchored on the `@` and nothing else. A future reader
seeing `cnmw` survive in the source should read this section.

Noted and accepted: `cng` also reads as the Cloud-Native Geospatial Forum.
Chris made this call knowing that; if the Forum ever wants the npm org,
this repo yields it.
The `description` broadens from the geocoder to the library: composable
zero-build browser widgets for cloud-native geospatial data — find an area
(search, upload, draw) and act on it (download, clip) — with MapLibre and
OpenLayers adapters. README's opening keeps its current structure; the
"geocoder" framing narrows to the widget it describes.

Per standing preference, "geocoder" stays the client-widget word and
"cloud-native gazetteer" stays the data-product word; the once-per-doc
"place-name/boundary lookup, not address geocoding" note stays.

**Pages layout.** Deploy from `main`, root folder.

- New root `index.html`: a short landing page — what this is, the 30-second
  quickstart, and a prominent link into the gallery. Not a redirect; a
  redirect wastes the one URL people will paste.
- New `.nojekyll` (no underscore paths today, but it also stops Jekyll from
  touching anything and speeds deploys).
- `examples/index.html` stays the gallery. Its footer links to `../README.md`
  and friends currently resolve to raw Markdown on Pages; they get pointed at
  the GitHub blob URLs instead so they render.

**CI.** One workflow, `.github/workflows/test.yml`: Node LTS, `npm ci`,
`npm test`, on push to `main` and on PRs. The live-data checks
(`verify-snippets.mjs`, the `examples/*/verify.mjs` scripts) stay out of CI —
they hit third-party object storage and would make the badge a weather report
for someone else's uptime. They stay documented as the local verification path.

**Repo contents.** `experiments/` stays (27 small tracked files; the 181M is
gitignored data, and the RESULTS.md files are the evidence behind the design
decisions). `PLAN.md` moves to `docs/PLAN.md`. `demo-server.py`, currently
untracked, is my call to leave untracked unless it does something `serve.py`
does not — I'll check and say which.

**Community files.** `CONTRIBUTING.md` (how to run it, how to verify, the
`serve.py` trap, that AGENTS.md is the agent-facing contract) and a
`CODE_OF_CONDUCT.md` (Contributor Covenant). No issue templates yet — premature
for a repo with no issues.

## How people use it before npm

Three paths, deliberately presented in this order, because they are not
equally good:

1. **Browser, zero install — the headline.** Once Pages is live,
   `https://cholmes.github.io/cng-map-widgets/packages/geocoder-core/src/index.js`
   is a real ESM module served cross-origin. An import map pointing at those
   URLs makes a single HTML file work with nothing cloned and nothing built.
   This falls out of the chosen Pages approach for free and is the best
   story the project has, so it leads the landing page — ahead of the clone
   instructions, which currently lead the README.
2. **Pinned, via jsDelivr:**
   `https://cdn.jsdelivr.net/gh/cholmes/cng-map-widgets@v0.1.0/packages/...`.
   Same mechanism, but pinnable to a tag, which Pages cannot do. This is the
   honest answer for anyone who wants reproducibility pre-npm, and it is why
   the first push gets a `v0.1.0` tag.
3. **Node and bundler users — worse, and the docs must say so.** `npm i`
   cannot install a subdirectory of a git repo, so there is no way to get
   just `@cng/geocoder-core` from GitHub. They clone and `npm link`, or
   vendor. No workaround exists until npm; the docs state this plainly
   rather than implying parity.

**The gotcha both CDN paths share:** packages cross-import by bare specifier
(37 of them, mostly `@cng/spec`), so a consumer must map *every*
transitively-needed package, not only the one they want. Mapping just
`geocoder-core` fails on `@cng/spec` at runtime. The CDN recipe states why,
and lists the full map.

## Left to the builder

- Exact copy of the root landing page, within the framing above.
- Mechanics of the `@cnmw` → `@cng` rename (it is a literal string
  substitution across sources, examples, docs and `package.json` names;
  `npm test` is the gate that it was complete).
- Whether the rename touches prose beyond names and links (it should not).
- Order of operations, so the public history starts clean: rename and reframe
  as commits on `main`, then create the repo, then push, then enable Pages.

## Verification

- `npm test` green before the first push, which is also the proof that the
  scope rename missed nothing.
- A grep for `@cnmw` returning only intentional historical mentions.
- After Pages is live: the gallery loads, and at least the quickstart and one
  download example run against live data with zero console errors, *from the
  `github.io` origin* — the clone path being green proves nothing about
  Pages' range support or CORS.
