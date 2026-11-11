# Admin panel — how it works

`/admin` is the control room for tinycometstudio.com: games, newsroom, media, team, pages, messages, settings,
analytics, users and roles, API keys, approvals, webhooks, the audit log and system switches. It's a small vanilla
ES-module app (`public/admin/`) that talks **only** to the public Control API (`/api/v1`, see [API.md](API.md)) —
so anything you can click, an app or agent with the right key can do too.

Setup steps (D1, R2, secrets, first owner) are in the [README](../README.md#admin-panel--control-api-setup).

## Architecture

```
browser ─┬─ /, /<game>/, /news/…, /press/, /privacy/, sitemap, RSS ── functions/_middleware.js ── lib/site-render.js
         │      D1 configured + seeded → render with tools/render (same HTML as the static build), edge-cached
         │      under a content-version key; otherwise → the static files in public/ (fallback)
         ├─ /<game>/play/*  ── functions/[slug]/play/_middleware.js  (Turnstile gate; build from R2 or public/)
         ├─ /media/*        ── functions/media/[[path]].js           (R2 media library)
         ├─ /admin/*        ── functions/admin/[[path]].js           (SPA shell, strict CSP, noindex, no-store)
         │                     /admin/assets/*  static (never runs a Function)
         └─ /api/v1/*       ── functions/api/v1/[[path]].js → lib/admin/api.js
                               auth → kill switch → rate limit → permission → validation → dry-run / approval / idempotency
                               → handler → Tx (one D1 batch: data + revision + audit entry + webhook deliveries)
```

| Folder | What |
| --- | --- |
| `migrations/` | D1 schema (`0001_init.sql`) and built-in role rows (`0002_builtin_roles.sql`) |
| `lib/admin/` | API core: `api.js` pipeline, `router.js`, `routes/*` (all endpoints), `tx.js` (the only write path), `audit.js`, `auth.js`, `permissions.js`, `totp.js`, `qr.js`, `crypto.js`, `schema.js`, `webhooks.js`, `ratelimit.js`, `content.js`, `state.js`, `tick.js`, `openapi.js`, `email.js` |
| `lib/site-render.js`, `lib/site-headers.js` | public pages from D1, security headers mirrored from `public/_headers` |
| `public/admin/` | the admin UI (`assets/app.js`, `assets/ui.js`, `assets/views/*.js`, `assets/admin.css`) |
| `tools/db-seed.mjs` | first import of `content/` into D1 |
| `tools/content-sync.mjs` | `pull` (D1 → `content/` files, for the repo) and `push` (files → D1, audited) |
| `tools/dev/` | dev-only: D1/R2 shims for Node tests, synthetic analytics generator |
| `tests/admin-*.test.mjs`, `tests/e2e/admin-flow.mjs` | unit/integration tests and the Playwright flow |

Admin code never loads on public pages: the public HTML is unchanged (byte-identical, tested), and static assets are
excluded from Functions in `public/_routes.json`.

## Content: D1 is the source of truth

- Tables `settings`, `games`, `news`, `team`, `pages` keep the same shapes as `content/*.json|md` (JSON columns), so the existing pure render
  functions render them unchanged. Every save writes a **revision** (restore any version from the History tab) and an audit entry.
- Deletes go to a trash (soft delete, restorable). News can be draft / scheduled / published; scheduled posts publish themselves
  (checked on page views and API calls, at most once a minute, or by `POST /system/tick` from any cron).
- **Edge cache & purge:** rendered pages are stored in the Cache API under `v<content_version>/<path>`. Every content write bumps the
  version in the same transaction, so all caches are bypassed immediately (each isolate re-reads the version at most every 10 s).
  Optional: set `CF_ZONE_ID` + `CF_API_TOKEN` (Cache Purge permission) + `SITE_URL` to also purge Cloudflare's zone cache by URL.
  Note: the Cache API only caches on a custom domain, not on `*.pages.dev`.
- **Fallback:** without a `DB` binding, or before seeding, every page is served from the static `public/` exactly as before.
- **Keeping the repo in sync:** `TC_API_KEY=… node tools/content-sync.mjs pull --url https://tinycometstudio.com` writes D1's content back
  to `content/`; then `node tools/build.mjs` and commit. `push` does the reverse (audited, with a diff per item; `--dry-run`, `--prune`).
- Web play: the admin "web play" toggle and uploaded builds (zip → R2 `builds/<game>/<id>/…`) are read from D1/R2 by the play gate.
  Without D1 the gate uses `lib/games.generated.js` from the build, as before.

## Sign-in (no Google / OAuth)

1. **Email + password.** PBKDF2-SHA256, 100 000 iterations (the Workers maximum), 16-byte salt per user; min 12 chars,
   checked against a list of common passwords and the user's own name/email.
2. **Authenticator code (TOTP)** — mandatory for everyone; there is no way to skip it. RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step),
   codes can't be reused (last used step stored per user). Works with Google Authenticator, Microsoft Authenticator, Authy, 1Password, etc.
   Enrollment shows a QR code (zero-dependency SVG encoder) and the key to type in; the secret is AES-GCM encrypted with `ENCRYPTION_KEY`.
   10 one-time **recovery codes** are shown once (stored hashed); regenerate in My account.
