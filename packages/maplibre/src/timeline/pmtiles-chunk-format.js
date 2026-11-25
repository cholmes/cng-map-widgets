// @cngeo/maplibre -- PMTiles as a timeline chunk format.
//
// A `ChunkFormat` for `@cngeo/timeline`'s orchestrator: `open()` reads what a
// PMTiles archive says about itself, and `mount()` turns it into one deck.gl
// `MVTLayer` whose tiles feed a histogram and whose cells are coloured by
// whatever window of time it is told to draw.
//
// Two ways an archive can carry time, and one archive may use both (cells at
// low zooms, points at high ones):
//
//   BUCKET COLUMNS  an aggregate layer whose features have a count per bucket
//                   (`count_20240105`). The window is the SUM of its columns,
//                   computed in an accessor: moving the window recolours and
//                   fetches nothing.
//   TIME PROPERTY   a layer of features that each carry their own day. The
//                   window is a range tested on the GPU.
//
// Settings that were measured, in the app this replaces (firms-catalog's
// firms-explorer), and are kept:
//   - `chromeWindowsNoCache` on the archive's source. Chrome serialises
//     concurrent Range reads of one URL behind its cache lock: 21 s -> 3 s.
//   - A tile size that makes deck.gl request floor(zoom) tiles, like MapLibre.
//   - `refinementStrategy: 'no-overlap'`: translucent parent and child tiles
//     must never be drawn together.
//   - Twenty requests in flight for the layer that is drawing: a tile is one
//     range read at 0.4-1.2 s, and a view wants a dozen.
//   - The tile BYTES are kept (64 MiB, least recently used), not the parsed
//     features, which are several times larger.

import { CngError } from '@cngeo/spec';
import { loadDeck as defaultLoadDeck } from '../deck-loader.js';
import { loadPmtiles as defaultLoadPmtiles } from '../pmtiles-loader.js';
import { layerZooms, timelineFromMetadata, vectorLayers } from './pmtiles-meta.js';
import { DECK_TILE_SIZE, TileCache, countFor, fillFor, pointFilter, tileZoom, windowPlan } from './tile-cells.js';

/** The count ramp of `@cngeo/timeline` (`COUNT_RAMP`), for a format given no stops. */
const DEFAULT_STOPS = [[1, '#2c3d5a'], [5, '#3f6d8f'], [20, '#59a1a0'], [75, '#a8c268'], [250, '#f2b134'], [1000, '#e8722c'], [4000, '#d1382a']];
const NO_LINE = [0, 0, 0, 0];

/** Bytes by key, least recently used out first, within a budget. */
export class ByteLru {
  constructor(maxBytes) {
    this.max = maxBytes;
    this.used = 0;
    /** @type {Map<string, ArrayBuffer>} insertion order is age: the first key is the oldest */
    this._map = new Map();
  }

  get(key) {
    const data = this._map.get(key);
    if (data === undefined) return undefined;
    this._map.delete(key); // re-insert, so a hit moves to the newest end
    this._map.set(key, data);
    return data;
  }

  set(key, data) {
    if (!data || !data.byteLength || data.byteLength > this.max) return;
    this.drop(key);
    this._map.set(key, data);
    this.used += data.byteLength;
    for (const oldest of this._map.keys()) {
      if (this.used <= this.max) break;
      this.drop(oldest);
    }
  }

  drop(key) {
    const had = this._map.get(key);
    if (had === undefined) return;
    this._map.delete(key);
    this.used -= had.byteLength;
  }

  dropPrefix(prefix) {
    for (const key of [...this._map.keys()]) if (key.startsWith(prefix)) this.drop(key);
  }
}

/** One device pixel, whatever the display: deck.gl's 1px line is two on a 2x screen and cells read as a heavy grid. */
const hairline = () => Math.max(1 / (globalThis.devicePixelRatio || 1), 1 / 3);

