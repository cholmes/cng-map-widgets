// @cngeo/maplibre -- renderer for `pmtiles-vector` layers: a PMTiles archive
// of vector tiles, drawn with the collection's own MapLibre style when it has
// one, and with a plain default style when it does not.
//
// A style that cannot be loaded is NOT a failure of the layer. The data is
// fine and can still be shown; the layer falls back to the default style and
// leaves a note saying why. (A missing or malformed style file is the kind of
// thing a publisher gets wrong without noticing.)

import { CngError } from '@cngeo/spec';
import { archiveFor, sharedProtocol } from '../pmtiles-loader.js';
import { planStyle, defaultVectorStyle } from './style-plan.js';
import { addPlan, removePlan, setPlanOpacity, setPlanVisible } from './style-layers.js';

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
async function describeVectorLayers(ctx) {
  let metadata = {};
  try {
    metadata = (await (await archiveFor(ctx.spec.source.url)).getMetadata()) ?? {};
  } catch {
    /* an archive whose metadata cannot be read still has the names the spec gave */
  }
  const geometryOf = new Map((metadata.tilestats?.layers ?? []).map((l) => [l.layer, l.geometry]));
  const names = ctx.spec.source.layers.length ? ctx.spec.source.layers : (metadata.vector_layers ?? []).map((l) => l.id);
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
          { retryable: false, context: { id: ctx.spec.id, kind: ctx.spec.kind } },
        );
      }
      const protocol = await sharedProtocol();
      // Registering again is harmless: it is the same handler.
      ctx.addProtocol('pmtiles', protocol.tile);

      if (!plan) {
        plan = (await fetchStylePlan(ctx)) ?? defaultVectorStyle({ slug: ctx.slug, url: ctx.spec.source.url, vectorLayers: await describeVectorLayers(ctx) });
      }
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
