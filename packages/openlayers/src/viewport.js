// @cng/openlayers -- viewport provider (design doc §5.1 item 2, §5.2),
// the "out" direction of the projection bridge: the view's extent (in
// whatever projection the map uses) -> a 4326 `BBox` for the ranking
// viewport boost (design doc §3.2's `SearchOptions.viewport`).

import { unprojectExtent, isMercatorCode } from './projection.js';
import { olTransform } from './ol-proj-bridge.js';

/**
 * @param {import('ol/Map.js').default} map
 * @param {{ featureProjection?: string }} [options]
 * @returns {() => import('@cng/spec').BBox}
 */
export function viewportProvider(map, options = {}) {
  return () => {
    const view = map.getView();
    const code = options.featureProjection ?? view.getProjection().getCode();
    const size = map.getSize();
    const extent = view.calculateExtent(size);
    const transformOpt = isMercatorCode(code) ? {} : { transform: olTransform };
    return unprojectExtent(extent, code, transformOpt);
  };
}
