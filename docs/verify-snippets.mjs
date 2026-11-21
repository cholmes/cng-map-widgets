#!/usr/bin/env node
/**
 * Executes every Node-runnable code snippet that appears in README.md,
 * AGENTS.md and the six packages/<name>/README.md files, and asserts the
 * outcome each document claims. If a snippet in a doc changes, change it
 * here too -- this file is the reason those docs can say "verified".
 *
 * Run it:   node docs/verify-snippets.mjs            (all groups)
 *           node docs/verify-snippets.mjs spec       (one or more groups)
 *
 * Groups: spec, geocoder, upload, download, openlayers, agents
 *
 * Network: the geocoder, download and agents groups hit real published
 * data at data.source.coop -- the published geoBoundaries gazetteer, the
 * Fields of The World Liechtenstein GeoParquet, the FIRMS detections
 * collection and the Sentinel-2 STAC-GeoParquet collection. There are no
 * fixtures and no mocks; a snippet that passes here is a snippet that
 * works against the live catalogs. Expect ~1-2 minutes.
 *
 * Browser-only snippets (the quickstart HTML, GeocoderControl, addAreaLayer,
 * attachDropTarget, the File System Access sinks) cannot run here. Those
 * are verified by the Playwright scripts under examples/: see
 * examples/index.html's "Verifying them yourself" table.
 *
 * Why `setHyparquetModules` appears at the top of every group: in a browser
 * the @cngeo packages load hyparquet by `import()`-ing a pinned absolute CDN
 * URL (design doc section 4.2). Node has no network imports, so this
 * injects the npm-installed copies instead -- the same host-injection seam
 * a bundled app (portolan-browser) uses to avoid shipping two hyparquets.
 */

import assert from 'node:assert/strict';

import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import * as hyparquetWriter from 'hyparquet-writer';

const GB_INDEX_URL = 'https://data.source.coop/portolan-mirrors/geoboundaries-catalog/names/index.json';
const FTW_LI_URL =
  'https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=LI/Liechtenstein.parquet';
const FIRMS_COLLECTION_URL = 'https://data.source.coop/portolan-mirrors/firms-catalog/detections/collection.json';
const S2_COLLECTION_URL = 'https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json';

let checks = 0;
const failures = [];

async function snippet(doc, label, fn) {
  checks += 1;
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`  ok   ${doc} :: ${label}${note ? ` -- ${note}` : ''}  (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${doc} :: ${label}`);
    console.log(`  FAIL ${doc} :: ${label}\n       ${err.message}`);
  }
}

/** The one dataset descriptor the download + agents snippets share. */
function ftwLiechtensteinDescriptor() {
  return {
    spec: 'cng-dataset/1.0',
    id: 'ftw-fields-li',
    title: 'Fields of The World — field boundaries (Liechtenstein)',
    source: { kind: 'parquet', url: FTW_LI_URL },
    table: {
      geometryColumn: 'geometry',
      geometryEncoding: 'WKB',
      crs: 'OGC:CRS84',
      bbox: { kind: 'struct', column: 'bbox' },
      columns: [
        { name: 'id', type: 'string' },
        { name: 'geometry', type: 'geometry' },
        { name: 'confidence', type: 'float32' },
        { name: 'bbox', type: 'struct' },
      ],
    },
    attribution: [
      { text: 'Fields of The World', license: 'CC-BY-4.0', url: 'https://fieldsofthe.world/', shareAlike: false },
    ],
  };
}

/** A square around Liechtenstein, so a download snippet needs no geocoder. */
async function liechtensteinBoxArea() {
  const { areaFromGeoJson } = await import('@cngeo/upload-core');
  const { area } = await areaFromGeoJson(
    {
      type: 'Polygon',
      coordinates: [[[9.47, 47.05], [9.47, 47.28], [9.64, 47.28], [9.64, 47.05], [9.47, 47.05]]],
    },
    { name: 'liechtenstein-box' },
  );
  return area;
}

