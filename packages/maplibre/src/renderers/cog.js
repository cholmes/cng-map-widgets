// @cngeo/maplibre -- renderer for `cog` layers: one Cloud-Optimized GeoTIFF,
// drawn by Development Seed's deck.gl-raster `COGLayer`. The file is read by
// range request straight from object storage and reprojected on the GPU, so a
// COG in a UTM zone needs no server and no pre-warping.
//
// `COGLayer` infers how to draw the file from the file itself (its photometric
// interpretation and sample format), which is right for a display-ready COG:
// true-colour RGB(A), or a single band with an embedded colour table. Custom
// stretches and band composites are the imagery work of Phase 2.
//
// deck.gl's idiom is to describe layers again from state on every change;
// it diffs them by `id` and props. So `deckLayers()` builds a new layer object
// each time, with the SAME id and the SAME `source` string -- a changed
// `source` would reopen the file.

import { CngError } from '@cngeo/spec';

/** @param {import('../layer-manager.js').RendererContext} ctx */
export function cogRenderer(ctx) {
  const id = `cng-layer-${ctx.slug}`;
  const url = ctx.spec.source.url;
  /** @type {any} */
  let COGLayer = null;

  return {
    async add() {
      ({ COGLayer } = await ctx.deck());
    },
    remove() {
      /* nothing of its own on the map: the manager rebuilds the overlay's layer list */
    },
    setVisible() {},
    setOpacity() {},
    deckLayers(state, beforeId) {
      if (!COGLayer) return [];
      return [
        new COGLayer({
          id,
          source: url,
          visible: state.visible,
          opacity: state.opacity,
          beforeId,
          // A tile that fails (a 403, a truncated file) should not take the
          // layer down or go unseen: say so on the layer.
          onTileError: (err) => ctx.note(`Some of this image could not be loaded: ${err?.message ?? err}`),
          // A file deck.gl cannot OPEN (a 404, not a GeoTIFF) or cannot DRAW
          // (a pixel type it has no default pipeline for, such as Float32)
          // arrives here, some time after the layer was handed over. Without
          // this the layer sat in the list as "ready" with nothing on the map.
          // Returning true tells deck.gl the error is handled (it would
          // otherwise only log it).
          onError: (err) => {
            ctx.fail(
              new CngError(`"${ctx.spec.title}" could not be drawn: ${err?.message ?? err}`, 'LAYER_LOAD_FAILED', {
                cause: err,
                context: { id: ctx.spec.id, kind: ctx.spec.kind, url },
              }),
            );
            return true;
          },
        }),
      ];
    },
  };
}
