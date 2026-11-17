import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArea, validateArea, toAreaDocument, fromAreaDocument } from '../src/area.js';
import { CngError } from '../src/errors.js';

const contraCostaRing = [[-122.4267, 37.7177], [-121.5347, 37.7177], [-121.5347, 38.0994], [-122.4267, 38.0994], [-122.4267, 37.7177]];
const contraCosta = { type: 'Polygon', coordinates: [contraCostaRing] };

test('buildArea produces a structurally valid Area for a single geocoder feature', () => {
  const area = buildArea({
    name: 'Contra Costa',
    geometry: contraCosta,
    source: 'geocoder',
    features: [{ featureId: 'USA-ADM2-123', name: 'Contra Costa', level: 2, country: 'USA' }],
    combine: 'single',
    geometryVariant: 'full',
  });
  assert.equal(area.type, 'Area');
  assert.equal(area.crs, 'EPSG:4326');
  assert.equal(area.name, 'Contra Costa');
  assert.ok(area.id.startsWith('area_'));
  assert.deepEqual(area.geometry, contraCosta);
  assert.deepEqual(area.filterGeometry, contraCosta);
  assert.equal(area.crossesAntimeridian, false);
  assert.equal(area.bboxes.length, 1);
  assert.equal(area.provenance.source, 'geocoder');
  assert.equal(area.provenance.combine, 'single');
  assert.doesNotThrow(() => validateArea(area));
});

test('buildArea rejects non-polygon geometry', () => {
  assert.throws(
    () => buildArea({ name: 'bad', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, source: 'upload', features: [] }),
    (err) => err instanceof CngError && err.code === 'AREA_UNSUPPORTED_GEOMETRY',
  );
});

test('validateArea rejects a non-EPSG:4326 crs', () => {
  const area = buildArea({ name: 'x', geometry: contraCosta, source: 'geocoder', features: [] });
  const bad = { ...area, crs: 'EPSG:3857' };
  assert.throws(() => validateArea(bad), (err) => err instanceof CngError && err.code === 'AREA_INVALID_CRS');
});

test('toAreaDocument / fromAreaDocument round-trip', () => {
  const area = buildArea({
    name: 'Contra Costa',
    geometry: contraCosta,
    source: 'geocoder',
    features: [{ featureId: 'USA-ADM2-123', name: 'Contra Costa', level: 2, country: 'USA' }],
    attribution: [{ text: 'Boundaries: geoBoundaries CGAZ', license: 'CC-BY-4.0', shareAlike: false }],
  });
  const doc = toAreaDocument(area);
  assert.equal(doc.type, 'Feature');
  assert.deepEqual(doc.bbox, area.bbox);
  assert.ok('area:version' in doc.properties);
  assert.ok('area:provenance' in doc.properties);
  assert.equal(doc.properties['area:provenance'].source, 'geocoder');
  assert.equal(doc.properties['area:provenance'].combine, 'single');

  const roundTripped = fromAreaDocument(doc);
  assert.equal(roundTripped.id, area.id);
  assert.equal(roundTripped.name, area.name);
  assert.deepEqual(roundTripped.bboxes, area.bboxes);
  assert.deepEqual(roundTripped.geometry, area.geometry);
  assert.equal(roundTripped.provenance.source, 'geocoder');
  assert.equal(roundTripped.provenance.combine, 'single');
});

test('buildArea degrades filter geometry to bbox-only when simplification cannot hold the area delta', () => {
  // Build a dense near-circular polygon over the filter ceiling.
  const n = 20000;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    ring.push([Math.cos(theta) * 0.01, Math.sin(theta) * 0.01]);
  }
  ring.push(ring[0]);
  const dense = { type: 'Polygon', coordinates: [ring] };
  const area = buildArea({
    name: 'dense',
    geometry: dense,
    source: 'upload',
    features: [],
    filterVertexCeiling: 10,
    areaDeltaMaxRatio: 1e-15,
  });
  assert.equal(area.filterGeometry, null);
  assert.equal(area.provenance.simplification.degradedToBbox, true);
});

// `maxSyncInputVertices` (fix history: "Canada ADM0 select() blocks the
// main thread for ~24s" -- see simplify.js). buildArea passes it through
// to both of its internal simplification passes.

function denseRing(n, radius = 1) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    ring.push([Math.cos(theta) * radius, Math.sin(theta) * radius]);
  }
  ring.push(ring[0]);
  return ring;
}

test('buildArea without maxSyncInputVertices simplifies a largeish display geometry for real (unchanged default)', () => {
  const geometry = { type: 'Polygon', coordinates: [denseRing(3000, 0.01)] };
  const area = buildArea({
    name: 'big',
    geometry,
    source: 'upload',
    features: [],
    filterVertexCeiling: 200,
  });
  assert.equal(area.filterGeometry !== null, true);
  assert.equal(area.provenance.simplification.method, 'visvalingam');
  assert.equal(area.provenance.simplification.degradedToBbox, false);
});

test('buildArea with maxSyncInputVertices degrades filterGeometry to bbox-only on a large display geometry, without running the sync search', () => {
  // Same geometry as above, but opting into the vertex-count guard --
  // this is what geocoder-core's select() passes for its synchronous
  // (non-"both"-upgrade) builds, e.g. Canada's 68,973-vertex display ring.
  const geometry = { type: 'Polygon', coordinates: [denseRing(3000, 0.01)] };
  const area = buildArea({
    name: 'big',
    geometry,
    source: 'upload',
    features: [],
    filterVertexCeiling: 200,
    maxSyncInputVertices: 1500,
  });
  assert.equal(area.filterGeometry, null);
  assert.equal(area.provenance.simplification.method, 'bbox');
  assert.equal(area.provenance.simplification.degradedToBbox, true);
  // bboxes[] remain the honest filter basis (design doc §1.3).
  assert.ok(area.bboxes.length >= 1);
});

test('buildArea with maxSyncInputVertices still simplifies for real when the display geometry is small', () => {
  const geometry = { type: 'Polygon', coordinates: [denseRing(1200, 0.01)] };
  const area = buildArea({
    name: 'small',
    geometry,
    source: 'upload',
    features: [],
    filterVertexCeiling: 100,
    maxSyncInputVertices: 1500,
  });
  assert.equal(area.filterGeometry !== null, true);
  assert.equal(area.provenance.simplification.method, 'visvalingam');
  assert.equal(area.provenance.simplification.degradedToBbox, false);
});
