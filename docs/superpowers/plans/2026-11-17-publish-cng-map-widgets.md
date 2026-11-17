# Publish cng-map-widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship this repo publicly as `github.com/cholmes/cng-map-widgets` with the example gallery live on GitHub Pages and a zero-install CDN path documented.

**Architecture:** No build step anywhere. GitHub Pages deploys from `main` at root, so the served site *is* the repo and every relative import map keeps working unchanged. The npm scope is renamed `@cnmw`→`@cng` by a substitution anchored on `@`; all other `cnmw` strings are load-bearing and stay.

**Tech Stack:** Plain ESM + JSDoc, import maps, `node --test`, GitHub Pages, GitHub Actions, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-11-17-cng-map-widgets-publish-design.md`

## Global Constraints

- Public repo name: `cng-map-widgets`. Local directory renamed to match.
- npm scope: `@cng/*`. Packages stay at version `0.1.0`, `private: true` at root.
- **Rename `@cnmw/` only.** Never touch `cnmw-index/1.0`, `cnmw-dataset/1.0`, `cnmw-filter/1.0`, `cnmw-output/1.0`, `cnmw-request/1.0`, `cnmw:catalog_version` (live wire format), or `cnmw-*` CSS classes / DOM ids / map source names.
- No build step, bundler, or site generator is introduced.
- Nothing is published to npm.
- Terminology: "geocoder" = the client widget; "cloud-native gazetteer" = the data product; each doc says "place-name/boundary lookup, not address geocoding" once.
- Pages URL base: `https://cholmes.github.io/cng-map-widgets/`.

## Review Focus

Five things the spec implies that no task's happy path exercises:

1. **Wire-format strings caught by an over-broad rename** — a `sed 's/cnmw/cng/'` without the `@` anchor silently breaks every published catalog. Pinned by Task 1's guard test.
2. **Pages serving `.js` as the wrong MIME type** — an ESM module served as `text/plain` fails to execute with a console error and no network error. Pinned by Task 8.
3. **Pages not honoring HTTP `Range`** — range reads degrade to full downloads of a 409 MB index with no error, only slowness. Pinned by Task 8.
4. **A CDN import map missing a transitive package** — mapping only `geocoder-core` throws on the bare `@cng/spec` specifier at runtime. Pinned by Task 5's documented full map.
5. **`?index=local` paths on a published site** — these point at gitignored `data/`, so they 404 for every public visitor. Must remain opt-in and never the default. Pinned by Task 8.

---

### Task 1: Rename the npm scope `@cnmw` → `@cng`

**Files:**
- Modify: every tracked file containing `@cnmw` (148 files, 857 occurrences), including all `packages/*/package.json` `name` fields
- Do not modify: `package-lock.json` is regenerated, not hand-edited

**Interfaces:**
- Produces: bare specifiers `@cng/spec`, `@cng/geocoder-core`, `@cng/upload-core`, `@cng/download-core`, `@cng/maplibre`, `@cng/openlayers`, `@cng/raster-core`, `@cng/format-gpkg`, `@cng/format-shapefile`, `@cng/format-flatgeobuf`, `@cng/format-extras` — every later task and every import map uses these.

- [ ] **Step 1: Record the pre-rename guard counts**

Run and save the output; these are the numbers Step 4 asserts against:
```bash
git ls-files -z | xargs -0 grep -ohI 'cnmw-index/1.0\|cnmw-dataset/1.0\|cnmw-filter/1.0\|cnmw-output/1.0\|cnmw-request/1.0\|cnmw:catalog_version' | wc -l
git ls-files -z | xargs -0 grep -ohI 'cnmw-area-display\|cnmw-geocoder\|cnmw-attribution' | wc -l
```

- [ ] **Step 2: Substitute, anchored on the `@`**

```bash
git ls-files -z | xargs -0 grep -lI '@cnmw/' | xargs sed -i '' 's|@cnmw/|@cng/|g'
```

- [ ] **Step 3: Verify no `@cnmw` remains**

Run: `git ls-files -z | xargs -0 grep -nI '@cnmw' ; echo "exit=$?"`
Expected: no matches (grep exit 1).

- [ ] **Step 4: Verify the load-bearing strings are untouched**

Re-run both commands from Step 1. Expected: **identical counts**. A drop means the substitution was over-broad — revert with `git checkout -- .` and redo Step 2 with the `@` anchor.

- [ ] **Step 5: Regenerate the lockfile and run the suite**

Run: `rm -rf node_modules package-lock.json && npm install && npm test`
Expected: all tests pass. This is the real proof the rename was complete — a missed specifier is an unresolved import, not a silent pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "rename: npm scope @cnmw -> @cng

Anchored on the @ so wire-format identifiers (cnmw-index/1.0 and
siblings, live in published catalogs) and CSS/DOM ids are untouched."
```

