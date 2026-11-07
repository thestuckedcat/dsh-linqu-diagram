import { createHash } from 'node:crypto';

/**
 * Deterministic canonical JSON: object keys sorted, array order preserved,
 * JSON primitive semantics only. The caller must have validated the value
 * (no undefined, functions, NaN, Infinity, bigint, symbols) first.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

/** @param {unknown} value @returns {unknown} */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(/** @type {any} */ (value)[key]);
    return out;
  }
  return value;
}

/** @param {string | Uint8Array} data @returns {string} lowercase hex sha256 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** @param {unknown} value @returns {string} */
export function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}

/**
 * Byte length of a UTF-8 string.
 * @param {string} text
 * @returns {number}
 */
export function utf8Length(text) {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Structural equality over canonical JSON.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
