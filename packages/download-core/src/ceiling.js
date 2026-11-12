// @cnmw/download-core -- default ceilings (design doc §3.4, O8: "as
// tabled") and `requirementsOf(filter)`.
//
// DEVIATION: the design doc places `requirementsOf` on `@cnmw/spec`
// (§2.5), but this experiment's `@cnmw/spec` package was built for E3 only
// and does not export it. Implemented here instead; a real release would
// move it to `@cnmw/spec` so the Python side can share the same table.

/** @returns {import('./types.js').Ceiling} */
export function defaultCeiling() {
  return {
    rows: 5_000_000,
    outputBytes: 2 * 1024 ** 3,
    readBytes: 4 * 1024 ** 3,
    files: 500,
    blobBytes: 256 * 1024 ** 2,
  };
}

/**
 * @param {import('./types.js').FilterSpec} filter
 * @param {import('@cnmw/spec').Area|null} [area]
 * @returns {readonly import('./types.js').FilterRequirement[]}
 */
export function requirementsOf(filter, area) {
  /** @type {import('./types.js').FilterRequirement[]} */
  const reqs = [];
  if (filter.whereSql) reqs.push('sql');
  if (filter.spatial?.mode === 'clip') reqs.push('exact-clip');
  if (area?.provenance?.combine === 'dissolve') reqs.push('dissolve');
  return reqs;
}
