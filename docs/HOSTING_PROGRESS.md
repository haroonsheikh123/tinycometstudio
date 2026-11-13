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
- [ ] E2E admin flow + play gate against `node server.mjs`, screenshots, Lighthouse, Node 18 run
- [ ] Docs: `docs/DEPLOY_CPANEL.md`, README

## Results so far
- `npm test`: 84/84 on SQLite (node:sqlite), MariaDB 10.11 and MySQL 8.4 (docker, binlog on), with R2 mock and FsBucket.
- MySQL 8 with binary logging and no SUPER: CREATE TRIGGER is refused → migration warns, app keeps working (test adapts).
- SMTP sender (off by default) tested against a fake SMTP server.

## Environment notes (this sandbox)
- Node 22.23 (node:sqlite available). Node 18.20.8 via `npx -p node@18`.
- MariaDB 10.11 installed from apt; start with `mkdir -p /run/mysqld && chown mysql:mysql /run/mysqld && mysqld_safe &`.
  Test user `tc`/`tcpass`, may create databases named `tinycomet%`.
- MySQL 8.4: `dockerd &` then `docker start mysql8` (port 3307, same user; `SET GLOBAL log_bin_trust_function_creators=1` for triggers).

## Resume
`git checkout admin-panel && npm test` (SQLite) · `TEST_DB_DRIVER=mysql MYSQL_URL=mysql://tc:tcpass@127.0.0.1/tinycomet_test npm test` (MariaDB)
