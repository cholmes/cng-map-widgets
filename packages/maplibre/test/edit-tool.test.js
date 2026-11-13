// @cnmw/maplibre -- unit tests for createEditTool's pure parts: the ring
// geometry math (no DOM/map) and buildEditedArea's provenance (built
// through @cnmw/spec's buildArea, no DOM at all).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArea } from '@cnmw/spec';
import {
  openRingOf,
  closeRing,
  moveVertex,
  midpointsOf,
  insertMidpoint,
  deleteVertex,
  largestExteriorRing,
  withExteriorRing,
  buildEditedArea,
} from '../src/edit-tool.js';

const SQUARE_CLOSED = [
  [0, 0],
  [2, 0],
  [2, 2],
  [0, 2],
  [0, 0],
];

test('openRingOf / closeRing round-trip', () => {
  const open = openRingOf(SQUARE_CLOSED);
  assert.equal(open.length, 4);
  assert.deepEqual(closeRing(open), SQUARE_CLOSED);
});

test('moveVertex: moves exactly one vertex, leaves others untouched', () => {
  const open = openRingOf(SQUARE_CLOSED);
  const moved = moveVertex(open, 1, [9, 9]);
  assert.deepEqual(moved[1], [9, 9]);
  assert.deepEqual(moved[0], open[0]);
  assert.deepEqual(moved[2], open[2]);
  assert.deepEqual(moved[3], open[3]);
  // original untouched (pure)
  assert.deepEqual(open[1], [2, 0]);
});

test('midpointsOf: one midpoint per edge, including the wrap-around edge', () => {
  const open = openRingOf(SQUARE_CLOSED);
  const mids = midpointsOf(open);
  assert.equal(mids.length, 4);
  assert.deepEqual(mids.map((m) => m.coord), [
    [1, 0],
    [2, 1],
    [1, 2],
    [0, 1],
  ]);
  assert.deepEqual(mids.map((m) => m.afterIndex), [0, 1, 2, 3]);
});

test('insertMidpoint: grows the ring by exactly one vertex at the right place', () => {
  const open = openRingOf(SQUARE_CLOSED);
  const withMid = insertMidpoint(open, 0, [1, 0]);
  assert.equal(withMid.length, open.length + 1);
  assert.deepEqual(withMid[1], [1, 0]);
  assert.deepEqual(withMid[0], open[0]);
  assert.deepEqual(withMid[2], open[1]);
});

test('deleteVertex: removes exactly one vertex above the minimum', () => {
  const open = openRingOf(SQUARE_CLOSED); // 4 unique vertices
  const smaller = deleteVertex(open, 1);
  assert.equal(smaller.length, 3);
  assert.deepEqual(smaller, [
    [0, 0],
    [2, 2],
    [0, 2],
  ]);
});

test('deleteVertex: refuses to go below a triangle (no-op, same length)', () => {
  const triangle = [
    [0, 0],
    [1, 0],
    [0, 1],
  ];
  const result = deleteVertex(triangle, 0);
  assert.equal(result.length, 3);
  assert.deepEqual(result, triangle);
});

test('largestExteriorRing: Polygon returns its own ring', () => {
  const geometry = { type: 'Polygon', coordinates: [SQUARE_CLOSED] };
  const { polygonIndex, ring } = largestExteriorRing(geometry);
  assert.equal(polygonIndex, 0);
  assert.deepEqual(ring, SQUARE_CLOSED);
});

test('largestExteriorRing: MultiPolygon picks the exterior ring with the most vertices', () => {
  const small = [
    [10, 10],
    [11, 10],
    [11, 11],
    [10, 10],
  ];
  const geometry = { type: 'MultiPolygon', coordinates: [[small], [SQUARE_CLOSED]] };
  const { polygonIndex, ring } = largestExteriorRing(geometry);
  assert.equal(polygonIndex, 1);
  assert.deepEqual(ring, SQUARE_CLOSED);
});

