/* Content validation (pure). Returns arrays of human-readable problems. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const RESERVED_SLUGS = ["admin", "api", "assets", "css", "js", "news", "press", "privacy", "play", "functions", "404", "index", "feed", "sitemap", "robots", "manifest", "favicon", "cdn-cgi", "fonts"];
const STATUSES = ["coming-soon", "in-development", "released"];
const PLATFORMS = ["android", "ios", "steam", "itch", "web"];

export function validateGames(games) {
  const errors = [];
  if (!Array.isArray(games)) return ["content/games.json must be an array"];
  const seen = new Set();
  games.forEach((g, i) => {
    const where = `games[${i}]${g && g.id ? ` (${g.id})` : ""}`;
    if (!g || typeof g !== "object") { errors.push(`${where}: must be an object`); return; }
    if (!SLUG_RE.test(g.id || "")) errors.push(`${where}: "id" must be lowercase letters, numbers and dashes`);
    if (RESERVED_SLUGS.includes(g.id)) errors.push(`${where}: "${g.id}" is a reserved path, choose another id`);
    if (seen.has(g.id)) errors.push(`${where}: duplicate id`);
    seen.add(g.id);
    if (!g.title) errors.push(`${where}: "title" is required`);
    if (!STATUSES.includes(g.status)) errors.push(`${where}: "status" must be one of ${STATUSES.join(", ")}`);
    (g.platforms || []).forEach((p) => { if (!PLATFORMS.includes(p)) errors.push(`${where}: unknown platform "${p}" (use ${PLATFORMS.join(", ")})`); });
    Object.keys(g.links || {}).forEach((k) => { if (!["android", "ios", "steam", "itch"].includes(k)) errors.push(`${where}: unknown links key "${k}"`); });
  });
  return errors;
}
export function validateSettings(s) {
  const errors = [];
  if (!s || typeof s !== "object") return ["content/settings.json must be an object"];
  if (!/^https?:\/\/[^/]+$/.test(String(s.siteUrl || "").replace(/\/+$/, ""))) errors.push('settings.siteUrl must look like "https://example.com"');
  if (!s.studioName) errors.push("settings.studioName is required");
  if (!/^[^@\s]+@[^@\s]+$/.test(s.contactEmail || "")) errors.push("settings.contactEmail must be an email address");
  return errors;
}
export function validateTeam(team) {
  if (!Array.isArray(team)) return ["content/team.json must be an array"];
  const errors = [];
  team.forEach((m, i) => { if (!m.id || !m.name) errors.push(`team[${i}]: "id" and "name" are required`); });
  if (team.filter((m) => m.featured).length > 1) errors.push('team: only one member can be "featured" (the founder card)');
  return errors;
}
