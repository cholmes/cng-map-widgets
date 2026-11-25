// @cngeo/maplibre -- projection definitions for the UTM families imagery is
// published in, so opening a scene does not depend on a third party.
//
// deck.gl-raster reprojects a COG on the GPU from whatever CRS the file
// declares, and resolves that CRS's EPSG code through a registry
// (`@developmentseed/proj`). The registry answers from proj4's own
// definitions when it can -- 4326, 3857 and the WGS84 UTM zones -- and asks
// https://epsg.io/<code>.json for everything else. E12 saw exactly that on
// the first NAIP scene (EPSG:26910, NAD83 / UTM zone 10N): a request to a
// host that is neither the page's nor the data's, on the path to first pixel.
//
// A UTM zone needs no lookup. It is fully described by three things -- zone
// number, hemisphere, datum -- so the families below are generated, not
// stored: 221 codes from a table of eight rows.
//
// The GRS80 families are given a null shift to WGS84. Their true offsets
// (NAD83(2011), ETRS89, SIRGAS 2000, GDA94) are under two metres and are
// tied to moving plates; for placing imagery on a web map that is the same
// thing epsg.io's own definitions say.

/**
 * `[first code, last code, zone of the first code, south?, datum]`.
 * Zones count up with the code within a row; two families restart, so they
 * take two rows each.
 * @type {readonly [number, number, number, boolean, 'WGS84'|'NAD83'|'GRS80'][]}
 */
const FAMILIES = Object.freeze([
  [32601, 32660, 1, false, 'WGS84'], // WGS 84 / UTM zone 1N-60N
  [32701, 32760, 1, true, 'WGS84'], // WGS 84 / UTM zone 1S-60S
  [26901, 26923, 1, false, 'NAD83'], // NAD83 / UTM zone 1N-23N
  [6328, 6329, 59, false, 'GRS80'], // NAD83(2011) / UTM zone 59N, 60N ...
  [6330, 6348, 1, false, 'GRS80'], // ... then 1N-19N
  [25828, 25838, 28, false, 'GRS80'], // ETRS89 / UTM zone 28N-38N
  [31965, 31976, 11, false, 'GRS80'], // SIRGAS 2000 / UTM zone 11N-22N ...
  [31977, 31985, 17, true, 'GRS80'], // ... then 17S-25S
  [28348, 28358, 48, true, 'GRS80'], // GDA94 / MGA zone 48-58
  [7846, 7859, 46, true, 'GRS80'], // GDA2020 / MGA zone 46-59
]);

const DATUM = {
  WGS84: '+datum=WGS84',
  NAD83: '+datum=NAD83',
  GRS80: '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0',
};

/**
 * The proj4 definition of a projected UTM CRS, by EPSG code.
 * @param {number} epsg
 * @returns {string|null} `null` for any code outside the families above.
 */
export function utmDefinition(epsg) {
  if (!Number.isInteger(epsg)) return null;
  for (const [first, last, firstZone, south, datum] of FAMILIES) {
    if (epsg < first || epsg > last) continue;
    return `+proj=utm +zone=${firstZone + (epsg - first)}${south ? ' +south' : ''} ${DATUM[datum]} +units=m +no_defs`;
  }
  return null;
}

/** Every EPSG code `utmDefinition` answers for. */
export const KNOWN_UTM_CODES = Object.freeze(FAMILIES.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i)));

/**
 * Give the deck.gl module set's proj4 every definition above that it does
 * not already have. deck.gl-raster's registry then resolves those codes
 * locally. A definition proj4 already holds -- its own, or a host's -- is
 * never replaced. Safe to call any number of times.
 * @param {{ proj4?: { defs: (name: string, definition?: string) => unknown } }|null|undefined} deck
 * @returns {number} How many definitions this call added.
 */
export function registerKnownProjections(deck) {
  const proj4 = deck?.proj4;
  if (typeof proj4?.defs !== 'function') return 0;
  let added = 0;
  for (const code of KNOWN_UTM_CODES) {
    const name = `EPSG:${code}`;
    if (proj4.defs(name) !== undefined) continue;
    proj4.defs(name, /** @type {string} */ (utmDefinition(code)));
    added += 1;
  }
  return added;
}