test('withExteriorRing: Polygon keeps holes, replaces only the exterior', () => {
  const hole = [
    [0.5, 0.5],
    [1.5, 0.5],
    [1.5, 1.5],
    [0.5, 1.5],
    [0.5, 0.5],
  ];
  const geometry = { type: 'Polygon', coordinates: [SQUARE_CLOSED, hole] };
  const newExterior = [
    [-1, -1],
    [3, -1],
    [3, 3],
    [-1, 3],
    [-1, -1],
  ];
  const updated = withExteriorRing(geometry, 0, newExterior);
  assert.equal(updated.coordinates.length, 2);
  assert.deepEqual(updated.coordinates[0], newExterior);
  assert.deepEqual(updated.coordinates[1], hole); // hole untouched
});

test('withExteriorRing: MultiPolygon replaces only the targeted polygon\'s exterior', () => {
  const other = [
    [10, 10],
    [11, 10],
    [11, 11],
    [10, 10],
  ];
  const geometry = { type: 'MultiPolygon', coordinates: [[other], [SQUARE_CLOSED]] };
  const newExterior = [
    [0, 0],
    [5, 0],
    [5, 5],
    [0, 5],
    [0, 0],
  ];
  const updated = withExteriorRing(geometry, 1, newExterior);
  assert.deepEqual(updated.coordinates[0][0], other); // untouched
  assert.deepEqual(updated.coordinates[1][0], newExterior);
});

// --- buildEditedArea: provenance (task's explicit "edited-Area provenance" ask) ---

function parentArea() {
  return buildArea({
    name: 'Liechtenstein',
    geometry: { type: 'Polygon', coordinates: [SQUARE_CLOSED] },
    source: 'geocoder',
    features: [{ featureId: 'LI-shape-1', name: 'Liechtenstein', level: 0, country: 'LIE' }],
    combine: 'single',
    geometryVariant: 'full',
    attribution: [{ text: 'geoBoundaries', license: 'CC-BY-4.0', shareAlike: false }],
    provenanceExtra: {
      geocoder: { indexUrl: 'https://example.test/index.json', indexSource: 'geoboundaries-cgaz', indexVersion: '1', catalogVersion: '1', boundaryUrl: 'https://example.test/LI.parquet' },
    },
  });
}

test('buildEditedArea: source is "edited"', () => {
  const parent = parentArea();
  const edited = buildEditedArea(parent, { type: 'Polygon', coordinates: [SQUARE_CLOSED] }, { moved: 1 });
  assert.equal(edited.provenance.source, 'edited');
});

test('buildEditedArea: provenance.edited carries the parent lineage', () => {
  const parent = parentArea();
  const edited = buildEditedArea(parent, { type: 'Polygon', coordinates: [SQUARE_CLOSED] }, { moved: 2, inserted: 1 });
  assert.equal(edited.provenance.edited.parentAreaId, parent.id);
  assert.equal(edited.provenance.edited.parentSource, 'geocoder');
  assert.equal(edited.provenance.edited.parentCreatedAt, parent.provenance.createdAt);
  assert.equal(edited.provenance.edited.tool, 'vertex-editor');
  assert.deepEqual(edited.provenance.edited.edits, { moved: 2, inserted: 1, deleted: 0 });
});

test('buildEditedArea: keeps the original featureId lineage in `features`', () => {
  const parent = parentArea();
  const edited = buildEditedArea(parent, { type: 'Polygon', coordinates: [SQUARE_CLOSED] });
  assert.deepEqual(edited.provenance.features, parent.provenance.features);
  assert.equal(edited.provenance.features[0].featureId, 'LI-shape-1');
});

test('buildEditedArea: a different id than the parent, and a new createdAt', () => {
  const parent = parentArea();
  const edited = buildEditedArea(parent, { type: 'Polygon', coordinates: [SQUARE_CLOSED] });
  assert.notEqual(edited.id, parent.id);
  assert.ok(edited.provenance.createdAt >= parent.provenance.createdAt);
});

test('buildEditedArea: a visibly shrunk geometry produces a smaller bbox (sanity check for the download row-count proof)', () => {
  const parent = parentArea(); // bbox [0,0,2,2]
  const shrunk = { type: 'Polygon', coordinates: [[[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1], [0.5, 0.5]]] };
  const edited = buildEditedArea(parent, shrunk);
  const areaOf = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  assert.ok(areaOf(edited.bbox) < areaOf(parent.bbox), `expected shrunk bbox area < parent bbox area (${areaOf(edited.bbox)} vs ${areaOf(parent.bbox)})`);
});
