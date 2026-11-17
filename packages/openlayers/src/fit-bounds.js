// @cng/openlayers -- antimeridian-aware fitBounds (design doc §5.1 item
// 4), the OL-calling half. Mirrors @cng/maplibre/src/fit-bounds.js's
// behavior (fit the bbox nearer the map's current center when an Area
// crosses the antimeridian) but must additionally project the chosen
// 4326 bbox into the view's projection before calling `view.fit()` --
// MapLibre's `fitBounds` takes plain lon/lat, OL's `view.fit()` does not.

import { unprojectPoint, projectExtent, isMercatorCode } from './projection.js';
import { olTransform } from './ol-proj-bridge.js';
import { selectNearestBBox } from './nearest-bbox.js';

/**
 * @param {import('ol/Map.js').default} map
 * @param {readonly [number, number, number, number][]} bboxes
 * @param {{ padding?: number, maxZoom?: number, featureProjection?: string }} [options]
 */
export function fitAreaBounds(map, bboxes, options = {}) {
  if (!bboxes || bboxes.length === 0) return;
  const view = map.getView();
  const code = options.featureProjection ?? view.getProjection().getCode();
  const transformOpt = isMercatorCode(code) ? {} : { transform: olTransform };

  const center = view.getCenter();
  const [centerLon] = center ? unprojectPoint(center, code, transformOpt) : [0, 0];
  const box = selectNearestBBox(bboxes, centerLon) ?? bboxes[0];

  const padding = options.padding ?? 40;
  const extent = projectExtent(box, code, transformOpt);
  view.fit(extent, {
    padding: [padding, padding, padding, padding],
    maxZoom: options.maxZoom,
    duration: 300,
  });
}
