/**
 * Restricted XML parsing + mxGraphModel serialization (DIA-06 / DIA-API-RENDER).
 *
 * This module is deliberately NOT a general XML parser. It implements the
 * frozen subset from DIA-DESIGN-2 §7 and docs/interfaces.md §6:
 *
 *  - input must be valid UTF-8 (bytes are decoded strictly; JS strings are
 *    rejected when they contain lone surrogates or non-XML code points);
 *  - only elements, attributes and character data are accepted: no DOCTYPE,
 *    internal/external entities, CDATA, processing instructions (including the
 *    XML declaration), comments or namespace declarations;
 *  - element/attribute names are ASCII names (no `:`), attributes must be
 *    quoted by ' or ", duplicate attributes are rejected, exactly one root
 *    element is allowed and the element stack must be empty at EOF;
 *  - only the five predefined entities plus decimal/hex numeric character
 *    references that resolve to legal XML code points;
 *  - byte/depth/element/attribute limits are checked while scanning, before
 *    building large structures.
 *
 * On top of that it implements the tool-owned `.drawio` profile:
 * `<mxfile>/<diagram>/<mxGraphModel>/<root>/<mxCell>/<mxGeometry>/<mxPoint>/
 * <Array>` with a strict attribute whitelist, a closed style whitelist and the
 * `data_*` display-only metadata attributes. Compressed diagram payloads,
 * unknown advanced shapes and unknown style keys are reported as UNSUPPORTED,
 * never silently stripped and re-saved.
 *
 * Everything here is synchronous, has no network/file access and is
 * deterministic: identical input produces byte-identical output.
 */

import { LIMITS } from '../limits.mjs';
import { DiagramError } from '../errors.mjs';
import { canonicalJson, utf8Length } from '../canonical.mjs';

/* -------------------------------------------------------------------------- */
/* contracts seam                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The shared contracts module is authored in parallel (owner: contracts).
 * Loading it lazily keeps the restricted tokenizer independently testable and
 * makes semantic entry points fail closed instead of silently skipping schema
 * checks. Only a genuinely missing module is tolerated.
 */
let CONTRACTS = null;
try {
  CONTRACTS = await import('../contracts.mjs');
} catch (error) {
  if (!(error && /** @type {any} */ (error).code === 'ERR_MODULE_NOT_FOUND')) throw error;
}

/** @returns {any} */
function requireContracts() {
  if (!CONTRACTS) {
    throw new DiagramError('INVALID_INPUT', 'shared contracts module (src/contracts.mjs) is not available');
  }
  return CONTRACTS;
}

/* -------------------------------------------------------------------------- */
/* shared helpers                                                              */
/* -------------------------------------------------------------------------- */

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} path @param {string} keyword @param {string} message */
function issue(path, keyword, message) {
  return { path, keyword, message };
}

const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const NAMED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/**
 * XML 1.0 Char production (BMP subset + astral planes).
 * @param {number} cp
 * @returns {boolean}
 */
function isLegalXmlCodePoint(cp) {
  if (!Number.isSafeInteger(cp) || cp < 0 || cp > 0x10ffff) return false;
  if (cp === 0x9 || cp === 0xa || cp === 0xd) return true;
  if (cp >= 0x20 && cp <= 0xd7ff) return true;
  if (cp >= 0xe000 && cp <= 0xfffd) return true;
  if (cp >= 0x10000 && cp <= 0x10ffff) return true;
  return false;
}

/** @param {number} code */
function isNameStartCode(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
}

