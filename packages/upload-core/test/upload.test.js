import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaFromGeoJson, areaFromFile, registerReader } from '../src/upload.js';
import { CngError } from '@cng/spec';

const triangle = (dx = 0, dy = 0) => ({
  type: 'Polygon',
  coordinates: [[[dx + 0, dy + 0], [dx + 1, dy + 0], [dx + 1, dy + 1], [dx + 0, dy + 0]]],
});

test('areaFromGeoJson: a single Feature produces combine="single" and no warnings', async () => {
  const fc = { type: 'Feature', properties: { name: 'solo' }, geometry: triangle() };
  const { area, warnings } = await areaFromGeoJson(fc, { name: 'solo.geojson' });
  assert.equal(area.provenance.combine, 'single');
  assert.equal(area.provenance.source, 'upload');
  assert.equal(area.geometry.type, 'Polygon');
  assert.deepEqual(warnings, []);
});

test('areaFromGeoJson: multiple non-overlapping features collect into one MultiPolygon, no overlap warning', async () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'a' }, geometry: triangle(0, 0) },
      { type: 'Feature', properties: { name: 'b' }, geometry: triangle(10, 10) },
    ],
  };
  const { area, warnings } = await areaFromGeoJson(fc, { name: 'two.geojson' });
  assert.equal(area.provenance.combine, 'collect');
  assert.equal(area.geometry.type, 'MultiPolygon');
  assert.equal(area.geometry.coordinates.length, 2);
  assert.equal(area.provenance.features.length, 2);
  assert.ok(!warnings.some((w) => w.code === 'overlapping-features'));
});

test('areaFromGeoJson: overlapping features raise the overlapping-features warning under collect', async () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: triangle(0, 0) },
      { type: 'Feature', properties: {}, geometry: triangle(0.5, 0.5) }, // overlaps the first
    ],
  };
  const { warnings } = await areaFromGeoJson(fc, { name: 'overlap.geojson' });
  const overlap = warnings.find((w) => w.code === 'overlapping-features');
  assert.ok(overlap, 'expected an overlapping-features warning');
  assert.equal(overlap.count, 1);
});

test('areaFromGeoJson: unionMode "dissolve" without a dissolver throws', async () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: triangle(0, 0) },
      { type: 'Feature', properties: {}, geometry: triangle(10, 10) },
    ],
  };
  await assert.rejects(() => areaFromGeoJson(fc, { name: 'x' }, { unionMode: 'dissolve' }), (err) => err instanceof CngError);
});

test('areaFromGeoJson: unionMode "dissolve" calls the supplied dissolver', async () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: triangle(0, 0) },
      { type: 'Feature', properties: {}, geometry: triangle(10, 10) },
    ],
  };
  const dissolved = { type: 'Polygon', coordinates: [[[0, 0], [11, 0], [11, 11], [0, 0]]] };
  let received = null;
  const { area } = await areaFromGeoJson(fc, { name: 'x' }, { unionMode: 'dissolve', dissolver: (polys) => { received = polys; return dissolved; } });
  assert.equal(received.length, 2);
  assert.equal(area.provenance.combine, 'dissolve');
  assert.deepEqual(area.geometry, dissolved);
});

test('areaFromGeoJson: repairs surface as a warning and in provenance.upload.repairs', async () => {
  const unclosedTriangle = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] };
  const { area, warnings } = await areaFromGeoJson({ type: 'Feature', properties: {}, geometry: unclosedTriangle }, { name: 'r.geojson' });
  const repaired = warnings.find((w) => w.code === 'repaired');
  assert.ok(repaired);
  assert.ok(repaired.repairs.some((r) => r.kind === 'closed-ring'));
  assert.ok(area.provenance.upload.repairs.some((r) => r.kind === 'closed-ring'));
});

test('areaFromGeoJson: a file with only points/lines throws AREA_UNSUPPORTED_GEOMETRY', async () => {
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }] };
  await assert.rejects(() => areaFromGeoJson(fc, { name: 'pts.geojson' }), (err) => err instanceof CngError && err.code === 'AREA_UNSUPPORTED_GEOMETRY');
});

