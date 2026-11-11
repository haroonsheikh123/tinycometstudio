import { h, api, pageHead, input, copyBtn } from "../ui.js";

export default async function apidocs() {
  const spec = await (await fetch("/api/v1/openapi.json", { credentials: "same-origin" })).json();
  const origin = location.origin;
  const ops = Object.entries(spec.paths).flatMap(([path, m]) => Object.entries(m).map(([method, op]) => ({ path, method: method.toUpperCase(), op })));
  const tags = [...new Set(ops.map((o) => o.op.tags[0]))];
  const list = h("div");
  const curl = (o) => {
    const body = o.op.requestBody?.content?.["application/json"]?.schema;
    const ex = body?.properties ? Object.fromEntries(Object.entries(body.properties).filter(([k]) => (body.required || []).includes(k)).map(([k, s]) => [k, s.enum?.[0] ?? (s.type === "boolean" ? true : s.type === "integer" ? 1 : s.type === "array" ? [] : `<${k}>`)])) : null;
    return `curl -X ${o.method} "${origin}/api/v1${o.path}" \\\n  -H "Authorization: Bearer $TC_API_KEY" \\\n  -H "X-Agent-Name: my-agent"${ex ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(ex)}'` : ""}`;
  };
  const render = (q = "") => {
    const qq = q.toLowerCase();
    list.replaceChildren(...tags.map((t) => {
      const items = ops.filter((o) => o.op.tags[0] === t && (!qq || `${o.method} ${o.path} ${o.op.summary} ${o.op["x-permission"]}`.toLowerCase().includes(qq)));
      return items.length ? h("section", { style: { marginBottom: "18px" } }, h("h2", null, t), items.map((o) => h("details", { class: "endpoint" },
        h("summary", null, h("span", { class: `method method--${o.method}` }, o.method), h("code", null, o.path), h("span", { class: "muted small" }, o.op.summary), o.op["x-permission"] && o.op["x-permission"] !== "dynamic" ? h("span", { class: "chip", style: { marginLeft: "auto" } }, o.op["x-permission"]) : null),
        h("div", { class: "body" }, o.op.description ? h("p", { class: "small" }, o.op.description.replace(/\*\*/g, "").replace(/`/g, "")) : null,
          o.op.parameters.filter((p) => p.in !== "header").length ? h("div", null, h("b", { class: "small" }, "Parameters: "), o.op.parameters.filter((p) => p.in !== "header").map((p) => h("span", { class: "chip", style: { margin: "2px" } }, `${p.name} (${p.in})`))) : null,
          o.op.requestBody?.content?.["application/json"] ? h("details", null, h("summary", { class: "small" }, "Request body schema"), h("pre", { class: "json" }, JSON.stringify(o.op.requestBody.content["application/json"].schema, null, 2))) : null,
          h("div", { class: "row row--between" }, h("b", { class: "small" }, "Example"), copyBtn(curl(o))), h("pre", { class: "json" }, curl(o)))))) : null;
    }).filter(Boolean));
  };
  render();
  return h("div", null, pageHead("API docs", `${ops.length} endpoints — the same API this panel uses. Machine-readable: /api/v1/openapi.json`, h("a", { class: "btn", href: "/api/v1/openapi.json", target: "_blank", rel: "noopener" }, "openapi.json")),
    h("div", { class: "card", style: { marginBottom: "16px" } }, h("h2", null, "Quick start for agents"), h("pre", { class: "json" }, `export TC_API_KEY=tck_…            # Admin › API keys\ncurl -H "Authorization: Bearer $TC_API_KEY" ${origin}/api/v1/auth/session\n# Preview any write first:\ncurl -X PATCH ${origin}/api/v1/games/project-nova -H "Authorization: Bearer $TC_API_KEY" \\\n  -H "X-Dry-Run: true" -H "X-Change-Reason: tagline refresh" -H "Content-Type: application/json" \\\n  -d '{"tagline":"A tiny comet, a very big sky."}'`),
      h("p", { class: "small muted" }, "Envelope { data, meta } · errors { error: { code, message, details, request_id } } · cursor pagination (meta.next_cursor) · Idempotency-Key on POST · If-Match on updates · every write is audited.")),
    h("div", { class: "toolbar" }, input("q", "", { type: "search", placeholder: "Filter endpoints…", "aria-label": "Filter endpoints", oninput: (e) => render(e.target.value) })), list);
}
