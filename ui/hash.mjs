/**
 * Browser-safe SHA-256 for the generated client bundle (ui/hash.mjs).
 *
 * tools/build-client.mjs maps the inlined `src/canonical.mjs` import of
 * `node:crypto` to this module, so the client can compute the same canonical
 * digests as the Host (spec digests, editor command ids, save XML
 * `data_base_digest`) without Node builtins, third-party packages, WebCrypto
 * promises or `eval`. Only SHA-256 with hex/base64 digests is implemented, which
 * is the complete surface `src/canonical.mjs` uses.
 *
 * Node tests compare every output against `node:crypto` (tests/client-bundle).
 */

/** @param {string | Uint8Array} data @returns {Uint8Array} */
function toBytes(data) {
  if (typeof data === 'string') {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(data);
    // Minimal UTF-8 fallback (never reached in browsers or Node >= 11).
    const encoded = unescape(encodeURIComponent(data));
    const bytes = new Uint8Array(encoded.length);
    for (let index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index);
    return bytes;
  }
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('sha256 input must be a string, Uint8Array or ArrayBuffer');
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** @param {number} value @param {number} shift @returns {number} */
function rotr(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

/** @param {Uint8Array} bytes @returns {Uint8Array} 32-byte digest */
export function sha256Bytes(bytes) {
  const length = bytes.length;
  // padded length: message + 0x80 + zero pad + 64-bit big-endian bit length, 64-byte blocks
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + K[index] + w[index]) >>> 0;
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let index = 0; index < 8; index += 1) digestView.setUint32(index * 4, words[index]);
  return digest;
}

const HEX = '0123456789abcdef';

/** @param {Uint8Array} bytes @returns {string} */
export function toHex(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    out += HEX[bytes[index] >> 4] + HEX[bytes[index] & 0x0f];
  }
  return out;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    out += BASE64[a >> 2];
    out += BASE64[((a & 0x03) << 4) | (b >> 4)];
    out += index + 1 < bytes.length ? BASE64[((b & 0x0f) << 2) | (c >> 6)] : '=';
    out += index + 2 < bytes.length ? BASE64[c & 0x3f] : '=';
  }
  return out;
}

/**
 * `node:crypto#createHash` subset for SHA-256 (hex/base64/undefined digest).
 * @param {string} algorithm
 * @returns {{update:(data:string|Uint8Array)=>any, digest:(encoding?:'hex'|'base64')=>string}}
 */
export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error('unsupported hash algorithm');
  /** @type {Uint8Array[]} */
  const chunks = [];
  return {
    update(data) {
      chunks.push(toBytes(data));
      return this;
    },
    digest(encoding) {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      const digest = sha256Bytes(joined);
      if (encoding === 'hex' || encoding === undefined) return toHex(digest);
      if (encoding === 'base64') return toBase64(digest);
      throw new Error('unsupported digest encoding');
    },
  };
}

/**
 * @param {string | Uint8Array} data
 * @returns {string} lowercase hex sha256
 */
export function sha256Hex(data) {
  return toHex(sha256Bytes(toBytes(data)));
}
