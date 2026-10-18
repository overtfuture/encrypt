// tlock-js contains a Node randomBytes fallback. Resolve that import to native
// Web Crypto in browser builds instead of bundling a Node crypto polyfill.
export function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
