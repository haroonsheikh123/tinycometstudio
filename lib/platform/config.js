/* Configuration for the Node.js (cPanel / Passenger) host.
   Secrets and settings come from environment variables — the cPanel "Setup Node.js App" screen sets them — plus an
   optional .env file kept OUTSIDE the web root. Real environment variables always win over the .env file.
   The names are the same as on Cloudflare (SIGNING_KEY, ENCRYPTION_KEY, SETUP_TOKEN, TURNSTILE_SECRET, …). */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Parse a .env file: KEY=value, optional quotes, # comments, `export` prefix. */
export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^"(.*)"$/s.test(v)) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    else if (/^'(.*)'$/s.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

const expandHome = (p) => (p && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
const abs = (p, base = APP_ROOT) => (p ? (isAbsolute(expandHome(p)) ? expandHome(p) : resolve(base, p)) : p);

/** Candidate .env files, first match per key wins (after real env vars). */
export function envFileCandidates(env = process.env) {
  if (env.ENV_FILE) return [abs(env.ENV_FILE)];
  const dataDir = abs(env.DATA_DIR || "~/tinycomet-data");
  return [join(dataDir, ".env"), join(APP_ROOT, ".env")];
}

/** Load .env files into a plain object merged under `base` (process.env by default). Does not mutate process.env. */
export function loadEnv(base = process.env) {
  const merged = {};
  const loaded = [];
  for (const file of envFileCandidates(base).reverse()) {
    if (!existsSync(file)) continue;
    try { Object.assign(merged, parseDotEnv(readFileSync(file, "utf8"))); loaded.push(file); } catch { /* unreadable: ignore */ }
  }
  for (const [k, v] of Object.entries(base)) if (typeof v === "string") merged[k] = v;
  return { vars: merged, files: loaded.reverse() };
}

/** Defaults that wrangler.toml [vars] provides on Cloudflare. */
export const DEFAULT_VARS = {
  PLAY_TTL_HOURS: "4",
  ALLOWED_HOSTNAMES: "",
  ENVIRONMENT: "production",
  SESSION_IDLE_MINUTES: "120",
  SESSION_MAX_HOURS: "12"
};

/** Resolved host configuration (paths are absolute). */
export function resolveConfig(vars) {
  const v = { ...DEFAULT_VARS, ...vars };
  const dataDir = abs(v.DATA_DIR || "~/tinycomet-data");
  const bool = (x, d = false) => (x == null || x === "" ? d : /^(1|true|yes|on)$/i.test(String(x)));
  const num = (x, d) => (x != null && x !== "" && Number.isFinite(Number(x)) ? Number(x) : d);
  return {
    vars: v,
    dataDir,
    publicDir: abs(v.PUBLIC_DIR || "public"),
    functionsDir: abs(v.FUNCTIONS_DIR || "functions"),
    mediaDir: abs(v.MEDIA_DIR || join(dataDir, "media"), dataDir),
    cacheDir: v.RENDER_CACHE_DIR === "off" ? null : abs(v.RENDER_CACHE_DIR || join(dataDir, "cache"), dataDir),
    db: {
      driver: (v.DB_DRIVER || "auto").toLowerCase(),
      sqliteFile: abs(v.SQLITE_FILE || join(dataDir, "site.db"), dataDir),
      url: v.DATABASE_URL || v.MYSQL_URL || "",
      mysql: { host: v.MYSQL_HOST || "localhost", port: num(v.MYSQL_PORT, 3306), user: v.MYSQL_USER || "", password: v.MYSQL_PASSWORD || "", database: v.MYSQL_DATABASE || "", socketPath: v.MYSQL_SOCKET || undefined }
    },
    port: v.PORT || "3000",
    host: v.HOST || undefined,
    trustProxy: v.TRUST_PROXY ?? "1",
    trustCloudflare: bool(v.TRUST_CLOUDFLARE),
    forceHttps: bool(v.FORCE_HTTPS),
    publicUrl: v.PUBLIC_URL || "",
    maxBodyBytes: num(v.MAX_BODY_MB, 110) * 1024 * 1024,
    renderCacheEntries: num(v.RENDER_CACHE_ENTRIES, 300),
    logLevel: (v.LOG_LEVEL || "info").toLowerCase(),
    pbkdf2Iterations: num(v.PBKDF2_ITERATIONS, 600_000)
  };
}