3. A server-side **session** (`__Host-tc_session`, HttpOnly, Secure, SameSite=Strict, HMAC-signed; only a hash stored in D1),
   idle timeout 2 h and absolute 12 h (`SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`), list/revoke devices, "sign out everywhere".
   Writes need the `X-CSRF-Token` header and a same-origin `Origin`.
4. **Step-up:** creating API keys, changing roles or role assignments, inviting/removing users, resetting 2FA/passwords,
   the kill switch, imports, approvals and ownership transfer ask for a fresh code (valid 10 minutes).

Brute force: per-IP rate limits on every auth endpoint, per-account lockout after 5 failures (15 min, doubling, max 24 h),
and a Cloudflare Turnstile check after 3 failures (same widget keys as web play). A password alone never creates a session or lets
anyone enroll an authenticator: invite/reset links are one-time tokens, and an admin's "reset 2FA" link also requires the user's password.

**First owner:** set the `SETUP_TOKEN` secret, open `/admin/setup`, enter it with your name, email and password, scan the QR code.
Setup switches itself off as soon as one user exists. **Email** is optional: invite/reset links are shown to the admin (once)
to share privately; set `EMAIL_WEBHOOK_URL` (+ `EMAIL_WEBHOOK_TOKEN`) to have them posted to any mail relay as `{ to, subject, text }`.

**Optional extra layer:** put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/)
in front of `tinycometstudio.com/admin*` (Zero Trust → Access → Applications → Self-hosted, policy "emails ending in @tinycometstudio.com",
one-time PIN login). Don't put `/api/*` behind Access if agents use API keys.

## Users & roles

- Owners/admins **invite** users (email + name + role) → one-time link (7 days) → the person sets a password and enrolls TOTP.
- Users can be suspended (signed out everywhere), reactivated, have their 2FA or password reset, sessions revoked, or be removed
  (sessions end, their API keys are revoked; their audit history stays).
- **Built-in roles** (fixed, defined in `lib/admin/permissions.js`): Owner (everything), Admin (everything except owner-only audit retention),
  Editor (games copy/status, newsroom, team, pages, media, read messages/analytics, purge cache), Marketing/Analyst (read-only content + analytics),
  Developer (games incl. builds, media, own API keys, webhooks, cache), Viewer (read-only).
