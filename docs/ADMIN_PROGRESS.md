# Admin panel — progress log

Branch: `admin-panel`. Spec: `docs/ADMIN_SPEC.md` (founder's requirements; plus: NO Google/OAuth — login is email + password + TOTP).

## Done
- `migrations/0001_init.sql`, `0002_builtin_roles.sql` — D1 schema (content, users/roles/sessions/tokens, api_keys, approvals,
  idempotency, rate_limits, webhooks + deliveries, analytics, site_state, append-only hash-chained `audit_log` with triggers).
- `lib/admin/` core: `crypto.js` (PBKDF2 100k, AES-GCM, HMAC), `totp.js` (RFC 6238), `qr.js` (zero-dep QR → SVG, verified with jsQR),
  `permissions.js`, `schema.js` (validator = OpenAPI schemas), `audit.js` (deep/text diff, redaction, HMAC chain, verify),
  `tx.js` (only write path; refuses writes without audit; dry-run), `auth.js` (sessions, CSRF, tokens, API keys),
  `ratelimit.js`, `state.js`, `webhooks.js`, `tick.js`, `content.js`, `router.js`, `api.js` (pipeline), `openapi.js`, `email.js`.
- Routes (`lib/admin/routes/*`, ~148 endpoints): auth/setup, users/roles, api-keys/approvals, content (games/news/team/pages/settings,
  revisions, history, export/import), media + signed uploads + game zip builds → R2, messages (+ public /contact), analytics
  (/collect + queries), audit (list/verify/export/retention/archive), webhooks, system (kill switch, maintenance, cache purge, tick, dashboard).
- Functions: `functions/_middleware.js` (D1 render via `lib/site-render.js`, edge cache keyed by content version, maintenance),
  `functions/api/v1/[[path]].js`, `functions/admin/[[path]].js`, `functions/media/[[path]].js`, play middleware uses D1 + R2 builds.
- `public/_routes.json`, `lib/site-headers.js`, build writes `lib/site.generated.js` (ASSET_VERSION).
- Tools: `tools/db-seed.mjs` (content/ → D1 SQL), `tools/content-sync.mjs` (pull/push via API), `tools/dev/d1-shim.mjs` (node:sqlite D1 + R2 mock).
- Tests harness `tests/helpers.mjs`; smoke flow works in Node. Existing 18 tests pass.
- Admin UI: shell + auth screens (app.js), views: dashboard, analytics, games, news, media, team, pages, messages, settings, _shared.

## In progress / next
1. `public/admin/assets/app.js` (router, shell, auth screens) + `assets/views/*.js` (dashboard, analytics, games, news, media, team,
   messages, pages, settings, users, roles, keys, approvals, webhooks, audit, system, account, api-docs).
2. Wire `settings.analyticsEndpoint = "/api/v1/collect"` + optional contact form endpoint; update `public/_headers` (/admin, /api noindex + CSP).
3. wrangler.toml D1/R2 bindings (placeholder IDs), `.dev.vars.example` (ENCRYPTION_KEY, SIGNING_KEY, SETUP_TOKEN, TURNSTILE_SECRET, ENVIRONMENT).
4. Tests: TOTP vectors, passwords/sessions, permission matrix + no-escalation, key scopes/IP/expiry/rate limit, kill switch/dry-run/approvals,
   audit diffs/chain/verify, redaction, webhook signing.
5. E2E with `npx wrangler@4 pages dev` + local D1 (works in this container) and Playwright; screenshots 1440/390 → `/home/user/tiny-comet-admin-screenshots/`.
6. Docs: `docs/ADMIN.md`, `docs/API.md`, README setup.

## Resume
`git checkout admin-panel && npm test`; smoke: see tests/helpers.mjs (`makeEnv`, `bootstrapOwner`).
