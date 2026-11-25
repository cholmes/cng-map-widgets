// @cngeo/stac -- the `render` column: how a catalog index could say what each
// collection draws as.
//
// Today a catalog index says what a collection IS -- title, extent, licence --
// and nothing about how to show it. To put a search result on a map, its
// collection JSON has to be fetched and read (`layersFromCollection`): one
// more request per click, and no way to filter a search by "things I can
// draw" without fetching thousands of documents.
//
// A `render` value is `layersFromCollection`'s answer, written down in the
// index: a short list, one entry per layer, nine flat fields. It holds only
// what is specific to drawing. A collection's title, extent, dates, thumbnail
// and credit are (or belong in) columns of their own, and a layer takes them
// from there.
//
// This is the shape experiment E13 writes and measures
// (experiments/e13-render-column). It is a proposal, not a published spec.

import { validateLayerSpec } from '@cngeo/spec';

/**
 * @typedef {Object} RenderEntry
 * @property {string} kind                 A LayerSpec kind: `pmtiles-vector`, `cog`, `scenes`, `table`, `unsupported`.
 * @property {string} id                   The layer's id.
 * @property {string|null} title           Only when it differs from the collection's own title.
 * @property {string|null} url             The PMTiles archive, the COG, or the table's parquet file.
 * @property {string|null} style           A MapLibre style JSON for the tiles.
 * @property {string[]|null} layers        The PMTiles source layers.
 * @property {string|null} display_asset   `scenes`: the item asset to draw.
 * @property {string|null} items           `scenes`: the item table, when it is one file.
 * @property {string|null} reason          `unsupported`: why.
 */

/** A render entry's fields, in order. A parquet struct column has exactly these. */
export const RENDER_FIELDS = Object.freeze(['kind', 'id', 'title', 'url', 'style', 'layers', 'display_asset', 'items', 'reason']);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * LayerSpecs -> the `render` value to store for their collection.
 * @param {object[]} layers   From `layersFromCollection`.
 * @param {{ title?: string }} [options]  The collection's own title: a layer's title is stored only when it differs.
 * @returns {RenderEntry[]}
 */
export function renderFromLayers(layers, options = {}) {
  return (Array.isArray(layers) ? layers : []).filter(isObject).map((layer) => {
    const source = isObject(layer.source) ? layer.source : {};
    return {
      kind: layer.kind,
      id: layer.id,
      title: layer.title && layer.title !== options.title ? layer.title : null,
      url: str(source.url),
      style: str(source.style?.url),
      layers: Array.isArray(source.layers) && source.layers.length ? source.layers.filter((l) => typeof l === 'string') : null,
      display_asset: str(source.displayAsset),
      items: str(source.items?.url),
      reason: str(source.reason),
    };
  });
}

/** Credits as LayerSpec wants them, from an index's `attribution` column (snake_case) or a LayerSpec's own. */
function attributionOf(entry) {
  const listed = (Array.isArray(entry.attribution) ? entry.attribution : []).filter((a) => isObject(a) && (str(a.text) || str(a.license)));
  if (!listed.length) {
    // An index with no attribution column: say at least whose it is and under what terms.
    return [{ text: entry.title ?? entry.id, ...(entry.license ? { license: entry.license } : {}), shareAlike: false, share_alike: false }];
  }
  return listed.map((a) => {
    const shareAlike = Boolean(a.shareAlike ?? a.share_alike);
    return { ...(str(a.text) ? { text: a.text } : {}), ...(str(a.license) ? { license: a.license } : {}), ...(str(a.url) ? { url: a.url } : {}), shareAlike, share_alike: shareAlike };
  });
}

/**
 * A catalog entry's `render` value -> LayerSpecs, with no request. The
 * layer's extent, dates, thumbnail and credit come from the entry.
 *
 * @param {object} entry  A `CatalogEntry` (`render`, `href`, `title`, and what else it has).
 * @returns {object[]} Validated LayerSpecs; `[]` when the entry has no `render`.
 * @throws {CngError} `LAYER_INVALID` when a render entry cannot be a layer (an address that is not http(s), say).
 */
export function layersFromRender(entry) {
  const render = Array.isArray(entry?.render) ? entry.render.filter(isObject) : [];
  if (!render.length) return [];
  const attribution = attributionOf(entry);
  const box = entry.bbox;
  const boxOk = Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[0] <= box[2] && box[1] <= box[3];
  const temporal = entry.start || entry.end ? [entry.start ?? null, entry.end ?? null] : null;
  return render.map((r) => {
    let source;
    if (r.kind === 'pmtiles-vector') {
      source = { url: r.url, ...(Array.isArray(r.layers) && r.layers.length ? { layers: r.layers } : {}), ...(str(r.style) ? { style: { url: r.style } } : {}) };
    } else if (r.kind === 'scenes') {
      source = { collectionUrl: entry.href, items: str(r.items) ? { kind: 'parquet', url: r.items } : { kind: 'partitioned' }, ...(str(r.display_asset) ? { displayAsset: r.display_asset } : {}) };
    } else if (r.kind === 'unsupported') {
      source = { reason: str(r.reason) ?? 'Nothing in this collection can be drawn here.' };
    } else {
      source = { url: r.url };
    }
    return validateLayerSpec({
      spec: 'cng-layer/1.0',
      id: str(r.id) ?? entry.id,
      title: str(r.title) ?? entry.title ?? entry.id,
      kind: r.kind,
      source,
      attribution,
      ...(boxOk ? { bbox: box } : {}),
      ...(temporal ? { temporal } : {}),
      ...(str(entry.thumbnail) ? { thumbnail: entry.thumbnail } : {}),
    });
  });
}