- **Custom roles:** a resource × action checkbox matrix (`read / create / update / delete / publish / manage`), optionally limited to some games.
- **No escalation:** you can't create or edit a role, assign a role, or create an API key with any permission you don't hold yourself
  (boxes you lack are greyed out, and the API refuses with the list of what's missing). You can't manage someone with more access than you.
  The owner can't be removed or suspended; ownership moves only via "Make owner" (owner only), which keeps exactly one owner.

## API keys, approvals, kill switch

See [API.md](API.md#authentication). In the panel: **API keys** (create with the scope matrix, IP allowlist, expiry, rate limit,
environments, approval + dry-run flags; edit, disable, rotate with 24 h grace, revoke, per-key activity) · **Approvals**
(dry-run preview of what a queued request would change; approve & run / reject, with a note) · **System** (kill switch,
maintenance mode, cache purge, housekeeping, content export, which bindings/secrets are set — never their values).

## Audit log

Every write anywhere — admin UI, API keys/agents, signed uploads, the scheduler, sign-ins/sign-outs (including **wrong password vs wrong code**),
denied and failed attempts, permission changes, settings, key create/rotate/revoke, kill switch, exports, deletes, restores — produces an entry.
It's enforced centrally: handlers can only write through `Tx`, which refuses to commit a write without an audit entry, and stores the data,
the revision and the audit entry in one D1 transaction.

Each entry has: `id`, `seq`, `ts` (UTC ms), `actor_type` (user / api_key / system / anonymous), `actor_id`, `actor_name`, `actor_email`,
`actor_role` (snapshots at the time), `api_key_id` / `api_key_name`, `session_id`, `ip`, `country`, `city`, `user_agent`, `device`,
`request_id`, `method`, `route`, `source` (`admin_ui`, `api`, `agent:<X-Agent-Name>`, `scheduler`, `setup`, `signed_upload`), `action`
(e.g. `game.update`), `resource_type` / `resource_id` / `resource_label`, `result` (success / denied / error / dry_run / pending_approval) and
`result_reason`, `reason` (`X-Change-Reason` or the reason box in the UI), `parent_id` (bulk operations: one parent + a child per item), and:

```json
"changes": [
  { "path": "tagline", "op": "changed", "old": "A tiny comet, a very big sky.", "new": "Steer a tiny comet through a very big sky." },
  { "path": "links.android", "op": "changed", "old": "", "new": "https://play.google.com/store/apps/details?id=com.tinycomet.nova" },
  { "path": "platforms", "op": "changed", "old": ["android","ios"], "new": ["android","web"], "diff": { "added": ["web"], "removed": ["ios"] } },
  { "path": "screenshots[src=/assets/a.webp].alt", "op": "changed", "old": "A", "new": "Menu screen" },
  { "path": "body", "op": "changed", "diff": { "added": 2, "removed": 1, "hunks": [{ "t": "-", "line": "old line", "n": 3 }, { "t": "+", "line": "new line", "n": 3 }] } },
  { "path": "password", "op": "changed", "old": "[redacted]", "new": "[redacted: changed]" }
],
"before": { …full snapshot… }, "after": { …full snapshot… }, "meta": { … },
"prev_hash": "…", "hash": "…"
```

Secrets (passwords, TOTP secrets, tokens, key hashes, webhook secrets, recovery codes, Authorization headers) are never stored — they appear
as `[redacted]` / `[redacted: changed]`.

**Tamper evidence:** `hash = HMAC-SHA256(key derived from SIGNING_KEY, prev_hash + "\n" + canonical JSON of the entry)`, chained from a zero
genesis hash. Entries are append-only: there is no API to edit or delete them and D1 triggers reject `UPDATE`/`DELETE`. **Verify integrity**
(Audit log page, or `GET /api/v1/audit/verify`) recomputes every HMAC and link and reports the first broken `seq` (edited, deleted or reordered rows).
Because it's an HMAC, someone with only database access can't forge a valid chain.

**Retention:** keep forever by default. The owner can set a retention period; `POST /audit/archive` then writes old entries to R2 as JSONL,
removes them from D1 inside the same transaction that records an anchor (last archived seq + hash) and an `audit.archive` entry, so the
remaining chain still verifies.

In the panel: searchable, filterable timeline (person, API key, agent, action incl. `game.*`, resource, result, IP, date range, free text),
"Live" toggle, entry drawer with side-by-side old/new diff, Markdown line diff, snapshots and hashes, CSV/JSON export (itself audited),
per-resource **History** tabs with one-click **restore** (audited as `*.restore_version`), and per-user/per-key **Activity** links.

## Analytics

`public/js/main.js`'s `track()` beacons go to `POST /api/v1/collect` (`settings.analyticsEndpoint`). No cookies; IPs are never stored —
a unique visitor is `SHA-256(daily random salt + IP + user agent + host)`, and each day's salt is deleted after a day. Bots, Do-Not-Track and
Global Privacy Control requests are dropped; cross-origin beacons are ignored; 120 events/min per visitor. Country comes from Cloudflare,
device/browser/OS from the user agent, referrer is kept as a host name only. Daily aggregates power the dashboards; raw events power the
funnels and real-time view. Retention defaults to 400 days (Analytics › Retention).

Dashboards: visitors, page views, store clicks, play starts and captcha passes with period comparison; time series; breakdowns by page,
game, country, device, browser, OS, referrer and store; per-game funnel (page view → store click / play click → captcha passed);
real time (last 30 minutes); CSV/JSON export.

## Security headers

`/admin/*`: `default-src 'self'`, no inline script or style, Turnstile only, `frame-ancestors 'none'`, `X-Robots-Tag: noindex, nofollow`,
`Cache-Control: no-store`, `Referrer-Policy: same-origin`. `/api/*`: `default-src 'none'`, `noindex`, `no-store`, no CORS (same-origin only).
Uploaded media is served with a sandbox CSP (SVG/PDF can't run scripts in the site's origin). Public pages rendered from D1 send the same
headers as `public/_headers` (kept in sync by a test). `robots.txt` disallows `/admin/` and `/api/`.

## Testing

```bash
npm test                                   # 59 unit/integration tests (Node 22+, uses node:sqlite as a D1 stand-in)
node tools/db-seed.mjs --local             # fresh local D1 (delete .wrangler/state to start over)
npx wrangler@4 pages dev --port 8788       # http://localhost:8788/admin/setup  (SETUP_TOKEN from .dev.vars)
NODE_PATH=$(npm root -g) node tests/e2e/admin-flow.mjs   # Playwright: full flow + screenshots (needs a fresh DB)
node tools/dev/demo-analytics.mjs > .wrangler/demo.sql && npx wrangler@4 d1 execute tinycomet --local --file=.wrangler/demo.sql  # synthetic charts (local only)
```
