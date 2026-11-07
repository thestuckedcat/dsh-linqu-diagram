/** Stable internal error type. Business boundaries convert it to fixed codes; raw messages never cross RPC. */
export class DiagramError extends Error {
  /** @param {string} code @param {string} [message] @param {object} [details] */
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'DiagramError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** @param {unknown} error @returns {error is DiagramError} */
export function isDiagramError(error) {
  return error instanceof DiagramError;
}

/**
 * Throw a stable coded error.
 * @param {string} code
 * @param {string} [message]
 * @param {object} [details]
 * @returns {never}
 */
export function fail(code, message, details) {
  throw new DiagramError(code, message, details);
}

/**
 * Clamp/validate a non-negative safe integer argument.
 * @param {unknown} value
 * @param {string} name
 * @param {number} max
 * @returns {number}
 */
export function safeInteger(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new DiagramError('INVALID_INPUT', `${name} must be an integer in 0..${max}`);
  }
  return value;
}