---

### Task 2: Rename the project and broaden its description

**Files:**
- Modify: `package.json` (`name`, `description`, `keywords`)
- Modify: `README.md` (title line, opening paragraph, any `cn-geocoding` mention)
- Modify: `AGENTS.md` (any `cn-geocoding` mention)

- [ ] **Step 1: Find every project-name mention**

Run: `git ls-files -z | xargs -0 grep -nI 'cn-geocoding'`
Expected: a short list. Each one gets reviewed, not blind-substituted — some may be prose about the geocoder rather than the project.

- [ ] **Step 2: Set `package.json` name and description**

`name` becomes `cng-map-widgets`. `description` becomes:

> Composable, zero-build browser widgets for cloud-native geospatial data: find an area — search a published gazetteer, upload a GeoJSON, draw one — then act on it, filtering and downloading datasets or clipping rasters, entirely over HTTP range requests against object storage. MapLibre and OpenLayers adapters.

Add `raster`, `cog`, `widgets` to `keywords`; keep the rest.

- [ ] **Step 3: Broaden the README opening**

Keep the existing three-bullet structure and the `Area` seam paragraph — they are good. Change only the framing so the geocoder reads as *one* widget rather than the subject: the library is for finding an area and acting on it, and the set of widgets is open-ended. Keep the "Status: experimental" callout.

- [ ] **Step 4: Verify terminology holds**

