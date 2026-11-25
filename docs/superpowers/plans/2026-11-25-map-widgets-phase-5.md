# Map widgets, phase 5: docs and release — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the four widgets usable from the documents alone, and make the repository releasable as 0.4.0 with its two new packages.

**Architecture:** No new behaviour. Every Node-runnable snippet added to `AGENTS.md` is executed against live data by a new `widgets` group in `docs/verify-snippets.mjs`; browser-only lines (controls) point at the Playwright verifier that covers them, as the existing documents do.

**Tech stack:** as phases 0–4. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-map-widgets-design.md`, "Phase 5 — docs and release".

## Global constraints

- Live-data verifiers are **not** added to CI (`.github/workflows/test.yml` says why).
- Third-party modules reach a snippet through the documented injection seams only.
- A document says what the code does. Where a document and the code disagree, the code is checked and the document corrected.
- Nothing is published, tagged or uploaded. The first npm publish of `@cngeo/stac` and `@cngeo/timeline` is Chris's step.
- Version strings: every `package.json` `version`, every `@cngeo/*` dependency pin, every `VERSION` constant and its test, and the CDN URLs in documents move together to `0.4.0`.

## Review focus

1. A snippet in `AGENTS.md` that is not executed by `verify-snippets.mjs` and not marked as browser-only: it must be one or the other.
2. A document that still describes a widget as unbuilt, or an API as it was planned rather than as it is (`@cngeo/stac`'s "under construction", the design doc's package table and charter for `stac`).
3. An import map in the documents that leaves out a package a widget needs transitively (`@cngeo/timeline` for a timeline, `@cngeo/stac` and `@cngeo/extract-core` for the search controls).
4. A version string left at `0.3.1`, or a dependency pin that no longer matches its package.
5. The release order: a package published before one it depends on (`timeline` and `stac` before `maplibre`; `extract-core` before `stac`).

---

### Task 1: `widgets` snippets and the `AGENTS.md` recipes

**Files:** modify `docs/verify-snippets.mjs`, `AGENTS.md`.

- [ ] Add `groupWidgets()` to `docs/verify-snippets.mjs`, registered as `widgets`, with one `snippet()` per recipe below. Inject `hyparquet`/`compressors` into `@cngeo/extract-core` and `MiniSearch` into `@cngeo/stac`.
  - layers: `layersFromCollection` on a live collection → a `pmtiles-vector` spec with an absolute URL, its style and attribution.
  - imagery: `imageryProfile` + `ImagerySearch.search({ area, time, limit })` on a live STAC-GeoParquet collection → scenes inside the window, newest first; `layerSpecFor(scene)` → a `cog` spec.
  - catalog: `CatalogIndex.search({ text })` on the live registry index → results and facets; `resolve(result)` → `drawable` specs.
  - timeline: `chunksFromTemplate` (yearly and monthly), `forView` (a narrow window is days, a wide one months), `chunksFromStac` on the live FIRMS collection, and a minimal in-memory `ChunkFormat` driven by `createChunkSet`.
- [ ] Run: `node docs/verify-snippets.mjs widgets`. Expected: every snippet `ok`.
- [ ] Write recipes 6–9 into `AGENTS.md` from the verified snippets, each followed by the control lines for a browser and the name of the `examples/*/verify.mjs` that covers them. Extend the import map, the Node injection section, the mental model, the pitfalls (those that bite silently first) and "Verifying your work".
- [ ] Run: `node docs/verify-snippets.mjs agents widgets`. Expected: all `ok`.
- [ ] Commit.

### Task 2: READMEs and the design document

**Files:** modify `README.md`, `packages/stac/README.md`, `packages/timeline/README.md`, `packages/maplibre/README.md`, `examples/index.html` (verification table), `docs/design/widgets-architecture.md`, `docs/verify-snippets.mjs` (header).

- [ ] Root `README.md`: package table gains `@cngeo/stac` and `@cngeo/timeline`; a short "Showing data" section with the four widgets and their examples.
- [ ] `packages/stac/README.md`: remove "under construction"; `packages/maplibre/README.md`: the loaders paragraph names all the seams.
- [ ] `docs/design/widgets-architecture.md`: amend §3.1 (package table), §4.5 and §5.4 (`@cngeo/stac`'s charter is broad, not "≤ 6 KB, pure JSON"), §5.1 (an adapter holds layer state; `@cngeo/timeline` draws on a canvas), §5 / O13 (deck.gl adopted, one prebuilt bundle), §8. Each amendment is dated and says what it replaces.
- [ ] Run: `npm test`. Expected: 0 failures.
- [ ] Commit.

### Task 3: CI and the release workflow

**Files:** modify `.github/workflows/test.yml`, `.github/workflows/release.yml`.

- [ ] `test.yml`: after `npm ci`, run `npm run check:deck` (the committed bundle equals a fresh build).
- [ ] `release.yml`: publish order `spec geocoder-core upload-core extract-core timeline stac maplibre openlayers raster-core format-gpkg format-shapefile format-flatgeobuf format-extras`; "11 entries" → 13; "The other ten" → twelve; the same bundle check before `npm test`.
- [ ] Add a unit test (`packages/spec/test/release-order.test.js`) that reads `release.yml` and every `packages/*/package.json`: every package is in the order exactly once, and each comes after its `@cngeo/*` dependencies. Watch it fail against the old order first.
- [ ] Run: `npm test`. Expected: 0 failures.
- [ ] Commit.

### Task 4: version 0.4.0

**Files:** every `packages/*/package.json`, `package-lock.json`, the `VERSION` constants and tests, `AGENTS.md`, `README.md`, package READMEs, `index.html`.

- [ ] Extend the release-order test: every package has one version, every `@cngeo/*` pin equals it, and every `VERSION` constant equals it. Expected to pass at 0.3.1 (a guard), then again at 0.4.0.
- [ ] Move every `0.3.1` that is a `@cngeo` version to `0.4.0` (not the historical mentions in plans and specs). `npm install --package-lock-only` to refresh the lock.
- [ ] Run: `npm test`, `node docs/verify-snippets.mjs`. Expected: 0 failures.
- [ ] Commit.
