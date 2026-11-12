// Prototype of the only coordinate math a raster clip needs: lon/lat (the
// `Area` contract's only CRS, §1) -> the COG's own projected CRS, because
// geotiff.js reads windows in *image* coordinates and does no reprojection.
//
// Scope decision (E11): support the CRSs that cloud rasters actually use --
// EPSG:4326/CRS84, EPSG:3857, and the WGS84 UTM zones (EPSG:326xx/327xx,
// which is what Sentinel-2, Landsat and most COG archives publish). Anything
// else refuses loudly (RASTER_CRS_UNSUPPORTED) rather than silently
// mis-locating a window. A proj4js-backed plugin is the documented escape
// hatch; it is deliberately not a dependency of the core.

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const E2 = WGS84_F * (2 - WGS84_F);
const K0 = 0.9996;
const DEG = Math.PI / 180;

/** @param {number} epsg @returns {{ kind:'geographic'|'webmercator'|'utm', zone?:number, south?:boolean }} */
export function describeCrs(epsg) {
  if (epsg === 4326 || epsg === 4979 || epsg === 4269) return { kind: 'geographic' };
  if (epsg === 3857 || epsg === 900913 || epsg === 3785) return { kind: 'webmercator' };
  if (epsg >= 32601 && epsg <= 32660) return { kind: 'utm', zone: epsg - 32600, south: false };
  if (epsg >= 32701 && epsg <= 32760) return { kind: 'utm', zone: epsg - 32700, south: true };
  return null;
}

/** Transverse Mercator forward (Snyder 8-9..8-11); cm-level inside a UTM zone. */
function lonLatToUtm(lon, lat, zone, south) {
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const phi = lat * DEG;
  const lam = (lon - lon0) * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const N = WGS84_A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const ep2 = E2 / (1 - E2);
  const C = ep2 * cosPhi * cosPhi;
  const A = lam * cosPhi;
  const M =
    WGS84_A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 * E2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));
  const x =
    K0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let y =
    K0 *
    (M +
      N *
        tanPhi *
        ((A * A) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (south) y += 10000000;
  return [x, y];
}

function lonLatToWebMercator(lon, lat) {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  return [
    (lon * DEG) * WGS84_A,
    WGS84_A * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2)),
  ];
}

/** @param {number} epsg @returns {(lon:number, lat:number)=>[number,number]} */
export function forwardTransform(epsg) {
  const d = describeCrs(epsg);
  if (!d) return null;
  if (d.kind === 'geographic') return (lon, lat) => [lon, lat];
  if (d.kind === 'webmercator') return lonLatToWebMercator;
  return (lon, lat) => lonLatToUtm(lon, lat, d.zone, d.south);
}

/**
 * A lon/lat bbox is not a rectangle in a projected CRS, so project the whole
 * ring (corners + edge midpoints, 4x densified) and take the envelope. Using
 * only the 4 corners under-covers a UTM window by up to a few hundred metres
 * at the zone edges; densifying is two dozen flops and removes the class of
 * bug entirely.
 * @param {[number,number,number,number]} bbox lon/lat
 * @param {number} epsg
 */
export function projectBbox(bbox, epsg) {
  const fwd = forwardTransform(epsg);
  if (!fwd) return null;
  const [w, s, e, n] = bbox;
  const steps = 16;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const fx = w + ((e - w) * i) / steps;
    const fy = s + ((n - s) * i) / steps;
    for (const [lon, lat] of [[fx, s], [fx, n], [w, fy], [e, fy]]) {
      const [x, y] = fwd(lon, lat);
      if (x < xmin) xmin = x;
      if (y < ymin) ymin = y;
      if (x > xmax) xmax = x;
      if (y > ymax) ymax = y;
    }
  }
  return [xmin, ymin, xmax, ymax];
}