Run: `grep -n 'address geocoding' README.md AGENTS.md`
Expected: the "place-name/boundary lookup, not address geocoding" line still present in each.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test` → pass.
```bash
git add -A && git commit -m "rename: cn-geocoding -> cng-map-widgets, broaden description beyond the geocoder"
```

---

### Task 3: Restructure the repo root for a public front door

**Files:**
- Move: `PLAN.md` → `docs/PLAN.md`
- Delete: `demo-server.py` (untracked; byte-identical to `serve.py`, verified 2026-11-17)
- Create: `.nojekyll`
- Create: `CONTRIBUTING.md`
- Create: `CODE_OF_CONDUCT.md`

- [ ] **Step 1: Move PLAN.md and fix inbound links**

```bash
git mv PLAN.md docs/PLAN.md
git ls-files -z | xargs -0 grep -nI 'PLAN\.md'
```
Update each hit to `docs/PLAN.md` (note `examples/index.html` links `../PLAN.md` → `../docs/PLAN.md`).

- [ ] **Step 2: Delete the duplicate server**

Run: `rm -f demo-server.py`

- [ ] **Step 3: Create `.nojekyll`**

Empty file at repo root. Stops Jekyll processing and speeds deploys.

- [ ] **Step 4: Write `CONTRIBUTING.md`**

Covers, in this order: how to run it (`python3 serve.py`, **and that `python3 -m http.server` silently breaks every range read** — the single highest-value warning in the repo); how to verify (`npm test`, `node docs/verify-snippets.mjs`, the `examples/*/verify.mjs` pattern); that `AGENTS.md` is the agent-facing contract and its snippets are executed by `docs/verify-snippets.mjs`, so changing one means changing both; and the `cnmw` wire-format strings that must never be renamed, with a pointer to the spec section.

- [ ] **Step 5: Add a Contributor Covenant**

Standard Contributor Covenant v2.1 text, contact set to Chris's public GitHub handle (`@cholmes`) — **not an email address**.

- [ ] **Step 6: Verify nothing broke and commit**

Run: `npm test` → pass. Run `node docs/verify-snippets.mjs` → pass (it reads AGENTS.md paths).
```bash
git add -A && git commit -m "repo: public front door — CONTRIBUTING, code of conduct, .nojekyll, PLAN.md to docs/"
```

---

### Task 4: Root landing page

**Files:**
- Create: `index.html` (repo root)

**Interfaces:**
- Consumes: `examples/index.html` as the gallery it links to; the `@cng/*` specifiers from Task 1.

- [ ] **Step 1: Write `index.html`**

A single self-contained page, no build, visually consistent with `examples/index.html` (reuse its CSS variables and card styling so the two read as one site). Content, in order:

1. Title and the broadened one-line description from Task 2.
2. **The zero-install CDN quickstart, first** — a complete copy-pasteable HTML file whose import map points at `https://cholmes.github.io/cng-map-widgets/packages/...`, working with nothing cloned. This leads because it is the project's best story.
3. A prominent link to `examples/` ("See it running →").
4. The clone path (`git clone`, `python3 serve.py`) with the `-m http.server` warning.
5. A short package table and links to README, AGENTS.md, the architecture doc, and the GitHub repo.
6. The "Status: experimental, not on npm" callout.

The import map in (2) **must list every package**, not just `geocoder-core`, with a one-line comment saying why: packages cross-import by bare specifier.

- [ ] **Step 2: Verify it serves and the links resolve**

```bash
python3 serve.py 8000 &
curl -sf localhost:8000/index.html > /dev/null && echo "root ok"
curl -sf localhost:8000/examples/index.html > /dev/null && echo "gallery ok"
curl -sf localhost:8000/packages/geocoder-core/src/index.js > /dev/null && echo "module ok"
```
Expected: three `ok` lines.

- [ ] **Step 3: Commit**

```bash
git add index.html && git commit -m "site: root landing page, leading with the zero-install CDN path"
```

---

### Task 5: Document the pre-npm install paths

**Files:**
- Modify: `README.md` (new "Installing" section)
- Modify: `AGENTS.md` (Setup section — add the CDN map alongside the local one)
- Modify: `examples/index.html` (footer links)

- [ ] **Step 1: Write the README "Installing" section**

Three paths in the spec's order, with their honest tradeoffs:
1. Browser, zero install — Pages import map.
2. Pinned — `https://cdn.jsdelivr.net/gh/cholmes/cng-map-widgets@v0.1.0/packages/...`.
3. Node/bundler — **clone and `npm link`, or vendor.** State plainly that `npm i` cannot install a subdirectory of a git repo, so there is no way to get a single `@cng/*` package from GitHub, and that this is fixed only by publishing to npm.

Include the full import map and the cross-import warning.

- [ ] **Step 2: Add the CDN map to AGENTS.md Setup**

Alongside the existing local import map, not replacing it. Keep the existing "Do not add hyparquet to that map" rule — it applies identically.

- [ ] **Step 3: Fix the gallery footer links**

In `examples/index.html`, the footer links to `../README.md`, `../AGENTS.md`, `../docs/PLAN.md` serve as raw Markdown on Pages. Point them at `https://github.com/cholmes/cng-map-widgets/blob/main/<file>` so they render.

- [ ] **Step 4: Verify the docs still execute**

Run: `node docs/verify-snippets.mjs`
Expected: pass. The AGENTS.md snippets are executed against live data; a broken edit fails here.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: how to use this before it is on npm"
```

---

### Task 6: CI

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Write the workflow**

Triggers: `push` to `main`, `pull_request`. One job, `ubuntu-latest`, `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 22` and `cache: npm`, then `npm ci` and `npm test`.

**Does not run** `verify-snippets.mjs` or `examples/*/verify.mjs` — they hit third-party object storage, so a red badge would report someone else's uptime rather than this code. Add that as a comment in the file so nobody "fixes" it later.

- [ ] **Step 2: Validate the YAML parses**

Run: `python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/test.yml'));print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github && git commit -m "ci: run npm test on push and PR"
```

---

### Task 7: Create the repo and push

**Files:** none (git and `gh` operations)

- [ ] **Step 1: Rename the local directory**

```bash
cd .. && mv cn-geocoding cng-map-widgets && cd cng-map-widgets
```

- [ ] **Step 2: Confirm the working tree is clean and tests pass**

Run: `git status --porcelain` → empty. Run `npm test` → pass.

- [ ] **Step 3: Review exactly what will become public**

Run: `git ls-files | wc -l` and skim `git ls-files`. Confirm no credentials, no `data/`, no `node_modules`. **This is the last reversible moment** — stop and report to Chris if anything looks like it should not be public.

- [ ] **Step 4: Create the repo**

```bash
gh repo create cholmes/cng-map-widgets --public \
  --description "Composable, zero-build browser widgets for cloud-native geospatial data" \
  --source . --remote origin
