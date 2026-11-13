/* Shared bits for the Node-host command-line tools (migrate, seed, tick, backup, setup). */
import "../lib/platform/polyfills.js";
import { loadEnv, resolveConfig } from "../lib/platform/config.js";
import { openDatabase } from "../lib/platform/db/index.js";

export function hostConfig() {
  const { vars, files } = loadEnv();
  return { config: resolveConfig(vars), files };
}
export async function openHostDb() {
  const { config, files } = hostConfig();
  const db = await openDatabase(config.db);
  const where = db.driver === "sqlite" ? config.db.sqliteFile : "MySQL/MariaDB";
  return { db, config, files, where };
}
export const say = (...a) => console.log(...a);
export function fail(e) { console.error(`✖ ${e?.message || e}`); process.exit(1); }
