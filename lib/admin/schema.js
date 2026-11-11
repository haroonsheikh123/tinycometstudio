/* Tiny JSON-Schema subset validator. The same schema objects are emitted verbatim into the
   OpenAPI 3.1 document, so docs and validation can't drift.
   Supported: type (string|integer|number|boolean|object|array|null, or an array of types), enum, const,
   properties, required, additionalProperties (false | schema), items, minItems, maxItems, uniqueItems,
   minLength, maxLength, pattern, format (email|uri|url-or-path|date|date-time|hex-color), minimum, maximum,
   nullable via type: [..., "null"], oneOf (first match), default (applied), description (ignored). */

const FORMATS = {
  email: (s) => /^[^\s@<>()",;:]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i.test(s),
  uri: (s) => { try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; } },
  "url-or-path": (s) => s === "" || s === "#" || /^\/(?!\/)[^\s]*$/.test(s) || FORMATS.uri(s),
  date: (s) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s),
  "full-date": (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  "date-time": (s) => !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s),
  "hex-color": (s) => /^#[0-9a-f]{6}$/i.test(s),
  slug: (s) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(s)
};

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const typeMatches = (t, v) => { const a = typeOf(v); return t === a || (t === "number" && a === "integer"); };

/** Validate & normalise `value`. Returns { value, errors: [{ path, message }] }. Unknown props are rejected unless allowed. */
export function validate(schema, value, path = "") {
  const errors = [];
  const out = walk(schema, value, path || "$", errors);
  return { value: out, errors };
}

function walk(s, v, path, errors) {
  if (!s) return v;
  if (v === undefined && s.default !== undefined) v = structuredClone(s.default);
  if (v === undefined) return v;
  if (s.oneOf) {
    for (const alt of s.oneOf) {
      const e = [];
      const r = walk(alt, v, path, e);
      if (!e.length) return r;
    }
    errors.push({ path, message: "does not match any allowed shape" });
    return v;
  }
  const types = s.type ? [].concat(s.type) : null;
  if (types && !types.some((t) => typeMatches(t, v))) {
    errors.push({ path, message: `must be ${types.join(" or ")}` });
    return v;
  }
  if (s.const !== undefined && v !== s.const) errors.push({ path, message: `must be ${JSON.stringify(s.const)}` });
  if (s.enum && !s.enum.includes(v)) errors.push({ path, message: `must be one of: ${s.enum.join(", ")}` });
  if (typeof v === "string") {
    if (s.trim !== false) v = v.replace(/\u0000/g, "");
    if (s.minLength != null && v.length < s.minLength) errors.push({ path, message: `must be at least ${s.minLength} characters` });
    if (s.maxLength != null && v.length > s.maxLength) errors.push({ path, message: `must be at most ${s.maxLength} characters` });
    if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push({ path, message: `has an invalid format` });
    if (s.format && FORMATS[s.format] && !(v === "" && s.allowEmpty) && !FORMATS[s.format](v)) errors.push({ path, message: `must be a valid ${s.format}` });
  }
  if (typeof v === "number") {
    if (s.minimum != null && v < s.minimum) errors.push({ path, message: `must be ≥ ${s.minimum}` });
    if (s.maximum != null && v > s.maximum) errors.push({ path, message: `must be ≤ ${s.maximum}` });
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) errors.push({ path, message: `needs at least ${s.minItems} items` });
    if (s.maxItems != null && v.length > s.maxItems) errors.push({ path, message: `allows at most ${s.maxItems} items` });
    if (s.items) v = v.map((x, i) => walk(s.items, x, `${path}[${i}]`, errors));
    if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push({ path, message: "must not contain duplicates" });
  }
  if (v && typeOf(v) === "object" && (s.properties || s.additionalProperties !== undefined)) {
    const out = {};
    const props = s.properties || {};
    for (const k of s.required || []) if (v[k] === undefined) errors.push({ path: `${path}.${k}`, message: "is required" });
    for (const [k, val] of Object.entries(v)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") { errors.push({ path: `${path}.${k}`, message: "is not allowed" }); continue; }
      if (props[k]) out[k] = walk(props[k], val, `${path}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push({ path: `${path}.${k}`, message: "is not a known field" });
      else if (s.additionalProperties && typeof s.additionalProperties === "object") out[k] = walk(s.additionalProperties, val, `${path}.${k}`, errors);
      else out[k] = val;
    }
    for (const [k, ps] of Object.entries(props)) if (out[k] === undefined && ps.default !== undefined && v[k] === undefined) out[k] = structuredClone(ps.default);
    return out;
  }
  return v;
}

/** Make every property optional (for PATCH bodies) and drop defaults. */
export function partial(schema) {
  const props = {};
  for (const [k, v] of Object.entries(schema.properties || {})) { const { default: _d, ...rest } = v; props[k] = rest; }
  return { ...schema, required: [], properties: props };
}

/** Strip non-standard keys for OpenAPI output. */
export function toOpenApi(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toOpenApi);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "trim" || k === "allowEmpty") continue;
    if (k === "format" && ["url-or-path", "hex-color", "slug", "full-date"].includes(v)) { out["x-format"] = v; continue; }
    out[k] = typeof v === "object" && v !== null ? (k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toOpenApi(pv)])) : toOpenApi(v)) : v;
  }
  return out;
}

/* Shared building blocks */
export const S = {
  str: (max = 500, extra = {}) => ({ type: "string", maxLength: max, ...extra }),
  slug: (extra = {}) => ({ type: "string", format: "slug", maxLength: 64, ...extra }),
  bool: (extra = {}) => ({ type: "boolean", ...extra }),
  int: (min, max, extra = {}) => ({ type: "integer", minimum: min, maximum: max, ...extra }),
  arr: (items, max = 100, extra = {}) => ({ type: "array", items, maxItems: max, ...extra }),
  obj: (properties, required = [], extra = {}) => ({ type: "object", properties, required, additionalProperties: false, ...extra }),
  link: () => ({ type: "string", format: "url-or-path", maxLength: 2000 }),
  enumOf: (values, extra = {}) => ({ type: "string", enum: values, ...extra })
};
