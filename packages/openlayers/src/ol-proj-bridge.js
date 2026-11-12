// @cnmw/openlayers -- the generic (non-3857) half of the projection
// bridge. Isolated into its own file so that every OTHER module in this
// package can be imported, and unit tested, without the `ol` peer
// dependency installed; only this file (and the modules that import it)
// need `ol` actually present.
//
// `ol/proj.js`'s `transform(coord, from, to)` already knows every
// projection OL ships registered (and anything a host page has added via
// proj4), so for "something exotic" (design doc §5.1 item 5) we hand it
// off rather than reimplementing it. The EPSG:3857 fast path in
// `projection.js` is used in preference to this whenever it applies, both
// for speed and so that path needs no `ol` import at all.

import { transform } from 'ol/proj.js';

/** @type {(coord: [number, number], from: string, to: string) => [number, number]} */
export const olTransform = (coord, from, to) => transform(coord, from, to);