// ===========================================================================
// packages/spec/README.md
// ===========================================================================
async function groupSpec() {
  console.log('\n@cngeo/spec');
  const {
    buildArea,
    validateArea,
    toAreaDocument,
    fromAreaDocument,
    computeBBoxes,
    crossesAntimeridian,
    bboxOfGeometry,
    bboxesIntersect,
    scaleBBox,
    normalizeName,
    simplifyToVertexCeiling,
    simplifyToVertexCeilingAsync,
    vertexCount,
    wkbToGeoJson,
    CngError,
    isCngError,
    VERSION,
  } = await import('@cngeo/spec');

  await snippet('spec/README', 'VERSION', async () => {
    assert.equal(VERSION, '0.2.0');
    return VERSION;
  });

  await snippet('spec/README', 'buildArea() from one polygon', async () => {
    const area = buildArea({
      name: 'A square over Liechtenstein',
      geometry: {
        type: 'Polygon',
        coordinates: [[[9.47, 47.05], [9.47, 47.28], [9.64, 47.28], [9.64, 47.05], [9.47, 47.05]]],
      },
      source: 'upload',
      features: [{ featureId: null, name: 'box' }],
    });

    assert.equal(area.type, 'Area');
    assert.equal(area.version, 1);
    assert.equal(area.crs, 'EPSG:4326');
    assert.deepEqual(area.bbox, [9.47, 47.05, 9.64, 47.28]);
    assert.equal(area.bboxes.length, 1);
    assert.equal(area.crossesAntimeridian, false);
    assert.equal(area.vertexCount.display, 5);
    assert.equal(area.vertexCount.filter, 5);
    assert.equal(area.filterGeometry, area.geometry); // under the ceiling: same object
    assert.equal(area.provenance.source, 'upload');
    assert.equal(area.provenance.combine, 'single');
    assert.equal(area.provenance.simplification, undefined);
    validateArea(area);
    return `id ${area.id.slice(0, 6)}…`;
  });

  await snippet('spec/README', 'antimeridian: computeBBoxes() splits into 2 boxes', async () => {
    const fiji = {
      type: 'MultiPolygon',
      coordinates: [
        [[[177.3, -17.8], [177.9, -17.8], [177.9, -17.2], [177.3, -17.2], [177.3, -17.8]]],
        [[[-179.9, -19.2], [-178.2, -19.2], [-178.2, -16.1], [-179.9, -16.1], [-179.9, -19.2]]],
      ],
    };

    assert.equal(crossesAntimeridian(fiji), true);
    const { bbox, bboxes, crossesAntimeridian: wraps } = computeBBoxes(fiji);
    assert.equal(wraps, true);
    assert.equal(bboxes.length, 2);
    assert.ok(bbox[0] > bbox[2], 'the signed bbox wraps: west > east');
    for (const b of bboxes) assert.ok(b[0] <= b[2], 'every split box is normalized');
    // A naive bbox would claim the area spans 357 degrees of longitude.
    assert.ok(bboxOfGeometry(fiji)[2] - bboxOfGeometry(fiji)[0] > 350);
    return `signed ${JSON.stringify(bbox)}`;
  });

  await snippet('spec/README', 'bbox helpers', async () => {
    assert.equal(bboxesIntersect([0, 0, 10, 10], [5, 5, 15, 15]), true);
    assert.equal(bboxesIntersect([0, 0, 10, 10], [11, 11, 15, 15]), false);
    assert.deepEqual(scaleBBox([0, 0, 10, 10], 2), [-5, -5, 15, 15]);
  });

  await snippet('spec/README', 'normalizeName() matches the index builder', async () => {
    assert.equal(normalizeName('Zürich'), 'zurich');
    assert.equal(normalizeName('  Côte d’Ivoire '), 'cote divoire');
    assert.equal(normalizeName("Saint-Denis  (Réunion)"), 'saint-denis reunion');
    assert.equal(normalizeName('東京都'), '東京都'); // non-Latin scripts survive untouched
  });

  await snippet('spec/README', 'simplifyToVertexCeiling() + the sync guard', async () => {
    // A dense circle: 1,200 vertices, well above a 200-vertex ceiling.
    const ring = [];
    for (let i = 0; i <= 1200; i++) {
      const t = (i / 1200) * 2 * Math.PI;
      ring.push([10 + Math.cos(t), 45 + Math.sin(t)]);
    }
    const circle = { type: 'Polygon', coordinates: [ring] };
    assert.equal(vertexCount(circle), 1201);

    const result = simplifyToVertexCeiling(circle, { vertexCeiling: 200 });
    assert.equal(result.method, 'visvalingam');
    assert.ok(result.outputVertices <= 200, `output ${result.outputVertices} <= 200`);
    // A circle is the worst case for Visvalingam -- every vertex carries the
    // same amount of shape -- so this lands just under the default
    // areaDeltaMaxRatio of 5%, which is exactly the bound that matters.
    assert.ok(result.areaDeltaRatio <= 0.05, `area delta ${result.areaDeltaRatio}`);
    assert.equal(result.degradedToBbox, false);

    // maxSyncInputVertices refuses to run the O(m^2) search on a big input.
    const guarded = simplifyToVertexCeiling(circle, { vertexCeiling: 200, maxSyncInputVertices: 1000 });
    assert.equal(guarded.method, 'bbox');
    assert.equal(guarded.degradedToBbox, true);

    // The async version is safe on any size and never blocks a frame.
    const async1 = await simplifyToVertexCeilingAsync(circle, { vertexCeiling: 200 });
    assert.equal(async1.method, 'visvalingam');
    assert.ok(async1.outputVertices <= 200);
    return `${result.inputVertices} -> ${result.outputVertices} vertices, area delta ${(result.areaDeltaRatio * 100).toFixed(3)}%`;
  });

  await snippet('spec/README', 'toAreaDocument()/fromAreaDocument() round trip', async () => {
    const area = buildArea({
      name: 'Contra Costa',
      geometry: { type: 'Polygon', coordinates: [[[-122.4, 37.7], [-121.5, 37.7], [-121.5, 38.1], [-122.4, 38.1], [-122.4, 37.7]]] },
      source: 'geocoder',
      features: [{ featureId: 'USA-ADM2-3160769234B82345678', name: 'Contra Costa', level: 2, country: 'USA' }],
      geometryVariant: 'display-simplified',
      attribution: [{ text: 'geoBoundaries CGAZ', license: 'CC-BY-4.0', shareAlike: false }],
    });

    const doc = toAreaDocument(area);
    assert.equal(doc.type, 'Feature'); // opens in geojson.io / QGIS / ogr2ogr unchanged
    assert.equal(doc.properties['area:name'], 'Contra Costa');
    assert.equal(doc.properties['area:crs'], 'EPSG:4326');
    assert.equal(doc.properties['area:provenance'].geometry_variant, 'display-simplified');
    assert.equal(doc.properties['area:provenance'].features[0].feature_id, 'USA-ADM2-3160769234B82345678');

    const back = fromAreaDocument(doc);
    assert.equal(back.name, area.name);
    assert.equal(back.provenance.geometryVariant, 'display-simplified');
    assert.deepEqual(back.bboxes, area.bboxes);
    return 'snake_case under `area:` on the wire, camelCase in memory';
  });

  await snippet('spec/README', 'wkbToGeoJson()', async () => {
    // A 5-point square, hand-built little-endian ISO WKB Polygon.
    const ring = [[9.47, 47.05], [9.64, 47.05], [9.64, 47.28], [9.47, 47.28], [9.47, 47.05]];
    const buf = new ArrayBuffer(1 + 4 + 4 + 4 + ring.length * 16);
    const view = new DataView(buf);
    view.setUint8(0, 1); // little-endian
    view.setUint32(1, 3, true); // wkbPolygon
    view.setUint32(5, 1, true); // 1 ring
    view.setUint32(9, ring.length, true);
    ring.forEach(([x, y], i) => {
      view.setFloat64(13 + i * 16, x, true);
      view.setFloat64(13 + i * 16 + 8, y, true);
    });

    const geometry = wkbToGeoJson(new Uint8Array(buf));
    assert.equal(geometry.type, 'Polygon');
    assert.deepEqual(geometry.coordinates[0][2], [9.64, 47.28]);

    // Points and lines are refused rather than guessed at.
    const pointWkb = new Uint8Array([1, 1, 0, 0, 0, ...new Uint8Array(16)]);
    assert.throws(() => wkbToGeoJson(pointWkb), /unsupported geometry type 1/);
  });

  await snippet('spec/README', 'the error taxonomy', async () => {
    const err = new CngError('Only EPSG:4326 (lon/lat) data is supported.', 'AREA_INVALID_CRS', {
      context: { crs: 'EPSG:3857' },
    });
    assert.equal(err.code, 'AREA_INVALID_CRS');
    assert.equal(err.retryable, false);
    assert.equal(err.context.crs, 'EPSG:3857');
    assert.equal(isCngError(err), true);
    assert.equal(err instanceof Error, true);

    // Network-shaped codes default to retryable.
    assert.equal(new CngError('x', 'INDEX_FETCH_FAILED').retryable, true);

    // Points/lines are rejected structurally, not silently dropped.
    assert.throws(
      () => buildArea({ name: 'p', geometry: { type: 'Point', coordinates: [0, 0] }, source: 'upload', features: [] }),
      (e) => e.code === 'AREA_UNSUPPORTED_GEOMETRY',
    );
  });
}

