// @cnmw/download-core -- `registerFormat`/`registerEngine` seams (design
// doc §3.4, §4.4 rule 2: "registered, not lazily imported").

/** @type {Map<string, import('./types.js').FormatPlugin>} */
const formatRegistry = new Map();
/** @type {Map<string, import('./types.js').Engine>} */
const engineRegistry = new Map();

/** @param {import('./types.js').FormatPlugin} plugin */
export function registerFormat(plugin) {
  formatRegistry.set(plugin.id, plugin);
}

/** @returns {readonly import('./types.js').FormatPlugin[]} */
export function formats() {
  return [...formatRegistry.values()];
}

/** @param {string} id @returns {import('./types.js').FormatPlugin|undefined} */
export function getFormat(id) {
  return formatRegistry.get(id);
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
