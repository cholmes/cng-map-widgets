// @cnmw/download-core -- `registerFormat`/`registerEngine` seams (design
// doc §3.4, §4.4 rule 2: "registered, not lazily imported").
//
// Amendment, 2026-11-12 -- reason: Chris's requirement that a heavy format
// (GeoPackage wasm, FlatGeobuf's small JS) load "on the fly ... just when
// people select that format", with its weight shown *before* that happens.
// `registerFormat` (eager -- a ready `FormatPlugin` object) is unchanged;
// `registerLazyFormat` adds a second registration shape: a small, static
// descriptor (id, label, extension, mediaType, `approxBytes`, capabilities,
// a synchronous `estimateBytes`) plus a `load()` that returns
// `Promise<FormatPlugin>`. `formats()` lists both kinds without resolving
// a single lazy one; `resolveFormat(id)` is the one place that calls
// `load()`, exactly once per id (the promise, and its resolved plugin, are
// cached), and is what `download()` now awaits before using a format.
//
// This does NOT relax §4.4 rule 2's "never a bare specifier" rule --
// `load()` is documented (by every plugin package that supplies one) to
// resolve via `import(<exact pinned absolute CDN URL>)`, same as
// `cdn.js`'s existing hyparquet-writer loader. The rule's intent was no
// *bare-specifier* imports (which only resolve through a bundler or an
// import map the host must maintain); deferring *when* an absolute-URL
// dynamic import runs until the format is actually selected honors that
// intent -- it is still "registered" (the id, label and weight are known
// and listed immediately), just not *loaded* until used.

/** @type {Map<string, import('./types.js').FormatPlugin>} */
const formatRegistry = new Map();
/** @type {Map<string, import('./types.js').Engine>} */
const engineRegistry = new Map();

/**
 * @typedef {object} LazyFormatDescriptor
 * @property {string} id
 * @property {string} [label] - Human label for a format picker, e.g. "GeoPackage".
 * @property {string} extension
 * @property {string} mediaType
 * @property {boolean} streaming
 * @property {{ nestedColumns: boolean, mixedGeometryTypes: boolean, maxFeatures?: number, crs: readonly string[] }} capabilities
 * @property {{ min: number, max: number, estimate?: number }} [approxBytes] - min+gz wire weight of what `load()` will fetch, known up front so a UI can show "+~480KB" *before* the fetch happens.
 * @property {(schema: readonly unknown[], rows: unknown) => unknown} estimateBytes - Same signature as `FormatPlugin.estimateBytes`; must not require `load()` to have run (it's pure JS, no wasm needed to model output bytes-per-row).
 * @property {() => Promise<import('./types.js').FormatPlugin | { default: import('./types.js').FormatPlugin | (() => import('./types.js').FormatPlugin) }>} load
 */

/** @type {Map<string, LazyFormatDescriptor>} */
const lazyFormatRegistry = new Map();
/** @type {Map<string, import('./types.js').FormatPlugin>} */
const resolvedLazyFormats = new Map();
/** @type {Map<string, Promise<import('./types.js').FormatPlugin>>} */
const lazyLoadPromises = new Map();
/** @type {Map<string, 'idle'|'loading'|'loaded'|'failed'>} */
const lazyLoadState = new Map();

/** @param {import('./types.js').FormatPlugin} plugin */
export function registerFormat(plugin) {
  formatRegistry.set(plugin.id, plugin);
}

/**
 * Register a format whose implementation loads on first use (design doc
 * §3.4 amendment). `descriptor.load` is not called here -- only when
 * `resolveFormat(descriptor.id)` (or a `download()` for that format id) is
 * first reached.
 * @param {LazyFormatDescriptor} descriptor
 */
export function registerLazyFormat(descriptor) {
  lazyFormatRegistry.set(descriptor.id, descriptor);
  if (!lazyLoadState.has(descriptor.id)) lazyLoadState.set(descriptor.id, 'idle');
}

/**
 * All registered formats, eager and lazy, in a shape a format picker can
 * render directly -- lazy ones carry `approxBytes` and `loadState` instead
 * of the live plugin, and listing them never triggers a `load()`.
 * @returns {readonly ({ id: string, label?: string, extension: string, mediaType: string, streaming: boolean, capabilities: unknown, lazy: false, loadState: 'loaded' } | (LazyFormatDescriptor & { lazy: true, loadState: 'idle'|'loading'|'loaded'|'failed' }))[]}
 */