/** @param {number} code */
function isNameCharCode(code) {
  return isNameStartCode(code) || (code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x2d;
}

/** @param {number} code */
function isWhitespaceCode(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** @param {string} value */
function escXmlAttr(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** @param {string} value */
function escXmlText(value) {
  return String(value).replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

/**
 * HTML/script markup must never be stored as a drawio value. The XML itself
 * escapes everything before it reaches this check; the decoded text is still
 * refused so a file cannot smuggle a tag that a later consumer might execute.
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeMarkup(value) {
  if (typeof value !== 'string') return false;
  const tag =
    /<\s*\/?\s*(?:script|img|svg|foreignobject|iframe|style|object|embed|link|meta|a|div|span|p|br|body|html)\b[^>]*>/i;
  if (tag.test(value)) return true;
  if (/["']\s*on[a-z]+\s*=\s*["']?/i.test(value)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* restricted XML parser                                                       */
/* -------------------------------------------------------------------------- */

const XML_LIMITS = Object.freeze({
  xml_bytes: LIMITS.xml_bytes,
  xml_depth: LIMITS.xml_depth,
  xml_elements: LIMITS.xml_elements,
  xml_attributes_per_element: LIMITS.xml_attributes_per_element,
});

/**
 * @param {Record<string, number> | undefined} custom
 * @returns {{xml_bytes: number, xml_depth: number, xml_elements: number, xml_attributes_per_element: number}}
 */
function resolveXmlLimits(custom) {
  const resolved = { ...XML_LIMITS };
  if (isRecord(custom)) {
    for (const key of Object.keys(resolved)) {
      const value = custom[key];
      if (Number.isSafeInteger(value) && value >= 1) resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Strictly decode the caller's input. Buffers/typed arrays must be valid
 * UTF-8; strings must not contain lone surrogates or non-XML code points.
 * @param {unknown} input
 * @returns {{ok: true, text: string, bytes: number} | {ok: false, keyword: 'invalidUtf8' | 'invalidChar'}}
 */
function decodeInput(input) {
  /** @type {string} */
  let text;
  /** @type {number} */
  let bytes;
  if (typeof input === 'string') {
    text = input;
    bytes = utf8Length(text);
  } else if (input instanceof Uint8Array) {
    bytes = input.byteLength;
    try {
      text = UTF8_DECODER.decode(input);
    } catch {
      return { ok: false, keyword: 'invalidUtf8' };
    }
  } else {
    return { ok: false, keyword: 'invalidUtf8' };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    bytes = Math.max(0, bytes - 3);
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return { ok: false, keyword: 'invalidUtf8' };
      const cp = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
      if (!isLegalXmlCodePoint(cp)) return { ok: false, keyword: 'invalidChar' };
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return { ok: false, keyword: 'invalidUtf8' };
    if (!isLegalXmlCodePoint(code)) return { ok: false, keyword: 'invalidChar' };
  }
  return { ok: true, text, bytes };
}

/**
 * Decode the five predefined entities and legal numeric character references.
 * @param {string} raw
 * @returns {{ok: true, value: string} | {ok: false, keyword: string, message: string}}
 */
function decodeEntities(raw) {
  if (raw.indexOf('&') === -1) return { ok: true, value: raw };
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 12) {
      return { ok: false, keyword: 'invalidEntity', message: `unterminated entity reference at offset ${amp}` };
    }
    const body = raw.slice(amp + 1, semi);
    if (body.length === 0) {
      return { ok: false, keyword: 'invalidEntity', message: `empty entity reference at offset ${amp}` };
    }
    if (body.charCodeAt(0) === 0x23 /* # */) {
      let cp;
      if (body.length > 1 && (body[1] === 'x' || body[1] === 'X')) {
        if (!/^[0-9A-Fa-f]+$/.test(body.slice(2))) {
          return { ok: false, keyword: 'invalidNumericEntity', message: `invalid hex character reference at offset ${amp}` };
        }
        cp = Number.parseInt(body.slice(2), 16);
      } else {
        if (!/^[0-9]+$/.test(body.slice(1))) {
          return { ok: false, keyword: 'invalidNumericEntity', message: `invalid decimal character reference at offset ${amp}` };
        }
        cp = Number.parseInt(body.slice(1), 10);
      }
      if (!isLegalXmlCodePoint(cp)) {
        return { ok: false, keyword: 'invalidNumericEntity', message: `character reference ${body} is not a legal XML code point` };
      }
      out += String.fromCodePoint(cp);
    } else {
      const mapped = NAMED_ENTITIES.get(body);
      if (mapped === undefined) {
        return { ok: false, keyword: 'unknownEntity', message: `entity &${body}; is not allowed` };
      }
      out += mapped;
    }
    i = semi + 1;
  }
  return { ok: true, value: out };
}

/**
 * @typedef {{name: string, attributes: Record<string, string>, children: Array<any>, text: string}} XmlNode
 */

/**
 * Parse the restricted XML subset.
 *
 * @param {string | Uint8Array} input
 * @param {{limits?: Record<string, number>}} [options]
 * @returns {{ok: true, root: XmlNode} | {ok: false, code: 'INVALID_XML' | 'LIMIT_EXCEEDED', errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function parseXmlRestricted(input, options = {}) {
  const limits = resolveXmlLimits(options.limits);
  const decoded = decodeInput(input);
  if (!decoded.ok) {
    const message =
      decoded.keyword === 'invalidChar'
        ? 'input contains a character that is not legal in XML 1.0'
        : 'input must be valid UTF-8 XML text';
    return { ok: false, code: 'INVALID_XML', errors: [issue('$', decoded.keyword, message)] };
  }
  const { text } = decoded;
  if (decoded.bytes > limits.xml_bytes) {
    return limitFailure('maxBytes', `XML input is ${decoded.bytes} bytes; limit is ${limits.xml_bytes}`, '$');
  }

  const n = text.length;
  let i = 0;
  /** @type {XmlNode[]} */
  const stack = [];
  /** @type {XmlNode | null} */
  let root = null;
  let rootClosed = false;
  let elementCount = 0;

  /** @param {string} keyword @param {string} message @param {string} [path] */
  const bad = (keyword, message, path = '$') => ({
    ok: /** @type {const} */ (false),
    code: /** @type {const} */ ('INVALID_XML'),
    errors: [issue(path, keyword, message)],
  });

  while (i < n) {
    const code = text.charCodeAt(i);
    if (code !== 0x3c /* < */) {
      const next = text.indexOf('<', i);
      const end = next === -1 ? n : next;
      const chunk = text.slice(i, end);
      if (chunk.includes(']]>')) return bad('cdataEnd', '"]]>" is not allowed in character data');
      const decodedChunk = decodeEntities(chunk);
      if (!decodedChunk.ok) return bad(decodedChunk.keyword, decodedChunk.message);
      if (stack.length === 0) {
        if (decodedChunk.value.trim() !== '') {
          return bad('textOutsideRoot', 'character data is not allowed outside the root element');
        }
      } else if (decodedChunk.value !== '') {
        const parent = stack[stack.length - 1];
        parent.children.push({ text: decodedChunk.value });
        parent.text += decodedChunk.value;
      }
      i = end;
      continue;
    }

    if (text.startsWith('<!--', i)) return bad('comment', 'XML comments are not allowed');
    if (text.startsWith('<![CDATA[', i)) return bad('cdata', 'CDATA sections are not allowed');
    if (text.startsWith('<?', i)) {
      return bad('processingInstruction', 'processing instructions and the XML declaration are not allowed');
    }
    if (text.startsWith('<!', i)) {
      return bad('doctype', 'DOCTYPE/entity declarations are not allowed');
    }

    if (text.startsWith('</', i)) {
      let j = i + 2;
      const nameStart = j;
      if (j >= n || !isNameStartCode(text.charCodeAt(j))) return bad('malformed', 'malformed closing tag');
      j += 1;
      while (j < n && isNameCharCode(text.charCodeAt(j))) j += 1;
      const name = text.slice(nameStart, j);
      while (j < n && isWhitespaceCode(text.charCodeAt(j))) j += 1;
      if (j >= n) return bad('unterminatedTag', `unterminated closing tag </${name}>`);
      if (text.charCodeAt(j) !== 0x3e /* > */) return bad('malformed', `malformed closing tag </${name}>`);
      j += 1;
      const current = stack.pop();
      if (!current) return bad('unexpectedClose', `unexpected closing tag </${name}>`);
      if (current.name !== name) {
        return bad('mismatchedTag', `closing tag </${name}> does not match open element <${current.name}>`);
      }
      if (stack.length === 0) rootClosed = true;
      i = j;
      continue;
    }

    /* opening tag */
    let j = i + 1;
    const nameStart = j;
    if (j >= n || !isNameStartCode(text.charCodeAt(j))) return bad('malformed', 'malformed element name');
    j += 1;
    while (j < n && isNameCharCode(text.charCodeAt(j))) j += 1;
    const name = text.slice(nameStart, j);
    if (RESERVED_NAMES.has(name)) return bad('invalidName', `element name "${name}" is not allowed`);

    /** @type {Record<string, string>} */
    const attributes = {};
    let attributeCount = 0;
    let selfClosing = false;
    for (;;) {
      while (j < n && isWhitespaceCode(text.charCodeAt(j))) j += 1;
      if (j >= n) return bad('unterminatedTag', `unterminated start tag <${name}>`);
      const ch = text.charCodeAt(j);
      if (ch === 0x3e /* > */) {
        j += 1;
        break;
      }
      if (ch === 0x2f /* / */) {
        if (text.charCodeAt(j + 1) !== 0x3e) return bad('malformed', `malformed self-closing tag <${name}>`);
        j += 2;
        selfClosing = true;
        break;
      }
      if (!isNameStartCode(ch)) return bad('malformedAttribute', `malformed attribute in <${name}>`);
      const attrStart = j;
      j += 1;
      while (j < n && isNameCharCode(text.charCodeAt(j))) j += 1;
      const attrName = text.slice(attrStart, j);
      if (attrName === 'xmlns' || attrName === 'xmlns:') {
        return bad('namespace', 'namespace declarations are not allowed');
      }
      if (attrName.includes(':')) return bad('namespace', 'namespace prefixes are not allowed');
      if (RESERVED_NAMES.has(attrName)) return bad('invalidName', `attribute name "${attrName}" is not allowed`);
      while (j < n && isWhitespaceCode(text.charCodeAt(j))) j += 1;
      if (j >= n || text.charCodeAt(j) !== 0x3d /* = */) {
        return bad('malformedAttribute', `attribute "${attrName}" has no value`);
      }
      j += 1;
      while (j < n && isWhitespaceCode(text.charCodeAt(j))) j += 1;
      const quote = text.charCodeAt(j);
      if (quote !== 0x22 /* " */ && quote !== 0x27 /* ' */) {
        return bad('attributeNotQuoted', `attribute "${attrName}" value must be quoted`);
      }
      j += 1;
      const valueStart = j;
      while (j < n && text.charCodeAt(j) !== quote) {
        if (text.charCodeAt(j) === 0x3c) {
          return bad('malformedAttribute', `"<" is not allowed in attribute values`);
        }
        j += 1;
      }
      if (j >= n) return bad('unterminatedTag', `unterminated attribute value for "${attrName}"`);
      const rawValue = text.slice(valueStart, j);
      j += 1;
      attributeCount += 1;
      if (attributeCount > limits.xml_attributes_per_element) {
        return limitFailure(
          'maxAttributes',
          `element <${name}> exceeds ${limits.xml_attributes_per_element} attributes`,
          '$',
        );
      }
      if (Object.prototype.hasOwnProperty.call(attributes, attrName)) {
        return bad('duplicateAttribute', `duplicate attribute "${attrName}" on <${name}>`);
      }
      const value = decodeEntities(rawValue);
      if (!value.ok) return bad(value.keyword, value.message);
      attributes[attrName] = value.value;
    }

    elementCount += 1;
    if (elementCount > limits.xml_elements) {
      return limitFailure('maxElements', `XML input exceeds ${limits.xml_elements} elements`, '$');
    }
    /** @type {XmlNode} */
    const node = { name, attributes, children: [], text: '' };
    if (stack.length === 0) {
      if (root !== null) return bad('multipleRoots', 'XML document must have exactly one root element');
      root = node;
    } else {
      stack[stack.length - 1].children.push(node);
    }
    if (stack.length + 1 > limits.xml_depth) {
      return limitFailure('maxDepth', `XML nesting exceeds depth ${limits.xml_depth}`, '$');
    }
    if (!selfClosing) {
      stack.push(node);
    } else if (stack.length === 0) {
      rootClosed = true;
    }
    i = j;
  }

  if (stack.length > 0) {
    return bad('unterminatedTag', `element <${stack[stack.length - 1].name}> is not closed`);
  }
  if (root === null) return bad('noRoot', 'XML document has no root element');
  return { ok: true, root };
}

/**
 * @param {string} keyword
 * @param {string} message
 * @param {string} path
 * @returns {{ok: false, code: 'LIMIT_EXCEEDED', errors: Array<{path: string, keyword: string, message: string}>}}
 */
function limitFailure(keyword, message, path) {
  return { ok: false, code: 'LIMIT_EXCEEDED', errors: [issue(path, keyword, message)] };
}

/* -------------------------------------------------------------------------- */
/* style whitelist                                                             */
/* -------------------------------------------------------------------------- */

const LOCAL_FONTS = new Set([
  'helvetica',
  'arial',
  'verdana',
  'tahoma',
  'georgia',
  'times new roman',
  'courier new',
  'consolas',
  'monospace',
  'sans-serif',
  'serif',
]);
const SHAPE_VALUES = new Set(['rectangle', 'ellipse', 'rhombus', 'note', 'text', 'cylinder']);
const EDGE_STYLE_VALUES = new Set([
  'orthogonalEdgeStyle',
  'elbowEdgeStyle',
  'entityRelationEdgeStyle',
  'segmentEdgeStyle',
]);
const ARROW_VALUES = new Set(['none', 'classic', 'block', 'open', 'oval', 'diamond', 'thin']);
const BARE_TOKENS = new Set(['text', 'ellipse', 'rounded', 'rhombus', 'note', 'cylinder']);
const FORBIDDEN_STYLE_KEYS = new Set(['image', 'link', 'url']);

/** @param {string} value */
function isLocalColor(value) {
  if (value === 'none') return true;
  return /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(value);
}

/**
 * Validate one key=value style entry against the closed whitelist. Returns
 * `{ok:true, value}` or `{ok:false, code, keyword, message}`.
 * @param {string} key
 * @param {string} value
 * @returns {{ok: true} | {ok: false, code: string, keyword: string, message: string}}
 */
function validateStyleEntry(key, value) {
  if (FORBIDDEN_STYLE_KEYS.has(key)) {
    return { ok: false, code: 'INVALID_XML', keyword: 'forbiddenStyle', message: `style "${key}" is not allowed` };
  }
  if (/(?:javascript|data|file|https?):/i.test(value) || value.startsWith('//')) {
    return {
      ok: false,
      code: 'INVALID_XML',
      keyword: 'remoteResourceStyle',
      message: `style "${key}" references a remote/script resource`,
    };
  }
  switch (key) {
    case 'rounded':
    case 'dashed':
    case 'endFill':
    case 'startFill':
      if (value !== '0' && value !== '1') {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: `style "${key}" must be 0 or 1` };
      }
      return { ok: true };
    case 'whiteSpace':
      if (value !== 'wrap' && value !== 'nowrap') {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: `style "whiteSpace" has an invalid value` };
      }
      return { ok: true };
    case 'fillColor':
    case 'strokeColor':
    case 'fontColor':
      if (!isLocalColor(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: `style "${key}" must be a local color` };
      }
      return { ok: true };
    case 'fontSize':
      if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "fontSize" must be 1..100' };
      }
      return { ok: true };
    case 'fontFamily':
      if (!LOCAL_FONTS.has(value.toLowerCase())) {
        return {
          ok: false,
          code: 'INVALID_XML',
          keyword: 'remoteFont',
          message: 'style "fontFamily" must be a local font family',
        };
      }
      return { ok: true };
    case 'fontStyle':
      if (!/^[0-3]$/.test(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "fontStyle" must be 0..3' };
      }
      return { ok: true };
    case 'strokeWidth':
      if (!/^(?:0|[1-9][0-9]?)$/.test(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "strokeWidth" must be 0..99' };
      }
      return { ok: true };
    case 'align':
      if (value !== 'left' && value !== 'center' && value !== 'right') {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "align" has an invalid value' };
      }
      return { ok: true };
    case 'verticalAlign':
      if (value !== 'top' && value !== 'middle' && value !== 'bottom') {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "verticalAlign" has an invalid value' };
      }
      return { ok: true };
    case 'shape':
      if (value === 'image' || value === 'link' || value === 'url') {
        return { ok: false, code: 'INVALID_XML', keyword: 'forbiddenStyle', message: 'style "shape" cannot be image/link/url' };
      }
      if (!SHAPE_VALUES.has(value)) {
        return { ok: false, code: 'UNSUPPORTED', keyword: 'unknownShape', message: `shape "${value}" is not supported` };
      }
      return { ok: true };
    case 'edgeStyle':
      if (!EDGE_STYLE_VALUES.has(value)) {
        return { ok: false, code: 'UNSUPPORTED', keyword: 'unknownShape', message: `edgeStyle "${value}" is not supported` };
      }
      return { ok: true };
    case 'endArrow':
    case 'startArrow':
      if (!ARROW_VALUES.has(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: `style "${key}" has an invalid arrow value` };
      }
      return { ok: true };
    case 'html':
      if (value !== '0') {
        return { ok: false, code: 'INVALID_XML', keyword: 'forbiddenStyle', message: 'style "html=1" is not allowed' };
      }
      return { ok: true };
    default:
      return { ok: false, code: 'UNSUPPORTED', keyword: 'unknownStyleKey', message: `style key "${key}" is not supported` };
  }
}

/**
 * Parse and validate a drawio `style` attribute.
 * @param {string} raw
 * @returns {Record<string, string>} key→value; bare tokens are stored as ''
 */
function parseDrawioStyle(raw) {
  if (typeof raw !== 'string') {
    throw new BoundaryError('INVALID_XML', 'styleType', 'style must be a string', '$');
  }
  if (raw.length > LIMITS.drawio_style_length) {
    throw new BoundaryError(
      'LIMIT_EXCEEDED',
      'styleLength',
      `style exceeds ${LIMITS.drawio_style_length} characters`,
      '$',
    );
  }
  const parts = raw.split(';');
  if (parts.length > LIMITS.drawio_style_entries) {
    throw new BoundaryError(
      'LIMIT_EXCEEDED',
      'styleEntries',
      `style exceeds ${LIMITS.drawio_style_entries} entries`,
      '$',
    );
  }
  const entries = [];
  for (const part of parts) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq === -1) entries.push({ key: part, value: '' });
    else entries.push({ key: part.slice(0, eq), value: part.slice(eq + 1) });
  }
  // Pass 1: dangerous/forbidden constructs, so they are never classified as a
  // mere unknown key and skipped.
  for (const entry of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(entry.key)) {
      throw new BoundaryError('INVALID_XML', 'styleKey', `style key "${entry.key}" is malformed`, '$');
    }
    if (/(?:javascript|data|file|https?):/i.test(entry.value) || entry.value.startsWith('//')) {
      throw new BoundaryError(
        'INVALID_XML',
        'remoteResourceStyle',
        `style "${entry.key}" references a remote/script resource`,
        '$',
      );
    }
    if (FORBIDDEN_STYLE_KEYS.has(entry.key)) {
      throw new BoundaryError('INVALID_XML', 'forbiddenStyle', `style "${entry.key}" is not allowed`, '$');
    }
    if (entry.key === 'html' && entry.value !== '0') {
      throw new BoundaryError('INVALID_XML', 'forbiddenStyle', 'style "html=1" is not allowed', '$');
    }
    if (entry.key === 'fontFamily' && !LOCAL_FONTS.has(entry.value.toLowerCase())) {
      throw new BoundaryError('INVALID_XML', 'remoteFont', 'style "fontFamily" must be a local font family', '$');
    }
    if (entry.key === 'shape' && (entry.value === 'image' || entry.value === 'link' || entry.value === 'url')) {
      throw new BoundaryError('INVALID_XML', 'forbiddenStyle', 'style "shape" cannot be image/link/url', '$');
    }
  }
  // Pass 2: closed whitelist. Bare tokens are a fixed enum as well.
  /** @type {Record<string, string>} */
  const style = {};
  for (const entry of entries) {
    if (entry.value === '') {
      if (!BARE_TOKENS.has(entry.key)) {
        throw new BoundaryError('UNSUPPORTED', 'unknownStyleKey', `style token "${entry.key}" is not supported`, '$');
      }
      style[entry.key] = '';
      continue;
    }
    const verdict = validateStyleEntry(entry.key, entry.value);
    if (!verdict.ok) throw new BoundaryError(verdict.code, verdict.keyword, verdict.message, '$');
    style[entry.key] = entry.value;
  }
  return style;
}

