// @cnmw/maplibre -- antimeridian-aware fitBounds (design doc §5.1 item 4).
//
// `Area.bboxes` is the computational form: 1 box for a normal area, 2 for
// one that crosses the antimeridian. MapLibre's own `fitBounds` cannot be
// handed a bbox with west > east (it does not know it is a wrap), so for
// the 2-box case we fit the box nearer the map's current centre -- a
// reasonable default for "I just searched for Fiji and want to see it",
// without requiring `renderWorldCopies` tricks.

/**
 * @param {import('maplibre-gl').Map} map
 * @param {readonly [number, number, number, number][]} bboxes
 * @param {{ padding?: number, maxZoom?: number }} [options]
 */
export function fitAreaBounds(map, bboxes, options = {}) {
  if (!bboxes || bboxes.length === 0) return;
  const padding = options.padding ?? 40;
  const maxZoom = options.maxZoom;

  let box = bboxes[0];
  if (bboxes.length > 1) {
    const center = map.getCenter();
    const centerLon = center.lng;
    let best = bboxes[0];
    let bestDist = Infinity;
    for (const b of bboxes) {
      const boxCenterLon = (b[0] + b[2]) / 2;
      const dist = Math.min(
        Math.abs(boxCenterLon - centerLon),
        Math.abs(boxCenterLon - centerLon + 360),
        Math.abs(boxCenterLon - centerLon - 360),
      );
      if (dist < bestDist) {
        bestDist = dist;
        best = b;
      }
    }
    box = best;
  }

  const [west, south, east, north] = box;
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding, ...(maxZoom !== undefined ? { maxZoom } : {}) },
  );
}
