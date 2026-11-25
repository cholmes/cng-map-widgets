// @cngeo/maplibre -- the timeline's cell logic: selection counts, colours, and
// the tile cache that answers "how many, per bucket, in view".
//
// MapLibre answers "what is in the loaded tiles" and "colour this cell by an
// expression" on its own. deck.gl does neither: tiles arrive through
// onTileLoad and leave through onTileUnload, and a cell's colour is whatever
// JavaScript returns from an accessor. So the tiles are kept here, and each
// cell's count is computed in one place -- which runs in Node with no deck.gl.
//
// Ported from firms-catalog's apps/firms-explorer/deck-cells.js. The property
// names it hard-coded (`count_`, `a5_cell`, `day`) are now configuration.

import { dayNumber, dayNumbersOfBucket, keyOfDayNumber, keysBetween } from './days.js';

// ---------------------------------------------------------------- tile zoom

/**
 * MapLibre requests floor(zoom) tiles. deck.gl's TileLayer requests
 * round(zoom + log2(512 / tileSize)), so this tile size makes that floor(zoom)
 * too. Rounding half a zoom early costs real bytes: at zoom 5.6 the rounded
 * rule asks for the z6 tiles, where the floored rule keeps z5 until zoom 6.
 */
export const DECK_TILE_SIZE = 512 * Math.SQRT2;
export function tileZoom(viewZoom) {
  return Math.floor(viewZoom);
}

// ------------------------------------------------------------------- bounds

const MAX_LAT = 85.0511287798066;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + ((lat * Math.PI) / 180) / 2));
const latOfMerc = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

/**
 * A tile-local coordinate as longitude and latitude. deck.gl parses MVT
 * geometry in tile-local space, 0..1 from the north-west corner; the histogram
 * needs lon/lat, so the local coordinate is placed on the tile's bbox --
 * linearly in longitude, and linearly in mercator y, which is not linear in
 * latitude.
 */
export function localToLngLat(x, y, bbox) {
  const n = mercY(Math.min(bbox.north, MAX_LAT));
  const s = mercY(Math.max(bbox.south, -MAX_LAT));
  return [bbox.west + x * (bbox.east - bbox.west), latOfMerc(n + y * (s - n))];
}

/** A feature's bounding box in lon/lat, from its tile-local geometry. */
export function featureBounds(feature, bbox) {
  let x0 = 1;
  let x1 = 0;
  let y0 = 1;
  let y1 = 0;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0];
      if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1];
      if (c[1] > y1) y1 = c[1];
    } else for (const q of c) walk(q);
  };
  walk(feature.geometry.coordinates);
  const [w, n] = localToLngLat(x0, y0, bbox);
  const [e, s] = localToLngLat(x1, y1, bbox);
  return { w, s, e, n };
}

/** Longitude-cyclic overlap, so world copies do not drop cells off the edge. */
export function lngOverlaps(cw, ce, w, e) {
  if (e - w >= 360) return true;
  const k = Math.floor((w - cw) / 360) * 360;
  return (cw + k <= e && ce + k >= w) || (cw + k + 360 <= e && ce + k + 360 >= w);
}

// ------------------------------------------------------------ selected count

/**
 * Everything a per-cell count needs, worked out once per change of window
 * rather than once per cell: the accessor then does one property read per
 * selected bucket.
 *
 * @param {Object} o
 * @param {Set<string>|null} o.columns  Bucket keys the archive has a column for; null when it did not say.
 * @param {{ unit: 'day'|'month', ranges: [string, string][] }|null} o.window  What to draw; null for nothing.
 * @param {string} [o.prefix]  Default `count_`.
 * @returns {{ keys: string[], buckets: number, signature: string }}
 *   `buckets` is how wide the window is on the calendar, whether or not every bucket has a column.
 */
export function windowPlan({ columns, window, prefix = 'count_' }) {
  if (!window || !Array.isArray(window.ranges) || !window.ranges.length) return { keys: [], buckets: 0, signature: 'none' };
  const keys = [];
  let buckets = 0;
  for (const [from, to] of window.ranges) {
    for (const key of keysBetween(from, to, window.unit)) {
      buckets += 1;
      if (!columns || columns.has(key)) keys.push(prefix + key);
    }
  }
  return { keys, buckets, signature: `${prefix}|${window.unit}|${window.ranges.map((r) => r.join('-')).join(',')}` };
}

/** A cell's count within the planned window. MVT leaves out zero-valued attributes: absent is zero. */
export function countFor(plan, properties) {
  let sum = 0;
  for (const key of plan.keys) sum += properties[key] || 0;
  return sum;
}

