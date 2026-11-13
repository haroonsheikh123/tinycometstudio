#!/usr/bin/env node
// Housekeeping for the Node host: publish scheduled news posts, retry webhooks, delete expired rows.
// Run it from a cPanel cron job every 5 minutes (see docs/DEPLOY_CPANEL.md, "Cron"), e.g.
//   */5 * * * * cd ~/tinycomet-app && ~/nodevenv/tinycomet-app/20/bin/node tools/tick.mjs >> ~/tinycomet-data/tick.log 2>&1
// Reads the same configuration as the app (env vars + ~/tinycomet-data/.env). Same work as POST /api/v1/system/tick.
import { fail } from "./lib-host.mjs";
import { createApp } from "../lib/platform/node-server.js";
import { createLogger } from "../lib/platform/logger.js";
import { runTick } from "../lib/admin/tick.js";

try {
  const app = await createApp({ log: createLogger("warn"), noTimers: true });
  const waits = [];
  const r = await runTick(app.env, { waitUntil: (p) => waits.push(p) });
  await Promise.allSettled(waits);
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: "tick", ...r }));
  await app.close();
} catch (e) { fail(e); }