/* -------------------------------------------------------------------------- */
/* mxGraph model serialization                                                 */
/* -------------------------------------------------------------------------- */

const MXGRAPH_STATIC_ATTRS = Object.freeze({
  dx: '0',
  dy: '0',
  grid: '1',
  gridSize: '10',
  guides: '1',
  tooltips: '1',
  connect: '1',
  arrows: '1',
  fold: '1',
  page: '1',
  pageScale: '1',
  pageWidth: '827',
  pageHeight: '1169',
  math: '0',
  shadow: '0',
});

const DATA_ATTRIBUTES = Object.freeze([
  'data_origin',
  'data_certainty',
  'data_base_digest',
  'data_diagram_id',
  'data_cell_kind',
]);

/** Short keys used by the parsed cell `data` object. */
const DATA_SHORT_KEYS = Object.freeze({
  data_origin: 'origin',
  data_certainty: 'certainty',
  data_base_digest: 'base_digest',
  data_diagram_id: 'diagram_id',
  data_cell_kind: 'cell_kind',
});

/**
 * Normalize a model style (string or parsed key→value record) to its
 * serializable `k=v;` form.
 * @param {unknown} style
 * @returns {string}
 */
function modelStyleString(style) {
  if (typeof style === 'string') return style;
  if (!isRecord(style)) return '';
  return Object.entries(style)
    .map(([key, value]) => (value === '' || value === undefined || value === null ? key : `${key}=${value}`))
    .join(';');
}

