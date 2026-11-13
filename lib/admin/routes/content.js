/* Content: games, news, team, pages, settings — CRUD, publish/schedule, ordering, revisions & restore,
   per-resource history, export to repo files, import. Every save writes a revision + an audit entry with a field diff. */
import { route, reply } from "../router.js";
import { S, validate } from "../schema.js";
import { ApiError, notFound, forbidden } from "../http.js";
import { Tx } from "../tx.js";
import { diff } from "../audit.js";
import { can } from "../permissions.js";
import { j, gameFromRow, memberFromRow, newsFromRow, pageFromRow, exportFiles, parseFiles, nextPublishStmt } from "../content.js";
import { validateGames, validateSettings, validateTeam, RESERVED_SLUGS, markdownToHtml, markdownToText, parseFrontMatter } from "../../../tools/render/index.mjs";
import { paginate, sortBy, checkIfMatch, etag, merge, iso, parseTime, revisionsFor, revisionData, historyFor } from "./_util.js";

/* ---------------------------------------------------------------- schemas */
const PLATFORMS = ["android", "ios", "steam", "itch", "web"];
const link = S.link;
const paragraphs = { oneOf: [S.str(8000), S.arr(S.str(8000), 30)] };
export const gameSchema = S.obj({
  id: S.slug(), placeholder: S.bool(), title: S.str(120, { minLength: 1 }), tagline: S.str(200), kind: S.enumOf(["Game", "App"]),
  status: S.enumOf(["coming-soon", "in-development", "released"]),
  platforms: S.arr(S.enumOf(PLATFORMS), 5, { uniqueItems: true }), genres: S.arr(S.str(40), 12),
  colors: S.arr({ type: "string", format: "hex-color" }, 2), releaseDate: { type: "string", format: "date", allowEmpty: true, maxLength: 10 },
  description: paragraphs,
  links: S.obj({ android: link(), ios: link(), steam: link(), itch: link() }),
  webPlay: S.obj({ enabled: S.bool() }), cover: link(),
  screenshots: S.arr({ oneOf: [link(), S.obj({ src: link(), alt: S.str(300) }, ["src"])] }, 30),
  trailer: link(), pressKitUrl: link()
}, ["id", "title", "status"]);
export const memberSchema = S.obj({
  id: S.slug(), name: S.str(100, { minLength: 1 }), role: S.str(100), featured: S.bool(), placeholder: S.bool(), photo: link(), bio: paragraphs,
  links: S.arr(S.obj({ label: S.str(40, { minLength: 1 }), url: link() }, ["label", "url"]), 20)
}, ["id", "name"]);
export const newsSchema = S.obj({
  slug: S.slug(), title: S.str(200, { minLength: 1 }), date: { type: "string", format: "full-date" }, updated: { type: "string", format: "full-date", allowEmpty: true },
  category: S.str(40), game: { type: "string", maxLength: 64, pattern: "^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)?$" }, author: { type: "string", maxLength: 64, pattern: "^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)?$" },
  excerpt: S.str(400), cover: link(), placeholder: S.bool(), body: S.str(200_000),
  status: S.enumOf(["draft", "scheduled", "published"]), publish_at: { type: ["string", "null"], format: "date-time" }
}, ["title"]);
const pageSchema = S.obj({ slug: S.slug(), title: S.str(200, { minLength: 1 }), source: S.str(200_000, { minLength: 1 }) }, ["slug", "source"]);
const settingsSchema = {
  type: "object", additionalProperties: true, properties: {
    studioName: S.str(100, { minLength: 1 }), shortName: S.str(40), siteUrl: { type: "string", format: "uri", maxLength: 200 }, tagline: S.str(200), description: S.str(500),
    country: S.str(60), contactEmail: { type: "string", format: "email", maxLength: 254 }, pressEmail: { type: "string", format: "email", maxLength: 254, allowEmpty: true },
    turnstileSiteKey: S.str(100), analyticsEndpoint: { type: "string", maxLength: 200, pattern: "^(|/[^\\s]*|https://[^\\s]+)$" },
    socials: S.arr(S.obj({ id: S.str(30), label: S.str(60), url: link() }, ["id", "url"]), 30),
    hero: { type: "object", properties: { eyebrow: S.str(200), titleLine1: S.str(100), titleLine2: S.str(100), lead: S.str(1000) }, additionalProperties: false },
    about: { type: "object", properties: { title: S.str(200), lead: S.str(1000), paragraphs: S.arr(S.str(4000), 20) }, additionalProperties: false },
    expertise: S.arr(S.obj({ icon: S.str(30), title: S.str(100), text: S.str(400) }), 12),
    press: { type: "object", additionalProperties: true },
    seo: { type: "object", additionalProperties: true, description: "SEO defaults (free-form): e.g. ogImage, keywords" }
  }
};

const v = (schema, obj, what) => {
  const { value, errors } = validate(schema, obj, what);
  if (errors.length) throw new ApiError(400, "validation_failed", `Invalid ${what}: ${errors[0].path.replace(/^\w+\.?/, "")} ${errors[0].message}`, errors);
  return value;
};
const readQuery = S.obj({ q: S.str(100), status: S.str(20), category: S.str(40), game: S.str(64), include_deleted: S.bool(), sort: S.str(30), limit: S.int(1, 200), cursor: S.str(200) });
const today = (now) => new Date(now).toISOString().slice(0, 10);

