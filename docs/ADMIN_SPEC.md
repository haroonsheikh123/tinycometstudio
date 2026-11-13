# Tiny Comet Studio — Admin Panel + Control API spec (for admin agent)

Built ON TOP of the public site in /home/user/tiny-comet-website (Cloudflare Pages + Pages Functions; content schema in docs/CONTENT_SCHEMA.md; pure render functions in tools/render/*.mjs; analytics hook `track()` in public JS).

## Platform
- Cloudflare Pages Functions (`/functions`), D1 (SQLite) for all data, R2 for media, no npm runtime deps (Web Crypto, fetch). Migrations in `migrations/*.sql`. `wrangler.toml` with D1/R2 bindings (placeholder IDs). Seed script imports existing content/*.json + content/news/*.md into D1.
- Public pages: render from D1 via the shared render functions in Pages Functions, with edge caching (Cache API) + purge on content change; keep static generation as fallback.

## 1. Control API (MOST IMPORTANT) — the admin UI must use only this API
- Versioned REST: `/api/v1/...`, JSON, consistent envelope + error format (`{error:{code,message,details}}`), pagination (cursor), filtering, sorting, field validation, idempotency keys on POST, ETag/If-Match optimistic concurrency on updates.
- Full coverage — every action the admin UI can do, the API can do: games (CRUD, status, store links, web play on/off, build upload to R2), news (CRUD, drafts, schedule, publish/unpublish), media (upload/list/delete, signed uploads), team, pages/settings, messages inbox, analytics queries (time series, breakdowns, top lists, export CSV/JSON), users, roles, API keys, audit log, webhooks, cache purge, site maintenance mode.
- **OpenAPI 3.1 spec** at `/api/v1/openapi.json` + human docs page in admin (`/admin/api-docs`), kept in sync (generate from route definitions if possible).
- **API keys for apps / cloud agents (fully controllable):**
  - Create/name/describe keys; shown once; stored hashed (SHA-256 + prefix for lookup).
  - Granular scopes per resource+action (e.g. `games:read`, `games:write`, `news:publish`, `analytics:read`, `users:manage`, `*` only for owner), or attach a role.
  - Per-key: expiry date, IP/CIDR allowlist, rate limit (req/min), allowed environments, enable/disable toggle, revoke, rotate (grace period), last-used time/IP, usage counters.
  - Optional **dry-run mode** (`X-Dry-Run: true`) to preview changes, and optional **approval required** flag for destructive scopes (changes queued for a human admin to approve in the panel).
  - Global **kill switch**: disable all API-key access instantly.
  - Every API-key action written to the audit log (who/which key, what, before/after diff, IP, time); undo/restore for content via revision history.
- **Webhooks**: admins subscribe URLs to events (news.published, game.updated, message.received, etc.), HMAC-signed payloads, retries, delivery log.
- Security: HMAC/Bearer auth, CSRF protection for cookie sessions, strict input validation, rate limiting (D1 or KV counters), no secrets ever returned.

## 2. Authentication — NO Google sign-in / no OAuth. Username/email + password + authenticator-app code (TOTP)
- Login = email + password, then a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password, etc.). **2FA is mandatory for every admin user**, no way to skip it.
- TOTP per RFC 6238 (SHA-1, 6 digits, 30s, ±1 step window), implemented with Web Crypto, no deps. Reject reused codes (store last used time-step per user).
- Enrollment on first login / invite acceptance: show QR code (generate QR as inline SVG, zero-dependency encoder) + manual secret key; user must enter a valid code to confirm. TOTP secrets encrypted at rest (AES-GCM with `ENCRYPTION_KEY` secret).
- 10 one-time **recovery codes** shown once at enrollment (stored hashed), regenerate option.
- Passwords: PBKDF2-SHA256 (Web Crypto, ≥100k iterations, per-user salt) — or the strongest Web-Crypto-available option; min length 12, check against a small common-password list; password change & reset flows (reset by an admin issuing a one-time invite/reset link, since there may be no email service — make email sending optional/pluggable).
- Brute-force protection: per-account and per-IP rate limits + temporary lockout, Turnstile on login page after failed attempts.
- Admins can reset a child user's 2FA (forces re-enrollment) — audited.
- Sessions: HttpOnly, Secure, SameSite=Strict signed cookie, server-side session table (revocable), idle + absolute timeout, "sign out everywhere", list of active sessions/devices per user; re-ask TOTP for sensitive actions (creating API keys, changing roles, kill switch, owner transfer).
- First owner bootstrapped via a one-time setup token (env `SETUP_TOKEN`) at `/admin/setup`, which disables itself after use.
- Optional extra layer: Cloudflare Access in front of /admin (document only).
- Login audit (success/failure incl. wrong password vs wrong code, IP, country, device).

## 3. Users & roles (admin creates child users)
- Owner/admin can invite users (email + one-time invite link; they set password and enroll authenticator), set role, suspend, remove, transfer ownership (owner only).
- Built-in roles: Owner, Admin, Editor (content), Marketing/Analyst (analytics read), Developer (games/builds/API keys), Viewer.
- **Custom roles**: admin creates roles with checkbox permission matrix (resource × action: read/create/update/delete/publish/manage). Optional scoping to specific games.
- Admins can't grant permissions they don't have; owner can't be removed; at least one owner always.
- Child users can create API keys only within their own permissions.

## 4. Admin panel UI (`/admin`)
- Dashboard (visitors, top pages/games, store clicks, play starts/unlocks, latest messages, recent activity), Analytics (date range, charts, breakdowns by page/game/country/device/referrer, funnels: game view → store click / play → captcha pass, real-time), Games, Newsroom (Markdown editor w/ preview, scheduling, revisions), Media library, Team, Messages inbox, Pages/Settings (social links, contact, Turnstile keys reference, SEO defaults, maintenance mode), Users, Roles, API keys, Webhooks, Audit log, API docs.
- Fast, light vanilla JS (ES modules) or a tiny lib only if justified; responsive; dark/light; accessible. Charts: lightweight inline SVG, no heavy chart libs.

## 5. Analytics ingestion
- `POST /api/v1/collect` (public, rate-limited, bot-filtered) for the site's `track()` events; no cookies, no IP stored (hash with daily-rotating salt for unique visitors), country from CF headers, device from UA. Aggregation tables for fast dashboards; retention setting.

## 5b. Audit log (founder priority: VERY detailed)
- Every write anywhere (UI, API key, webhook-triggered, system/scheduled job, login/logout, failed/denied attempts, permission changes, settings, key create/rotate/revoke, kill switch, exports, deletes, restores) produces an immutable audit entry. Implement centrally in the data layer/middleware so nothing can bypass it.
- Each entry: id, timestamp (UTC, ms), actor type (user / api_key / system / webhook), actor id + display name + email (snapshot at time of action), role at the time, API key id/name if used, session id, IP, country, city (CF), user agent/device, request id, HTTP method + route, source (admin UI / API / agent name from `X-Agent-Name` header), action (e.g. `game.update`), resource type + id + human label, result (success / denied / error + reason), and optional reason/comment field the actor can supply (`X-Change-Reason`).
- **Field-level diff**: for every changed field store path, old value → new value (deep diff for nested JSON, arrays, Markdown body as a text diff with lines added/removed), plus full before/after snapshots. Secrets never stored in plain text — logged as `[redacted: changed]`.
- Bulk operations: one parent entry + child entries per item.
- Tamper-evidence: each entry stores a hash chained to the previous entry's hash (verifiable via `/api/v1/audit/verify`); audit entries cannot be edited or deleted via the API (only retention policy by owner, itself audited).
- Admin UI: searchable, filterable timeline (by user, key, agent, action, resource, date range, result, IP), per-resource history tab ("who changed this game and when") with side-by-side diff view, one-click "restore to this version" (which is itself audited), per-user activity page, export CSV/JSON, real-time feed. API: `/api/v1/audit` with the same filters.
- Retention: default keep forever (configurable by owner), with archive to R2 as JSONL.

## 6. Quality
- Tests: node tests for auth (JWT verification with mocked JWKS), permissions, API key scope checks, rate limit, kill switch, audit log, webhooks signing. Local run via `wrangler pages dev` with local D1 if available; otherwise mocked.
- Docs: `docs/ADMIN.md`, `docs/API.md` (with curl examples for agents), setup steps (D1/R2 creation, ENCRYPTION_KEY/SIGNING_KEY/SETUP_TOKEN generation, secrets, first-owner bootstrap).
- Screenshots of admin pages via Playwright.
- No git push; no real secrets.