/** @param {unknown} value @param {string} name */
function finiteNumberAttr(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DiagramError('INVALID_INPUT', `${name} must be a finite number`);
  }
  return String(value);
}

/**
 * @param {{x?: number, y?: number, width?: number, height?: number, relative?: boolean, as?: string, points?: Array<{x: number, y: number, as?: string}>}} geometry
 * @returns {string}
 */
function serializeGeometry(geometry) {
  const attrs = [];
  for (const key of ['x', 'y', 'width', 'height']) {
    if (geometry[key] !== undefined && geometry[key] !== null) {
      attrs.push(`${key}="${finiteNumberAttr(geometry[key], `geometry.${key}`)}"`);
    }
  }
  if (geometry.relative === true) attrs.push('relative="1"');
  const as = geometry.as ?? 'geometry';
  attrs.push(`as="${escXmlAttr(as)}"`);
  const points = Array.isArray(geometry.points) ? geometry.points : [];
  const directPoints = points.filter(
    (point) => point.as === 'sourcePoint' || point.as === 'targetPoint' || point.as === 'offset',
  );
  const plainPoints = points.filter(
    (point) => !(point.as === 'sourcePoint' || point.as === 'targetPoint' || point.as === 'offset'),
  );
  const children = [];
  for (const point of directPoints) {
    children.push(
      `<mxPoint x="${finiteNumberAttr(point.x, 'point.x')}" y="${finiteNumberAttr(point.y, 'point.y')}" as="${escXmlAttr(point.as)}" />`,
    );
  }
  if (plainPoints.length > 0) {
    const pointsXml = plainPoints
      .map(
        (point) =>
          `<mxPoint x="${finiteNumberAttr(point.x, 'point.x')}" y="${finiteNumberAttr(point.y, 'point.y')}" />`,
      )
      .join('\n');
    children.push(`<Array as="points">\n${pointsXml}\n</Array>`);
  }
  const attrText = attrs.join(' ');
  if (children.length === 0) return `<mxGeometry ${attrText} />`;
  return `<mxGeometry ${attrText}>\n${children.join('\n')}\n</mxGeometry>`;
}

/**
 * @param {any} cell
 * @returns {string}
 */
function serializeMxCell(cell) {
  const id = cell.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new DiagramError('INVALID_INPUT', 'every mxCell needs a non-empty string id');
  }
  const attrs = [`id="${escXmlAttr(id)}"`];
  if (cell.parent !== undefined && cell.parent !== null) attrs.push(`parent="${escXmlAttr(cell.parent)}"`);
  if (cell.value !== undefined && cell.value !== null) attrs.push(`value="${escXmlAttr(cell.value)}"`);
  const style = modelStyleString(cell.style);
  if (style !== '') attrs.push(`style="${escXmlAttr(style)}"`);
  if (cell.vertex === true) attrs.push('vertex="1"');
  if (cell.edge === true) attrs.push('edge="1"');
  if (cell.source !== undefined && cell.source !== null) attrs.push(`source="${escXmlAttr(cell.source)}"`);
  if (cell.target !== undefined && cell.target !== null) attrs.push(`target="${escXmlAttr(cell.target)}"`);
  if (cell.visible === false) attrs.push('visible="0"');
  if (cell.visible === true) attrs.push('visible="1"');
  const nestedData = isRecord(cell.data) ? cell.data : null;
  for (const key of DATA_ATTRIBUTES) {
    const value =
      cell[key] !== undefined && cell[key] !== null
        ? cell[key]
        : nestedData
          ? nestedData[DATA_SHORT_KEYS[key]]
          : undefined;
    if (value !== undefined && value !== null) attrs.push(`${key}="${escXmlAttr(value)}"`);
  }
  const children = [];
  if (cell.geometry) children.push(serializeGeometry(cell.geometry));
  const open = `<mxCell ${attrs.join(' ')}`;
  if (children.length === 0) return `${open} />`;
  return `${open}>\n${children.join('\n')}\n</mxCell>`;
}

/**
 * Serialize the `<mxGraphModel>` element. `root_cells` is the ordered list of
 * content cells; the model root cell `0` and the layer cells are emitted first.
 * Callers are responsible for deterministic cell order (exportDrawio sorts by
 * id); canonicalMxGraph ignores order entirely.
 *
 * @param {{root_cells: Array<any>, layers?: Array<{id: string, value?: string, visible?: boolean}>}} model
 * @returns {string}
 */
export function serializeMxGraphModel(model) {
  if (!isRecord(model) || !Array.isArray(model.root_cells)) {
    throw new DiagramError('INVALID_INPUT', 'model.root_cells must be an array');
  }
  const layers = Array.isArray(model.layers) ? model.layers : [];
  const layerIds = new Set(layers.map((layer) => String(layer.id)));
  /** @type {string[]} */
  const cellsXml = [];
  const ownCell0 = model.root_cells.find((cell) => String(cell?.id) === '0');
  cellsXml.push(serializeMxCell(ownCell0 ?? { id: '0' }));
  for (const layer of layers) {
    cellsXml.push(
      serializeMxCell({
        id: String(layer.id),
        parent: '0',
        value: layer.value,
        visible: layer.visible,
      }),
    );
  }
  for (const cell of model.root_cells) {
    const id = String(cell?.id);
    if (id === '0' || layerIds.has(id)) continue;
    cellsXml.push(serializeMxCell(cell));
  }
  const attrs = Object.entries(MXGRAPH_STATIC_ATTRS)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return `<mxGraphModel ${attrs}>\n<root>\n${cellsXml.join('\n')}\n</root>\n</mxGraphModel>`;
}

/* -------------------------------------------------------------------------- */
/* mxGraph model parsing                                                       */
/* -------------------------------------------------------------------------- */

class BoundaryError extends Error {
  /**
   * @param {'INVALID_XML' | 'UNSUPPORTED' | 'LIMIT_EXCEEDED'} code
   * @param {string} keyword
   * @param {string} message
   * @param {string} [path]
   */
  constructor(code, keyword, message, path = '$') {
    super(message);
    this.name = 'BoundaryError';
    this.code = code;
    this.report = { path, keyword, message };
  }
}

/** @param {string} message @param {string} [path] @returns {never} */
function reject(message, path) {
  throw new BoundaryError('INVALID_XML', 'invalid', message, path);
}

/** @param {string} message @param {string} [path] @returns {never} */
function rejectUnsupported(message, path) {
  throw new BoundaryError('UNSUPPORTED', 'unsupported', message, path);
}

/** @param {string} keyword @param {string} message @param {string} [path] @returns {never} */
function rejectLimit(keyword, message, path) {
  throw new BoundaryError('LIMIT_EXCEEDED', keyword, message, path);
}