/* ---------------------------------------------------------------- generic save */
async function save(ctx, cfg, { id, row, before, after, action, event, eventData, creating = false, deleting = false, restoring = false, label, extra }) {
  const changes = deleting ? [{ path: "deleted", op: "changed", old: false, new: true }] : restoring ? [{ path: "deleted", op: "changed", old: true, new: false }, ...diff(before, after)] : diff(creating ? {} : before, after);
  if (!changes.length) return { unchanged: true };
  const version = creating ? 1 : row.version + 1;
  const tx = new Tx(ctx);
  if (!creating) tx.guard(`SELECT 1 FROM ${cfg.table} WHERE ${cfg.key} = ? AND version = ?`, [id, row.version]);
  cfg.write(tx, after, { creating, deleting, restoring, version, row, id, now: ctx.now });
  const auditId = tx.audit({ action, resourceType: cfg.type, resourceId: id, label: label || cfg.label(after || before), before: creating ? undefined : before, after: deleting ? undefined : after, changes, ...(extra || {}) });
  tx.run("INSERT INTO revisions (resource_type, resource_id, version, data, deleted, created_at, actor, audit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    cfg.type, id, version, JSON.stringify(after || before), deleting ? 1 : 0, ctx.now, ctx.actor.name || ctx.actor.type, auditId);
  if (event) tx.event(event, eventData || { id, label: cfg.label(after || before), changes: changes.map((c) => c.path) });
  tx.content(cfg.paths(after || before, before));
  if (cfg.afterWrite) cfg.afterWrite(tx, ctx);
  await tx.commit();
  return { version, changes };
}

/* ---------------------------------------------------------------- games & team (id + position + JSON data) */
function positional(cfg) {
  const T = cfg.tag, R = cfg.resource;
  const load = async (db, id, withDeleted = false) => {
    const row = await db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?${withDeleted ? "" : " AND deleted_at IS NULL"}`).bind(id).first();
    if (!row) throw notFound(cfg.label0);
    return { row, obj: cfg.fromRow(row) };
  };
  const out = (row, obj) => ({ ...obj, _meta: { version: row.version, position: row.position, created_at: iso(row.created_at), updated_at: iso(row.updated_at), updated_by: row.updated_by, deleted_at: iso(row.deleted_at) } });
  cfg.load = load;
  cfg.out = out;

  route({
    method: "GET", path: `/${cfg.plural}`, op: `${R}.list`, tag: T, perm: `${R}:read`, resource: cfg.type, summary: `List ${cfg.plural} (ordered as on the site).`, query: readQuery,
    handler: async (ctx, { query }) => {
      const { results } = await ctx.env.DB.prepare(`SELECT * FROM ${cfg.table} ${query.include_deleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY position, id`).all();
      let items = results.map((r) => out(r, cfg.fromRow(r)));
      if (query.status) items = items.filter((x) => x.status === query.status);
      if (query.q) { const q = query.q.toLowerCase(); items = items.filter((x) => JSON.stringify(x).toLowerCase().includes(q)); }
      items = sortBy(items, query.sort, cfg.sortable, null);
      const { page, meta } = paginate(items, query);
      return reply(page, { meta });
    }
  });
  route({
    method: "GET", path: `/${cfg.plural}/{id}`, op: `${R}.get`, tag: T, perm: `${R}:read`, resource: cfg.type, summary: `Get one ${cfg.type} (ETag = version).`,
    handler: async (ctx, { params }) => { const { row, obj } = await load(ctx.env.DB, params.id, true); ctx.etag = etag(row.version); return out(row, obj); }
  });
  route({
    method: "POST", path: `/${cfg.plural}`, op: `${R}.create`, tag: T, perm: cfg.createPerm || `${R}:create`, resource: cfg.type, summary: `Create a ${cfg.type}.`, body: cfg.schema,
    handler: async (ctx, { body }) => {
      const db = ctx.env.DB;
      const obj = await cfg.check(ctx, body, null);
      const ex = await db.prepare(`SELECT deleted_at FROM ${cfg.table} WHERE id = ?`).bind(obj.id).first();
      if (ex) throw new ApiError(409, "conflict", ex.deleted_at ? `"${obj.id}" exists in the trash — restore it instead` : `"${obj.id}" already exists`);
      const pos = await db.prepare(`SELECT MIN(position) AS lo, MAX(position) AS hi FROM ${cfg.table}`).first();
      obj.__position = cfg.addToTop ? (pos.lo ?? 1) - 1 : (pos.hi ?? -1) + 1;
      const { __position, ...clean } = obj;
      await save(ctx, { ...cfg, write: (tx, o, m) => cfg.write(tx, o, { ...m, position: __position }) }, { id: obj.id, after: clean, action: `${cfg.type}.create`, event: `${cfg.type}.created`, creating: true });
      const fresh = await load(db, obj.id).catch(() => null);
      return reply(fresh ? out(fresh.row, fresh.obj) : clean, { status: 201 });
    }
  });
  route({
    method: "PATCH", path: `/${cfg.plural}/{id}`, op: `${R}.update`, tag: T, resource: cfg.type, gameParam: cfg.type === "game" ? "id" : undefined,
    perm: (ctx, { body }) => [`${R}:update`, ...(cfg.publishFields || []).some((f) => body?.[f] !== undefined) ? [`${R}:publish`] : []],
    summary: `Partial update (deep merge for objects; arrays replace). Send If-Match: "v<version>" for optimistic concurrency.${cfg.publishFields ? ` Changing ${cfg.publishFields.join("/")} also needs ${R}:publish.` : ""}`,
    body: { ...cfg.schema, required: [] },
    handler: async (ctx, { params, body }) => {
      const { row, obj } = await load(ctx.env.DB, params.id);
      checkIfMatch(ctx, row.version);
      if (body.id && body.id !== params.id) throw new ApiError(400, "validation_failed", "id can't be changed");
      const after = await cfg.check(ctx, merge(obj, body), obj);
      const r = await save(ctx, cfg, { id: params.id, row, before: obj, after, action: `${cfg.type}.update`, event: `${cfg.type}.updated` });
      if (cfg.publishFields?.some((f) => body[f] !== undefined && JSON.stringify(body[f]) !== JSON.stringify(obj[f])) && !r.unchanged && !ctx.dryRun) {
        /* published-state change also announced */
      }
      if (ctx.dryRun) return { ...after, _meta: { version: row.version } };
      const fresh = await load(ctx.env.DB, params.id);
      ctx.etag = etag(fresh.row.version);
      return out(fresh.row, fresh.obj);
    }
  });
  route({
    method: "DELETE", path: `/${cfg.plural}/{id}`, op: `${R}.delete`, tag: T, perm: `${R}:delete`, resource: cfg.type, gameParam: cfg.type === "game" ? "id" : undefined,
    summary: `Move a ${cfg.type} to the trash (restorable; its pages disappear from the site).`,
    handler: async (ctx, { params }) => {
      const { row, obj } = await load(ctx.env.DB, params.id);
      checkIfMatch(ctx, row.version);
      if (cfg.beforeDelete) await cfg.beforeDelete(ctx, obj);
      await save(ctx, cfg, { id: params.id, row, before: obj, after: obj, action: `${cfg.type}.delete`, event: `${cfg.type}.deleted`, deleting: true });
      return { deleted: params.id, restorable: true };
    }
  });
  route({
    method: "POST", path: `/${cfg.plural}/{id}/restore`, op: `${R}.restore`, tag: T, perm: `${R}:delete`, resource: cfg.type, gameParam: cfg.type === "game" ? "id" : undefined, destructive: false,
    summary: `Restore a ${cfg.type} from the trash.`,
    handler: async (ctx, { params }) => {
      const { row, obj } = await load(ctx.env.DB, params.id, true);
      if (!row.deleted_at) throw new ApiError(409, "conflict", "Not in the trash");
      await save(ctx, cfg, { id: params.id, row, before: obj, after: obj, action: `${cfg.type}.restore`, event: `${cfg.type}.restored`, restoring: true });
      return { restored: params.id };
    }
  });
  route({
    method: "PUT", path: `/${cfg.plural}/order`, op: `${R}.reorder`, tag: T, perm: `${R}:update`, resource: cfg.type, summary: `Set the display order (bulk: one parent audit entry + one child per moved item).`,
    body: S.obj({ ids: S.arr(S.slug(), 500, { uniqueItems: true, minItems: 1 }) }, ["ids"]),
    handler: async (ctx, { body }) => {
      const { results } = await ctx.env.DB.prepare(`SELECT id, position, version FROM ${cfg.table} WHERE deleted_at IS NULL ORDER BY position, id`).all();
      const known = results.map((r) => r.id);
      if (body.ids.length !== known.length || body.ids.some((id) => !known.includes(id))) throw new ApiError(400, "validation_failed", `ids must list every ${cfg.type} exactly once: ${known.join(", ")}`);
      if (cfg.type === "game") for (const id of body.ids) if (!can(ctx.grant, "games:update", { gameId: id }) && results.find((r) => r.id === id).position !== body.ids.indexOf(id)) throw forbidden(`Missing permission: games:update on ${id}`);
      const tx = new Tx(ctx);
      const parent = tx.audit({ action: `${cfg.type}.reorder`, resourceType: cfg.type, label: `Reorder ${cfg.plural}`, changes: [{ path: "$order", op: "changed", old: known, new: body.ids }] });
      body.ids.forEach((id, i) => {
        const r = results.find((x) => x.id === id);
        if (r.position === i) return;
        tx.run(`UPDATE ${cfg.table} SET position = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?`, i, ctx.now, ctx.actor.name, id);
        tx.audit({ parentId: parent, action: `${cfg.type}.update`, resourceType: cfg.type, resourceId: id, label: id, changes: [{ path: "position", op: "changed", old: r.position, new: i }] });
      });
      tx.content("/", "/press/");
      tx.event(`${cfg.type}.updated`, { reordered: body.ids });
      await tx.commit();
      return { order: body.ids };
    }
  });
  revisionRoutes(cfg, `/${cfg.plural}/{id}`, "id");
  return cfg;
}

function revisionRoutes(cfg, base, param) {
  const R = cfg.resource, T = cfg.tag;
  route({ method: "GET", path: `${base}/revisions`, op: `${R}.revisions`, tag: T, perm: `${R}:read`, resource: cfg.type, summary: "Saved versions (newest first).", handler: async (ctx, { params }) => revisionsFor(ctx.env.DB, cfg.type, params[param] ?? "site") });
  route({ method: "GET", path: `${base}/revisions/{version}`, op: `${R}.revision_get`, tag: T, perm: `${R}:read`, resource: cfg.type, summary: "One saved version (full snapshot).", handler: async (ctx, { params }) => revisionData(ctx.env.DB, cfg.type, params[param] ?? "site", Number(params.version)) });
  route({
    method: "POST", path: `${base}/revisions/{version}/restore`, op: `${R}.revision_restore`, tag: T, perm: `${R}:update`, resource: cfg.type, gameParam: cfg.type === "game" ? param : undefined, destructive: false,
    summary: "Restore an earlier version (creates a new version; audited as a restore with the diff).",
    handler: async (ctx, { params }) => {
      const id = params[param] ?? "site";
      const data = await revisionData(ctx.env.DB, cfg.type, id, Number(params.version));
      const { row, obj } = await cfg.load(ctx.env.DB, id, true);
      checkIfMatch(ctx, row.version);
      const after = await cfg.check(ctx, { ...data }, obj);
      const r = await save(ctx, cfg, { id, row, before: obj, after, action: `${cfg.type}.restore_version`, event: `${cfg.type}.restored`, extra: { meta: { restored_version: Number(params.version), from_version: row.version } } });
      return { restored_version: Number(params.version), new_version: r.version ?? row.version, unchanged: !!r.unchanged };
    }
  });
  route({ method: "GET", path: `${base}/history`, op: `${R}.history`, tag: T, perm: `${R}:read`, resource: cfg.type, summary: "Who changed this and when — audit entries for this resource with field diffs.", handler: async (ctx, { params }) => historyFor(ctx.env.DB, cfg.type, params[param] ?? "site") });
}

/* ---------------------------------------------------------------- games */
const reservedOrPage = async (ctx, id) => {
  if (RESERVED_SLUGS.includes(id)) throw new ApiError(400, "validation_failed", `"${id}" is a reserved path — choose another id`);
  const p = await ctx.env.DB.prepare("SELECT 1 FROM pages WHERE slug = ? AND deleted_at IS NULL").bind(id).first();
  if (p) throw new ApiError(400, "validation_failed", `"${id}" is already used by a page`);
};
export const GAMES = positional({
  type: "game", resource: "games", plural: "games", table: "games", key: "id", tag: "Games", label0: "Game", schema: gameSchema, fromRow: gameFromRow, addToTop: true,
  sortable: ["title", "status", "releaseDate", "id"], publishFields: ["status", "webPlay"],
  label: (g) => g.title,
  paths: (g, b) => [`/${g.id}/`, "/", "/press/", "/sitemap.xml", "/news/", ...(b ? [] : [])],
  async check(ctx, obj, existing) {
    const { build, _meta, ...rest } = obj;
    const val = v(gameSchema, rest, "game");
    const errs = validateGames([val]);
    if (errs.length) throw new ApiError(400, "validation_failed", errs[0].replace(/^games\[0\]( \([^)]*\))?: /, ""), errs);
    if (!existing) await reservedOrPage(ctx, val.id);
    if (existing?.build) val.build = existing.build;
    return val;
  },
  write(tx, g, { creating, deleting, restoring, version, row, id, now, position }) {
    const by = tx.ctx.actor.name;
    if (creating) tx.run("INSERT INTO games (id, position, title, status, data, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)", g.id, position ?? 0, g.title, g.status, JSON.stringify(g), now, now, by, by);
    else if (deleting) tx.run("UPDATE games SET deleted_at = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?", now, version, now, by, id);
    else tx.run("UPDATE games SET title = ?, status = ?, data = ?, deleted_at = NULL, version = ?, updated_at = ?, updated_by = ? WHERE id = ?", g.title, g.status, JSON.stringify(g), version, now, by, id);
  }
});

// Convenience endpoints agents love: one field, one call.
const gameField = (path, op, perm, field, schema, summary) => route({
  method: "PUT", path, op, tag: "Games", perm, resource: "game", gameParam: "id", summary, body: schema,
  handler: async (ctx, { params, body }) => {
    const { row, obj } = await GAMES.load(ctx.env.DB, params.id);
    checkIfMatch(ctx, row.version);
    const after = await GAMES.check(ctx, { ...obj, [field]: field === "links" ? { ...obj.links, ...body } : field === "status" ? body.status : body }, obj);
    const statusChange = field === "status" && obj.status !== after.status;
    const r = await save(ctx, GAMES, { id: params.id, row, before: obj, after, action: field === "status" ? "game.status_change" : field === "webPlay" ? "game.web_play_toggle" : "game.update", event: statusChange && after.status === "released" ? "game.published" : "game.updated" });
    return { id: params.id, [field]: after[field], version: r.version ?? row.version, unchanged: !!r.unchanged };
  }
});
gameField("/games/{id}/status", "games.set_status", "games:publish", "status", S.obj({ status: S.enumOf(["coming-soon", "in-development", "released"]) }, ["status"]), "Change release status (coming-soon / in-development / released).");
gameField("/games/{id}/web-play", "games.set_web_play", "games:publish", "webPlay", S.obj({ enabled: S.bool() }, ["enabled"]), "Turn browser play on/off (needs a build in R2 or public/<id>/play/).");
gameField("/games/{id}/links", "games.set_links", "games:update", "links", S.obj({ android: link(), ios: link(), steam: link(), itch: link() }), "Set store links (\"\" hides a badge).");

/* ---------------------------------------------------------------- team */
export const TEAM = positional({
  type: "team_member", resource: "team", plural: "team", table: "team", key: "id", tag: "Team", label0: "Team member", schema: memberSchema, fromRow: memberFromRow,
  sortable: ["name", "role", "id"], label: (m) => m.name, paths: () => ["/", "/press/"],
  async check(ctx, obj, existing) {
    const { _meta, ...rest } = obj;
    const val = v(memberSchema, rest, "team member");
    if (val.featured) {
      const others = (await ctx.env.DB.prepare("SELECT id, name, data FROM team WHERE deleted_at IS NULL AND id != ?").bind(val.id).all()).results.filter((r) => j(r.data, {}).featured);
      if (others.length) throw new ApiError(400, "validation_failed", `Only one member can be featured (the founder card) — unfeature ${others[0].name} first`);
    }
    void existing;
    return val;
  },
  async beforeDelete(ctx, m) {
    const n = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM news WHERE author = ? AND deleted_at IS NULL").bind(m.id).first();
    if (n.n) throw new ApiError(409, "conflict", `${m.name} is the author of ${n.n} post(s) — reassign them first`);
  },
  write(tx, m, { creating, deleting, version, id, now, position }) {
    const by = tx.ctx.actor.name;
    if (creating) tx.run("INSERT INTO team (id, position, name, data, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)", m.id, position ?? 0, m.name, JSON.stringify(m), now, now, by, by);
    else if (deleting) tx.run("UPDATE team SET deleted_at = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?", now, version, now, by, id);
    else tx.run("UPDATE team SET name = ?, data = ?, deleted_at = NULL, version = ?, updated_at = ?, updated_by = ? WHERE id = ?", m.name, JSON.stringify(m), version, now, by, id);
  }
});

/* ---------------------------------------------------------------- news */
const NEWS = {
  type: "news", resource: "news", table: "news", key: "slug", tag: "Newsroom", label: (n) => n.title,
  paths: (n) => [`/news/${n.slug}/`, "/news/", "/news/feed.xml", "/", "/sitemap.xml", ...(n.game ? [`/${n.game}/`] : [])],
  async load(db, slug, withDeleted = false) {
    const row = await db.prepare(`SELECT * FROM news WHERE slug = ?${withDeleted ? "" : " AND deleted_at IS NULL"}`).bind(slug).first();
    if (!row) throw notFound("Post");
    return { row, obj: newsFromRow(row) };
  },
  async check(ctx, obj, existing) {
    const { _meta, html, reading_minutes, ...rest } = obj;
    const val = v(newsSchema, rest, "post");
    val.slug = val.slug || existing?.slug;
    if (!val.slug) val.slug = val.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "post";
    const full = {
      slug: val.slug, title: val.title, status: val.status || existing?.status || "draft", publish_at: val.publish_at ?? existing?.publish_at ?? null,
      date: val.date || existing?.date || today(ctx.now), updated: val.updated ?? existing?.updated ?? "", category: val.category ?? existing?.category ?? "Update",
      game: val.game ?? existing?.game ?? "", author: val.author ?? existing?.author ?? "", excerpt: val.excerpt ?? existing?.excerpt ?? "", cover: val.cover ?? existing?.cover ?? "",
      placeholder: val.placeholder ?? existing?.placeholder ?? false, body: val.body ?? existing?.body ?? ""
    };
    if (full.status === "scheduled" && !full.publish_at) throw new ApiError(400, "validation_failed", "Scheduled posts need publish_at");
    if (full.status !== "scheduled" && full.status !== "published") full.publish_at = null;
    if (full.game && !(await ctx.env.DB.prepare("SELECT 1 FROM games WHERE id = ? AND deleted_at IS NULL").bind(full.game).first())) throw new ApiError(400, "validation_failed", `Unknown game "${full.game}"`);
    if (full.author && !(await ctx.env.DB.prepare("SELECT 1 FROM team WHERE id = ? AND deleted_at IS NULL").bind(full.author).first())) throw new ApiError(400, "validation_failed", `Unknown author "${full.author}" (use a team member id)`);
    return full;
  },
  write(tx, n, { creating, deleting, version, id, now }) {
    const by = tx.ctx.actor.name;
    const data = JSON.stringify({ excerpt: n.excerpt, cover: n.cover, updated: n.updated, placeholder: n.placeholder });
    const pub = n.publish_at ? Date.parse(n.publish_at) : null;
    if (creating) tx.run("INSERT INTO news (slug, title, status, publish_at, date, category, game, author, data, body, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)", n.slug, n.title, n.status, pub, n.date, n.category, n.game, n.author, data, n.body, now, now, by, by);
    else if (deleting) tx.run("UPDATE news SET deleted_at = ?, version = ?, updated_at = ?, updated_by = ? WHERE slug = ?", now, version, now, by, id);
    else tx.run("UPDATE news SET title = ?, status = ?, publish_at = ?, date = ?, category = ?, game = ?, author = ?, data = ?, body = ?, deleted_at = NULL, version = ?, updated_at = ?, updated_by = ? WHERE slug = ?", n.title, n.status, pub, n.date, n.category, n.game, n.author, data, n.body, version, now, by, id);
  },
  afterWrite(tx, ctx) { tx.stmts.push(nextPublishStmt(ctx.env.DB, ctx.now)); }
};
const newsOut = (row, obj) => ({ ...obj, url: `/news/${obj.slug}/`, _meta: { version: row.version, created_at: iso(row.created_at), updated_at: iso(row.updated_at), updated_by: row.updated_by, deleted_at: iso(row.deleted_at) } });

route({
  method: "GET", path: "/news", op: "news.list", tag: "Newsroom", perm: "news:read", resource: "news", summary: "List posts (filter by status, category, game; search with q).", query: readQuery,
  handler: async (ctx, { query }) => {
    const { results } = await ctx.env.DB.prepare(`SELECT * FROM news ${query.include_deleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY date DESC, created_at DESC`).all();
    let items = results.map((r) => { const o = newsOut(r, newsFromRow(r)); if (!query.q) delete o.body; return o; });
    if (query.status) items = items.filter((x) => x.status === query.status);
    if (query.category) items = items.filter((x) => x.category === query.category);
    if (query.game) items = items.filter((x) => x.game === query.game);
    if (query.q) { const q = query.q.toLowerCase(); items = items.filter((x) => `${x.title} ${x.excerpt} ${x.body}`.toLowerCase().includes(q)).map(({ body, ...x }) => x); }
    items = sortBy(items, query.sort, ["date", "title", "status", "category"], null);
    const { page, meta } = paginate(items, query);
    return reply(page, { meta });
  }
});
route({
  method: "GET", path: "/news/{slug}", op: "news.get", tag: "Newsroom", perm: "news:read", resource: "news", summary: "Get a post (Markdown body + rendered HTML preview).",
  handler: async (ctx, { params }) => { const { row, obj } = await NEWS.load(ctx.env.DB, params.slug, true); ctx.etag = etag(row.version); return { ...newsOut(row, obj), html: markdownToHtml(obj.body) }; }
});
route({
  method: "POST", path: "/news", op: "news.create", tag: "Newsroom", resource: "news", body: newsSchema,
  perm: (ctx, { body }) => ["news:create", ...(body.status && body.status !== "draft" ? ["news:publish"] : [])],
  summary: "Create a post (draft by default; status published/scheduled needs news:publish). Slug defaults from the title.",
  handler: async (ctx, { body }) => {
    const n = await NEWS.check(ctx, body, null);
    if (await ctx.env.DB.prepare("SELECT 1 FROM news WHERE slug = ?").bind(n.slug).first()) throw new ApiError(409, "conflict", `A post with slug "${n.slug}" already exists`);
    if (n.status === "scheduled" && Date.parse(n.publish_at) <= ctx.now) n.status = "published";
    await save(ctx, NEWS, { id: n.slug, after: n, action: "news.create", event: n.status === "published" ? "news.published" : "news.created", creating: true });
    if (ctx.dryRun) return n;
    const f = await NEWS.load(ctx.env.DB, n.slug);
    return reply(newsOut(f.row, f.obj), { status: 201 });
  }
});
route({
  method: "PATCH", path: "/news/{slug}", op: "news.update", tag: "Newsroom", resource: "news", body: { ...newsSchema, required: [] },
  perm: (ctx, { body }) => ["news:update", ...(body.status !== undefined || body.publish_at !== undefined ? ["news:publish"] : [])],
  summary: "Edit a post (If-Match supported). Changing status/publish_at needs news:publish.",
  handler: async (ctx, { params, body }) => {
    const { row, obj } = await NEWS.load(ctx.env.DB, params.slug);
    checkIfMatch(ctx, row.version);
    if (body.slug && body.slug !== params.slug) throw new ApiError(400, "validation_failed", "slug can't be changed (create a new post instead)");
    const after = await NEWS.check(ctx, { ...obj, ...body }, obj);
    const r = await save(ctx, NEWS, { id: params.slug, row, before: obj, after, action: "news.update", event: obj.status !== "published" && after.status === "published" ? "news.published" : "news.updated" });
    if (ctx.dryRun) return after;
    const f = await NEWS.load(ctx.env.DB, params.slug);
    ctx.etag = etag(f.row.version);
    return { ...newsOut(f.row, f.obj), unchanged: !!r.unchanged };
  }
});
route({
  method: "POST", path: "/news/{slug}/publish", op: "news.publish", tag: "Newsroom", perm: "news:publish", resource: "news",
  summary: "Publish now, or schedule with publish_at (future ISO time). Sets date to today if publishing now and keep_date is false.",
  body: S.obj({ publish_at: { type: ["string", "null"], format: "date-time" }, keep_date: S.bool({ default: true }) }),
  handler: async (ctx, { params, body }) => {
    const { row, obj } = await NEWS.load(ctx.env.DB, params.slug);
    checkIfMatch(ctx, row.version);
    const at = parseTime(body.publish_at, "publish_at");
    const future = at && at > ctx.now;
    const after = { ...obj, status: future ? "scheduled" : "published", publish_at: new Date(future ? at : ctx.now).toISOString() };
    if (future) after.date = new Date(at).toISOString().slice(0, 10);
    else if (!body.keep_date) after.date = today(ctx.now);
    const r = await save(ctx, NEWS, { id: params.slug, row, before: obj, after, action: future ? "news.schedule" : "news.publish", event: future ? "news.scheduled" : "news.published", eventData: { slug: obj.slug, title: obj.title, url: `/news/${obj.slug}/`, publish_at: after.publish_at } });
    return { slug: params.slug, status: after.status, publish_at: after.publish_at, url: `/news/${params.slug}/`, version: r.version ?? row.version, unchanged: !!r.unchanged };
  }
});
route({
  method: "POST", path: "/news/{slug}/unpublish", op: "news.unpublish", tag: "Newsroom", perm: "news:publish", resource: "news", summary: "Back to draft (removed from the site).",
  handler: async (ctx, { params }) => {
    const { row, obj } = await NEWS.load(ctx.env.DB, params.slug);
    checkIfMatch(ctx, row.version);
    const r = await save(ctx, NEWS, { id: params.slug, row, before: obj, after: { ...obj, status: "draft", publish_at: null }, action: "news.unpublish", event: "news.unpublished" });
    return { slug: params.slug, status: "draft", version: r.version ?? row.version };
  }
});
route({
  method: "DELETE", path: "/news/{slug}", op: "news.delete", tag: "Newsroom", perm: "news:delete", resource: "news", summary: "Move a post to the trash (restorable).",
  handler: async (ctx, { params }) => {
    const { row, obj } = await NEWS.load(ctx.env.DB, params.slug);
    checkIfMatch(ctx, row.version);
    await save(ctx, NEWS, { id: params.slug, row, before: obj, after: obj, action: "news.delete", event: "news.deleted", deleting: true });
    return { deleted: params.slug, restorable: true };
  }
});
route({
  method: "POST", path: "/news/{slug}/restore", op: "news.restore", tag: "Newsroom", perm: "news:delete", resource: "news", destructive: false, summary: "Restore a post from the trash.",
  handler: async (ctx, { params }) => {
    const { row, obj } = await NEWS.load(ctx.env.DB, params.slug, true);
    if (!row.deleted_at) throw new ApiError(409, "conflict", "Not in the trash");
    await save(ctx, NEWS, { id: params.slug, row, before: obj, after: obj, action: "news.restore", event: "news.restored", restoring: true });
    return { restored: params.slug };
  }
});
route({
  method: "POST", path: "/news/preview", op: "news.preview", tag: "Newsroom", perm: "news:read", resource: "news", dryRun: false, destructive: false, summary: "Render Markdown to HTML exactly as the site does (no side effects).",
  body: S.obj({ body: S.str(200_000) }, ["body"]),
  handler: async (ctx, { body }) => { const text = markdownToText(body.body); return { html: markdownToHtml(body.body), words: text ? text.split(/\s+/).length : 0, reading_minutes: Math.max(1, Math.round((text ? text.split(/\s+/).length : 0) / 200)) }; }
});
revisionRoutes(NEWS, "/news/{slug}", "slug");

/* ---------------------------------------------------------------- pages */
const PAGES = {
  type: "page", resource: "pages", table: "pages", key: "slug", tag: "Pages", label: (p) => p.title, paths: (p) => [`/${p.slug}/`, "/sitemap.xml"],
  async load(db, slug, withDeleted = false) {
    const row = await db.prepare(`SELECT * FROM pages WHERE slug = ?${withDeleted ? "" : " AND deleted_at IS NULL"}`).bind(slug).first();
    if (!row) throw notFound("Page");
    return { row, obj: pageFromRow(row) };
  },
  async check(ctx, obj) {
    const { _meta, ...rest } = obj;
    const val = v(pageSchema, { ...rest, title: rest.title || String(parseFrontMatter(rest.source || "").data.title || rest.slug || "") }, "page");
    return { slug: val.slug, title: val.title || val.slug, source: val.source };
  },
  write(tx, p, { creating, deleting, version, id, now }) {
    const by = tx.ctx.actor.name;
    if (creating) tx.run("INSERT INTO pages (slug, title, source, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?)", p.slug, p.title, p.source, now, now, by, by);
    else if (deleting) tx.run("UPDATE pages SET deleted_at = ?, version = ?, updated_at = ?, updated_by = ? WHERE slug = ?", now, version, now, by, id);
    else tx.run("UPDATE pages SET title = ?, source = ?, deleted_at = NULL, version = ?, updated_at = ?, updated_by = ? WHERE slug = ?", p.title, p.source, version, now, by, id);
  }
};
const pageOut = (row, obj) => ({ ...obj, url: `/${obj.slug}/`, _meta: { version: row.version, updated_at: iso(row.updated_at), updated_by: row.updated_by, deleted_at: iso(row.deleted_at) } });
route({ method: "GET", path: "/pages", op: "pages.list", tag: "Pages", perm: "pages:read", resource: "page", summary: "List Markdown pages (e.g. privacy).", handler: async (ctx) => (await ctx.env.DB.prepare("SELECT * FROM pages WHERE deleted_at IS NULL ORDER BY slug").all()).results.map((r) => { const o = pageOut(r, pageFromRow(r)); delete o.source; return o; }) });
route({ method: "GET", path: "/pages/{slug}", op: "pages.get", tag: "Pages", perm: "pages:read", resource: "page", summary: "Get a page (Markdown source with front-matter).", handler: async (ctx, { params }) => { const { row, obj } = await PAGES.load(ctx.env.DB, params.slug, true); ctx.etag = etag(row.version); return pageOut(row, obj); } });
route({
  method: "POST", path: "/pages", op: "pages.create", tag: "Pages", perm: "pages:create", resource: "page", body: pageSchema, summary: "Create a page served at /<slug>/.",
  handler: async (ctx, { body }) => {
    const p = await PAGES.check(ctx, body);
    if (RESERVED_SLUGS.includes(p.slug) && p.slug !== "privacy") throw new ApiError(400, "validation_failed", `"${p.slug}" is a reserved path`);
    if (await ctx.env.DB.prepare("SELECT 1 FROM games WHERE id = ?").bind(p.slug).first()) throw new ApiError(400, "validation_failed", `"${p.slug}" is used by a game`);
    if (await ctx.env.DB.prepare("SELECT 1 FROM pages WHERE slug = ?").bind(p.slug).first()) throw new ApiError(409, "conflict", `Page "${p.slug}" already exists`);
    await save(ctx, PAGES, { id: p.slug, after: p, action: "page.create", event: "page.updated", creating: true });
    return reply(p, { status: 201 });
  }
});
route({
  method: "PATCH", path: "/pages/{slug}", op: "pages.update", tag: "Pages", perm: "pages:update", resource: "page", body: S.obj({ title: S.str(200), source: S.str(200_000, { minLength: 1 }) }), summary: "Edit a page.",
  handler: async (ctx, { params, body }) => {
    const { row, obj } = await PAGES.load(ctx.env.DB, params.slug);
    checkIfMatch(ctx, row.version);
    const after = await PAGES.check(ctx, { ...obj, ...body, slug: params.slug });
    const r = await save(ctx, PAGES, { id: params.slug, row, before: obj, after, action: "page.update", event: "page.updated" });
    return { ...after, version: r.version ?? row.version, unchanged: !!r.unchanged };
  }
});
route({
  method: "DELETE", path: "/pages/{slug}", op: "pages.delete", tag: "Pages", perm: "pages:delete", resource: "page", summary: "Move a page to the trash.",
  handler: async (ctx, { params }) => { const { row, obj } = await PAGES.load(ctx.env.DB, params.slug); await save(ctx, PAGES, { id: params.slug, row, before: obj, after: obj, action: "page.delete", event: "page.updated", deleting: true }); return { deleted: params.slug }; }
});
revisionRoutes(PAGES, "/pages/{slug}", "slug");

/* ---------------------------------------------------------------- settings */
const SETTINGS = {
  type: "settings", resource: "settings", table: "settings", key: "id", tag: "Settings", label: () => "Site settings",
  paths: () => ["/", "/news/", "/press/", "/privacy/", "/sitemap.xml", "/news/feed.xml", "/robots.txt", "/manifest.webmanifest"],
  async load(db) { const row = await db.prepare("SELECT * FROM settings WHERE id = 'site'").first(); if (!row) throw notFound("Settings (seed the database first)"); return { row, obj: j(row.data, {}) }; },
  async check(ctx, obj) {
    const val = v(settingsSchema, obj, "settings");
    const errs = validateSettings(val);
    if (errs.length) throw new ApiError(400, "validation_failed", errs[0], errs);
    return val;
  },
  write(tx, s, { version, now }) { tx.run("UPDATE settings SET data = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = 'site'", JSON.stringify(s), version, now, tx.ctx.actor.name); }
};
route({
  method: "GET", path: "/settings", op: "settings.get", tag: "Settings", perm: "settings:read", resource: "settings", summary: "Site settings (social links, contact, SEO defaults, Turnstile site key…). Secrets are only reported as configured/not configured.",
  handler: async (ctx) => {
    const { row, obj } = await SETTINGS.load(ctx.env.DB);
    ctx.etag = etag(row.version);
    const e = ctx.env;
    return reply(obj, { meta: { version: row.version, updated_at: iso(row.updated_at), updated_by: row.updated_by, secrets: { TURNSTILE_SECRET: !!e.TURNSTILE_SECRET, SIGNING_KEY: !!e.SIGNING_KEY, ENCRYPTION_KEY: !!e.ENCRYPTION_KEY, SETUP_TOKEN: !!e.SETUP_TOKEN, EMAIL_WEBHOOK_URL: !!e.EMAIL_WEBHOOK_URL, CF_API_TOKEN: !!e.CF_API_TOKEN } } });
  }
});
route({
  method: "PATCH", path: "/settings", op: "settings.update", tag: "Settings", perm: "settings:update", resource: "settings", body: settingsSchema, summary: "Deep-merge settings (arrays replace).",
  handler: async (ctx, { body }) => {
    const { row, obj } = await SETTINGS.load(ctx.env.DB);
    checkIfMatch(ctx, row.version);
    const after = await SETTINGS.check(ctx, merge(obj, body));
    const r = await save(ctx, SETTINGS, { id: "site", row, before: obj, after, action: "settings.update", event: "settings.updated" });
    return reply(after, { meta: { version: r.version ?? row.version, unchanged: !!r.unchanged } });
  }
});
revisionRoutes(SETTINGS, "/settings", "id");

/* ---------------------------------------------------------------- export / import */
route({
  method: "GET", path: "/export/content", op: "content.export", tag: "Content sync", perm: "system:read", resource: "content",
  summary: "Export all content as repo files ({ files: { 'content/games.json': '…', 'content/news/…md': '…' } }) — `node tools/content-sync.mjs pull` writes them to disk.",
  handler: async (ctx) => {
    const files = await exportFiles(ctx.env.DB);
    const tx = new Tx(ctx);
    tx.audit({ action: "content.export", resourceType: "content", label: `${Object.keys(files).length} files`, meta: { files: Object.keys(files) } });
    await tx.commit();
    return { files, exported_at: iso(ctx.now) };
  }
});
route({
  method: "POST", path: "/import/content", op: "content.import", tag: "Content sync", perm: "system:manage", stepUp: true, resource: "content", maxBody: 8_000_000,
  summary: "Import repo files (same shape as the export). Upserts everything given; with prune=true also trashes games/posts/members not in the bundle. One parent audit entry + a child per changed item.",
  body: S.obj({ files: { type: "object", additionalProperties: { type: "string", maxLength: 1_000_000 } }, prune: S.bool({ default: false }) }, ["files"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    let parsed;
    try { parsed = parseFiles(body.files); } catch (e) { throw new ApiError(400, "validation_failed", `Could not parse files: ${e.message}`); }
    const errs = [...(parsed.settings ? validateSettings(parsed.settings) : []), ...(parsed.games ? validateGames(parsed.games) : []), ...(parsed.team ? validateTeam(parsed.team) : [])];
    if (errs.length) throw new ApiError(400, "validation_failed", errs[0], errs);
    const tx = new Tx(ctx);
    const parent = tx.audit({ action: "content.import", resourceType: "content", label: `Import ${Object.keys(body.files).length} files`, meta: { files: Object.keys(body.files), prune: body.prune } });
    const by = ctx.actor.name, now = ctx.now;
    let changed = 0;
    const child = (type, id, label, before, after, deleting = false) => {
      const changes = deleting ? [{ path: "deleted", op: "changed", old: false, new: true }] : diff(before || {}, after);
      if (!changes.length) return false;
      const aid = tx.audit({ parentId: parent, action: `${type}.${deleting ? "delete" : before ? "update" : "create"}`, resourceType: type, resourceId: id, label, before, after: deleting ? undefined : after, changes });
      // INSERT … SELECT (not a sub-select inside VALUES) so the same SQL also runs on MySQL/MariaDB.
      tx.run("INSERT INTO revisions (resource_type, resource_id, version, data, deleted, created_at, actor, audit_id) SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ? FROM revisions WHERE resource_type = ? AND resource_id = ?", type, id, JSON.stringify(after || before), deleting ? 1 : 0, now, by, aid, type, id);
      changed++;
      return true;
    };
    if (parsed.settings) {
      const cur = await db.prepare("SELECT data FROM settings WHERE id = 'site'").first();
      if (child("settings", "site", "Site settings", j(cur?.data), parsed.settings)) tx.run("INSERT INTO settings (id, data, version, updated_at, updated_by) VALUES ('site', ?, 1, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, version = settings.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by", JSON.stringify(parsed.settings), now, by);
    }
    for (const [list, table, type, nameCol] of [[parsed.games, "games", "game", "title"], [parsed.team, "team", "team_member", "name"]]) {
      if (!list) continue;
      const { results } = await db.prepare(`SELECT * FROM ${table}`).all();
      const cur = new Map(results.map((r) => [r.id, r]));
      list.forEach((o, i) => {
        const r = cur.get(o.id);
        const before = r && !r.deleted_at ? (type === "game" ? gameFromRow(r) : memberFromRow(r)) : null;
        const keep = type === "game" && before?.build ? { ...o, build: before.build } : o;
        if (child(type, o.id, o[nameCol], before, keep) || (r && r.position !== i)) {
          tx.run(`INSERT INTO ${table} (id, position, ${nameCol}, ${type === "game" ? "status, " : ""}data, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ${type === "game" ? "?, " : ""}?, 1, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET position = excluded.position, ${nameCol} = excluded.${nameCol}, ${type === "game" ? "status = excluded.status, " : ""}data = excluded.data, deleted_at = NULL, version = ${table}.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
            ...[o.id, i, o[nameCol], ...(type === "game" ? [o.status] : []), JSON.stringify(keep), now, now, by, by]);
        }
      });
      if (body.prune) for (const r of results) if (!r.deleted_at && !list.some((o) => o.id === r.id)) { child(type, r.id, r[nameCol], type === "game" ? gameFromRow(r) : memberFromRow(r), null, true); tx.run(`UPDATE ${table} SET deleted_at = ?, version = version + 1 WHERE id = ?`, now, r.id); }
    }
    if (parsed.news.length || body.prune) {
      const { results } = await db.prepare("SELECT * FROM news").all();
      const cur = new Map(results.map((r) => [r.slug, r]));
      for (const n of parsed.news) {
        const r = cur.get(n.slug);
        const before = r && !r.deleted_at ? newsFromRow(r) : null;
        if (child("news", n.slug, n.title, before, n)) {
          tx.run(`INSERT INTO news (slug, title, status, publish_at, date, category, game, author, data, body, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
            ON CONFLICT (slug) DO UPDATE SET title = excluded.title, status = excluded.status, publish_at = excluded.publish_at, date = excluded.date, category = excluded.category, game = excluded.game, author = excluded.author, data = excluded.data, body = excluded.body, deleted_at = NULL, version = news.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
            n.slug, n.title, n.status, n.publish_at ? Date.parse(n.publish_at) : null, n.date, n.category, n.game, n.author, JSON.stringify({ excerpt: n.excerpt, cover: n.cover, updated: n.updated, placeholder: n.placeholder }), n.body, now, now, by, by);
        }
      }
      if (body.prune) for (const r of results) if (!r.deleted_at && !parsed.news.some((n) => n.slug === r.slug)) { child("news", r.slug, r.title, newsFromRow(r), null, true); tx.run("UPDATE news SET deleted_at = ?, version = version + 1 WHERE slug = ?", now, r.slug); }
    }
    for (const p of parsed.pages) {
      const r = await db.prepare("SELECT * FROM pages WHERE slug = ?").bind(p.slug).first();
      if (child("page", p.slug, p.title, r && !r.deleted_at ? pageFromRow(r) : null, p)) tx.run("INSERT INTO pages (slug, title, source, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT (slug) DO UPDATE SET title = excluded.title, source = excluded.source, deleted_at = NULL, version = pages.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by", p.slug, p.title, p.source, now, now, by, by);
    }
    tx.stmts.push(nextPublishStmt(db, now));
    tx.run("INSERT INTO site_state (key, value, updated_at) VALUES ('seeded_at', ?, ?) ON CONFLICT (key) DO NOTHING", JSON.stringify(now), now);
    tx.content("/");
    await tx.commit();
    return { changed_items: changed, dry_run: !!ctx.dryRun };
  }
});
