// @cng/download-core -- sha-256 hex digest via the standard Web Crypto API
// (`globalThis.crypto.subtle`), available in every modern browser and in
// Node >= 19 with no import. Used for `Estimate.requestDigest`.

/** @param {string} text @returns {Promise<string>} */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