// ===========================================================================
// packages/geocoder-core/README.md
// ===========================================================================
async function groupGeocoder() {
  console.log('\n@cngeo/geocoder-core (live: data.source.coop)');
  const { Geocoder, setHyparquetModules, classifyMatch, computeViewportRank, prefixRange, VERSION, DEFAULT_INDEX_URL } =
    await import('@cngeo/geocoder-core');
  const { normalizeName } = await import('@cngeo/spec');

  setHyparquetModules({ hyparquet, compressors });

  await snippet('geocoder-core/README', 'VERSION', async () => {
    assert.equal(VERSION, '0.2.0');
  });

  await snippet('geocoder-core/README', 'DEFAULT_INDEX_URL is the published geoBoundaries manifest, and it serves', async () => {
    // The README claims `new Geocoder()` with no options works. That is
    // only true if the default is an absolute, published, reachable URL --
    // it used to be './data/index.json', a relative dev path.
    assert.equal(DEFAULT_INDEX_URL, GB_INDEX_URL);
    const res = await fetch(DEFAULT_INDEX_URL);
    assert.equal(res.ok, true, `GET ${DEFAULT_INDEX_URL} -> ${res.status}`);
    const manifest = await res.json();
    assert.equal(manifest.source, 'geoboundaries-cgaz');
    // CC-BY-4.0, not ODbL: a default nobody chose must not impose
    // share-alike terms (design call #11).
    assert.ok(
      manifest.attribution.every((a) => !(a.share_alike ?? a.shareAlike)),
      'the default index must carry no share-alike obligation',
    );
    return `${DEFAULT_INDEX_URL} -> ${res.status}, source ${manifest.source}`;
  });

  await snippet('geocoder-core/README', 'two indexUrls refuse by name instead of silently loading the default', async () => {
    assert.throws(
      () => new Geocoder({ indexUrl: [GB_INDEX_URL, 'https://example.test/other/index.json'] }),
      (e) => e.code === 'INDEX_MULTI_SOURCE_UNSUPPORTED',
    );
    // One is unambiguous, so it is accepted.
    assert.doesNotThrow(() => new Geocoder({ indexUrl: [GB_INDEX_URL] }));
    return 'multi-source refuses; a one-element array is accepted';
  });

  /** @type {import('@cngeo/geocoder-core').Geocoder} */
  let shared;
  let sharedArea;

  await snippet('geocoder-core/README', 'load() against the published geoBoundaries gazetteer', async () => {
    const geocoder = new Geocoder({ indexUrl: GB_INDEX_URL, limit: 8 });
    const info = await geocoder.load();

    assert.equal(info.source, 'geoboundaries-cgaz');
    assert.deepEqual([...info.levels], [0, 1, 2]);
    assert.equal(info.strategy, 'full'); // 3.9 MB <= fullLoadMaxBytes (5 MiB)
    assert.ok(info.rows > 50_000, `rows ${info.rows}`);
    assert.equal(info.attribution[0].license, 'CC-BY-4.0');
    assert.equal(geocoder.state, 'ready');
    shared = geocoder;
    return `${info.rows.toLocaleString()} rows, ${(info.bytes / 1e6).toFixed(1)} MB, ${Math.round(info.loadMs)} ms`;
  });

  await snippet('geocoder-core/README', 'search() returns a ranked SearchResult[]', async () => {
    const results = await shared.search('contra costa');
    assert.ok(results.length >= 1);
    const [best] = results;
    assert.equal(best.name, 'Contra Costa');
    assert.equal(best.country, 'USA');
    assert.equal(best.level, 2);
    assert.equal(best.countryName, 'United States'); // geoBoundaries' dropdown context column
    assert.equal(best.source, 'geoboundaries-cgaz');
    assert.equal(best.rank.matchClass, 'exact');
    assert.equal(typeof best.areaKm2, 'number');
    assert.ok(best.score > 0 && best.score <= 1);
    assert.equal(best.bbox.length, 4);
    return `${best.name} / ${best.country} / ADM${best.level}, score ${best.score.toFixed(2)}`;
  });

  await snippet('geocoder-core/README', 'search() filters: levels, countries, limit', async () => {
    const countries = await shared.search('a', { levels: [0], limit: 3 });
    assert.ok(countries.length <= 3);
    for (const r of countries) assert.equal(r.level, 0);

    const swiss = await shared.search('zurich', { countries: ['CHE'] });
    assert.ok(swiss.length >= 1);
    for (const r of swiss) assert.equal(r.country, 'CHE');
    return `zurich/CHE -> ${swiss.map((r) => `ADM${r.level}`).join(', ')}`;
  });

  await snippet('geocoder-core/README', 'the viewport boost reorders results', async () => {
    const bayArea = [-122.6, 37.4, -121.7, 38.2]; // what map.getBounds() gives you

    const cold = await shared.search('contra', { limit: 5 });
    assert.equal(cold[0].name, 'Contralmirante Villar'); // PER, ties on level, wins on area
    assert.equal(cold.find((r) => r.name === 'Contra Costa').rank.viewportRank, 'outside');

    const warm = await shared.search('contra', { viewport: bayArea, limit: 5 });
    assert.equal(warm[0].name, 'Contra Costa');
    assert.equal(warm[0].rank.viewportRank, 'inside');
    // The boost is folded into levelAdjusted: one admin level, by default.
    assert.equal(warm[0].rank.effLevel, 2);
    assert.equal(warm[0].rank.levelAdjusted, 1);
    return `"contra": ${cold[0].name} -> ${warm[0].name} once the viewport is passed`;
  });

  await snippet('geocoder-core/README', 'searchSync() needs a fully-loaded index', async () => {
    const results = shared.searchSync('contra costa');
    assert.equal(results[0].name, 'Contra Costa');

    const cold = new Geocoder({ indexUrl: GB_INDEX_URL });
    assert.throws(() => cold.searchSync('paris'), (e) => e.code === 'GEOCODER_NOT_LOADED');
  });

  await snippet('geocoder-core/README', 'select() -> an Area, display resolution by default', async () => {
    const [result] = await shared.search('contra costa');
    const area = await shared.select(result);

    assert.equal(area.type, 'Area');
    assert.equal(area.crs, 'EPSG:4326');
    assert.equal(area.geometry.type, 'Polygon');
    assert.equal(area.provenance.source, 'geocoder');
    assert.equal(area.provenance.geometryVariant, 'display-simplified');
    assert.equal(area.provenance.geocoder.indexSource, 'geoboundaries-cgaz');
    assert.equal(area.provenance.geocoder.catalogVersion, 'geoboundaries-cgaz-2026-11-12');
    assert.match(area.provenance.geocoder.boundaryUrl, /adm2\/cgaz_adm2_display\.parquet$/);
    assert.equal(area.provenance.attribution[0].license, 'CC-BY-4.0');
    assert.ok(area.filterGeometry, 'filterGeometry present');
    sharedArea = area;
    return `${area.vertexCount.display} display vertices, bbox ${area.bbox.map((n) => n.toFixed(2)).join(',')}`;
  });

  await snippet('geocoder-core/README', 'select({ resolution: "full" }) reads the full-resolution file', async () => {
    const [result] = await shared.search('contra costa');
    const area = await shared.select(result, { resolution: 'full' });
    assert.equal(area.provenance.geometryVariant, 'full');
    assert.match(area.provenance.geocoder.boundaryUrl, /adm2\/cgaz_adm2\.parquet$/);
    assert.ok(
      area.vertexCount.display > sharedArea.vertexCount.display,
      `full ${area.vertexCount.display} > display ${sharedArea.vertexCount.display}`,
    );
    return `full ${area.vertexCount.display} vs display ${sharedArea.vertexCount.display} vertices`;
  });

  await snippet('geocoder-core/README', 'ADM0 joins on country, not feature id', async () => {
    const [country] = await shared.search('liechtenstein', { levels: [0] });
    assert.equal(country.level, 0);
    const area = await shared.select(country);
    assert.equal(area.name, 'Liechtenstein');
    assert.ok(area.vertexCount.display > 3);
    return 'CGAZ ADM0 has no shapeID column; the manifest declares index_key_column: "country"';
  });

  await snippet('geocoder-core/README', 'a SearchResult survives JSON.stringify, BigInt geometry_ref and all', async () => {
    // `geometry_ref.row` is parquet INT64, which hyparquet decodes as a
    // BigInt, and one BigInt anywhere in the graph makes JSON.stringify
    // *throw*. It is now converted at the result boundary, so this -- the
    // thing a caller actually does with a search result -- works.
    const [result] = await shared.search('contra costa');
    assert.ok(result.geometryRef, 'the published index carries geometry_ref');
    assert.equal(typeof result.geometryRef.row, 'number');
    assert.equal(typeof result.geometryRef.rowGroup, 'number');
    assert.equal(JSON.parse(JSON.stringify(result)).geometryRef.row, result.geometryRef.row);
    return `row ${result.geometryRef.row}, rowGroup ${result.geometryRef.rowGroup} -- both plain numbers, JSON-safe`;
  });

  await snippet('geocoder-core/README', 'events: load, results, select', async () => {
    const geocoder = new Geocoder({ indexUrl: GB_INDEX_URL, limit: 5 });
    const seen = [];
    const off = geocoder.on('load', (info) => seen.push(`load:${info.rows}`));
    geocoder.on('results', ({ query, results, wave }) => seen.push(`results:${query}:${results.length}:${wave}`));
    geocoder.on('select', ({ result }) => seen.push(`select:${result.name}`));

    const results = await geocoder.search('paris');
    await geocoder.select(results[0]);
    off(); // `on()` returns an unsubscribe

    assert.ok(seen.some((s) => s.startsWith('load:')));
    assert.ok(seen.some((s) => s.startsWith('results:paris:')));
    assert.ok(seen.some((s) => s.startsWith('select:')));
    geocoder.close();
    assert.equal(geocoder.state, 'idle');
    return seen.join(' | ');
  });

  await snippet('geocoder-core/README', 'a superseded search resolves to [], never rejects', async () => {
    const geocoder = new Geocoder({ indexUrl: GB_INDEX_URL });
    await geocoder.load();
    const stale = geocoder.search('par');
    const fresh = geocoder.search('paris');
    assert.deepEqual(await stale, []);
    assert.ok((await fresh).length >= 1);
    geocoder.close();
  });

  await snippet('geocoder-core/README', 'pure helpers: classifyMatch, computeViewportRank, prefixRange', async () => {
    const allowed = ['exact', 'prefix', 'word-prefix'];
    assert.equal(classifyMatch('paris', 'paris', allowed), 'exact');
    assert.equal(classifyMatch('paris paris', 'paris', allowed), 'prefix'); // starts with, but not equal
    assert.equal(classifyMatch('saint andrew parish', 'paris', allowed), 'word-prefix');
    assert.equal(classifyMatch('somewhere else', 'paris', allowed), null);
    assert.equal(classifyMatch('a paris b', 'paris', ['exact']), null); // class not allowed

    const viewport = [-10, -10, 10, 10];
    assert.equal(computeViewportRank([-1, -1, 1, 1], viewport, 2), 'inside');
    assert.equal(computeViewportRank([9, 9, 30, 30], viewport, 2), 'overlap');
    assert.equal(computeViewportRank([15, 0, 16, 1], viewport, 2), 'near');
    assert.equal(computeViewportRank([100, 100, 101, 101], viewport, 2), 'outside');
    assert.equal(computeViewportRank([0, 0, 1, 1], undefined, 2), 'outside');

    // prefixRange is the whole full-load search: a binary search over the
    // index's own byte-wise-sorted name_norm column.
    const sorted = ['bag', 'baghdad', 'bago', 'zurich'];
    assert.deepEqual(prefixRange(sorted, 'bag'), [0, 3]);
    assert.deepEqual(prefixRange(sorted, 'baghdad'), [1, 2]);
    assert.deepEqual(prefixRange(sorted, 'zz'), [4, 4]);
    assert.equal(normalizeName('Baghdad'), 'baghdad'); // what the index stores
  });

  await snippet('geocoder-core/README', 'the manifest is just JSON you can read yourself', async () => {
    const manifest = await fetch(GB_INDEX_URL).then((r) => r.json());
    assert.equal(manifest.spec, 'cnmw-index/1.0');
    assert.equal(manifest.index.feature_id_column, 'shape_id');
    assert.equal(typeof manifest.index.footer_metadata_bytes, 'number');
    assert.equal(manifest.boundaries.length, 3);
    assert.equal(manifest.boundaries[0].index_key_column, 'country');
    assert.equal(manifest.boundaries[0].feature_id_column, null);
    for (const b of manifest.boundaries) assert.ok(b.full?.url && b.display?.url);
    return `catalog_version ${manifest.catalog_version}, ${manifest.rows} rows`;
  });

  shared?.close();
}

