// The lon/lat -> image-CRS transform is the one place a raster clip can be
// silently, invisibly wrong: a window offset by a few hundred metres still
// returns plausible-looking pixels. Reference values come from GDAL 3.10.3 /
// PROJ (`osr.CoordinateTransformation`, EPSG:4326 -> target), so this test
// pins our closed-form implementation against the real thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCrs, forwardTransform, projectBbox } from '../src/crs.js';

/** [lon, lat, epsg, x, y] -- x/y from GDAL/PROJ. */
const REFERENCE = [
  [-122.25, 37.8, 32610, 566026.8993, 4183889.8557], // Oakland, UTM 10N (the E11 clip)
  [13.4, 52.52, 32633, 391440.0321, 5820079.6669], // Berlin, UTM 33N
  [151.21, -33.87, 32756, 334435.7061, 6250816.3978], // Sydney, UTM 56S
  [-60.0, -3.0, 32721, 166476.933, 9667949.5253], // Amazon, UTM 21S
  [-122.25, 37.8, 3857, -13608807.7495, 4551210.9197], // Web Mercator
];

test('forward transforms match GDAL/PROJ to better than 1 cm', () => {
  for (const [lon, lat, epsg, x, y] of REFERENCE) {
    const [gx, gy] = forwardTransform(epsg)(lon, lat);
    assert.ok(Math.abs(gx - x) < 0.01, `EPSG:${epsg} x: ${gx} vs ${x}`);
    assert.ok(Math.abs(gy - y) < 0.01, `EPSG:${epsg} y: ${gy} vs ${y}`);
  }
});

test('geographic CRSs pass through unchanged', () => {
  assert.deepEqual(forwardTransform(4326)(-94.5, 42.5), [-94.5, 42.5]);
  assert.equal(describeCrs(4326).kind, 'geographic');
  assert.equal(describeCrs(3857).kind, 'webmercator');
  assert.deepEqual(describeCrs(32610), { kind: 'utm', zone: 10, south: false });
  assert.deepEqual(describeCrs(32756), { kind: 'utm', zone: 56, south: true });
});

test('an unsupported CRS is null, not a wrong answer', () => {
  assert.equal(describeCrs(2193), null); // NZTM
  assert.equal(forwardTransform(2193), null);
  assert.equal(projectBbox([0, 0, 1, 1], 2193), null);
});

test('projectBbox densifies edges, so the window covers the whole area', () => {
  // A UTM zone bends lon/lat rectangles: a parallel maps to a curve, so an
  // envelope built from the 4 corners alone under-covers the edge that bows
  // outward (measured: the SOUTH edge of a zone-wide box in the northern
  // hemisphere, by ~1.9 km -- 186 Sentinel-2 pixels of missing data).
  const bbox = [-125, 37, -119, 41]; // 6 degrees wide, zone 10's full width
  const fwd = forwardTransform(32610);
  const corners = [
    fwd(bbox[0], bbox[1]), fwd(bbox[2], bbox[1]), fwd(bbox[0], bbox[3]), fwd(bbox[2], bbox[3]),
  ];
  const cornerEnv = [
    Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])),
    Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1])),
  ];
  const dense = projectBbox(bbox, 32610);
  assert.ok(dense[0] <= cornerEnv[0] && dense[1] <= cornerEnv[1]);
  assert.ok(dense[2] >= cornerEnv[2] && dense[3] >= cornerEnv[3]);
  // and the difference is material: kilometres, i.e. hundreds of pixels
  assert.ok(cornerEnv[1] - dense[1] > 1000, `south edge gain ${cornerEnv[1] - dense[1]} m`);
});

test('a small bbox projects to the right place, exactly', () => {
  const [xmin, ymin, xmax, ymax] = projectBbox([-122.3, 37.75, -122.2, 37.85], 32610);
  // Cross-checked against the E11 clip, whose GeoTIFF GDAL reads as
  // Upper Left (561580, 4189480) after outward pixel snapping at 10 m.
  assert.ok(xmin > 561570 && xmin < 561600, `xmin ${xmin}`);
  assert.ok(ymax > 4189470 && ymax < 4189500, `ymax ${ymax}`);
  assert.ok(xmax > 570460 && xmax < 570490, `xmax ${xmax}`);
  assert.ok(ymin > 4178290 && ymin < 4178320, `ymin ${ymin}`);
});
