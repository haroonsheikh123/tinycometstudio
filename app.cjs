/* CommonJS wrapper for hosts whose Passenger / Node selector only loads CommonJS startup files.
   cPanel → Setup Node.js App → Application startup file: app.cjs   (server.mjs works too on most hosts). */
import("./server.mjs").catch((err) => { console.error("Failed to start server.mjs:", err); process.exit(1); });
