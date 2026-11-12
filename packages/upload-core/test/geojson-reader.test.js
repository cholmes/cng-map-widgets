import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geoJsonReader } from '../src/geojson-reader.js';

function makeFile(obj, name = 'test.geojson', type = 'application/geo+json') {
  return new File([JSON.stringify(obj)], name, { type });
}

test('geoJsonReader.read: a valid FeatureCollection yields one raw feature per input feature', async () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    ],
  };
  const { features, declaredCrs } = await geoJsonReader.read(makeFile(fc));
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.name, 'A');
  assert.equal(declaredCrs, null);
});

test('geoJsonReader.read: a bare Feature is accepted', async () => {
  const feature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
  const { features } = await geoJsonReader.read(makeFile(feature));
  assert.equal(features.length, 1);
});

test('geoJsonReader.read: invalid JSON throws UPLOAD_PARSE_ERROR', async () => {
  const file = new File(['{not json'], 'bad.geojson', { type: 'application/geo+json' });
  await assert.rejects(() => geoJsonReader.read(file), (err) => err.code === 'UPLOAD_PARSE_ERROR');
});

test('geoJsonReader.read: detects the legacy top-level crs member', async () => {
  const fc = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
    features: [],
  };
  const { declaredCrs } = await geoJsonReader.read(makeFile(fc));
  assert.equal(declaredCrs, 'urn:ogc:def:crs:EPSG::3857');
});

test('geoJsonReader.read: passes points/lines through untouched -- filtering is the repair pipeline\'s job, not the reader\'s', async () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    ],
  };
  const { features } = await geoJsonReader.read(makeFile(fc));
  assert.equal(features.length, 2);
  assert.equal(features[0].geometry.type, 'Point');
  assert.equal(features[1].geometry.type, 'Polygon');
});
