// @cngeo/maplibre -- ways to ADD a layer from the panel.
//
// An add-provider is a small object the LayerControl's "Add" button opens:
//   { id, label, open({ manager, map, anchor, close }) }
// `anchor` is an empty element to build a form into. Catalog search (Phase 3)
// is one provider; pasting a URL, here, is another.
//
// `@cngeo/maplibre` must not import `@cngeo/stac` (a page that only wants a
// geocoder would then have to map it). So turning a STAC collection into
// layers is INJECTED: pass `layersFromCollection` from `@cngeo/stac`.

import { CngError, LAYER_SPEC, RENDERABLE_KINDS } from '@cngeo/spec';

function parseUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new CngError(`"${input}" is not an http(s) URL`, 'LAYER_INVALID', { retryable: false, context: { field: 'url' } });
  }
  return url;
}

/**
 * `https://host:8443/a/b/My%20File.tif?x=1` ->
 * `{ id: 'host:8443/a/b/My File.tif?x=1', title: 'My File' }`.
 *
 * The id keeps everything that distinguishes one resource from another --
 * port, extension, query -- so two different URLs never claim one id. The
 * title is the file's name without its extension, for a person to read.
 */
function nameOf(url) {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* a malformed %-escape: keep the path as it is written */
  }
  path = path.replace(/\/+$/, '');
  const title = path.replace(/\.[A-Za-z0-9]+$/, '').split('/').pop() || url.hostname;
  return { id: `${url.host}${path}${url.search}`, title };
}

/**
 * What layers does this URL give? `.pmtiles` and `.tif` are recognised by
 * extension with no request; anything else is fetched as JSON and may be a
 * STAC collection (handed to the injected `layersFromCollection`) or GeoJSON.
 * @param {string} input
 * @param {{ layersFromCollection?: Function, fetch?: typeof fetch }} [deps]
 * @returns {Promise<import('@cngeo/spec').LayerSpec[]>}
 */
export async function specsFromUrl(input, deps = {}) {
  const url = parseUrl(input);
  const href = url.toString();
  const { id, title } = nameOf(url);
  const base = { spec: LAYER_SPEC, id, title, attribution: [] };

  if (/\.pmtiles$/i.test(url.pathname)) {
    // `layers: []`: the renderer reads the vector layer names from the archive.
    return [{ ...base, kind: 'pmtiles-vector', source: { url: href, layers: [] } }];
  }
  if (/\.tiff?$/i.test(url.pathname)) {
    return [{ ...base, kind: 'cog', source: { url: href } }];
  }

  const doFetch = deps.fetch ?? globalThis.fetch;
  let doc;
  try {
    const response = await doFetch(href);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    doc = await response.json();
  } catch (cause) {
    throw new CngError(`Could not read ${href}: ${cause?.message ?? cause}`, 'LAYER_LOAD_FAILED', { cause, context: { url: href } });
  }

  if (doc?.type === 'FeatureCollection' || doc?.type === 'Feature') {
    return [{ ...base, kind: 'geojson', source: { data: doc } }];
  }
  if (doc?.type === 'Collection') {
    if (typeof deps.layersFromCollection !== 'function') {
      throw new CngError(
        'This is a STAC collection, and reading one needs layersFromCollection from @cngeo/stac: urlAddProvider({ layersFromCollection }).',
        'LAYER_UNSUPPORTED',
        { retryable: false, context: { url: href } },
      );
    }
    return deps.layersFromCollection(doc, { baseUrl: href });
  }
  throw new CngError(
    `${href} is a ${doc?.type ?? 'JSON document'}, not a STAC collection or GeoJSON. Paste a collection.json, a .pmtiles, a .tif or a .geojson URL.`,
    'LAYER_UNSUPPORTED',
    { retryable: false, context: { url: href, type: doc?.type } },
  );
}

/**
 * Add every drawable layer a URL gives to the manager. Layers that cannot be
 * drawn (a table, an unsupported kind) are reported, not thrown.
 * @returns {Promise<{ added: string[], skipped: { title: string, reason: string }[] }>}
 */
export async function addFromUrl(manager, input, deps = {}) {
  const specs = await specsFromUrl(input, deps);
  const added = [];
  const skipped = [];
  for (const spec of specs) {
    if (!RENDERABLE_KINDS.includes(spec.kind)) {
      skipped.push({ title: spec.title ?? spec.id, reason: spec.kind === 'table' ? 'a table with no geometry' : String(spec.source?.reason ?? 'not drawable') });
      continue;
    }
    try {
      await manager.add(spec);
      added.push(spec.id);
    } catch (err) {
      skipped.push({ title: spec.title ?? spec.id, reason: err?.message ?? String(err) });
    }
  }
  return { added, skipped };
}

/**
 * The "Add from a URL" provider: a text field for a collection.json,
 * .pmtiles, .tif or .geojson URL.
 * @param {{ layersFromCollection?: Function, fetch?: typeof fetch, label?: string }} [deps]
 */
export function urlAddProvider(deps = {}) {
  return {
    id: 'url',
    label: deps.label ?? 'Add from a URL…',
    open({ manager, anchor, close }) {
      const doc = anchor.ownerDocument;
      const form = doc.createElement('form');
      form.className = 'cng-layer-add-url';
      const label = doc.createElement('label');
      label.textContent = 'Collection, PMTiles, GeoTIFF or GeoJSON URL';
      const input = doc.createElement('input');
      input.type = 'url';
      input.required = true;
      input.placeholder = 'https://…/collection.json';
      input.setAttribute('aria-describedby', 'cng-layer-add-url-status');
      label.appendChild(input);
      const submit = doc.createElement('button');
      submit.type = 'submit';
      submit.textContent = 'Add';
      const cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => close());
      const status = doc.createElement('div');
      status.id = 'cng-layer-add-url-status';
      status.className = 'cng-layer-add-status';
      status.setAttribute('role', 'status');
      form.append(label, submit, cancel, status);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        submit.disabled = true;
        status.textContent = 'Loading…';
        try {
          const { added, skipped } = await addFromUrl(manager, input.value, deps);
          if (added.length && !skipped.length) return close();
          status.textContent = [
            added.length ? `Added ${added.length}.` : 'Nothing could be added.',
            ...skipped.map((s) => `${s.title}: ${s.reason}`),
          ].join(' ');
        } catch (err) {
          status.textContent = err?.message ?? String(err);
        } finally {
          submit.disabled = false;
        }
      });
      form.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close();
      });
      anchor.appendChild(form);
      input.focus();
    },
  };
}