// ===========================================================================
// packages/upload-core/README.md
// ===========================================================================
async function groupUpload() {
  console.log('\n@cngeo/upload-core');
  const { areaFromGeoJson, areaFromFile, registerReader, repairFeatures, VERSION } = await import('@cngeo/upload-core');

  await snippet('upload-core/README', 'VERSION', async () => {
    assert.equal(VERSION, '0.2.0');
  });

  await snippet('upload-core/README', 'areaFromFile() -> { area, warnings }', async () => {
    const text = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'my field' },
          geometry: { type: 'Polygon', coordinates: [[[9.47, 47.05], [9.64, 47.05], [9.64, 47.28], [9.47, 47.28], [9.47, 47.05]]] },
        },
      ],
    });
    const file = new File([text], 'my-field.geojson', { type: 'application/geo+json' });

    const { area, warnings } = await areaFromFile(file);
    assert.equal(area.name, 'my-field.geojson');
    assert.equal(area.provenance.source, 'upload');
    assert.equal(area.provenance.combine, 'single');
    assert.equal(area.provenance.upload.filename, 'my-field.geojson');
    assert.equal(area.provenance.upload.featureCount, 1);
    assert.equal(area.provenance.upload.declaredCrs, null); // RFC 7946 says WGS84
    assert.deepEqual(warnings, []);
    return `${area.vertexCount.display} vertices, no warnings`;
  });

  await snippet('upload-core/README', 'the repair pipeline reports every fix', async () => {
    const damaged = {
      type: 'FeatureCollection',
      features: [
        // Clockwise exterior ring (RFC 7946 wants CCW), unclosed, with a Z.
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [[[0, 0, 12], [0, 1, 12], [1, 1, 12], [1, 0, 12]]] },
        },
        // Not an area at all.
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      ],
    };

    const { area, warnings } = await areaFromGeoJson(damaged, { name: 'damaged.geojson' });
    const repairs = area.provenance.upload.repairs.map((r) => r.kind);
    assert.ok(repairs.includes('dropped-non-areal'));
    assert.ok(repairs.includes('closed-ring'));
    assert.ok(repairs.includes('dropped-z'));
    assert.equal(warnings[0].code, 'repaired');
    assert.equal(area.geometry.coordinates[0][0].length, 2, 'Z stripped');
    assert.deepEqual(area.geometry.coordinates[0][0], area.geometry.coordinates[0].at(-1), 'ring closed');
    return repairs.join(', ');
  });

  await snippet('upload-core/README', 'multi-feature upload: collect, not dissolve', async () => {
    const two = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'a' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
        { type: 'Feature', properties: { name: 'b' }, geometry: { type: 'Polygon', coordinates: [[[0.5, 0.5], [2, 0.5], [2, 2], [0.5, 2], [0.5, 0.5]]] } },
      ],
    };
    const { area, warnings } = await areaFromGeoJson(two, { name: 'two.geojson' });
    assert.equal(area.provenance.combine, 'collect');
    assert.equal(area.geometry.type, 'MultiPolygon');
    assert.equal(area.geometry.coordinates.length, 2);
    assert.equal(area.provenance.features.length, 2);
    assert.equal(area.provenance.features[0].name, 'a');
    // Overlapping inputs are reported, not silently unioned.
    assert.ok(warnings.some((w) => w.code === 'overlapping-features'));
    return 'MultiPolygon of 2 parts + an overlapping-features warning';
  });

  await snippet('upload-core/README', 'refusals: non-polygon, foreign CRS, too large', async () => {
    await assert.rejects(
      areaFromGeoJson({ type: 'Point', coordinates: [0, 0] }, { name: 'p.geojson' }),
      (e) => e.code === 'AREA_UNSUPPORTED_GEOMETRY',
    );

    const projected = {
      type: 'Feature',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    };
    await assert.rejects(areaFromGeoJson(projected, { name: 'm.geojson' }), (e) => e.code === 'AREA_INVALID_CRS');

    // ...unless you opt in, which records the assumption.
    const { area, warnings } = await areaFromGeoJson(projected, { name: 'm.geojson' }, { onForeignCrs: 'assume-4326' });
    assert.equal(area.provenance.upload.declaredCrs, 'urn:ogc:def:crs:EPSG::3857');
    assert.ok(warnings.some((w) => w.code === 'assumed-4326'));

    const big = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    await assert.rejects(
      areaFromGeoJson(big, { name: 'big.geojson' }, { maxBytes: 10 }),
      (e) => e.code === 'UPLOAD_TOO_LARGE',
    );
  });

  await snippet('upload-core/README', 'registerReader() adds a format', async () => {
    // A toy "WKT polygon in a .txt file" reader -- the same seam a
    // shapefile-js or gdal3.js reader would use.
    registerReader({
      id: 'wkt-txt',
      extensions: ['.wkt'],
      mediaTypes: ['text/plain'],
      async read(file) {
        const text = await file.text();
        const pairs = text.replace(/^POLYGON\s*\(\(/i, '').replace(/\)\)\s*$/, '').split(',');
        const ring = pairs.map((p) => p.trim().split(/\s+/).map(Number));
        return { features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }], declaredCrs: null };
      },
    });

    const file = new File(['POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))'], 'square.wkt', { type: 'text/plain' });
    const { area } = await areaFromFile(file);
    assert.equal(area.geometry.type, 'Polygon');
    assert.equal(area.vertexCount.display, 5);

    // An unregistered extension refuses by name rather than guessing.
    await assert.rejects(
      areaFromFile(new File(['x'], 'thing.shp', { type: '' })),
      (e) => e.code === 'UPLOAD_UNSUPPORTED_FORMAT',
    );
  });

  await snippet('upload-core/README', 'repairFeatures() standalone', async () => {
    const { features, repairs } = repairFeatures([
      { geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0]]] }, properties: {} },
      { geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
    ]);
    assert.equal(features.length, 1);
    assert.ok(repairs.some((r) => r.kind === 'dropped-non-areal'));
    return repairs.map((r) => `${r.kind}×${r.count}`).join(', ');
  });
}

