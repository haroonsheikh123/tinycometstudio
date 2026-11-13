/* OpenAPI 3.1 generated from the route table (lib/admin/routes/*) — same schemas that validate requests. */
import { toOpenApi } from "./schema.js";

const ERR = { $ref: "#/components/schemas/Error" };
export function buildOpenApi(routes, { origin = "https://tinycometstudio.com", version = "1.0.0" } = {}) {
  const paths = {};
  const tags = new Set();
  for (const r of routes) {
    const p = (paths[r.path] ||= {});
    tags.add(r.tag);
    const params = r.keys.map((k) => ({ name: k, in: "path", required: true, schema: { type: "string" } }));
    if (r.query) for (const [name, s] of Object.entries(r.query.properties || {})) params.push({ name, in: "query", required: false, schema: toOpenApi(s), ...(s.description ? { description: s.description } : {}) });
    const headerParams = [];
    if (r.write) {
      if (r.dryRun !== false) headerParams.push({ name: "X-Dry-Run", in: "header", required: false, schema: { type: "string", enum: ["true", "false"] }, description: "Preview: validate and return the would-be field diff without changing anything (still audited as dry_run)." });
      headerParams.push({ name: "X-Change-Reason", in: "header", required: false, schema: { type: "string", maxLength: 1000 }, description: "Why — stored in the audit log." });
      if (r.method === "POST") headerParams.push({ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 200 }, description: "Safe retries: the same key + body returns the first response for 24 h." });
      if (r.method === "PATCH" || r.method === "PUT" || r.method === "DELETE") headerParams.push({ name: "If-Match", in: "header", required: false, schema: { type: "string" }, description: 'Optimistic concurrency: the ETag from GET ("v<version>"). 412 if it changed.' });
    }
    headerParams.push({ name: "X-Agent-Name", in: "header", required: false, schema: { type: "string", maxLength: 80 }, description: "Name of the calling agent/app (recorded as the audit source)." });
    const perms = typeof r.perm === "string" ? [r.perm] : r.perm ? ["(depends on the fields sent — see description)"] : [];
    const notes = [
      perms.length ? `**Permission:** \`${perms.join("`, `")}\`` : null,
      r.ownerOnly ? "**Owner only.**" : null,
      r.stepUp ? "**Step-up:** cookie sessions must have confirmed a TOTP code in the last 10 min (POST /auth/step-up)." : null,
      r.auth === "session" ? "**Cookie session only** (not available to API keys)." : null,
      r.destructive && r.write && r.approvable !== false && !r.rawBody ? "Queued for human approval (202) when the API key has `require_approval`." : null
    ].filter(Boolean).join("\n\n");
    const op = {
      operationId: r.op, tags: [r.tag], summary: r.summary, ...(notes ? { description: notes } : {}),
      "x-permission": typeof r.perm === "string" ? r.perm : r.perm ? "dynamic" : null, "x-step-up": !!r.stepUp, "x-destructive": !!r.destructive,
      parameters: [...params, ...headerParams],
      security: r.auth === "public" || r.auth === "mfa" ? [{}] : r.auth === "session" ? [{ session: [] }] : [{ bearer: [] }, { session: [] }],
      responses: {
        [r.method === "POST" && /create|invite|upload|receive|setup/.test(r.op) ? "201" : "200"]: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } } },
        ...(r.destructive && r.write ? { 202: { description: "Queued for approval", content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } } } } : {}),
        400: { description: "Validation failed", content: { "application/json": { schema: ERR } } },
        401: { description: "Not signed in / invalid key", content: { "application/json": { schema: ERR } } },
        403: { description: "Forbidden / step-up required / CSRF", content: { "application/json": { schema: ERR } } },
        ...(r.keys.length ? { 404: { description: "Not found", content: { "application/json": { schema: ERR } } } } : {}),
        ...(r.write ? { 409: { description: "Conflict", content: { "application/json": { schema: ERR } } }, 412: { description: "If-Match / version mismatch", content: { "application/json": { schema: ERR } } } } : {}),
        429: { description: "Rate limited (see RateLimit-* and Retry-After headers)", content: { "application/json": { schema: ERR } } },
        503: { description: "Kill switch on / not configured", content: { "application/json": { schema: ERR } } }
      }
    };
    if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: toOpenApi(r.body) } } };
    if (r.rawBody && r.op !== "analytics.collect") op.requestBody = { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } }, "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } } };
    p[r.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Tiny Comet Studio Control API", version,
      description: "Everything the admin panel can do, as a versioned REST API for apps and cloud agents. JSON in/out; responses are `{ data, meta? }`, errors `{ error: { code, message, details?, request_id } }`. Lists use opaque cursors (`meta.next_cursor`). Every write is recorded in a tamper-evident audit log with field-level diffs.",
      contact: { name: "Tiny Comet Studio", url: origin }
    },
    servers: [{ url: `${origin}/api/v1` }],
    tags: [...tags].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", bearerFormat: "tck_<id>_<secret>", description: "API key from Admin › API keys. Scopes, IP allowlist, expiry, rate limit and environments are enforced per key." },
        session: { type: "apiKey", in: "cookie", name: "__Host-tc_session", description: "Admin session (email + password + authenticator code). Unsafe methods also need the X-CSRF-Token header from GET /auth/session." }
      },
      schemas: {
        Envelope: { type: "object", properties: { data: {}, meta: { type: "object", properties: { next_cursor: { type: ["string", "null"] }, dry_run: { type: "boolean" }, would_change: { type: "array" } } } }, required: ["data"] },
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {}, request_id: { type: "string" } }, required: ["code", "message"] } }, required: ["error"] }
      }
    }
  };
}
