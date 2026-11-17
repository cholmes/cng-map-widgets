// @cng/openlayers -- pure antimeridian fit-selection logic, factored out
// of fit-bounds.js so it has no `ol` import and is directly unit-testable
// (mirrors @cng/maplibre's fit-bounds.js, which needed no extraction
// because MapLibre's own fitBounds takes plain arrays; OL's `view.fit()`
// needs a projected extent, which is why this package splits the pure
// selection from the OL-calling half).

/** @typedef {import('@cng/spec').BBox} BBox */

/**
 * Pick the bbox (from `Area.bboxes`, 1 or 2 entries per design doc §1.5)
 * nearest to `centerLon`, by shortest wraparound longitude distance from
 * each box's own center. For the common 1-box case this is a no-op; for
 * the antimeridian 2-box case (e.g. Fiji) this is what lets "search and
 * select" land the camera on the half of the area nearer the current
 * view instead of on an arbitrary one.
 * @param {readonly BBox[]} bboxes
 * @param {number} centerLon
 * @returns {BBox|null}
 */
export function selectNearestBBox(bboxes, centerLon) {
  if (!bboxes || bboxes.length === 0) return null;
  if (bboxes.length === 1) return bboxes[0];
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
  return best;
}
