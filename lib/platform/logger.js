/* Structured (JSON lines) logging to stderr — Passenger/cPanel captures it in the app's stderr.log. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger(level = "info", stream = process.stderr) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const rec = { t: new Date().toISOString(), level: lvl, msg, ...fields };
    if (fields?.err instanceof Error) rec.err = { message: fields.err.message, code: fields.err.code, stack: fields.err.stack?.split("\n").slice(0, 6).join("\n") };
    try { stream.write(JSON.stringify(rec) + "\n"); } catch { /* stderr closed */ }
  };
  return {
    level,
    debug: (m, f) => write("debug", m, f), info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f), error: (m, f) => write("error", m, f)
  };
}
