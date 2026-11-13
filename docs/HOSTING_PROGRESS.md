# cPanel / Node.js hosting — progress log

Goal: run the whole site (public pages, web-play gate, admin, `/api/v1`, DB, media) on cPanel shared hosting
("Setup Node.js App" = Phusion Passenger), while keeping Cloudflare Pages + D1 + R2 working. Adapter layer, not a rewrite.

Branch: `admin-panel` (PR #1 → `main`). Never touch `main`, no force-push.

## Plan / status
- [x] Read code, baseline `npm test` (58/59 — one date-dependent sitemap assertion; fixed in the test)
- [x] Platform layer `lib/platform/`: config + `.env`, Node 18 polyfills, SQLite (node:sqlite) adapter, migration runner
- [x] MySQL/MariaDB adapter (mysql2) + SQLite→MySQL SQL translation + `migrations/mysql/`
- [x] Local-disk R2 replacement (FsBucket), render cache (LRU + file), client IP parsing
- [x] `server.mjs` (+ `app.cjs` wrapper): Pages-Functions router, static server (`_headers`, `_redirects`, `_routes.json`,
      gzip/br, ETag/304, Range), body limits, structured logs
- [x] Shared-code touch-ups (both platforms): render cache interface, client IP, Range for builds/media, PBKDF2 per-hash iterations
- [x] Tools: migrate / seed / tick / backup / cpanel-setup / deploy.sh; `.env.example`; opt-in GitHub Actions deploy
- [x] Tests: node adapter, storage, cache purge, client IP, MySQL translation; full suite on SQLite + MariaDB
- [x] E2E admin flow + play gate against `node server.mjs`, screenshots, Lighthouse, Node 18 run
- [x] Docs: `docs/DEPLOY_CPANEL.md`, README, ADMIN.md note

## Results
- `npm test` 84/84: Node 22.23 on SQLite, MariaDB 10.11, MySQL 8.4 (docker, binlog on); Node 18.20.8 on MariaDB;
  with the R2 mock and with FsBucket (`TEST_STORAGE=fs`).
- MySQL 8 with binary logging and no SUPER: CREATE TRIGGER is refused → migration warns, app keeps working (test adapts).
- E2E `tests/e2e/admin-flow.mjs` 35/35 against `node server.mjs` (Node 22 + SQLite, port 47913) and against
  `node app.cjs` on Node 18.20.8 + MariaDB (port 39217).
- E2E `tests/e2e/node-host-check.mjs` 9/9: real Turnstile widget + siteverify with test keys, play cookie, game assets,
  session survives a restart onto another port; screenshots in /home/user/tiny-comet-hosting-screenshots/.
- Passenger simulation: unix-socket PORT + `!~Passenger-Client-Address`/`!~Passenger-Proto` → right IP/scheme in the audit log.
- Lighthouse 12.6 (mobile) vs node server: / 99/100/100/100 (FCP 1.0 s, LCP 1.8 s, TBT 80 ms, CLS 0, TTFB 60 ms);
  /project-nova/ 99/100/100/100; /news/hello-world/ 100/100/100/100.
- Throughput (1 core, 10 concurrent, keep-alive): / ~870 req/s p50 10 ms; css ~2600 req/s.
- Cloudflare path still builds (`wrangler pages functions build`, no node: imports) and serves under `wrangler pages dev`.

## Environment notes (this sandbox)
- Node 22.23 (node:sqlite available). Node 18.20.8 via `npx -p node@18`.
- MariaDB 10.11 installed from apt; start with `mkdir -p /run/mysqld && chown mysql:mysql /run/mysqld && mysqld_safe &`.
  Test user `tc`/`tcpass`, may create databases named `tinycomet%`.
- MySQL 8.4: `dockerd &` then `docker start mysql8` (port 3307, same user; `SET GLOBAL log_bin_trust_function_creators=1` for triggers).

## Resume
`git checkout admin-panel && npm test` (SQLite) · `TEST_DB_DRIVER=mysql MYSQL_URL=mysql://tc:tcpass@127.0.0.1/tinycomet_test npm test` (MariaDB)