const MXFILE_ATTRS = new Set(['host', 'version', 'modified', 'agent', 'etag']);
const DIAGRAM_ATTRS = new Set(['id', 'name']);
const MXGRAPH_ATTRS = new Set([
  'dx',
  'dy',
  'grid',
  'gridSize',
  'guides',
  'tooltips',
  'connect',
  'arrows',
  'fold',
  'page',
  'pageScale',
  'pageWidth',
  'pageHeight',
  'math',
  'shadow',
]);
const CELL_ATTRS = new Set([
  'id',
  'value',
  'style',
  'parent',
  'source',
  'target',
  'vertex',
  'edge',
  'visible',
  ...DATA_ATTRIBUTES,
]);
const GEOMETRY_ATTRS = new Set(['x', 'y', 'width', 'height', 'relative', 'as']);
const POINT_ATTRS = new Set(['x', 'y', 'as']);
const ARRAY_ATTRS = new Set(['as']);
const POINT_AS_VALUES = new Set(['sourcePoint', 'targetPoint', 'offset']);

/**
 * @typedef {{id: string, parent: string | null, value: string, style: Record<string, string>, vertex: boolean, edge: boolean, source: string | null, target: string | null, visible: boolean | null, data: {origin: string | null, certainty: string | null, base_digest: string | null, diagram_id: string | null, cell_kind: string | null}, geometry: null | {x: number | null, y: number | null, width: number | null, height: number | null, relative: boolean | null, as: string, points: Array<{x: number, y: number, as: string | null}>}}} MxCell
 */

/**
 * @param {XmlNode} node
 * @param {string} elementName
 * @returns {XmlNode[]}
 */
function elementChildren(node, elementName) {
  /** @type {XmlNode[]} */
  const elements = [];
  for (const child of node.children) {
    if (Array.isArray(child.children)) elements.push(child);
  }
  for (const element of elements) {
    if (element.name !== elementName) {
      rejectUnsupported(`unknown element <${element.name}> inside <${node.name}>`, `$.${node.name}`);
    }
  }
  return elements;
}

/**
 * @param {XmlNode} node
 * @param {Set<string>} allowed
 */
function validateAttributes(node, allowed) {
  for (const key of Object.keys(node.attributes)) {
    if (!allowed.has(key)) {
      rejectUnsupported(`attribute "${key}" is not supported on <${node.name}>`, `$.${node.name}.${key}`);
    }
  }
}

/** @param {XmlNode} node @param {string} name */
function attr(node, name) {
  return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : undefined;
}

/** @param {XmlNode} node @param {string} name @param {string} path */
function requiredAttr(node, name, path) {
  const value = attr(node, name);
  if (value === undefined || value === '') reject(`<${node.name}> requires attribute "${name}"`, path);
  return value;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** @param {string} value @param {string} what @param {string} path */
function validateSafeId(value, what, path) {
  if (!SAFE_ID_PATTERN.test(value)) reject(`${what} "${value}" is not a safe id`, path);
}

/** @param {string} value @param {string} name @param {string} path */
function validatePlainTextValue(value, name, path) {
  if (utf8Length(value) > LIMITS.drawio_value) rejectLimit('maxValue', `${name} exceeds ${LIMITS.drawio_value} bytes`, path);
  if (looksLikeMarkup(value)) reject(`value of ${name} contains HTML/script markup`, path);
}

/**
 * @param {XmlNode} node
 * @param {string} name
 * @param {string} path
 * @returns {number | null}
 */
function optionalFiniteAttr(node, name, path) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) {
    reject(`attribute "${name}" must be a finite number`, path);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) reject(`attribute "${name}" must be a finite number`, path);
  return value;
}

/**
 * @param {XmlNode} node
 * @param {number} maxPoints
 * @returns {{x: number | null, y: number | null, width: number | null, height: number | null, relative: boolean | null, as: string, points: Array<{x: number, y: number, as: string | null}>}}
 */
function buildGeometry(node, maxPoints) {
  const path = '$.mxGeometry';
  validateAttributes(node, GEOMETRY_ATTRS);
  const as = attr(node, 'as') ?? 'geometry';
  if (as !== 'geometry') rejectUnsupported(`geometry as="${as}" is not supported`, path);
  const relativeRaw = attr(node, 'relative');
  if (relativeRaw !== undefined && relativeRaw !== '0' && relativeRaw !== '1') {
    reject('attribute "relative" must be 0 or 1', path);
  }
  /** @type {{x: number | null, y: number | null, width: number | null, height: number | null, relative: boolean | null, as: string, points: Array<{x: number, y: number, as: string | null}>}} */
  const geometry = {
    x: optionalFiniteAttr(node, 'x', path),
    y: optionalFiniteAttr(node, 'y', path),
    width: optionalFiniteAttr(node, 'width', path),
    height: optionalFiniteAttr(node, 'height', path),
    relative: relativeRaw === undefined ? null : relativeRaw === '1',
    as,
    points: [],
  };
  for (const child of node.children) {
    if (!Array.isArray(child.children)) continue;
    if (child.name === 'mxPoint') {
      geometry.points.push(buildPoint(child));
    } else if (child.name === 'Array') {
      validateAttributes(child, ARRAY_ATTRS);
      const arrayAs = attr(child, 'as');
      if (arrayAs !== 'points') rejectUnsupported(`Array as="${arrayAs ?? ''}" is not supported`, path);
      for (const pointNode of elementChildren(child, 'mxPoint')) {
        const point = buildPoint(pointNode);
        if (point.as !== null) reject('points inside <Array as="points"> cannot carry an "as" attribute', path);
        geometry.points.push(point);
      }
    } else {
      rejectUnsupported(`unknown geometry child <${child.name}>`, path);
    }
  }
  if (geometry.points.length > maxPoints) {
    rejectLimit('maxPoints', `geometry exceeds ${maxPoints} points`, path);
  }
  return geometry;
}

/**
 * @param {XmlNode} node
 * @returns {{x: number, y: number, as: string | null}}
 */
function buildPoint(node) {
  validateAttributes(node, POINT_ATTRS);
  const path = '$.mxPoint';
  const x = optionalFiniteAttr(node, 'x', path);
  const y = optionalFiniteAttr(node, 'y', path);
  if (x === null || y === null) reject('mxPoint requires "x" and "y"', path);
  const as = attr(node, 'as');
  if (as !== undefined && !POINT_AS_VALUES.has(as)) {
    rejectUnsupported(`mxPoint as="${as}" is not supported`, path);
  }
  return { x, y, as: as ?? null };
}

/**
 * @param {XmlNode} node
 * @returns {MxCell}
 */
function buildCell(node) {
  validateAttributes(node, CELL_ATTRS);
  const id = requiredAttr(node, 'id', '$.mxCell.id');
  validateSafeId(id, 'cell id', '$.mxCell.id');
  const parent = attr(node, 'parent');
  if (parent !== undefined) validateSafeId(parent, 'cell parent', '$.mxCell.parent');
  const value = attr(node, 'value') ?? '';
  validatePlainTextValue(value, 'mxCell value', '$.mxCell.value');
  const styleRaw = attr(node, 'style') ?? '';
  const style = parseDrawioStyle(styleRaw);
  const vertex = readFlag(node, 'vertex');
  const edge = readFlag(node, 'edge');
  const visible = readFlagOrNull(node, 'visible');
  const source = attr(node, 'source');
  const target = attr(node, 'target');
  if (source !== undefined) validateSafeId(source, 'edge source', '$.mxCell.source');
  if (target !== undefined) validateSafeId(target, 'edge target', '$.mxCell.target');

  const data = {
    origin: readEnum(node, 'data_origin', ['evidence', 'annotation']),
    certainty: readEnum(node, 'data_certainty', ['exact', 'may', 'unresolved', 'unknown']),
    base_digest: readDigest(node, 'data_base_digest'),
    diagram_id: readDisplayId(node, 'data_diagram_id'),
    cell_kind: readDisplayToken(node, 'data_cell_kind'),
  };

  let geometry = null;
  const cellElements = elementChildren(node, 'mxGeometry');
  if (cellElements.length > 1) reject('mxCell may contain at most one mxGeometry', '$.mxCell');
  if (cellElements.length === 1) geometry = buildGeometry(cellElements[0], LIMITS.mx_geometry_points);
  if (node.text.trim() !== '') reject('mxCell cannot contain character data', '$.mxCell');

  return { id, parent: parent ?? null, value, style, vertex, edge, source: source ?? null, target: target ?? null, visible, data, geometry };
}