// ------------------------------------------------------------------ colours

const TRANSPARENT = [0, 0, 0, 0];
const rgbaCache = new Map();

function rgba(hex) {
  let c = rgbaCache.get(hex);
  if (!c) {
    c = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
    rgbaCache.set(hex, c);
  }
  return c;
}

/**
 * The fill for a count under a set of stops (`[threshold, '#rrggbb']`,
 * ascending): transparent below the first, otherwise the colour of the
 * highest stop reached. Arrays are shared, so an accessor allocates nothing
 * per cell.
 */
export function fillFor(count, stops) {
  if (!(count >= stops[0][0])) return TRANSPARENT;
  let hex = stops[0][1];
  for (const [threshold, colour] of stops) if (count >= threshold) hex = colour;
  return rgba(hex);
}

// ------------------------------------------------------------------- points

/**
 * The day a feature belongs to, as days since 1970 -- from a number or string
 * `YYYYMMDD`, or an ISO date. NaN when it has none.
 */
export function dayNumberOf(properties, property) {
  const v = properties?.[property];
  if (v === null || v === undefined) return NaN;
  const text = String(v);
  if (/^\d{8}$/.test(text)) return dayNumber(text);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : NaN;
}

/**
 * How to filter points to a window with deck.gl's `DataFilterExtension`.
 *
 * One run of days is a range the GPU tests: the accessor is each point's day
 * number and never changes, so moving the window updates a uniform and
 * nothing else. Several runs (a chunk whose middle another chunk owns) cannot
 * be one range; then the accessor itself says in or out, and `trigger`
 * changes with the window so deck.gl recomputes it.
 *
 * @returns {{ getFilterValue: (feature: object) => number, filterRange: [number, number], trigger: string }}
 */
export function pointFilter(window, property) {
  if (!window || !window.ranges?.length) return { getFilterValue: () => 0, filterRange: [1, 0], trigger: 'none' };
  const spans = window.ranges.map(([from, to]) => [dayNumbersOfBucket(from, window.unit)[0], dayNumbersOfBucket(to, window.unit)[1]]);
  if (spans.length === 1) {
    return {
      getFilterValue: (f) => {
        const n = dayNumberOf(f.properties, property);
        return Number.isNaN(n) ? -1 : n;
      },
      filterRange: spans[0],
      trigger: property,
    };
  }
  return {
    getFilterValue: (f) => {
      const n = dayNumberOf(f.properties, property);
      return spans.some(([a, b]) => n >= a && n <= b) ? 1 : 0;
    },
    filterRange: [1, 1],
    trigger: `${property}|${spans.map((s) => s.join('-')).join(',')}`,
  };
}

// --------------------------------------------------------------- tile cache

/**
 * The loaded tiles of one chunk, and per-cell records derived from them.
 *
 * A tile is `{ id, index: { z }, bbox: { west, south, east, north }, content:
 * { cells, points } }` -- deck.gl's tile, with its features already split by
 * source layer. A cell record is its lon/lat bounds and its non-zero buckets.
 * The bounds are the union over every tile piece the cell has arrived in: a
 * cell on a tile seam is clipped, and the first piece alone can lie entirely
 * outside a view the whole cell is in.
 */
export class TileCache {
  /**
   * @param {{ idProperty?: string|null, prefix?: string, timeProperty?: string|null }} [options]
   *   `idProperty`: the property that names a cell, so a cell split across tiles is counted once
   *   (default: the feature's own `id`; with neither, each piece counts). `timeProperty`: a point's day.
   */
  constructor({ idProperty = null, prefix = 'count_', timeProperty = null } = {}) {
    this.idProperty = idProperty;
    this.prefix = prefix;
    this.timeProperty = timeProperty;
    /** @type {Map<string, { z: number, bbox: object, cells: object[], points: object[] }>} */
    this.tiles = new Map();
    /** @type {Map<any, object>} cell id -> record */
    this.cells = new Map();
  }

  get size() {
    return this.tiles.size;
  }

  add(tile) {
    this.tiles.set(tile.id, { z: tile.index.z, bbox: tile.bbox, cells: tile.content?.cells ?? [], points: tile.content?.points ?? [] });
  }

  remove(tile) {
    this.tiles.delete(tile.id);
  }

  clear() {
    this.tiles.clear();
    this.cells.clear();
  }

