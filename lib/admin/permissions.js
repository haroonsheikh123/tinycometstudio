/* Permission model: "resource:action" strings.
   - Roles (built-in or custom) hold a list of permissions, optionally scoped to specific games.
   - API keys hold scopes in the same format (plus "resource:*", "resource:write" shorthands) and/or a role.
   - Nobody can grant (to a role, user or key) anything they don't hold themselves. */

export const ACTIONS = ["read", "create", "update", "delete", "publish", "manage"];

/** Resource → actions that mean something for it (drives validation and the role matrix UI). */
export const RESOURCES = {
  games:     { label: "Games & apps", actions: ["read", "create", "update", "delete", "publish"], hint: "publish = status, web play on/off; update includes builds" },
  news:      { label: "Newsroom", actions: ["read", "create", "update", "delete", "publish"] },
  media:     { label: "Media library", actions: ["read", "create", "update", "delete"] },
  team:      { label: "Team", actions: ["read", "create", "update", "delete"] },
  pages:     { label: "Pages", actions: ["read", "create", "update", "delete"] },
  settings:  { label: "Site settings", actions: ["read", "update"] },
  messages:  { label: "Messages inbox", actions: ["read", "update", "delete"] },
  analytics: { label: "Analytics", actions: ["read", "manage"], hint: "manage = retention settings" },
  users:     { label: "Users", actions: ["read", "create", "update", "delete", "manage"], hint: "manage = suspend, reset 2FA / password, revoke sessions" },
  roles:     { label: "Roles", actions: ["read", "manage"] },
  api_keys:  { label: "API keys", actions: ["read", "create", "update", "delete", "manage"], hint: "manage = other people's keys" },
  approvals: { label: "Approval queue", actions: ["read", "manage"] },
  webhooks:  { label: "Webhooks", actions: ["read", "manage"] },
  audit:     { label: "Audit log", actions: ["read", "manage"], hint: "manage = retention / archive (owner only)" },
  cache:     { label: "Cache", actions: ["manage"] },
  system:    { label: "System", actions: ["read", "manage"], hint: "maintenance mode, API kill switch, import" }
};

export const ALL_PERMISSIONS = Object.entries(RESOURCES).flatMap(([r, { actions }]) => actions.map((a) => `${r}:${a}`));
/** Permissions only an owner can ever hold (never grantable to other roles). */
export const OWNER_ONLY = ["audit:manage"];

const pick = (res, acts) => acts.filter((a) => RESOURCES[res].actions.includes(a)).map((a) => `${res}:${a}`);
const allOf = (res) => pick(res, RESOURCES[res].actions);
const readAll = (...res) => res.flatMap((r) => pick(r, ["read"]));

export const BUILTIN_ROLES = {
  owner: { name: "Owner", permissions: ["*"] },
  admin: { name: "Admin", permissions: ALL_PERMISSIONS.filter((p) => !OWNER_ONLY.includes(p)) },
  editor: {
    name: "Editor",
    permissions: [...pick("games", ["read", "update", "publish"]), ...allOf("news"), ...allOf("media"), ...allOf("team"),
      ...allOf("pages"), "settings:read", "messages:read", "messages:update", "analytics:read", "cache:manage"]
  },
  analyst: { name: "Marketing / Analyst", permissions: [...readAll("games", "news", "media", "team", "pages", "settings", "messages", "analytics")] },
  developer: {
    name: "Developer",
    permissions: [...allOf("games"), ...allOf("media"), "news:read", "team:read", "pages:read", "settings:read", "analytics:read",
      "api_keys:read", "api_keys:create", "api_keys:update", "api_keys:delete", "webhooks:read", "webhooks:manage", "cache:manage", "system:read", "approvals:read"]
  },
  viewer: { name: "Viewer", permissions: readAll("games", "news", "media", "team", "pages", "settings", "analytics") }
};