/**
 * @param {Object} [options]
 * @param {{ layer?: string, prefix?: string, idProperty?: string|null, maxzoom?: number }|false} [options.aggregate]
 *   The layer of cells with a count per bucket. `layer` defaults to the first that has bucket columns;
 *   `idProperty` names a cell so one split across tiles is counted once. `false` for an archive with no such layer.
 * @param {{ layer: string, property: string, minzoom?: number, color?: number[]|((properties: object) => number[]),
 *   radiusMeters?: number }} [options.points]  A layer of features that each carry their own day.
 * @param {[number, string][]|((o: { buckets: number, totalBuckets: number, zoom: number }) => [number, string][])} [options.stops]
 *   Cell colours by count. A function can scale them to how much of the record is selected.
 * @param {number} [options.cellOpacity]  Default 0.74.
 * @param {number[]} [options.outline]    A cell's outline colour. Default `[0, 0, 0, 46]`.
 * @param {number} [options.byteCacheBytes]  Default 64 MiB.
 * @param {string} [options.idPrefix]     Prefix of the deck.gl layer ids. Default `cng-timeline`.
 * @param {(chunk: object, error: any) => void} [options.onTileError]
 * @param {() => Promise<object>} [options.loadDeck]
 * @param {() => Promise<object>} [options.loadPmtiles]
 * @returns {import('@cngeo/timeline').ChunkFormat & { bytes: ByteLru }}
 */
