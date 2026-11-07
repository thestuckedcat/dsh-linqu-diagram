/**
 * Small, strict JSON-Schema-subset validator (no external dependency).
 *
 * Supported keywords: type (string or array), properties, required,
 * additionalProperties (false or schema), items, minItems, maxItems,
 * minLength, maxLength, pattern, minimum, maximum, enum, const, oneOf, anyOf,
 * allOf, not, description, format (annotation only).
 *
 * Deliberate limits: JSON data only; object property names are treated as
 * plain keys; `$ref` is not supported (compose schema objects by reference in
 * JavaScript instead). Validation never throws on bad data; it returns error
 * objects so business boundaries can map them to fixed reason codes.
 */

/**
 * @typedef {{ path: string, keyword: string, message: string }} SchemaIssue
 */

/**
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {SchemaIssue[]} empty when valid
 */
export function validateSchema(schema, value, path = '$') {
  /** @type {SchemaIssue[]} */
  const issues = [];
  walk(schema, value, path, issues);
  return issues;
}

/**
 * @param {object} schema
 * @param {unknown} value
 * @param {string} label
 * @returns {void}
 */
export function assertSchema(schema, value, label) {
  const issues = validateSchema(schema, value);
  if (issues.length > 0) {
    const error = new TypeError(`${label}: ${issues[0].path} ${issues[0].message}`);
    // @ts-ignore - attach structured issues for callers
    error.issues = issues;
    throw error;
  }
}

/**
 * @param {any} schema
 * @param {any} value
 * @param {string} path
 * @param {SchemaIssue[]} issues
 */
function walk(schema, value, path, issues) {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    issues.push({ path, keyword: 'const', message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }
  if (schema.enum !== undefined) {
    if (!schema.enum.some((/** @type {unknown} */ entry) => Object.is(entry, value))) {
      issues.push({ path, keyword: 'enum', message: `must be one of ${JSON.stringify(schema.enum)}` });
      return;
    }
  }
  if (schema.not !== undefined && validateSchema(schema.not, value, path).length === 0) {
    issues.push({ path, keyword: 'not', message: 'must not match the forbidden schema' });
    return;
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((/** @type {any} */ sub) => validateSchema(sub, value, path).length === 0);
    if (matches.length !== 1) {
      issues.push({ path, keyword: 'oneOf', message: 'must match exactly one alternative' });
      return;
    }
  }
  if (schema.anyOf !== undefined) {
    const matches = schema.anyOf.some((/** @type {any} */ sub) => validateSchema(sub, value, path).length === 0);
    if (!matches) {
      issues.push({ path, keyword: 'anyOf', message: 'must match at least one alternative' });
      return;
    }
  }
  if (schema.allOf !== undefined) {
    for (const sub of schema.allOf) walk(sub, value, path, issues);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((/** @type {string} */ type) => matchesType(type, value))) {
      issues.push({ path, keyword: 'type', message: `must be of type ${types.join('|')}` });
      return;
    }
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      issues.push({ path, keyword: 'minLength', message: `must have at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      issues.push({ path, keyword: 'maxLength', message: `must have at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      issues.push({ path, keyword: 'pattern', message: 'must match the required pattern' });
    }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      issues.push({ path, keyword: 'type', message: 'must be a finite number' });
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, keyword: 'minimum', message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, keyword: 'maximum', message: `must be <= ${schema.maximum}` });
    }
    if (schema.multipleOf !== undefined && value % schema.multipleOf !== 0) {
      issues.push({ path, keyword: 'multipleOf', message: `must be a multiple of ${schema.multipleOf}` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, keyword: 'minItems', message: `must have at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, keyword: 'maxItems', message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      value.forEach((item, index) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) issues.push({ path: `${path}[${index}]`, keyword: 'uniqueItems', message: 'must be unique' });
        seen.add(key);
      });
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => walk(schema.items, item, `${path}[${index}]`, issues));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record);
    const properties = schema.properties ?? {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, keyword: 'additionalProperties', message: 'is not an allowed property' });
        continue;
      }
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object') {
        walk(schema.additionalProperties, record[key], `${path}.${key}`, issues);
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      walk(sub, record[key], `${path}.${key}`, issues);
    }
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) {
        issues.push({ path: `${path}.${key}`, keyword: 'required', message: 'is required' });
      }
    }
  }
}

/**
 * @param {string} type
 * @param {unknown} value
 * @returns {boolean}
 */
function matchesType(type, value) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      throw new TypeError(`unknown schema type: ${type}`);
  }
}
