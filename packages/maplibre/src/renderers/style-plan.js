// @cngeo/maplibre -- pure style arithmetic for the style-layer renderers.
//
// No map, no network. Three jobs:
//
//   planStyle()          take a published MapLibre style document and turn it
//                        into sources and layers that can be dropped into
//                        SOMEONE ELSE'S map: ids namespaced per layer (every
//                        Portolan style calls its source `data`), URLs made
//                        absolute against the style file.
//   defaultVectorStyle() what to draw when there is no usable style.
//   opacityPaint()       scale a layer's opacity from whatever the style gave
//                        it, without flattening a published expression.

const PREFIX = 'cng-layer-';
const PMTILES = 'pmtiles://';

/** Colours for default styles, cycled by layer. */
const PALETTE = ['#1f77b4', '#d95f02', '#1b9e77', '#7570b3', '#e7298a', '#66a61e'];

const absolute = (href, base) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
};

/** `{z}` and friends survive `new URL()` only percent-encoded; put them back. */
const absoluteTemplate = (href, base) => absolute(href, base).replace(/%7B/gi, '{').replace(/%7D/gi, '}');

function resolveSource(def, styleUrl) {
  const out = structuredClone(def);
  if (typeof out.url === 'string') {
    // Portolan's convention: `pmtiles://../x.pmtiles` is relative to the STYLE
    // file, not to the page.
    if (out.url.startsWith(PMTILES)) {
      out.url = PMTILES + absolute(out.url.slice(PMTILES.length), styleUrl);
    } else {
      const resolved = absolute(out.url, styleUrl);
      // Styles in the wild also name the archive with NO scheme
      // (`"url": "../parishes.pmtiles"`). Left alone, MapLibre fetches the
      // archive as TileJSON and fails on its first bytes. An archive is
      // recognisable by its extension, so read it as what it is.
      let isArchive = false;
      try {
        isArchive = /\.pmtiles$/i.test(new URL(resolved).pathname);
      } catch {
        /* not a URL we can parse: leave it */
      }
      out.url = isArchive ? PMTILES + resolved : resolved;
    }
  }
  if (Array.isArray(out.tiles)) out.tiles = out.tiles.map((t) => absoluteTemplate(t, styleUrl));
  if (typeof out.data === 'string') out.data = absolute(out.data, styleUrl);
  return out;
}

/**
 * A published style as namespaced, absolute sources and layers.
 * @param {{ slug: string, styleJson: any, styleUrl: string }} input
 * @returns {{ sources: Record<string, object>, layers: object[], note?: string }}
 */
export function planStyle({ slug, styleJson, styleUrl }) {
  if (!styleJson || typeof styleJson !== 'object' || !Array.isArray(styleJson.layers) || typeof styleJson.sources !== 'object' || !styleJson.sources) {
    throw new Error('not a MapLibre style document (it needs `sources` and `layers`)');
  }
  const name = (id) => `${PREFIX}${slug}--${id}`;
  const sources = {};
  for (const [id, def] of Object.entries(styleJson.sources)) sources[name(id)] = resolveSource(def, styleUrl);

  const layers = [];
  const dropped = [];
  for (const layer of styleJson.layers) {
    if (layer.type === 'background') {
      dropped.push(`${layer.id} (a background layer would cover the map)`);
      continue;
    }
    if (typeof layer.source !== 'string' || !(layer.source in styleJson.sources)) {
      dropped.push(`${layer.id} (its source "${layer.source}" is not defined)`);
      continue;
    }
    layers.push({ ...structuredClone(layer), id: name(layer.id), source: name(layer.source) });
  }
  return { sources, layers, ...(dropped.length ? { note: `Style layers left out: ${dropped.join('; ')}.` } : {}) };
}

const POLYGON = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const LINE = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const POINT = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];

function shapes(geometry) {
  if (/polygon/i.test(geometry ?? '')) return { fill: true, line: true, circle: false, filtered: false };
  if (/line/i.test(geometry ?? '')) return { fill: false, line: true, circle: false, filtered: false };
  if (/point/i.test(geometry ?? '')) return { fill: false, line: false, circle: true, filtered: false };
  return { fill: true, line: true, circle: true, filtered: true };
}