export function pmtilesChunkFormat(options = {}) {
  const aggregate = options.aggregate === false ? null : { prefix: 'count_', idProperty: null, ...options.aggregate };
  const points = options.points ?? null;
  const prefix = aggregate?.prefix ?? 'count_';
  const cellOpacity = options.cellOpacity ?? 0.74;
  const outline = options.outline ?? [0, 0, 0, 46];
  const idPrefix = options.idPrefix ?? 'cng-timeline';
  const loadDeck = options.loadDeck ?? defaultLoadDeck;
  const loadPmtiles = options.loadPmtiles ?? defaultLoadPmtiles;
  const bytes = new ByteLru(options.byteCacheBytes ?? 64 << 20);
  const stopsFor = (context) => (typeof options.stops === 'function' ? options.stops(context) : options.stops) ?? DEFAULT_STOPS;
  const pointColour = typeof points?.color === 'function' ? (f) => points.color(f.properties) : (points?.color ?? [230, 85, 13, 235]);
  let pointFilterExtension = null;

  return {
    bytes,

    async open(chunk) {
      const [deck, pm] = await Promise.all([loadDeck(), loadPmtiles()]);
      const source = new pm.FetchSource(chunk.url);
      // Not a published option: the source's own switch for this workaround.
      source.chromeWindowsNoCache = true;
      const archive = new pm.PMTiles(source);
      const [metadata, header] = await Promise.all([archive.getMetadata(), archive.getHeader()]);
      const timeline = aggregate ? timelineFromMetadata(metadata, { layer: aggregate.layer, prefix }) : null;
      const unit = timeline?.unit ?? chunk.unit;
      if (unit !== chunk.unit) {
        throw new CngError(`Chunk "${chunk.id}" is described as having ${chunk.unit} buckets, but its archive has ${unit} buckets.`, 'TIMELINE_INVALID', {
          retryable: false,
          context: { chunk: chunk.id, url: chunk.url, declared: chunk.unit, found: unit },
        });
      }
      const pointsLayer = points ? vectorLayers(metadata).find((l) => l?.id === points.layer) : null;
      const pointsMinZoom = pointsLayer ? (points.minzoom ?? layerZooms(metadata, points.layer)?.minzoom ?? header.minZoom) : Infinity;
      const said = timeline?.layer ? layerZooms(metadata, timeline.layer) : null;
      const aggregateZooms = [said?.minzoom ?? header.minZoom, aggregate?.maxzoom ?? said?.maxzoom ?? (Number.isFinite(pointsMinZoom) ? pointsMinZoom - 1 : header.maxZoom)];
      return {
        deck, archive, unit,
        columns: timeline ? new Set(timeline.columns) : null,
        totalBuckets: timeline?.buckets ?? 0,
        declared: timeline?.declared ?? false,
        aggregateLayer: timeline?.layer ?? null,
        minZoom: header.minZoom, maxZoom: header.maxZoom,
        aggregateZooms, pointsMinZoom,
      };
    },

    mount(ctx) {
      const { chunk, info } = ctx;
      const { deck, archive } = info;
      const cache = new TileCache({ idProperty: aggregate?.idProperty ?? null, prefix, timeProperty: points?.property ?? null });
      const bytePrefix = `${chunk.url}|`;
      let window = null;
      let plan = windowPlan({ columns: info.columns, window: null, prefix });
      let filter = pointFilter(null, points?.property);
      let frozen = false;
      let destroyed = false;
      let lastLayer = null;
      let lastSettled = null;
      let tileErrors = 0;
      /** The layer panel's opacity, as last given to `layers()`: the sublayers multiply their own by it. */
      let layerOpacity = 1;

      /** deck.gl's `fetch` for this layer: one tile's bytes out of the archive, parsed and split by source layer. */
      const fetchTile = async (url, fetchContext = {}) => {
        const key = bytePrefix + url;
        let data = bytes.get(key);
        if (data === undefined) {
          const [z, x, y] = url.split('/').map(Number);
          const found = await archive.getZxy(z, x, y, fetchContext.signal);
          if (!found) return null; // no tile here: an empty tile, not an error
          data = found.data;
          bytes.set(key, data);
        }
        const features = await deck.MVTLoader.parse(data, { ...fetchContext.loadOptions, worker: false });
        const cells = [];
        const dots = [];
        for (const f of Array.isArray(features) ? features : []) {
          const name = f.properties?.layerName;
          if (points && name === points.layer) dots.push(f);
          else if (!info.aggregateLayer || name === info.aggregateLayer) cells.push(f);
        }
        // Split here rather than when rendering, so the arrays deck.gl sees as
        // `data` keep their identity across changes of window.
        return { cells, points: dots };
      };

      /** A tile's sublayers: cells coloured by the window, points filtered by it. */
      const renderTile = (p) => {
        if (!p.data || plan.keys.length + (filter.trigger === 'none' ? 0 : 1) === 0) return null;
        const out = [];
        if (p.data.cells?.length && plan.keys.length) {
          const stops = stopsFor({ buckets: plan.buckets, totalBuckets: info.totalBuckets, zoom: p.tile?.index?.z ?? 0 });
          const floor = stops[0][0];
          const current = plan;
          out.push(new deck.GeoJsonLayer({
            ...p,
            id: `${p.id}-cells`,
            data: p.data.cells,
            filled: true,
            stroked: true,
            opacity: cellOpacity * layerOpacity,
            lineWidthUnits: 'pixels',
            getLineWidth: hairline(),
            getFillColor: (f) => fillFor(countFor(current, f.properties), stops),
            getLineColor: (f) => (countFor(current, f.properties) >= floor ? outline : NO_LINE),
          }));
        }
        if (points && p.data.points?.length && filter.trigger !== 'none') {
          pointFilterExtension ??= new deck.DataFilterExtension({ filterSize: 1 });
          out.push(new deck.GeoJsonLayer({
            ...p,
            id: `${p.id}-points`,
            data: p.data.points,
            pointType: 'circle',
            stroked: false,
            opacity: 0.85 * layerOpacity,
            // A radius in metres grows with zoom; the pixel clamps are its end stops.
            pointRadiusUnits: 'meters',
            getPointRadius: points.radiusMeters ?? 57,
            pointRadiusMinPixels: 1.6,
            pointRadiusMaxPixels: 5.5,
            getFillColor: pointColour,
            // The window filters points on the GPU: a uniform per change, no per-point JavaScript.
            extensions: [...(p.extensions ?? []), pointFilterExtension],
            getFilterValue: filter.getFilterValue,
            filterRange: filter.filterRange,
          }));
        }
        return out.length ? out : null;
      };

      const report = () => {
        const loaded = lastLayer?.state?.tileset?.isLoaded;
        if (typeof loaded !== 'boolean' || loaded === lastSettled) return;
        lastSettled = loaded;
        ctx.settled(loaded);
      };

      return {
        setWindow(next) {
          window = next ?? null;
          frozen = false;
          plan = windowPlan({ columns: info.columns, window, prefix });
          filter = pointFilter(window, points?.property);
        },

        /** Counts per bucket for what is in view: cells below the points zoom, points from it up. */
        histogram(viewport) {
          const box = viewport?.bbox;
          if (destroyed || !Array.isArray(box)) return {};
          const view = { w: box[0], s: box[1], e: box[2], n: box[3] };
          const z = tileZoom(viewport.zoom ?? 0);
          if (z >= info.pointsMinZoom) return cache.pointHistogram(info.pointsMinZoom, info.maxZoom, view, info.unit).buckets;
          const at = Math.min(Math.max(z, info.aggregateZooms[0]), info.aggregateZooms[1]);
          return cache.histogram(at, at, view).buckets;
        },

        freeze() {
          frozen = true;
        },

        destroy() {
          destroyed = true;
          cache.clear();
          bytes.dropPrefix(bytePrefix);
          lastLayer = null;
        },

        /**
         * This chunk's deck.gl layer, described again from its present state
         * (deck.gl matches it to the last one by id).
         * @param {{ visible: boolean, opacity: number }} state
         * @param {string} [beforeId]
         */
        layers(state, beforeId) {
          if (destroyed) return [];
          const drawing = window !== null;
          layerOpacity = typeof state?.opacity === 'number' ? state.opacity : 1;
          const stopsKey = typeof options.stops === 'function' ? `fn:${plan.buckets}` : '';
          lastLayer = new deck.MVTLayer({
            id: `${idPrefix}--${chunk.id}`,
            data: '{z}/{x}/{y}',
            fetch: fetchTile,
            binary: false,
            minZoom: info.minZoom,
            maxZoom: info.maxZoom,
            tileSize: DECK_TILE_SIZE,
            refinementStrategy: 'no-overlap',
            loadOptions: { worker: false },
            beforeId,
            visible: state?.visible !== false,
            // Not `opacity` here: deck.gl would hand it down to the sublayers
            // AND they multiply by it themselves, applying it twice.
            // On its way out it must not starve its successor; a chunk that is
            // only loading for the histogram is in less of a hurry than one drawing.
            maxRequests: frozen ? 4 : drawing ? 20 : 6,
            pickable: false,
            onTileLoad: (tile) => {
              if (destroyed) return;
              cache.add(tile);
              ctx.changed();
            },
            onTileUnload: (tile) => cache.remove(tile),
            onViewportLoad: () => {
              if (destroyed) return;
              lastSettled = true;
              ctx.settled(true);
              ctx.changed();
            },
            onTileError: (error) => {
              tileErrors += 1;
              options.onTileError?.(chunk, error);
            },
            updateTriggers: { getFillColor: plan.signature + stopsKey, getLineColor: plan.signature + stopsKey, getFilterValue: filter.trigger },
            renderSubLayers: renderTile,
          });
          return [lastLayer];
        },

        /** Look at deck.gl's own tile set and say whether this view has loaded. Call after the map moves. */
        refresh: report,

        /** How many of the tiles this view wants have arrived. */
        tiles() {
          const selected = lastLayer?.state?.tileset?.selectedTiles ?? [];
          return { selected: selected.length, loaded: selected.filter((t) => t.isLoaded).length, errors: tileErrors };
        },
      };
    },
  };
}