```

- [ ] **Step 5: Push and tag**

```bash
git push -u origin main
git tag v0.1.0 && git push origin v0.1.0
```
The tag exists so the jsDelivr URLs documented in Task 5 resolve.

- [ ] **Step 6: Verify CI went green**

Run: `gh run list --limit 1` then `gh run watch`
Expected: the `test` workflow concludes `success`. If it fails, fix before enabling Pages.

---

### Task 8: Enable Pages and verify from the live origin

**Files:** none, unless verification finds a fix

- [ ] **Step 1: Enable Pages from `main` at root**

```bash
gh api -X POST repos/cholmes/cng-map-widgets/pages \
  -f 'source[branch]=main' -f 'source[path]=/'
```
Then poll `gh api repos/cholmes/cng-map-widgets/pages` until `status` is `built`.

- [ ] **Step 2: Verify the site serves, with the right MIME type**

```bash
curl -sI https://cholmes.github.io/cng-map-widgets/ | head -1
curl -sI https://cholmes.github.io/cng-map-widgets/packages/geocoder-core/src/index.js | grep -i 'content-type'
```
Expected: `200`, and a content-type of `text/javascript` or `application/javascript`. **`text/plain` means every CDN import fails** — that is Review Focus item 2.

- [ ] **Step 3: Verify HTTP Range is honored**

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  -r 0-99 https://cholmes.github.io/cng-map-widgets/packages/spec/src/index.js
```
Expected: `206 100`. A `200` with the full size means range reads silently degrade (Review Focus item 3) — if so, stop and report: the CDN story needs rethinking.

- [ ] **Step 4: Drive the live site with the real verifier**

Adapt `examples/quickstart/verify.mjs` to take the Pages origin instead of a localhost port, and run it against `https://cholmes.github.io/cng-map-widgets/examples/quickstart/index.html`. Assert, as that script already does, on the actual map source data (`map.getSource('cnmw-area-display')._data`) and **fail on any console error**.

Expected: pass. A green local run proves nothing here — this is the only check that exercises Pages' range support and the cross-origin fetch to `data.source.coop` together.

- [ ] **Step 5: Verify a download example end to end**

Same approach against `examples/download-demo/index.html`. Confirm its default path uses the **live** index URL, not `?index=local` — the local path points at gitignored `data/` and 404s for every public visitor (Review Focus item 5).

- [ ] **Step 6: Commit any fixes and report**

Report to Chris: the live URL, which examples were verified from the `github.io` origin, the range-request result, and anything that did not work.