function defaultLayers({ idBase, source, sourceLayer, geometry, color }) {
  const use = shapes(geometry);
  const base = { source, ...(sourceLayer ? { 'source-layer': sourceLayer } : {}) };
  const out = [];
  if (use.fill) out.push({ id: `${idBase}fill`, type: 'fill', ...base, ...(use.filtered ? { filter: POLYGON } : {}), paint: { 'fill-color': color, 'fill-opacity': 0.3 } });
  // With an unknown geometry the outline is drawn for lines and polygons alike.
  if (use.line) out.push({ id: `${idBase}line`, type: 'line', ...base, ...(use.filtered ? { filter: ['any', LINE, POLYGON] } : {}), paint: { 'line-color': color, 'line-width': 1.5 } });
  if (use.circle) {
    out.push({
      id: `${idBase}circle`,
      type: 'circle',
      ...base,
      ...(use.filtered ? { filter: POINT } : {}),
      paint: { 'circle-color': color, 'circle-radius': 4, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 },
    });
  }
  return out;
}

/**
 * What to draw for a PMTiles archive with no usable style: per vector layer,
 * fill + outline for polygons, a line for lines, a circle for points -- or all
 * three, each filtered to its own geometry type, when the type is unknown.
 * @param {{ slug: string, url: string, vectorLayers: { id: string, geometry?: string }[] }} input
 */
export function defaultVectorStyle({ slug, url, vectorLayers }) {
  const source = `${PREFIX}${slug}--data`;
  const layers = vectorLayers.flatMap((vl, i) =>
    defaultLayers({ idBase: `${PREFIX}${slug}--${vl.id}-`, source, sourceLayer: vl.id, geometry: vl.geometry, color: PALETTE[i % PALETTE.length] }),
  );
  return { sources: { [source]: { type: 'vector', url: PMTILES + url } }, layers };
}

/** The default layers for a GeoJSON source: fill, line and circle, each filtered by geometry type. */
export function defaultGeojsonLayers({ slug, source, color = PALETTE[0] }) {
  return defaultLayers({ idBase: `${PREFIX}${slug}--`, source, sourceLayer: undefined, geometry: undefined, color });
}

/** The paint properties that carry a layer type's opacity. */
const OPACITY_PROPS = {
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  symbol: ['text-opacity', 'icon-opacity'],
  raster: ['raster-opacity'],
  'fill-extrusion': ['fill-extrusion-opacity'],
  heatmap: ['heatmap-opacity'],
  background: ['background-opacity'],
};

const isZoom = (expr) => Array.isArray(expr) && expr.length === 1 && expr[0] === 'zoom';

function scale(value, factor) {
  if (value === undefined || value === null) return factor;
  if (typeof value === 'number') return value * factor;
  if (Array.isArray(value)) {
    // A zoom `interpolate`/`step` must stay the OUTERMOST expression (MapLibre
    // rejects a style that wraps one), so scale its outputs in place.
    if (value[0] === 'interpolate' && isZoom(value[2])) return value.map((v, i) => (i >= 4 && i % 2 === 0 ? scale(v, factor) : v));
    if (value[0] === 'step' && isZoom(value[1])) return value.map((v, i) => (i >= 2 && i % 2 === 0 ? scale(v, factor) : v));
    return ['*', value, factor];
  }
  // A legacy function object: { stops: [[zoom, value], …] }.
  if (typeof value === 'object' && Array.isArray(value.stops)) {
    return { ...value, stops: value.stops.map(([z, v]) => [z, typeof v === 'number' ? v * factor : v]) };
  }
  return value;
}

/**
 * The paint properties to set so `layer` shows at its own opacity times
 * `factor`. `layer` is the layer as the STYLE defined it (its base), not as
 * the map currently has it -- so repeated calls never compound. Factor 1
 * returns exactly what the style had.
 * @param {{ type: string, paint?: Record<string, unknown> }} layer
 * @param {number} factor 0..1
 * @returns {Record<string, unknown>}
 */
export function opacityPaint(layer, factor) {
  const out = {};
  for (const prop of OPACITY_PROPS[layer.type] ?? []) {
    const base = layer.paint?.[prop];
    out[prop] = factor === 1 ? (base ?? 1) : scale(base, factor);
  }
  return out;
}