/** Expand shorthands: "*" stays, "games:*" → all game actions, "games:write" → create/update/delete. Unknown → dropped. */
export function expand(perms) {
  const out = new Set();
  for (const raw of perms || []) {
    const p = String(raw).trim();
    if (p === "*") { out.add("*"); continue; }
    const [res, act] = p.split(":");
    if (!RESOURCES[res]) continue;
    if (act === "*") RESOURCES[res].actions.forEach((a) => out.add(`${res}:${a}`));
    else if (act === "write") ["create", "update", "delete"].filter((a) => RESOURCES[res].actions.includes(a)).forEach((a) => out.add(`${res}:${a}`));
    else if (RESOURCES[res].actions.includes(act)) out.add(`${res}:${act}`);
  }
  return out;
}
/** Returns problems for a list of permission strings (unknown resource/action). */
export function invalidPermissions(perms, { allowStar = false } = {}) {
  return (perms || []).filter((raw) => {
    const p = String(raw);
    if (p === "*") return !allowStar;
    const [res, act] = p.split(":");
    return !RESOURCES[res] || !(act === "*" || act === "write" || RESOURCES[res].actions.includes(act));
  });
}

/** A principal's effective access: { all: boolean, perms: Set, gameScope: null|string[] } */
export function grant(perms, gameScope = null) {
  const set = expand(perms);
  return { all: set.has("*"), perms: set, gameScope: Array.isArray(gameScope) && gameScope.length ? [...gameScope] : null };
}
export const rolePermissions = (role) => (role?.builtin && BUILTIN_ROLES[role.id] ? BUILTIN_ROLES[role.id].permissions : role?.permissions || []);
export const roleGrant = (role) => grant(rolePermissions(role), role?.builtin ? null : role?.game_scope);

/** Intersection of two grants (used for API keys: key scopes ∩ creator's current access). */
export function intersect(a, b) {
  if (a.all && b.all) return { all: true, perms: new Set(["*"]), gameScope: scopeIntersect(a.gameScope, b.gameScope) };
  const base = a.all ? b.perms : b.all ? a.perms : new Set([...a.perms].filter((p) => b.perms.has(p)));
  const perms = new Set([...base].filter((p) => p !== "*"));
  return { all: false, perms, gameScope: scopeIntersect(a.gameScope, b.gameScope) };
}
function scopeIntersect(x, y) {
  if (!x) return y ? [...y] : null;
  if (!y) return [...x];
  return x.filter((g) => y.includes(g));
}

/**
 * Can `g` do `perm`? For game-scoped grants pass { gameId } — a scoped grant can only act on those games,
 * and can't create new games (unless … never: creation is unscoped by definition).
 */
export function can(g, perm, { gameId } = {}) {
  if (!g) return false;
  if (g.all) return true;
  if (!g.perms.has(perm)) return false;
  if (g.gameScope && perm.startsWith("games:")) {
    if (perm === "games:read") return true;            // reading the catalogue is fine
    if (perm === "games:create") return false;         // scoped roles can't add games
    if (!gameId || !g.gameScope.includes(gameId)) return false;
  }
  return true;
}

/**
 * May `actor` grant `target` (a set of permissions + optional game scope)?
 * Returns the list of permissions the actor lacks ([] = allowed).
 */
export function missingForGrant(actor, perms, gameScope = null) {
  const wanted = expand(perms);
  if (actor.all) return [];
  const missing = [];
  if (wanted.has("*")) missing.push("*");
  for (const p of wanted) if (p !== "*" && !actor.perms.has(p)) missing.push(p);
  for (const p of wanted) if (OWNER_ONLY.includes(p)) missing.push(p);
  if (actor.gameScope) {
    const scope = Array.isArray(gameScope) && gameScope.length ? gameScope : null;
    if (!scope && [...wanted].some((p) => p.startsWith("games:") && p !== "games:read")) missing.push("game_scope:all");
    if (scope) for (const id of scope) if (!actor.gameScope.includes(id)) missing.push(`game_scope:${id}`);
  }
  return [...new Set(missing)];
}
/** Is grant `a` ⊆ grant `b`? (b can do everything a can) */
export const isSubset = (a, b) => missingForGrant(b, a.all ? ["*"] : [...a.perms], a.gameScope).length === 0;

export const toList = (g) => (g.all ? ["*"] : [...g.perms].sort());
