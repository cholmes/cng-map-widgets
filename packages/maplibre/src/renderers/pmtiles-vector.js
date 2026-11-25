// @cngeo/maplibre -- renderer for `pmtiles-vector` layers: a PMTiles archive
// of vector tiles, drawn with the collection's own MapLibre style when it has
// one, and with a plain default style when it does not.
//
// Two different things can go wrong, and they are treated differently:
//
//   The STYLE cannot be loaded (a 404, an HTML error page, no usable layers).
//   That is not a failure of the layer: the data is fine and can still be
//   shown. The layer falls back to a default style and leaves a note. A
//   missing or malformed style file is the kind of thing a publisher gets
//   wrong without noticing.
//
//   The ARCHIVE cannot be read, or holds nothing this can draw. That IS a
//   failure, and it is found before anything is put on the map -- by reading
//   the archive's header, which is the first thing drawing it would need
//   anyway. Without that check a 404 archive sat in the list as "ready",
//   with an empty source and no layers.

import { CngError } from '@cngeo/spec';
import { archiveFor, sharedProtocol } from '../pmtiles-loader.js';
import { planStyle, defaultVectorStyle } from './style-plan.js';
import { addPlan, removePlan, setPlanOpacity, setPlanVisible } from './style-layers.js';
import { creditSources } from '../layer-attribution.js';

/** PMTiles header `tileType`: 1 is MVT (vector); 2-5 are raster image formats. */
const TILE_TYPE_MVT = 1;
const TILE_TYPE_NAMES = { 0: 'unknown', 2: 'PNG', 3: 'JPEG', 4: 'WebP', 5: 'AVIF' };

const context = (ctx) => ({ id: ctx.spec.id, kind: ctx.spec.kind, url: ctx.spec.source.url });

/** Read the archive's header, or throw the error a user should see. */
async function openArchive(ctx) {
  let archive;
  let header;
  try {
    archive = await archiveFor(ctx.spec.source.url);
    header = await archive.getHeader();
  } catch (cause) {
    throw new CngError(`The PMTiles archive for "${ctx.spec.title}" could not be read: ${cause?.message ?? cause}`, 'LAYER_LOAD_FAILED', {
      cause,
      context: context(ctx),
    });
  }
  if (header?.tileType !== undefined && header.tileType !== TILE_TYPE_MVT) {
    throw new CngError(
      `"${ctx.spec.title}" is a PMTiles archive of raster tiles (${TILE_TYPE_NAMES[header.tileType] ?? `type ${header.tileType}`}); only vector tiles can be drawn here.`,
      'LAYER_UNSUPPORTED',
      { retryable: false, context: { ...context(ctx), tileType: header.tileType } },
    );
  }
  return archive;
}

async function fetchStylePlan(ctx) {
  const styleUrl = ctx.spec.source.style?.url;
  if (!styleUrl) return null;
  try {
    const response = await fetch(styleUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const plan = planStyle({ slug: ctx.slug, styleJson: await response.json(), styleUrl });
    if (!plan.layers.length) throw new Error('it has no usable layers');
    if (plan.note) ctx.note(plan.note);
    return plan;
  } catch (err) {
    ctx.note(`The published style could not be used (${err?.message ?? err}); drawn with a default style.`);
    return null;
  }
}

/** Vector layer names and geometry types, from the spec and the archive's own metadata. */
async function describeVectorLayers(ctx, archive) {
  let metadata = {};
  try {
    metadata = (await archive.getMetadata()) ?? {};
  } catch {
    /* the header was readable; without metadata the names must come from the spec */
  }
  const geometryOf = new Map((Array.isArray(metadata.tilestats?.layers) ? metadata.tilestats.layers : []).map((l) => [l?.layer, l?.geometry]));
  const discovered = (Array.isArray(metadata.vector_layers) ? metadata.vector_layers : []).map((l) => l?.id).filter((id) => typeof id === 'string');
  const names = ctx.spec.source.layers.length ? ctx.spec.source.layers : discovered;
  if (!names.length) {
    throw new CngError(
      `"${ctx.spec.title}" names no vector layers, and its PMTiles archive does not list any; there is nothing to draw.`,
      'LAYER_UNSUPPORTED',
      { retryable: false, context: context(ctx) },
    );
  }
  return names.map((id) => ({ id, geometry: geometryOf.get(id) }));
}

/** @param {import('../layer-manager.js').RendererContext} ctx */
export function pmtilesVectorRenderer(ctx) {
  /** Built once; a basemap change re-adds from it without fetching again. */
  let plan = null;

  return {
    async add(state) {
      if (typeof ctx.addProtocol !== 'function') {
        throw new CngError(
          `"${ctx.spec.title}" needs MapLibre's addProtocol to read PMTiles. Pass it: new LayerManager(map, { addProtocol: maplibregl.addProtocol }).`,
          'LAYER_UNSUPPORTED',
          { retryable: false, context: context(ctx) },
        );
      }
      if (!plan) {
        const archive = await openArchive(ctx);
        const styled = (await fetchStylePlan(ctx)) ?? defaultVectorStyle({ slug: ctx.slug, url: ctx.spec.source.url, vectorLayers: await describeVectorLayers(ctx, archive) });
        plan = { ...styled, sources: creditSources(styled.sources, ctx.spec.attribution) };
      }
      const protocol = await sharedProtocol();
      // Registering again is harmless: it is the same handler.
      ctx.addProtocol('pmtiles', protocol.tile);
      addPlan(ctx.map, plan, state);
    },
    remove() {
      if (plan) removePlan(ctx.map, plan);
    },
    setVisible(visible) {
      if (plan) setPlanVisible(ctx.map, plan, visible);
    },
    setOpacity(opacity) {
      if (plan) setPlanOpacity(ctx.map, plan, opacity);
    },
    styleLayerIds: () => (plan ? plan.layers.map((l) => l.id) : []),
  };
}
