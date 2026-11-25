// @cngeo/maplibre -- renderer for `geojson` layers: inline GeoJSON or a URL,
// drawn as a MapLibre geojson source with a default style (fill, outline and
// points, each filtered to its own geometry type).

import { defaultGeojsonLayers } from './style-plan.js';
import { addPlan, removePlan, setPlanOpacity, setPlanVisible } from './style-layers.js';
import { creditSources } from '../layer-attribution.js';

/** @param {import('../layer-manager.js').RendererContext} ctx */
export function geojsonRenderer(ctx) {
  const source = `cng-layer-${ctx.slug}--data`;
  const plan = {
    sources: creditSources({ [source]: { type: 'geojson', data: ctx.spec.source.data ?? ctx.spec.source.url } }, ctx.spec.attribution),
    layers: defaultGeojsonLayers({ slug: ctx.slug, source }),
  };
  return {
    async add(state) {
      addPlan(ctx.map, plan, state);
    },
    remove: () => removePlan(ctx.map, plan),
    setVisible: (visible) => setPlanVisible(ctx.map, plan, visible),
    setOpacity: (opacity) => setPlanOpacity(ctx.map, plan, opacity),
    styleLayerIds: () => plan.layers.map((l) => l.id),
  };
}