  #buckets(properties) {
    const keys = [];
    const values = [];
    const at = this.prefix.length;
    for (const name in properties) {
      if (!name.startsWith(this.prefix)) continue;
      // Reject `count_c*`, `count_d`, `count_modis` on the first character
      // before the regex is reached; the regex per key was measured to matter.
      const c0 = name.charCodeAt(at);
      if (c0 < 48 || c0 > 57) continue;
      const key = name.slice(at);
      if (key.length !== 6 && key.length !== 8) continue;
      if (!/^\d+$/.test(key)) continue;
      const value = properties[name];
      if (!value) continue;
      keys.push(key);
      values.push(value);
    }
    return { keys, values };
  }

  #cell(feature, bbox, id) {
    let record = this.cells.get(id);
    const piece = `${bbox.west}:${bbox.north}`;
    if (!record) {
      record = { ...featureBounds(feature, bbox), ...this.#buckets(feature.properties), pieces: new Set([piece]) };
      this.cells.set(id, record);
      return record;
    }
    // Another piece of a known cell widens its bounds; the buckets are the
    // cell's own and are the same in every piece.
    if (!record.pieces.has(piece)) {
      record.pieces.add(piece);
      const b = featureBounds(feature, bbox);
      if (b.w < record.w) record.w = b.w;
      if (b.e > record.e) record.e = b.e;
      if (b.s < record.s) record.s = b.s;
      if (b.n > record.n) record.n = b.n;
    }
    return record;
  }

  #idOf(feature) {
    const id = this.idProperty ? feature.properties?.[this.idProperty] : feature.id;
    return id === null || id === undefined ? null : id;
  }

  /**
   * Sum the bucket columns over the cells in view, from tiles at zooms
   * z0..z1. Restricting to one zoom range keeps two resolutions from being
   * counted together.
   * @param {number} z0
   * @param {number} z1
   * @param {{ w: number, s: number, e: number, n: number }} view
   * @returns {{ buckets: Record<string, number>, cells: number }}
   */
  histogram(z0, z1, view) {
    const total = new Map();
    const seen = new Set();
    let cells = 0;
    const tally = ({ keys, values }) => {
      for (let i = 0; i < keys.length; i++) total.set(keys[i], (total.get(keys[i]) ?? 0) + values[i]);
    };
    for (const t of this.tiles.values()) {
      if (t.z < z0 || t.z > z1) continue;
      const offscreen = t.bbox.south > view.n || t.bbox.north < view.s || !lngOverlaps(t.bbox.west, t.bbox.east, view.w, view.e);
      for (const f of t.cells) {
        const id = this.#idOf(f);
        if (id === null) {
          // Nothing to tell this piece from another piece of the same cell: it counts as it comes.
          if (offscreen) continue;
          const b = featureBounds(f, t.bbox);
          if (b.s > view.n || b.n < view.s || !lngOverlaps(b.w, b.e, view.w, view.e)) continue;
          cells += 1;
          tally(this.#buckets(f.properties));
          continue;
        }
        // Absorb every piece -- even from a tile off screen -- before the
        // seen test, so a cell's bounds are whole by the time it is tested.
        const record = this.#cell(f, t.bbox, id);
        if (offscreen || seen.has(id)) continue;
        seen.add(id);
        if (record.s > view.n || record.n < view.s || !lngOverlaps(record.w, record.e, view.w, view.e)) continue;
        cells += 1;
        tally(record);
      }
    }
    return { buckets: Object.fromEntries(total), cells };
  }

  /**
   * The same histogram, counted from points in view, by `timeProperty`.
   * Points carry no id to dedupe on and are clipped to their tile, so one on a
   * seam can count twice: a rounding error against thousands.
   * @param {'day'|'month'} unit
   * @returns {{ buckets: Record<string, number>, points: number }}
   */
  pointHistogram(z0, z1, view, unit) {
    const total = new Map();
    let points = 0;
    if (!this.timeProperty) return { buckets: {}, points };
    for (const t of this.tiles.values()) {
      if (t.z < z0 || t.z > z1) continue;
      if (t.bbox.south > view.n || t.bbox.north < view.s || !lngOverlaps(t.bbox.west, t.bbox.east, view.w, view.e)) continue;
      for (const f of t.points) {
        const c = f.geometry?.coordinates;
        if (!c || typeof c[0] !== 'number') continue;
        const [lng, lat] = localToLngLat(c[0], c[1], t.bbox);
        if (lat < view.s || lat > view.n || !lngOverlaps(lng, lng, view.w, view.e)) continue;
        const n = dayNumberOf(f.properties, this.timeProperty);
        if (Number.isNaN(n)) continue;
        const day = keyOfDayNumber(n);
        const key = unit === 'month' ? day.slice(0, 6) : day;
        total.set(key, (total.get(key) ?? 0) + 1);
        points += 1;
      }
    }
    return { buckets: Object.fromEntries(total), points };
  }
}
