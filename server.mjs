#!/usr/bin/env node
/* Tiny Comet Studio — Node.js entry point (cPanel "Setup Node.js App" / Phusion Passenger, or any Node 18+ host).
   Startup file in cPanel: server.mjs (or app.cjs if your Passenger refuses ES modules).
   Passenger gives the app a socket through PORT / its own listen hook; locally it listens on PORT or 3000.
   Configuration: environment variables (cPanel app screen) and/or ~/tinycomet-data/.env — see .env.example. */
import "./lib/platform/polyfills.js";
import http from "node:http";
import { createApp } from "./lib/platform/node-server.js";

const app = await createApp().catch((err) => {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "startup failed", err: { message: err.message, stack: err.stack } }) + "\n");
  process.exit(1);
});
const { config, log } = app;

const server = http.createServer({ requestTimeout: 15 * 60_000, headersTimeout: 60_000, keepAliveTimeout: 5_000 }, app.handler);
server.on("clientError", (err, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); });

const passenger = typeof globalThis.PhusionPassenger !== "undefined";
const port = passenger ? "passenger" : /^\d+$/.test(String(config.port)) ? Number(config.port) : config.port; // a number, a socket path, or Passenger
server.listen(port, config.host, () => {
  log.info("listening", {
    port: passenger ? "passenger" : port, node: process.versions.node, pid: process.pid, db: app.db.driver,
    data_dir: config.dataDir, media_dir: config.mediaDir, env_files: app.envFiles, functions: app.table.routes.length + app.table.middlewares.length
  });
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info("shutting down", { signal });
  server.close();
  setTimeout(() => process.exit(0), 8000).unref();
  await app.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", { err }));
