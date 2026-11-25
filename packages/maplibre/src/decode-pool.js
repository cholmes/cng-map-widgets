// @cngeo/maplibre -- which pool decodes GeoTIFF tiles.
//
// deck.gl-raster decompresses tiles in a pool of web workers. In the prebuilt
// bundle that worker is started from a Blob URL (see
// tools/build-deck-bundle.mjs: a bundle has no file "next to" it to load a
// worker from). A page whose Content-Security-Policy does not allow `blob:` in
// `worker-src` cannot start one, and the default pool then fails every tile:
// a layer that is "ready" and draws nothing.
//
// So the question is asked once per page, with a worker that does nothing:
// can a module worker be started from a Blob URL here? If so, layers share the
// default worker pool. If not, they share a `DecoderPool` with no worker
// factory, which is that class's documented main-thread mode: slower, and
// drawn.

const PROBE_TIMEOUT_MS = 2000;

/**
 * Can this page start a module worker from a Blob URL? Resolves `false` --
 * never rejects -- when there is no `Worker`, when constructing one throws
 * (a CSP refusal in some browsers), when it reports an error (the same
 * refusal in others), or when it has said nothing after two seconds.
 * @returns {Promise<boolean>}
 */
export async function canStartBlobWorker() {
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') return false;
  let url = null;
  let worker = null;
  try {
    url = URL.createObjectURL(new Blob(['self.postMessage(1);'], { type: 'text/javascript' }));
    worker = new Worker(url, { type: 'module' });
    const started = worker;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      timer.unref?.();
      const settle = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
      started.onmessage = () => settle(true);
      started.onerror = () => settle(false);
    });
  } catch {
    return false;
  } finally {
    worker?.terminate?.();
    if (url) URL.revokeObjectURL?.(url);
  }
}

/** One answer per module set, so every layer on the page gets the same pool object. @type {WeakMap<object, Promise<object|undefined>>} */
const pools = new WeakMap();

/**
 * The decode pool every COG layer built from `deck` should use.
 * @param {{ DecoderPool?: any, defaultDecoderPool?: any }} deck  The deck.gl module set.
 * @returns {Promise<object|undefined>} `undefined` when `deck` offers no pool to build
 *   (a host's own module set): the layer then keeps deck.gl-raster's default.
 */
export function decodePoolFor(deck) {
  let pending = pools.get(deck);
  if (!pending) {
    pending = canStartBlobWorker().then((workers) => {
      if (workers && typeof deck.defaultDecoderPool === 'function') return deck.defaultDecoderPool();
      if (!workers && typeof deck.DecoderPool === 'function') return new deck.DecoderPool({});
      return undefined;
    });
    pools.set(deck, pending);
  }
  return pending;
}