test('areaFromGeoJson: an empty FeatureCollection throws AREA_EMPTY', async () => {
  await assert.rejects(
    () => areaFromGeoJson({ type: 'FeatureCollection', features: [] }, { name: 'empty.geojson' }),
    (err) => err instanceof CngError && err.code === 'AREA_EMPTY',
  );
});

test('areaFromGeoJson: a foreign declared CRS is rejected by default', async () => {
  const fc = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
    features: [{ type: 'Feature', properties: {}, geometry: triangle() }],
  };
  await assert.rejects(() => areaFromGeoJson(fc, { name: 'x' }), (err) => err instanceof CngError && err.code === 'AREA_INVALID_CRS');
});

test('areaFromGeoJson: onForeignCrs "assume-4326" proceeds and warns', async () => {
  const fc = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
    features: [{ type: 'Feature', properties: {}, geometry: triangle() }],
  };
  const { area, warnings } = await areaFromGeoJson(fc, { name: 'x' }, { onForeignCrs: 'assume-4326' });
  assert.ok(area);
  const assumed = warnings.find((w) => w.code === 'assumed-4326');
  assert.ok(assumed);
  assert.equal(assumed.declared, 'urn:ogc:def:crs:EPSG::3857');
});

test('areaFromGeoJson: a CRS84/4326-equivalent declared crs is NOT treated as foreign', async () => {
  const fc = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: [{ type: 'Feature', properties: {}, geometry: triangle() }],
  };
  const { warnings } = await areaFromGeoJson(fc, { name: 'x' });
  assert.ok(!warnings.some((w) => w.code === 'assumed-4326'));
});

test('areaFromGeoJson: maxFeatures is enforced', async () => {
  const fc = {
    type: 'FeatureCollection',
    features: [triangle(0, 0), triangle(10, 10), triangle(20, 20)].map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
  };
  await assert.rejects(
    () => areaFromGeoJson(fc, { name: 'x' }, { maxFeatures: 2 }),
    (err) => err instanceof CngError && err.code === 'UPLOAD_TOO_LARGE',
  );
});

test('areaFromFile: dispatches to the built-in geojson reader by extension and sets provenance.upload', async () => {
  const fc = { type: 'Feature', properties: {}, geometry: triangle() };
  const file = new File([JSON.stringify(fc)], 'my-area.geojson', { type: 'application/geo+json' });
  const { area } = await areaFromFile(file);
  assert.equal(area.provenance.upload.filename, 'my-area.geojson');
  assert.equal(area.provenance.upload.mediaType, 'application/geo+json');
  assert.equal(area.provenance.upload.featureCount, 1);
});

test('areaFromFile: enforces maxBytes before even dispatching to a reader', async () => {
  const file = new File(['x'.repeat(1000)], 'big.geojson', { type: 'application/geo+json' });
  await assert.rejects(
    () => areaFromFile(file, { maxBytes: 10 }),
    (err) => err instanceof CngError && err.code === 'UPLOAD_TOO_LARGE',
  );
});

test('areaFromFile: an unrecognized extension/media type throws UPLOAD_UNSUPPORTED_FORMAT', async () => {
  const file = new File(['not geo data'], 'data.shp', { type: 'application/octet-stream' });
  await assert.rejects(() => areaFromFile(file), (err) => err instanceof CngError && err.code === 'UPLOAD_UNSUPPORTED_FORMAT');
});

test('registerReader: a custom reader is dispatched to by its declared extension', async () => {
  const customReader = {
    id: 'test-custom',
    extensions: ['.custom'],
    mediaTypes: ['application/x-custom'],
    async read() {
      return { features: [{ type: 'Feature', properties: { name: 'from-custom' }, geometry: triangle() }], declaredCrs: null };
    },
  };
  registerReader(customReader);
  const file = new File(['irrelevant'], 'area.custom', { type: 'application/x-custom' });
  const { area } = await areaFromFile(file);
  assert.equal(area.provenance.features[0].name, 'from-custom');
});