/** @param {XmlNode} node @param {string} name */
function readFlag(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return false;
  if (raw !== '0' && raw !== '1') reject(`attribute "${name}" must be 0 or 1`, `$.mxCell.${name}`);
  return raw === '1';
}

/** @param {XmlNode} node @param {string} name */
function readFlagOrNull(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (raw !== '0' && raw !== '1') reject(`attribute "${name}" must be 0 or 1`, `$.mxCell.${name}`);
  return raw === '1';
}

/** @param {XmlNode} node @param {string} name @param {string[]} allowed */
function readEnum(node, name, allowed) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (!allowed.includes(raw)) reject(`attribute "${name}" has an unsupported value`, `$.mxCell.${name}`);
  return raw;
}

/** @param {XmlNode} node @param {string} name */
function readDigest(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) reject(`attribute "${name}" must be a sha256 hex digest`, `$.mxCell.${name}`);
  return raw;
}

/** @param {XmlNode} node @param {string} name */
function readDisplayId(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  validateSafeId(raw, `attribute "${name}"`, `$.mxCell.${name}`);
  return raw;
}

/** @param {XmlNode} node @param {string} name */
function readDisplayToken(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(raw)) {
    reject(`attribute "${name}" is malformed`, `$.mxCell.${name}`);
  }
  return raw;
}

/**
 * Parse an uncompressed `.drawio` / `<mxGraphModel>` payload into the
 * restricted cell model. Compressed diagrams, unknown elements, unknown
 * attributes and unknown shapes are UNSUPPORTED (never stripped); malformed
 * or dangerous values are INVALID_XML.
 *
 * @param {string | Uint8Array} input
 * @param {{limits?: Record<string, number>}} [options]
 * @returns {{ok: true, document: {cells: MxCell[], layers: Array<{id: string, value: string}>}} | {ok: false, code: string, errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function parseDrawioXml(input, options = {}) {
  const customLimits = isRecord(options.limits) ? options.limits : {};
  const parsed = parseXmlRestricted(input, {
    limits: {
      xml_bytes: customLimits.xml_bytes ?? LIMITS.xml_bytes,
      xml_depth: customLimits.xml_depth ?? LIMITS.xml_depth,
      xml_elements: customLimits.xml_elements ?? LIMITS.xml_elements,
      xml_attributes_per_element: customLimits.xml_attributes_per_element ?? LIMITS.xml_attributes_per_element,
    },
  });
  if (!parsed.ok) return parsed;
  try {
    return { ok: true, document: buildDrawioDocument(parsed.root, customLimits) };
  } catch (error) {
    if (error instanceof BoundaryError) {
      return { ok: false, code: error.code, errors: [error.report] };
    }
    throw error;
  }
}

/**
 * @param {XmlNode} rootNode
 * @param {Record<string, any>} customLimits
 * @returns {{cells: MxCell[], layers: Array<{id: string, value: string}>}}
 */
function buildDrawioDocument(rootNode, customLimits) {
  const maxCells = Number.isSafeInteger(customLimits.mx_cells) && customLimits.mx_cells >= 1
    ? customLimits.mx_cells
    : LIMITS.mx_cells;

  /** @type {XmlNode | null} */
  let graphModelNode = null;
  if (rootNode.name === 'mxfile') {
    validateAttributes(rootNode, MXFILE_ATTRS);
    const diagrams = elementChildren(rootNode, 'diagram');
    if (diagrams.length === 0) reject('mxfile must contain a diagram element', '$.mxfile');
    if (diagrams.length > 1) rejectUnsupported('multi-page diagrams are not supported', '$.mxfile');
    graphModelNode = readDiagram(diagrams[0]);
  } else if (rootNode.name === 'diagram') {
    graphModelNode = readDiagram(rootNode);
  } else if (rootNode.name === 'mxGraphModel') {
    graphModelNode = rootNode;
  } else {
    rejectUnsupported(`unknown root element <${rootNode.name}>`, '$');
  }

  validateAttributes(graphModelNode, MXGRAPH_ATTRS);
  const roots = elementChildren(graphModelNode, 'root');
  if (roots.length !== 1) reject('mxGraphModel must contain exactly one root element', '$.mxGraphModel');
  const rootElement = roots[0];
  if (Object.keys(rootElement.attributes).length > 0) reject('root element must not have attributes', '$.root');
  if (rootElement.text.trim() !== '') reject('root element cannot contain character data', '$.root');

  const cellNodes = elementChildren(rootElement, 'mxCell');
  if (cellNodes.length > maxCells) rejectLimit('maxCells', `document exceeds ${maxCells} cells`, '$.root');

  /** @type {MxCell[]} */
  const cells = cellNodes.map((cellNode) => buildCell(cellNode));
  /** @type {Map<string, MxCell>} */
  const byId = new Map();
  for (const cell of cells) {
    if (byId.has(cell.id)) reject(`duplicate cell id "${cell.id}"`, '$.root');
    byId.set(cell.id, cell);
  }
  const rootCell = byId.get('0');
  if (!rootCell) reject('document must contain root cell 0', '$.root');
  if (rootCell.parent !== null) reject('root cell 0 must not have a parent', '$.root');
  if (rootCell.vertex || rootCell.edge) reject('root cell 0 cannot be a vertex or edge', '$.root');

  /** @type {MxCell[]} */
  const layerCells = [];
  /** @type {MxCell[]} */
  const contentCells = [];
  for (const cell of cells) {
    if (cell.id === '0') continue;
    if (cell.parent === '0') layerCells.push(cell);
    else contentCells.push(cell);
  }
  if (layerCells.length === 0) reject('document must contain at least one layer cell (parent 0)', '$.root');
  const layerIds = new Set(layerCells.map((layer) => layer.id));

  for (const layer of layerCells) {
    if (layer.vertex || layer.edge || layer.geometry) {
      rejectUnsupported(`layer cell "${layer.id}" cannot be a vertex/edge`, '$.root');
    }
  }
  for (const cell of contentCells) {
    if (cell.parent === null) reject(`cell "${cell.id}" is missing a parent`, '$.root');
    if (!layerIds.has(cell.parent)) {
      rejectUnsupported(`cell "${cell.id}" is nested in non-layer cell "${cell.parent}"; groups are not supported`, '$.root');
    }
    if (cell.vertex && cell.edge) reject(`cell "${cell.id}" cannot be both vertex and edge`, '$.root');
    if (!cell.vertex && !cell.edge) rejectUnsupported(`cell "${cell.id}" has no vertex/edge role`, '$.root');
    if (cell.edge) {
      if (cell.source === null || cell.target === null) reject(`edge cell "${cell.id}" requires source and target`, '$.root');
      const sourceCell = byId.get(cell.source);
      const targetCell = byId.get(cell.target);
      if (!sourceCell || !targetCell) reject(`edge cell "${cell.id}" references a missing endpoint`, '$.root');
      for (const [side, endpoint] of [['source', sourceCell], ['target', targetCell]]) {
        if (!endpoint.vertex) reject(`edge cell "${cell.id}" ${side} must reference a vertex cell`, '$.root');
      }
    }
    if (cell.vertex && (cell.source !== null || cell.target !== null)) {
      reject(`vertex cell "${cell.id}" cannot have source/target attributes`, '$.root');
    }
  }

  return {
    cells,
    layers: layerCells.map((layer) => ({ id: layer.id, value: layer.value })),
  };
}

/**
 * @param {XmlNode} diagramNode
 * @returns {XmlNode}
 */
function readDiagram(diagramNode) {
  validateAttributes(diagramNode, DIAGRAM_ATTRS);
  const children = diagramNode.children.filter((child) => Array.isArray(child.children));
  if (children.length === 0) {
    if (diagramNode.text.trim() !== '') {
      rejectUnsupported(
        'compressed diagram content is not supported; export the diagram as uncompressed XML first',
        '$.diagram',
      );
    }
    reject('diagram element is empty', '$.diagram');
  }
  if (children.length > 1) rejectUnsupported('multi-page diagrams are not supported', '$.diagram');
  if (children[0].name !== 'mxGraphModel') {
    rejectUnsupported(`unknown diagram child <${children[0].name}>`, '$.diagram');
  }
  return children[0];
}

/* -------------------------------------------------------------------------- */
/* canonical semantic form                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Canonical style string: entries sorted by key, bare tokens preserved.
 * @param {unknown} style
 * @returns {string}
 */