// ===========================================================================
// packages/extract-core/README.md
// ===========================================================================
async function groupDownload() {
  console.log('\n@cngeo/extract-core (live: data.source.coop)');
  const {
    setHyparquetModules,
    estimate,
    download,
    downloadRequest,
    memorySink,
    resolveDataset,
    descriptorFromCollection,
    collectionDownloadSupport,
    formats,
    engines,
    defaultCeiling,
    requirementsOf,
    evaluateWhere,
    evaluatePredicate,
    getPath,
    rowMatchesArea,
    isCngError,
    VERSION,
  } = await import('@cngeo/extract-core');
  const { toAreaDocument } = await import('@cngeo/spec');

  setHyparquetModules({ hyparquet, compressors, writer: hyparquetWriter });

  await snippet('extract-core/README', 'VERSION + the built-in registries', async () => {
    assert.equal(VERSION, '0.2.0');
    assert.deepEqual(formats().map((f) => f.id).sort(), ['geojson', 'geoparquet']);
    assert.equal(formats().find((f) => f.id === 'geojson').streaming, true);
    assert.equal(formats().find((f) => f.id === 'geoparquet').streaming, false);
    assert.deepEqual(engines().map((e) => e.id), ['hyparquet']);
    assert.deepEqual([...engines()[0].capabilities], ['bbox', 'intersects']);
    assert.deepEqual(defaultCeiling(), {
      rows: 5_000_000,
      outputBytes: 2 * 1024 ** 3,
      readBytes: 4 * 1024 ** 3,
      files: 500,
      blobBytes: 256 * 1024 ** 2,
    });
  });

  const dataset = ftwLiechtensteinDescriptor();
  const area = await liechtensteinBoxArea();
  const filter = {
    spec: 'cng-filter/1.0',
    spatial: { mode: 'intersects' },
    where: [{ col: 'confidence', op: '>=', value: 0.5 }],
    columns: { include: ['id', 'confidence'] },
  };

  await snippet('extract-core/README', 'estimate() reads footers only', async () => {
    const est = await estimate(dataset, area, filter);

    assert.equal(est.readBytes.exact, true); // straight from column-chunk sizes
    assert.equal(est.readBytes.estimate, 204_945);
    assert.equal(est.rows.max, 795);
    assert.equal(est.rows.exact, false); // a selectivity model, honestly labelled
    assert.deepEqual(est.files, { total: 1, selected: 1 });
    assert.deepEqual(est.rowGroups, { total: 1, selected: 1 });
    assert.equal(est.requests, 2);
    assert.deepEqual(est.columns, ['id', 'confidence', 'geometry']);
    assert.ok(est.warnings.some((w) => w.code === 'single-row-group'));
    assert.equal(est.ceiling.exceeded, false);
    assert.match(est.requestDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      est.prune.map((s) => s.stage),
      // `row-group-where` is the predicate-pushdown stage; it is reported
      // even with no `where` filter, so a UI can show the whole cascade
      // rather than a list whose length depends on the query.
      ['row-group-bbox', 'row-group-stats', 'row-group-where'],
    );
    return `${est.rows.min}–${est.rows.max} rows, ${est.readBytes.estimate.toLocaleString()} B, ${est.requests} requests`;
  });

  await snippet('extract-core/README', 'download() to GeoJSON', async () => {
    const sink = memorySink();
    const handle = download(dataset, area, filter, { spec: 'cng-output/1.0', format: 'geojson', filename: 'fields.geojson' }, { sink });

    assert.equal(handle.state, 'planning'); // the handle exists before any await

    const result = await handle.result;
    assert.equal(handle.state, 'done');
    assert.equal(result.rows, 769);
    assert.equal(result.format, 'geojson');
    assert.equal(result.truncated, false);
    assert.equal(result.sink.kind, 'memory');
    assert.equal(result.readBytes, 204_945);
    assert.equal(result.attribution[0].license, 'CC-BY-4.0');

    const text = Buffer.concat(sink.chunks.map((c) => Buffer.from(c))).toString('utf8');
    const fc = JSON.parse(text);
    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.features.length, 769);
    assert.deepEqual(Object.keys(fc.features[0].properties).sort(), ['confidence', 'id']);
    assert.equal(fc.features[0].geometry.type, 'Polygon');
    return `${result.rows} features, ${result.bytes.toLocaleString()} bytes, ${result.requests} data request`;
  });

  await snippet('extract-core/README', 'download() to GeoParquet, with a 1.1 covering', async () => {
    const sink = memorySink();
    const result = await download(
      dataset,
      area,
      filter,
      { spec: 'cng-output/1.0', format: 'geoparquet', filename: 'fields.parquet' },
      { sink },
    ).result;

    assert.equal(result.rows, 769);
    const bytes = Buffer.concat(sink.chunks.map((c) => Buffer.from(c)));
    const metadata = hyparquet.parquetMetadata(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    assert.equal(Number(metadata.num_rows), 769);
    assert.deepEqual(
      metadata.schema.slice(1).map((s) => s.name),
      ['id', 'confidence', 'geometry', 'bbox_xmin', 'bbox_ymin', 'bbox_xmax', 'bbox_ymax'],
    );
    const geo = JSON.parse(metadata.key_value_metadata.find((kv) => kv.key === 'geo').value);
    assert.equal(geo.version, '1.1.0');
    assert.equal(geo.primary_column, 'geometry');
    assert.deepEqual(geo.columns.geometry.covering.bbox.xmin, ['bbox_xmin']);
    return `${result.bytes.toLocaleString()} bytes, covering written so the output is itself prunable`;
  });

  await snippet('extract-core/README', 'zstd is refused, not silently downgraded', async () => {
    const handle = download(
      dataset,
      area,
      filter,
      { spec: 'cng-output/1.0', format: 'geoparquet', options: { compression: 'zstd' } },
      { sink: memorySink() },
    );
    await assert.rejects(handle.result, (e) => e.code === 'FORMAT_CAPABILITY');
  });

  await snippet('extract-core/README', 'an unregistered format refuses by name', async () => {
    const handle = download(dataset, area, filter, { spec: 'cng-output/1.0', format: 'gpkg' }, { sink: memorySink() });
    await assert.rejects(handle.result, (e) => e.code === 'FORMAT_UNAVAILABLE');
  });

  await snippet('extract-core/README', 'the ceiling refuses by rejecting, and acceptCeiling() hands back the continued run', async () => {
    // (1) Blocked: `result` REJECTS with CeilingExceededError. It does not
    // wait (which is what it used to do, forever -- the 2026-11-12 §3.4
    // "blocked handles reject" amendment). The error carries the estimate,
    // so a caller who only ever awaits `result` still gets the numbers.
    const blocked = download(dataset, area, filter, { spec: 'cng-output/1.0', format: 'geojson' }, { sink: memorySink(), ceiling: { rows: 10 } });
    const err = await blocked.result.then(() => null, (e) => e);
    assert.equal(err.code, 'CEILING_EXCEEDED');
    assert.deepEqual(err.context.breaches, ['rows']);
    assert.equal(err.context.estimate.ceiling.exceeded, true);
    assert.equal(blocked.state, 'blocked');
    // `estimate` resolves on its own either way.
    assert.deepEqual((await blocked.estimate).ceiling.breaches, ['rows']);
    // Declining leaves the already-settled rejection alone; `state` is
    // what records the decision.
    await blocked.cancel('too big');
    assert.equal(blocked.state, 'cancelled');

    // (2) Accepted from the 'ceiling' event -- the auditable override.
    // `acceptCeiling()` returns the continued run's promise, because the
    // one above has already rejected.
    const accepted = download(dataset, area, filter, { spec: 'cng-output/1.0', format: 'geojson' }, { sink: memorySink(), ceiling: { rows: 10 } });
    const continued = await new Promise((resolve) => {
      accepted.on('ceiling', () => resolve(accepted.acceptCeiling()));
    });
    assert.equal(continued.rows, 769);
    assert.equal((await accepted.result).rows, 769); // `result` returns the same promise now

    // (3) Or pre-accepted, when a caller has already decided: never blocks.
    const preAccepted = download(dataset, area, filter, { spec: 'cng-output/1.0', format: 'geojson' }, { sink: memorySink(), ceiling: { rows: 10 }, acceptCeiling: true });
    assert.equal((await preAccepted.result).rows, 769);
    return 'blocked -> result rejects CEILING_EXCEEDED; acceptCeiling() returns the continued run';
  });

  await snippet('extract-core/README', 'downloadRequest() runs a serialized DownloadRequest', async () => {
    const request = {
      spec: 'cng-request/1.0',
      dataset,
      filter: { ...filter, area: toAreaDocument(area), limit: 25 },
      output: { spec: 'cng-output/1.0', format: 'geojson', filename: 'fields.geojson' },
      generator: { name: 'docs/verify-snippets.mjs', version: '0.1.0', at: new Date().toISOString() },
    };
    // The Area travels inside the request, so the second argument is null.
    const result = await downloadRequest(request, null, { sink: memorySink() }).result;
    assert.equal(result.rows, 25);
    assert.equal(result.truncated, true); // `limit` bound
    return 'the whole request is one copy-pasteable JSON document';
  });

  await snippet('extract-core/README', 'progress events', async () => {
    const handle = download(dataset, area, filter, { spec: 'cng-output/1.0', format: 'geojson' }, { sink: memorySink() });
    const phases = new Set();
    handle.on('progress', (p) => phases.add(p.phase));
    handle.on('estimate', (e) => phases.add(`estimate:${e.rows.max}`));
    await handle.result;
    assert.ok(phases.has('planning'));
    assert.ok(phases.has('reading'));
    assert.ok(phases.has('writing'));
    assert.ok(phases.has('finalizing'));
    assert.ok(phases.has('estimate:795'));
    return [...phases].join(', ');
  });

  await snippet('extract-core/README', 'requirementsOf() + FILTER_REQUIRES_ENGINE', async () => {
    assert.deepEqual([...requirementsOf({ spatial: { mode: 'intersects' } })], []);
    assert.deepEqual([...requirementsOf({ spatial: { mode: 'clip' } })], ['exact-clip']);
    assert.deepEqual(
      [...requirementsOf({ spatial: { mode: 'intersects' }, whereSql: { dialect: 'duckdb', fragment: 'x > 1' } })],
      ['sql'],
    );

    // The built-in engine says no before fetching a byte.
    await assert.rejects(
      estimate(dataset, area, { ...filter, spatial: { mode: 'clip' } }),
      (e) => e.code === 'FILTER_REQUIRES_ENGINE',
    );
  });

  await snippet('extract-core/README', 'predicates: evaluateWhere, dotted paths', async () => {
    const row = { confidence: 0.95, kind: 'field', names: { primary: 'Westfield' }, tags: ['a', 'b'], retired: null };
    assert.equal(evaluateWhere([{ col: 'confidence', op: '>=', value: 0.9 }], row), true);
    assert.equal(evaluateWhere([{ col: 'confidence', op: '>=', value: 0.99 }], row), false);
    assert.equal(evaluateWhere([{ col: 'kind', op: 'in', values: ['field', 'orchard'] }], row), true);
    assert.equal(evaluateWhere([{ col: 'names.primary', op: 'ilike', value: 'west%' }], row), true);
    assert.equal(evaluateWhere([{ col: 'retired', op: 'is_null' }], row), true);
    assert.equal(evaluateWhere([{ col: 'confidence', op: 'between', low: 0.9, high: 1 }], row), true);
    // where[] is ANDed; or/not are explicit nodes.
    assert.equal(
      evaluatePredicate({ op: 'or', args: [{ col: 'kind', op: '=', value: 'nope' }, { col: 'confidence', op: '>', value: 0.5 }] }, row),
      true,
    );
    assert.equal(getPath(row, 'names.primary'), 'Westfield');
    assert.equal(getPath(row, 'tags[1]'), 'b');
    assert.equal(getPath(row, 'nothing.here'), undefined);
  });

  await snippet('extract-core/README', 'rowMatchesArea(): bbox prune, then exact test', async () => {
    const triangle = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [0, 10], [0, 0]]] };
    const areaLike = { bboxes: [[0, 0, 10, 10]], filterGeometry: triangle };
    // Inside the bbox but outside the triangle.
    assert.equal(rowMatchesArea({ featureBBox: [9, 9, 9.5, 9.5], featureGeometry: { type: 'Point', coordinates: [9.2, 9.2] } }, areaLike, { mode: 'intersects' }), false);
    assert.equal(rowMatchesArea({ featureBBox: [9, 9, 9.5, 9.5] }, areaLike, { mode: 'bbox' }), true);
    assert.equal(rowMatchesArea({ featureBBox: [1, 1, 2, 2], featureGeometry: { type: 'Point', coordinates: [1.5, 1.5] } }, areaLike, { mode: 'intersects' }), true);
    // Outside every box: never reaches the geometry test.
    assert.equal(rowMatchesArea({ featureBBox: [50, 50, 51, 51] }, areaLike, { mode: 'intersects' }), false);
  });

  await snippet('extract-core/README', 'resolveDataset(): a Portolan collection -> a concrete descriptor', async () => {
    const resolved = await resolveDataset({
      spec: 'cng-dataset/1.0',
      id: 'firms-detections',
      source: { kind: 'portolan-collection', url: FIRMS_COLLECTION_URL },
    });

    assert.equal(resolved.source.kind, 'hive');
    assert.equal(resolved.source.strategy, 'temporal');
    assert.equal(resolved.source.fileCount, 27);
    assert.deepEqual(resolved.source.keys.map((k) => k.name), ['year']);
    assert.equal(resolved.source.enumeration.kind, 'stac-items');
    assert.equal(resolved.table.timeColumn, 'acq_datetime');
    assert.equal(resolved.table.bbox.kind, 'none'); // FIRMS publishes no covering
    assert.ok(resolved.table.rowCount > 6e8, `rowCount ${resolved.table.rowCount}`);
    assert.equal(resolved.attribution[0].license, 'CC0-1.0');
    // The glob is an s3:// URI -- a browser must use `enumeration`, not the glob.
    assert.match(resolved.source.glob, /^s3:\/\//);
    return `${resolved.table.rowCount.toLocaleString()} rows, ${resolved.source.fileCount} year= partitions`;
  });

  await snippet('extract-core/README', 'stac-geoparquet is recognized from table:columns', async () => {
    const resolved = await resolveDataset({
      spec: 'cng-dataset/1.0',
      source: { kind: 'portolan-collection', url: S2_COLLECTION_URL },
    });
    assert.equal(resolved.source.kind, 'stac-geoparquet');
    assert.equal(resolved.table.timeColumn, 'datetime');
    assert.equal(resolved.attribution[0].shareAlike, true); // CC-BY-SA-3.0-IGO
    assert.ok(resolved.table.columns.some((c) => c.name === 'assets'));
    return `${resolved.table.columns.length} columns, share_alike: true`;
  });

  await snippet('extract-core/README', 'descriptorFromCollection()/collectionDownloadSupport() are synchronous', async () => {
    const collection = await fetch(FIRMS_COLLECTION_URL).then((r) => r.json());
    const descriptor = descriptorFromCollection(collection, { baseUrl: FIRMS_COLLECTION_URL });
    assert.equal(descriptor.source.kind, 'hive');

    const support = collectionDownloadSupport(collection, { baseUrl: FIRMS_COLLECTION_URL });
    assert.equal(support.supported, true);
    assert.equal(support.descriptor.source.kind, 'hive');

    // Design call #8's graceful refusal: raster is an absence, not an error dialog.
    const raster = collectionDownloadSupport(
      {
        id: 'some-cogs',
        license: 'CC-BY-4.0',
        assets: { data: { href: './scene.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] } },
      },
      { baseUrl: 'https://example.org/c/collection.json' },
    );
    assert.equal(raster.supported, false);
    assert.equal(raster.code, 'DATASET_UNSUPPORTED');
    assert.match(raster.message, /raster\/zarr/);
    return raster.message;
  });

  await snippet('extract-core/README', 'every error carries a stable code', async () => {
    const handle = download(
      { spec: 'cng-dataset/1.0', source: { kind: 'parquet', url: 'https://data.source.coop/does-not-exist-404.parquet' } },
      null,
      { spec: 'cng-filter/1.0', spatial: { mode: 'bbox' } },
      { spec: 'cng-output/1.0', format: 'geojson' },
      { sink: memorySink() },
    );
    await assert.rejects(handle.result, (err) => {
      assert.equal(isCngError(err), true);
      assert.ok(['NETWORK', 'HTTP_STATUS', 'DATASET_UNRESOLVED'].includes(err.code), `code ${err.code}`);
      return true;
    });
    assert.equal(handle.state, 'failed');
  });
}

// ===========================================================================
// packages/openlayers/README.md (the projection half; the DOM half is Playwright)
// ===========================================================================
async function groupOpenLayers() {
  console.log('\n@cngeo/openlayers (pure helpers only; the control is Playwright-verified)');
  const {
    isMercatorCode,
    isLonLatCode,
    lonLatToMercator,
    mercatorToLonLat,
    projectPoint,
    unprojectPoint,
    projectExtent,
    unprojectExtent,
    projectGeometry,
    selectNearestBBox,
  } = await import('../packages/openlayers/src/index.js');

  await snippet('openlayers/README', 'the Web Mercator bridge is closed-form', async () => {
    assert.equal(isMercatorCode('EPSG:3857'), true);
    assert.equal(isMercatorCode('EPSG:900913'), true);
    assert.equal(isLonLatCode('EPSG:4326'), true);
    assert.equal(isLonLatCode('EPSG:3857'), false);

    const [x, y] = lonLatToMercator([9.5, 47.14]);
    assert.ok(Math.abs(x - 1_057_539) < 50, `x ${x}`);
    assert.ok(Math.abs(y - 5_965_150) < 2000, `y ${y}`);

    const [lon, lat] = mercatorToLonLat([x, y]);
    assert.ok(Math.abs(lon - 9.5) < 1e-9 && Math.abs(lat - 47.14) < 1e-9, 'round trips');

    assert.deepEqual(projectPoint([9.5, 47.14], 'EPSG:4326'), [9.5, 47.14]); // no-op into 4326
    assert.deepEqual(unprojectPoint([9.5, 47.14], 'EPSG:4326'), [9.5, 47.14]);
    return `9.5,47.14 -> ${Math.round(x)},${Math.round(y)} m`;
  });

  await snippet('openlayers/README', 'projectExtent()/projectGeometry() for a 3857 view', async () => {
    const extent = projectExtent([9.47, 47.05, 9.64, 47.28], 'EPSG:3857');
    assert.equal(extent.length, 4);
    assert.ok(extent[0] < extent[2] && extent[1] < extent[3]);
    const back = unprojectExtent(extent, 'EPSG:3857');
    assert.ok(Math.abs(back[0] - 9.47) < 1e-9 && Math.abs(back[3] - 47.28) < 1e-9);

    const projected = projectGeometry(
      { type: 'Polygon', coordinates: [[[9.47, 47.05], [9.64, 47.05], [9.64, 47.28], [9.47, 47.05]]] },
      'EPSG:3857',
    );
    assert.equal(projected.type, 'Polygon');
    assert.ok(Math.abs(projected.coordinates[0][0][0]) > 1000, 'metres, not degrees');
  });

  await snippet('openlayers/README', 'selectNearestBBox() picks the right half of an antimeridian area', async () => {
    const fijiBoxes = [
      [177.3, -19.2, 180, -12.4],
      [-180, -19.2, -176.8, -12.4],
    ];
    assert.deepEqual(selectNearestBBox(fijiBoxes, 178), fijiBoxes[0]);
    assert.deepEqual(selectNearestBBox(fijiBoxes, -178), fijiBoxes[1]);
    assert.deepEqual(selectNearestBBox([[0, 0, 1, 1]], 170), [0, 0, 1, 1]); // 1-box case is a no-op
    assert.equal(selectNearestBBox([], 0), null);
  });
}

// ===========================================================================
// AGENTS.md
// ===========================================================================
async function groupAgents() {
  console.log('\nAGENTS.md (live: data.source.coop)');
  const { Geocoder, setHyparquetModules: setGeocoderModules } = await import('@cngeo/geocoder-core');
  const {
    setHyparquetModules: setDownloadModules,
    estimate,
    download,
    memorySink,
    resolveDataset,
  } = await import('@cngeo/extract-core');
  const { areaFromGeoJson } = await import('@cngeo/upload-core');
  const { toAreaDocument, fromAreaDocument } = await import('@cngeo/spec');

  setGeocoderModules({ hyparquet, compressors });
  setDownloadModules({ hyparquet, compressors, writer: hyparquetWriter });

  let area;

  await snippet('AGENTS.md', 'recipe 1: an Area from the live gazetteer', async () => {
    const geocoder = new Geocoder({ indexUrl: GB_INDEX_URL, limit: 5 });
    await geocoder.load();
    const [best] = await geocoder.search('liechtenstein', { levels: [0] });
    area = await geocoder.select(best);
    geocoder.close();

    assert.equal(area.type, 'Area');
    assert.equal(area.name, 'Liechtenstein');
    assert.equal(area.crs, 'EPSG:4326');
    assert.ok(area.filterGeometry);
    return `${area.name}, ${area.vertexCount.filter} filter vertices`;
  });

  await snippet('AGENTS.md', 'recipe 2: consume an Area (and serialize it)', async () => {
    // Everything a consumer needs is on the object; nothing has to be computed.
    assert.ok(Array.isArray(area.bboxes) && area.bboxes.length >= 1);
    for (const [w, s, e, n] of area.bboxes) assert.ok(w <= e && s <= n, 'bboxes are normalized');
    assert.equal(area.bboxes.length > 1, area.crossesAntimeridian);

    // Attribution casing: the manifest declares `share_alike` (snake_case,
    // like the rest of the manifest), the documented `AreaAttribution`
    // shape names it `shareAlike`. `geocoder-core` normalizes on ingestion
    // and keeps the raw key alongside, so BOTH spellings are present and
    // agree -- an adapter reading either one is correct. (This used to be
    // a wart this snippet pinned: only `share_alike` existed, so code
    // checking `shareAlike` alone silently reported no share-alike
    // obligation on ODbL data.)
    for (const a of area.provenance.attribution) {
      assert.equal(typeof a.license, 'string');
      assert.equal(typeof a.shareAlike, 'boolean');
      assert.equal(a.shareAlike, Boolean(a.share_alike));
    }
    assert.equal(area.provenance.attribution[0].shareAlike, false); // CC-BY-4.0

    const doc = toAreaDocument(area); // a plain GeoJSON Feature
    const json = JSON.stringify(doc);
    const restored = fromAreaDocument(JSON.parse(json));
    assert.equal(restored.name, area.name);
    assert.deepEqual(restored.bboxes, area.bboxes);
    return `${(json.length / 1024).toFixed(1)} KB as a GeoJSON Feature`;
  });

  await snippet('AGENTS.md', 'recipe 3a: DownloadRequest for a single GeoParquet file', async () => {
    const request = {
      spec: 'cng-request/1.0',
      dataset: ftwLiechtensteinDescriptor(),
      filter: {
        spec: 'cng-filter/1.0',
        area: { ref: 'area' },
        spatial: { mode: 'intersects' },
        where: [{ col: 'confidence', op: '>=', value: 0.9 }],
        columns: { include: ['id', 'confidence'] },
        limit: 50,
      },
      output: { spec: 'cng-output/1.0', format: 'geojson', filename: 'ftw-liechtenstein.geojson' },
    };
    const est = await estimate(request.dataset, area, request.filter);
    assert.ok(est.rows.max > 0);
    assert.equal(est.files.selected, 1);
    return `${est.rows.max} candidate rows, ${est.requests} requests`;
  });

  await snippet('AGENTS.md', 'recipe 3b: DownloadRequest for a hive-partitioned table', async () => {
    const dataset = await resolveDataset({
      spec: 'cng-dataset/1.0',
      id: 'firms-detections',
      source: { kind: 'portolan-collection', url: FIRMS_COLLECTION_URL },
    });
    const filter = {
      spec: 'cng-filter/1.0',
      area: { ref: 'area' },
      spatial: { mode: 'intersects' },
      time: { column: 'acq_datetime', start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z', closed: '[)' },
      columns: { exclude: ['instrument', 'satellite'] },
      limit: 100,
    };
    const est = await estimate(dataset, area, filter);
    const partitionStages = est.prune.filter((s) => s.stage.startsWith('part'));
    assert.ok(partitionStages.length >= 1, 'the time filter pruned partitions');
    assert.equal(est.files.total, 27);
    assert.equal(est.files.selected, 1, 'one year= partition survives a 1-week window');
    // FIRMS declares no covering COLUMN, but its GeoParquet 2.0 geometry
    // carries native per-row-group GeospatialStatistics, which prune hard.
    const rgStage = est.prune.find((st) => st.stage === 'row-group-bbox');
    assert.equal(rgStage.basis, 'native geometry statistics');
    assert.ok(rgStage.after < rgStage.before, 'native stats actually narrowed the read');
    assert.ok(!est.warnings.some((w) => w.code === 'no-covering'), 'native stats mean this is not a full scan');
    return `27 files -> 1; row groups ${rgStage.before}->${rgStage.after} via native stats`;
  });

  await snippet('AGENTS.md', 'recipe 3c: DownloadRequest for STAC-GeoParquet footprints', async () => {
    const dataset = await resolveDataset({
      spec: 'cng-dataset/1.0',
      id: 'sentinel-2-c1-l2a',
      source: { kind: 'portolan-collection', url: S2_COLLECTION_URL },
    });
    assert.equal(dataset.source.kind, 'stac-geoparquet');
    const filter = {
      spec: 'cng-filter/1.0',
      area: { ref: 'area' },
      spatial: { mode: 'intersects' },
      time: { start: '2025-06-01T00:00:00Z', end: '2025-06-08T00:00:00Z', closed: '[)' },
      where: [{ col: 'eo:cloud_cover', op: '<=', value: 20 }],
      columns: { include: ['id', 'datetime', 'eo:cloud_cover'], includeBbox: true },
      limit: 100,
    };
    const est = await estimate(dataset, area, filter);
    assert.equal(est.files.total, 12); // one STAC item per year= partition
    assert.equal(est.files.selected, 1, 'a one-week window selects one year');
    assert.ok(!est.columns.includes('assets'), 'the fat assets column is not in the projection');
    assert.deepEqual(est.columns, ['id', 'datetime', 'eo:cloud_cover', 'geometry']);
    // This collection's `bbox` column is a LIST, not a struct covering, so
    // `includeBbox: true` has nothing usable to add -- but the GeoParquet 2.0
    // geometry carries native per-row-group GeospatialStatistics, and those
    // prune the read by roughly 30x.
    const rgStage = est.prune.find((st) => st.stage === 'row-group-bbox');
    assert.equal(rgStage.basis, 'native geometry statistics');
    assert.ok(rgStage.after * 5 < rgStage.before, 'native stats prune the footprint read hard');
    assert.ok(!est.warnings.some((w) => w.code === 'no-covering'));
    // CC-BY-SA-3.0-IGO: the estimate tells you the output carries share-alike.
    assert.ok(est.warnings.some((w) => w.code === 'share-alike'));
    return `${est.files.selected}/${est.files.total} year partitions, ${est.rowGroups.selected}/${est.rowGroups.total} row groups, ${est.requests} requests`;
  });

  await snippet('AGENTS.md', 'recipe 4: run a download, handling the estimate and the ceiling', async () => {
    const dataset = ftwLiechtensteinDescriptor();
    const filter = {
      spec: 'cng-filter/1.0',
      spatial: { mode: 'intersects' },
      columns: { include: ['id', 'confidence'] },
    };
    const output = { spec: 'cng-output/1.0', format: 'geojson', filename: 'fields.geojson' };

    // Deliberately tiny ceiling, so the refusal path actually runs.
    const sink = memorySink();
    const handle = download(dataset, area, filter, output, { sink, ceiling: { rows: 100 } });

    // The shape AGENTS.md recipe 4 shows: await the result and decide from
    // the rejection, which carries the estimate. A breach rejects rather
    // than hanging, so there is no "inspect the estimate first or deadlock"
    // rule to remember any more.
    let result;
    let accepted = false;
    try {
      result = await handle.result;
    } catch (err) {
      assert.equal(err.code, 'CEILING_EXCEEDED');
      const est = err.context.estimate;
      if (est.rows.max > 10_000) {
        await handle.cancel('over budget');
        throw err;
      }
      // Returns the CONTINUED run's promise: the one awaited above has
      // already rejected.
      result = await handle.acceptCeiling();
      accepted = true;
    }
    assert.equal(accepted, true);
    const est = await handle.estimate; // still available, and still resolves

    assert.equal(handle.state, 'done');
    assert.equal(result.rows, 795);
    assert.ok(sink.chunks.length > 0);
    return `accepted ${est.rows.max} rows over a 100-row ceiling, wrote ${result.rows}`;
  });

  await snippet('AGENTS.md', 'recipe 5: an uploaded Area is interchangeable with a geocoded one', async () => {
    const { area: uploaded } = await areaFromGeoJson(
      { type: 'Polygon', coordinates: [[[9.47, 47.05], [9.64, 47.05], [9.64, 47.28], [9.47, 47.28], [9.47, 47.05]]] },
      { name: 'box.geojson' },
    );
    const est = await estimate(ftwLiechtensteinDescriptor(), uploaded, {
      spec: 'cng-filter/1.0',
      spatial: { mode: 'intersects' },
    });
    assert.ok(est.rows.max > 0);
    assert.equal(uploaded.provenance.source, 'upload');
    return 'same estimate() call, different Area source';
  });

  await snippet('AGENTS.md', 'recipe 6: the manifest contract, read directly', async () => {
    const manifest = await fetch(GB_INDEX_URL).then((r) => r.json());
    assert.equal(manifest.spec, 'cnmw-index/1.0');
    // Required top level.
    for (const key of ['source', 'index_version', 'catalog_version', 'rows', 'levels', 'index', 'boundaries', 'attribution']) {
      assert.ok(key in manifest, `manifest.${key}`);
    }
    // Required on `index`.
    for (const key of ['url', 'size', 'row_groups']) assert.ok(key in manifest.index, `index.${key}`);
    // Optional-but-present speed fields.
    assert.ok(manifest.index.footer_metadata_bytes < manifest.index.footer_bytes);
    // Per level: a full file always, a display file when the catalog built one.
    for (const b of manifest.boundaries) {
      assert.equal(typeof b.level, 'number');
      assert.ok(b.geometry_column);
      assert.ok(b.full.url);
      assert.ok(typeof b.row_group_rows === 'number');
    }
    return `rows ${manifest.rows}, levels ${manifest.levels.join('/')}, ${manifest.boundaries.length} boundary levels`;
  });

  await snippet('AGENTS.md', 'pitfall: hyparquet needs geoparquet:false AND utf8:false for raw WKB', async () => {
    const file = await hyparquet.asyncBufferFromUrl({ url: FTW_LI_URL, requestInit: { cache: 'no-store' } });

    // Wrong: GeoParquet auto-decode replaces the WKB with hyparquet's own GeoJSON.
    const autoMeta = await hyparquet.parquetMetadataAsync(file, { initialFetchSize: 65_536 });
    const [autoRow] = await hyparquet.parquetReadObjects({ file, metadata: autoMeta, columns: ['geometry'], rowStart: 0, rowEnd: 1, compressors });
    assert.equal(typeof autoRow.geometry, 'object');
    assert.ok(!(autoRow.geometry instanceof Uint8Array), 'auto-decoded, not bytes');

    // Right: both flags, and `initialFetchSize` inside the options OBJECT.
    const rawMeta = await hyparquet.parquetMetadataAsync(file, { initialFetchSize: 65_536, geoparquet: false });
    const [rawRow] = await hyparquet.parquetReadObjects({ file, metadata: rawMeta, columns: ['geometry'], rowStart: 0, rowEnd: 1, utf8: false, compressors });
    assert.ok(rawRow.geometry instanceof Uint8Array, 'raw WKB bytes');
    assert.equal(rawRow.geometry[0], 1); // little-endian WKB byte order marker

    // With geoparquet:false but utf8 left at its default, the column is mangled to a string.
    const [mangled] = await hyparquet.parquetReadObjects({ file, metadata: rawMeta, columns: ['geometry'], rowStart: 0, rowEnd: 1, compressors });
    assert.equal(typeof mangled.geometry, 'string', 'utf8:true silently turns WKB into text');
    return 'geoparquet:false + utf8:false, both, every time';
  });
}

// ===========================================================================

const GROUPS = {
  spec: groupSpec,
  geocoder: groupGeocoder,
  upload: groupUpload,
  download: groupDownload,
  openlayers: groupOpenLayers,
  agents: groupAgents,
};

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = requested.length > 0 ? requested : Object.keys(GROUPS);
for (const name of names) {
  const group = GROUPS[name];
  if (!group) {
    console.error(`Unknown group "${name}". Known: ${Object.keys(GROUPS).join(', ')}`);
    process.exit(2);
  }
  await group();
}

console.log(`\n${checks - failures.length}/${checks} snippet groups verified.`);
if (failures.length > 0) {
  console.error('FAILED:\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exitCode = 1;
}