export function formats() {
  const eager = [...formatRegistry.values()].map((p) => ({
    id: p.id,
    label: p.id,
    extension: p.extension,
    mediaType: p.mediaType,
    streaming: p.streaming,
    capabilities: p.capabilities,
    lazy: false,
    loadState: 'loaded',
  }));
  const lazy = [...lazyFormatRegistry.values()]
    .filter((d) => !formatRegistry.has(d.id)) // an eager registration for the same id wins
    .map((d) => ({ ...d, lazy: true, loadState: resolvedLazyFormats.has(d.id) ? 'loaded' : (lazyLoadState.get(d.id) ?? 'idle') }));
  return [...eager, ...lazy];
}

/**
 * Synchronous lookup: an eager plugin, or a lazy one that has *already*
 * finished loading. Returns `undefined` for a lazy format not yet loaded
 * -- it deliberately never triggers `load()` (that's `resolveFormat`'s
 * job), since a sync function cannot await it.
 * @param {string} id @returns {import('./types.js').FormatPlugin|undefined}
 */
export function getFormat(id) {
  return formatRegistry.get(id) ?? resolvedLazyFormats.get(id);
}

/**
 * The async counterpart: resolves to the format plugin, loading it first
 * if it was registered lazily and hasn't been loaded yet. Concurrent calls
 * for the same id share one in-flight `load()` and one cached result --
 * a lazy format's CDN fetch happens at most once per page per id.
 * @param {string} id
 * @returns {Promise<import('./types.js').FormatPlugin|undefined>}
 */
export async function resolveFormat(id) {
  const eager = formatRegistry.get(id);
  if (eager) return eager;

  const cached = resolvedLazyFormats.get(id);
  if (cached) return cached;

  const descriptor = lazyFormatRegistry.get(id);
  if (!descriptor) return undefined;

  const inFlight = lazyLoadPromises.get(id);
  if (inFlight) return inFlight;

  lazyLoadState.set(id, 'loading');
  const promise = (async () => {
    let plugin;
    try {
      const loaded = await descriptor.load();
      plugin = normalizeLoadedPlugin(loaded);
    } catch (err) {
      lazyLoadState.set(id, 'failed');
      lazyLoadPromises.delete(id);
      const { CnmwError } = await import('@cnmw/spec');
      throw new CnmwError(
        `Failed to load the "${id}" format plugin: ${err?.message ?? err}`,
        'FORMAT_LOAD_FAILED',
        { context: { format: id, approxBytes: descriptor.approxBytes }, cause: err },
      );
    }
    resolvedLazyFormats.set(id, plugin);
    lazyLoadState.set(id, 'loaded');
    return plugin;
  })();
  lazyLoadPromises.set(id, promise);
  return promise;
}

/**
 * A `load()` may resolve to the plugin itself, an ESM module whose
 * `default` export is the plugin or a zero-arg factory for it, or a
 * zero-arg factory directly -- every shape this repo's own lazy plugin
 * packages (`@cnmw/format-gpkg`, `@cnmw/format-flatgeobuf`) use. Normalized
 * here once so every descriptor's `load()` can return whichever is most
 * natural for how its heavy dependency's module is shaped.
 * @param {unknown} loaded
 */
function normalizeLoadedPlugin(loaded) {
  if (typeof loaded === 'function') return loaded();
  if (loaded && typeof loaded === 'object' && 'default' in loaded) {
    const d = /** @type {{ default: unknown }} */ (loaded).default;
    return typeof d === 'function' ? d() : d;
  }
  return loaded;
}

/**
 * Current load state for a registered format id ('loaded' for every eager
 * format, 'unknown' for an id that was never registered at all).
 * @param {string} id @returns {'idle'|'loading'|'loaded'|'failed'|'unknown'}
 */
export function formatLoadState(id) {
  if (formatRegistry.has(id) || resolvedLazyFormats.has(id)) return 'loaded';
  return lazyLoadState.get(id) ?? 'unknown';
}

/** @param {import('./types.js').Engine} engine */
export function registerEngine(engine) {
  engineRegistry.set(engine.id, engine);
}

/** @returns {readonly import('./types.js').Engine[]} */
export function engines() {
  return [...engineRegistry.values()];
}

/** @param {string} id @returns {import('./types.js').Engine|undefined} */
export function getEngine(id) {
  return engineRegistry.get(id);
}
