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

- Unit tests: tests/admin-auth|admin-access|admin-audit.test.mjs (41 new; 59 total passing).
- E2E: tests/e2e/admin-flow.mjs against wrangler pages dev — 33+/35 checks first run, fixed; screenshots in /home/user/tiny-comet-admin-screenshots/.

## Status: feature-complete on this branch
- E2E: 35/35 checks on a fresh local D1 (wrangler pages dev); 76 screenshots (38 screens × 1440/390) in /home/user/tiny-comet-admin-screenshots/.
- Docs: docs/ADMIN.md, docs/API.md, README › Admin setup.

## Possible follow-ups
- Real Cloudflare deploy: create D1/R2, put the database_id in wrangler.toml, set secrets, run `node tools/db-seed.mjs --remote`.
- External cron for exact scheduled publishing (`POST /api/v1/system/tick`).
- Check PBKDF2 CPU time on the Workers plan in use.

## Resume
`git checkout admin-panel && npm test`; local: `cp .dev.vars.example .dev.vars && node tools/db-seed.mjs --local && npx wrangler@4 pages dev`.