function canonicalStyle(style) {
  /** @type {Array<[string, string]>} */
  const entries = [];
  if (typeof style === 'string') {
    for (const part of style.split(';')) {
      if (part === '') continue;
      const eq = part.indexOf('=');
      if (eq === -1) entries.push([part, '']);
      else entries.push([part.slice(0, eq), part.slice(eq + 1)]);
    }
  } else if (isRecord(style)) {
    for (const key of Object.keys(style)) {
      const value = style[key];
      entries.push([key, value === undefined || value === null ? '' : String(value)]);
    }
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return entries.map(([key, value]) => (value === '' ? key : `${key}=${value}`)).join(';');
}

/** @param {unknown} value */
function canonicalVisible(value) {
  if (value === undefined || value === null) return true;
  if (value === false || value === '0' || value === 0) return false;
  return true;
}

/** @param {unknown} value */
function canonicalNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * @param {any} cell
 * @returns {any}
 */
function canonicalCell(cell) {
  const data = isRecord(cell.data) ? cell.data : {};
  const pick = (flatName, shortName) => {
    if (cell[flatName] !== undefined) return cell[flatName];
    if (data[shortName] !== undefined) return data[shortName];
    return null;
  };
  let geometry = null;
  if (isRecord(cell.geometry)) {
    const rawPoints = Array.isArray(cell.geometry.points) ? cell.geometry.points : [];
    geometry = {
      x: canonicalNumberOrNull(cell.geometry.x),
      y: canonicalNumberOrNull(cell.geometry.y),
      width: canonicalNumberOrNull(cell.geometry.width),
      height: canonicalNumberOrNull(cell.geometry.height),
      relative: cell.geometry.relative === true || cell.geometry.relative === '1' ? true : null,
      as: cell.geometry.as ?? 'geometry',
      points: rawPoints.map((point) => ({
        x: canonicalNumberOrNull(point?.x),
        y: canonicalNumberOrNull(point?.y),
        as: point?.as ?? null,
      })),
    };
  }
  return {
    id: String(cell.id),
    parent: cell.parent ?? null,
    value: cell.value ?? '',
    style: canonicalStyle(cell.style),
    vertex: Boolean(cell.vertex),
    edge: Boolean(cell.edge),
    source: cell.source ?? null,
    target: cell.target ?? null,
    visible: canonicalVisible(cell.visible),
    data: {
      origin: pick('data_origin', 'origin'),
      certainty: pick('data_certainty', 'certainty'),
      base_digest: pick('data_base_digest', 'base_digest'),
      diagram_id: pick('data_diagram_id', 'diagram_id'),
      cell_kind: pick('data_cell_kind', 'cell_kind'),
    },
    geometry,
  };
}

/**
 * @param {{root_cells?: any[], layers?: any[], cells?: any[]}} model
 * @returns {any[]}
 */
function modelCells(model) {
  if (Array.isArray(model.cells)) return model.cells;
  if (!Array.isArray(model.root_cells)) {
    throw new DiagramError('INVALID_INPUT', 'canonicalMxGraph needs {cells} or {root_cells} or XML text');
  }
  const layers = Array.isArray(model.layers) ? model.layers : [];
  const layerIds = new Set(layers.map((layer) => String(layer?.id)));
  const cells = [];
  const cell0 = model.root_cells.find((cell) => String(cell?.id) === '0');
  if (cell0) cells.push(cell0);
  for (const layer of layers) {
    cells.push({ id: String(layer.id), parent: '0', value: layer.value, visible: layer.visible });
  }
  for (const cell of model.root_cells) {
    const id = String(cell?.id);
    if (id === '0' || layerIds.has(id)) continue;
    cells.push(cell);
  }
  return cells;
}

/**
 * Canonical semantic form for comparing two drawio representations. Ordering,
 * attribute order and style entry order are irrelevant; cells are sorted by id,
 * numbers and visibility flags are normalized. This is what the save guard uses
 * to compare client XML with the canonical XML (DIA-DESIGN-2 §9).
 *
 * Accepts a parsed document ({cells,layers}), an export model
 * ({root_cells,layers}) or raw XML text.
 *
 * @param {string | Uint8Array | {cells?: any[], root_cells?: any[], layers?: any[]}} model
 * @returns {string}
 */
export function canonicalMxGraph(model) {
  /** @type {any[]} */
  let cells;
  if (typeof model === 'string' || model instanceof Uint8Array) {
    const parsed = parseDrawioXml(model);
    if (!parsed.ok) {
      throw new DiagramError(parsed.code, 'cannot canonicalize invalid drawio XML', { errors: parsed.errors });
    }
    cells = parsed.document.cells;
  } else if (isRecord(model)) {
    cells = modelCells(model);
  } else {
    throw new DiagramError('INVALID_INPUT', 'canonicalMxGraph needs XML text or a parsed/model document');
  }
  const normalized = cells
    .map((cell) => canonicalCell(cell))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return canonicalJson({ cells: normalized });
}

/* -------------------------------------------------------------------------- */
/* export: DiagramSpec + AnnotationOverlay -> restricted .drawio               */
/* -------------------------------------------------------------------------- */

const LAYERS = Object.freeze([
  { id: 'layer-base', value: 'Base' },
  { id: 'layer-annotations', value: 'Annotations' },
  { id: 'layer-notes', value: 'Notes' },
]);

const NODE_STYLES = Object.freeze({
  module: 'rounded=1;whiteSpace=wrap;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=12;',
  function: 'rounded=1;whiteSpace=wrap;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=12;',
  type: 'rounded=0;whiteSpace=wrap;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=12;',
  resource: 'shape=cylinder;whiteSpace=wrap;fillColor=#f8cecc;strokeColor=#b85450;fontSize=12;',
  note: 'shape=note;whiteSpace=wrap;fillColor=#ffffff;strokeColor=#999999;fontSize=12;',
});
const BASE_EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;strokeColor=#666666;fontSize=11;';
const ANNOTATION_NODE_STYLE = 'rounded=1;whiteSpace=wrap;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=12;';
const ANNOTATION_EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;dashed=1;strokeColor=#9673a6;fontSize=11;';
const NOTE_STYLE = 'shape=note;whiteSpace=wrap;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=12;';

const DEFAULT_NODE_SIZE = Object.freeze({ width: 160, height: 64 });

/** @param {any} left @param {any} right */
function byId(left, right) {
  const leftId = String(left?.id ?? '');
  const rightId = String(right?.id ?? '');
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** @param {string} value @param {string} what @param {string} code */
function assertPlainDisplayText(value, what, code) {
  if (typeof value !== 'string') throw new DiagramError(code, `${what} must be a string`);
  if (looksLikeMarkup(value)) {
    throw new DiagramError(code, `${what} contains HTML/script markup and cannot be written to drawio`, {
      errors: [issue('$.value', 'forbiddenValue', `${what} contains HTML/script markup`)],
    });
  }
  if ([...value].some((ch) => {
    const cp = ch.codePointAt(0);
    return !isLegalXmlCodePoint(cp ?? 0);
  })) {
    throw new DiagramError(code, `${what} contains characters that are not legal XML`, {
      errors: [issue('$.value', 'invalidChar', `${what} contains an illegal XML character`)],
    });
  }
}

/** @param {any} position @param {any} fallback */
function exportPosition(position, fallback = DEFAULT_NODE_SIZE) {
  const x = Number.isSafeInteger(position?.x) ? position.x : 0;
  const y = Number.isSafeInteger(position?.y) ? position.y : 0;
  const width = Number.isSafeInteger(position?.width) && position.width >= 1 ? position.width : fallback.width;
  const height = Number.isSafeInteger(position?.height) && position.height >= 1 ? position.height : fallback.height;
  return { x, y, width, height };
}

/**
 * Export a validated DiagramSpecV1 + AnnotationOverlayV1 to the restricted
 * `.drawio` profile.
 *
 * @param {{spec: any, annotation_overlay?: any, overlay?: any}} input
 * @param {{now?: string, diagram_name?: string, limits?: Record<string, number>, self_check?: boolean}} [policy]
 * @returns {{xml: string, warnings: string[]}}
 */
export function exportDrawio(input, policy = {}) {
  if (!isRecord(input) || !isRecord(input.spec)) {
    throw new DiagramError('INVALID_INPUT', 'exportDrawio expects {spec, annotation_overlay}');
  }
  const spec = input.spec;
  const contracts = requireContracts();
  const specCheck = contracts.validateDiagramSpec(spec);
  if (!specCheck.ok) {
    throw new DiagramError('INVALID_SPEC', 'diagram spec failed validation', { errors: specCheck.errors });
  }
  const specDigest = contracts.specDigest(spec);
  const now = typeof policy.now === 'string' ? policy.now : new Date().toISOString();
  const providedOverlay = input.annotation_overlay ?? input.overlay ?? null;
  const overlay =
    providedOverlay ??
    {
      schema_version: 1,
      diagram_id: spec.diagram_id,
      base_spec_digest: specDigest,
      revision: 0,
      items: [],
      orphaned_annotations: [],
      updated_at: now,
    };
  const overlayCheck = contracts.validateOverlay(overlay);
  if (!overlayCheck.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'annotation overlay failed validation', { errors: overlayCheck.errors });
  }
  if (typeof contracts.validateComposite === 'function') {
    const composite = contracts.validateComposite(spec, overlay);
    if (composite && composite.ok === false) {
      throw new DiagramError('INVALID_OVERLAY', 'spec/overlay do not form a valid composite', {
        errors: composite.errors,
      });
    }
  }

  /** @type {string[]} */
  const warnings = [];
  const specLayout = new Map();
  for (const position of spec.layout?.positions ?? []) {
    if (isRecord(position) && typeof position.node_id === 'string') specLayout.set(position.node_id, position);
  }
  /** @type {Map<string, any>} */
  const layoutOverrides = new Map();
  /** @type {Set<string>} */
  const hidden = new Set();
  const items = Array.isArray(overlay.items) ? overlay.items : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.kind === 'layout' && typeof item.target_ref === 'string') layoutOverrides.set(item.target_ref, item.position);
    else if (item.kind === 'visibility' && item.hidden === true && typeof item.target_ref === 'string') {
      hidden.add(item.target_ref);
    }
  }
  if (Array.isArray(overlay.orphaned_annotations) && overlay.orphaned_annotations.length > 0) {
    warnings.push('orphaned_annotations_not_serialized');
  }

  const baseNodeIds = new Set((spec.nodes ?? []).map((node) => node.id));
  const annotationNodeIds = new Set(
    items.filter((item) => item.kind === 'annotation_node').map((item) => item.id),
  );
  /** @param {string} ref @returns {string | null} */
  const cellRef = (ref) => {
    if (baseNodeIds.has(ref)) return `base:${ref}`;
    if (annotationNodeIds.has(ref)) return `overlay:${ref}`;
    return null;
  };

  /** @type {any[]} */
  const cells = [];

  const nodes = [...(spec.nodes ?? [])].sort(byId);
  for (const node of nodes) {
    assertPlainDisplayText(node.label, `node "${node.id}" label`, 'INVALID_SPEC');
    const position = exportPosition(layoutOverrides.get(node.id) ?? specLayout.get(node.id));
    /** @type {any} */
    const cell = {
      id: `base:${node.id}`,
      parent: 'layer-base',
      value: node.label,
      style: NODE_STYLES[node.kind] ?? NODE_STYLES.module,
      vertex: true,
      data_cell_kind: 'base_node',
      geometry: { ...position, as: 'geometry' },
    };
    if (hidden.has(node.id)) cell.visible = false;
    cells.push(cell);
  }

  const baseEdges = [...(spec.edges ?? [])].sort(byId);
  for (const edge of baseEdges) {
    assertPlainDisplayText(edge.label ?? '', `edge "${edge.id}" label`, 'INVALID_SPEC');
    const source = cellRef(edge.from);
    const target = cellRef(edge.to);
    if (source === null || target === null) {
      throw new DiagramError('INVALID_SPEC', `base edge "${edge.id}" references a node outside the spec`);
    }
    /** @type {any} */
    const cell = {
      id: `base:${edge.id}`,
      parent: 'layer-base',
      value: edge.label ?? '',
      style: BASE_EDGE_STYLE,
      edge: true,
      source,
      target,
      data_cell_kind: 'base_edge',
    };
    // A base edge connected to a hidden base node is hidden in the view only:
    // the base spec is untouched and the evidence remains in the JSON pack.
    if (hidden.has(edge.id) || hidden.has(edge.from) || hidden.has(edge.to)) cell.visible = false;
    cells.push(cell);
  }

  const annotationNodes = items.filter((item) => item.kind === 'annotation_node').sort(byId);
  for (const item of annotationNodes) {
    assertPlainDisplayText(item.label, `annotation node "${item.id}" label`, 'INVALID_OVERLAY');
    cells.push({
      id: `overlay:${item.id}`,
      parent: 'layer-annotations',
      value: item.label,
      style: ANNOTATION_NODE_STYLE,
      vertex: true,
      data_origin: 'annotation',
      data_certainty: 'unknown',
      data_cell_kind: 'annotation_node',
      geometry: { ...exportPosition(item.position), as: 'geometry' },
    });
  }

  const annotationEdges = items.filter((item) => item.kind === 'annotation_edge').sort(byId);
  for (const item of annotationEdges) {
    assertPlainDisplayText(item.label ?? '', `annotation edge "${item.id}" label`, 'INVALID_OVERLAY');
    const source = cellRef(item.from);
    const target = cellRef(item.to);
    if (source === null || target === null) {
      throw new DiagramError('INVALID_OVERLAY', `annotation edge "${item.id}" references an unknown endpoint`);
    }
    cells.push({
      id: `overlay:${item.id}`,
      parent: 'layer-annotations',
      value: item.label ?? '',
      style: ANNOTATION_EDGE_STYLE,
      edge: true,
      source,
      target,
      data_origin: 'annotation',
      data_certainty: 'unknown',
      data_cell_kind: 'annotation_edge',
    });
  }

  const notes = items.filter((item) => item.kind === 'note').sort(byId);
  for (const item of notes) {
    assertPlainDisplayText(item.text, `note "${item.id}" text`, 'INVALID_OVERLAY');
    cells.push({
      id: `overlay:${item.id}`,
      parent: 'layer-notes',
      value: item.text,
      style: NOTE_STYLE,
      vertex: true,
      data_origin: 'annotation',
      data_certainty: 'unknown',
      data_cell_kind: 'note',
      geometry: { ...exportPosition(item.position), as: 'geometry' },
    });
  }
  if (notes.some((item) => item.target_ref !== null && item.target_ref !== undefined)) {
    // The restricted .drawio profile is not the authoritative overlay store:
    // note target references stay in annotations.json and are not trusted from
    // XML (DIA-DESIGN-2 §7).
    warnings.push('note_target_ref_not_serialized');
  }

  const digest = specDigest;
  const model = {
    root_cells: [
      {
        id: '0',
        data_diagram_id: spec.diagram_id,
        data_base_digest: digest,
      },
      ...cells,
    ],
    layers: LAYERS,
  };
  const modelXml = serializeMxGraphModel(model);
  const diagramName = policy.diagram_name ?? spec.title ?? 'diagram';
  const xml = `<mxfile host="local-diagrams" version="v1">\n<diagram id="${escXmlAttr(spec.diagram_id)}" name="${escXmlAttr(diagramName)}">\n${modelXml}\n</diagram>\n</mxfile>`;
  const bytes = utf8Length(xml);
  const maxBytes = Number.isSafeInteger(policy.limits?.document_xml_bytes)
    ? policy.limits.document_xml_bytes
    : LIMITS.document_xml_bytes;
  if (bytes > maxBytes) {
    throw new DiagramError('LIMIT_EXCEEDED', `serialized drawio XML is ${bytes} bytes; limit is ${maxBytes}`);
  }

  if (policy.self_check !== false) {
    const reparsed = parseDrawioXml(xml);
    if (!reparsed.ok) {
      throw new DiagramError('INTERNAL_FAILURE', 'serialized drawio XML failed the restricted parser self-check', {
        errors: reparsed.errors,
      });
    }
    if (canonicalMxGraph(model) !== canonicalMxGraph(reparsed.document)) {
      throw new DiagramError('INTERNAL_FAILURE', 'serialized drawio XML is not semantically stable across a round-trip');
    }
  }

  return { xml, warnings };
}
