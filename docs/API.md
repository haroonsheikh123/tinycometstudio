# Tiny Comet Studio — Control API (`/api/v1`)

Everything the admin panel does goes through this API — the panel has no hidden endpoints — so an app or a
cloud agent with the right key can run the whole site. The machine-readable spec is generated from the same route table that
validates requests: **`GET /api/v1/openapi.json`** (OpenAPI 3.1). There's a browsable copy in the admin under **API docs**.

- Base URL: `https://tinycometstudio.com/api/v1` (local: `http://localhost:8788/api/v1`)
- JSON in, JSON out. Success: `{ "data": …, "meta": { … } }`. Error: `{ "error": { "code", "message", "details"?, "request_id" } }`
- Lists: `?limit=` (≤ 200) and an opaque `meta.next_cursor` → pass it back as `?cursor=`. Most lists also take `q`, `status`, `sort` (`title`, `-date`…).
- Every write is recorded in the audit log with a field-level diff (see [ADMIN.md › Audit log](ADMIN.md#audit-log)).

## Authentication

| Who | How |
| --- | --- |
| Apps & agents | `Authorization: Bearer tck_<12 chars>_<43 chars>` — create keys in **Admin › API keys** (shown once; only a SHA-256 hash is stored). |
| The admin panel | `__Host-tc_session` cookie (HttpOnly, Secure, SameSite=Strict) from email + password + authenticator code, plus `X-CSRF-Token` on every write (from `GET /auth/session`). |

A key's access is **(its scopes ∪ its optional role) ∩ the current access of the person who created it**. Demoting or removing that
person shrinks or revokes their keys immediately. Per key you also control: expiry, IP/CIDR allowlist (IPv4 + IPv6), rate limit
(requests/min, `RateLimit-*` + `Retry-After` headers), allowed environments (`production` / `preview` / `development`), enable/disable,
rotate with a grace period, revoke, `require_approval`, `force_dry_run`. Last used time/IP and a usage counter are tracked.

**Kill switch:** `PUT /system/kill-switch {"enabled":true}` (or Admin › System) blocks every API key instantly with
`503 api_keys_disabled`. Admin sessions keep working. Keys can switch it on, only a signed-in human can switch it off.

### Scopes

Format `resource:action`. Shorthands: `resource:*` (all actions), `resource:write` (create + update + delete), `*` (everything — owner only).

| Resource | Actions |
| --- | --- |
| `games` | read, create, update (incl. builds, links), delete, publish (status, web play on/off) |
| `news` | read, create, update, delete, publish (publish/schedule/unpublish) |
| `media` | read, create, update, delete |
| `team` | read, create, update, delete |
| `pages` | read, create, update, delete |
| `settings` | read, update |
| `messages` | read, update, delete |
| `analytics` | read (incl. exports), manage (retention) |
| `users` | read, create (invite), update, delete, manage (suspend, reset 2FA / password, sessions) |
| `roles` | read, manage |
| `api_keys` | read, create, update, delete, manage (other people's keys) |
| `approvals` | read, manage |
| `webhooks` | read, manage |
| `audit` | read (incl. verify, export), manage (retention/archive — owner only) |
| `cache` | manage |
| `system` | read (status, export content), manage (maintenance, kill switch, import, tick) |

`GET /permissions` returns this catalogue plus the built-in roles. `GET /auth/session` tells a key exactly what it may do.

## Headers that make agents safe

| Header | Effect |
| --- | --- |
| `X-Dry-Run: true` | Validate and compute the change, return `meta.would_change` (field diffs) and `meta.would_emit` (webhooks) — **nothing is written** (one `dry_run` audit entry is). |
| `X-Change-Reason: …` | Stored as the *why* on the audit entry. |
| `X-Agent-Name: release-bot` | Recorded as the audit `source` (`agent:release-bot`) and filterable in the audit log. |
| `Idempotency-Key: …` | POST retries with the same key and body return the first response for 24 h (`Idempotent-Replayed: true`); a different body → `422`. |
| `If-Match: "v7"` | Optimistic concurrency: `GET` returns `ETag: "v<version>"`; an update with a stale ETag gets `412 precondition_failed`. |

**Approval queue.** If a key has `require_approval`, any destructive call (delete, publish/unpublish, `manage` actions) is *not run*:
the API answers `202` with `data.approval = { id, status: "pending", preview }`. A human approves or rejects it in **Admin › Approvals**;
on approval it runs as the key, and the audit entries record the approver. Poll `GET /approvals/{id}` (needs `approvals:read`) or subscribe to the `approval.decided` webhook.

## Errors

`400 validation_failed` (`details` = `[{ path, message }]`) · `401 unauthenticated | invalid_api_key` (`details.reason`: revoked, disabled, expired,
ip_not_allowed, environment_not_allowed) · `403 forbidden` (`details.required`) | `step_up_required` | `csrf_failed` | `session_required` · `404` · `405` ·
`409 conflict` · `412 precondition_failed` · `413` · `415` · `422 idempotency_key_reused` · `429 rate_limited` · `503 api_keys_disabled | not_configured`.
Every response carries `X-Request-Id`; denied attempts are audited.

## curl cookbook (for AI agents)

```bash
export TC=https://tinycometstudio.com/api/v1
export TC_API_KEY=tck_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # Admin › API keys
H=(-H "Authorization: Bearer $TC_API_KEY" -H "X-Agent-Name: release-bot" -H "Content-Type: application/json")

# Who am I and what may I do?
curl -s "${H[@]}" $TC/auth/session | jq '.data.permissions, .data.api_key'

# Read the catalogue (cursor pagination)
curl -s "${H[@]}" "$TC/games?limit=50" | jq '.data[] | {id, title, status, version: ._meta.version}'

# Preview a change first, then apply it with optimistic concurrency
curl -s "${H[@]}" -X PATCH $TC/games/project-nova -H "X-Dry-Run: true" \
  -d '{"tagline":"A tiny comet, a very big sky.","links":{"android":"https://play.google.com/store/apps/details?id=com.tinycomet.nova"}}' | jq .meta
ETAG=$(curl -sI "${H[@]}" $TC/games/project-nova | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s "${H[@]}" -X PATCH $TC/games/project-nova -H "If-Match: $ETAG" -H "X-Change-Reason: store launch" \
  -d '{"links":{"android":"https://play.google.com/store/apps/details?id=com.tinycomet.nova"}}'

# One-field helpers
curl -s "${H[@]}" -X PUT $TC/games/project-nova/status   -d '{"status":"released"}'      # games:publish
curl -s "${H[@]}" -X PUT $TC/games/project-nova/web-play -d '{"enabled":true}'          # games:publish

# Upload a browser build (zip with index.html at the root) → served at /project-nova/play/ behind Turnstile
curl -s -H "Authorization: Bearer $TC_API_KEY" -H "Content-Type: application/zip" --data-binary @build.zip $TC/games/project-nova/build

# Newsroom: draft → schedule (or publish now)
curl -s "${H[@]}" -X POST $TC/news -H "Idempotency-Key: devlog-2026-11-12" \
  -d '{"title":"Project Nova devlog #2","category":"Devlog","game":"project-nova","author":"haroon-sheikh","excerpt":"Trails!","body":"## Trails\n\nComets now leave sparkly trails."}'
curl -s "${H[@]}" -X POST $TC/news/project-nova-devlog-2/publish -d '{"publish_at":"2026-11-20T09:00:00Z"}'   # news:publish
curl -s "${H[@]}" -X POST $TC/news/preview -d '{"body":"**bold** and {{youtube https://youtu.be/dQw4w9WgXcQ}}"}' | jq -r .data.html

# Media: direct upload, or a signed URL for a big file (PUT without other auth, 15 min)
curl -s -H "Authorization: Bearer $TC_API_KEY" -H "Content-Type: image/webp" --data-binary @cover.webp "$TC/media?filename=nova-cover.webp&alt=Project%20Nova%20cover"
UP=$(curl -s "${H[@]}" -X POST $TC/media/uploads -d "{\"filename\":\"trailer.mp4\",\"content_type\":\"video/mp4\",\"size\":$(stat -c%s trailer.mp4)}" | jq -r .data.upload_url)
curl -s -X PUT -H "Content-Type: video/mp4" --data-binary @trailer.mp4 "$UP"

# Analytics
curl -s "${H[@]}" "$TC/analytics/summary?from=2026-11-01&to=2026-11-30" | jq .data.totals
curl -s "${H[@]}" "$TC/analytics/breakdown?dimension=country&event=store_click"
curl -s "${H[@]}" "$TC/analytics/funnel?game=project-nova"
curl -s "${H[@]}" "$TC/analytics/export?format=csv&kind=daily" -o analytics.csv          # audited

# Audit log (needs audit:read): everything this agent did, and integrity check
curl -s "${H[@]}" "$TC/audit?agent=release-bot&limit=20" | jq '.data[] | {ts, action, resource_id, result, changes}'
curl -s "${H[@]}" $TC/audit/verify | jq '.data | {ok, checked, head_hash}'

# Webhooks (webhooks:manage) — secret is returned once
curl -s "${H[@]}" -X POST $TC/webhooks -d '{"url":"https://hooks.example.com/tinycomet","events":["news.published","message.received","game.*"]}'

# Emergency stop (system:manage) — blocks every key, including this one
curl -s "${H[@]}" -X PUT $TC/system/kill-switch -d '{"enabled":true,"reason":"agent misbehaving"}'
```

### Verifying webhook signatures

Each delivery is a `POST` with `X-TinyComet-Event`, `X-TinyComet-Delivery`, `X-TinyComet-Attempt` and
`X-TinyComet-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Reject signatures older than 5 minutes.
Non-2xx responses are retried after 30 s, 2 min, 10 min, 1 h and 6 h (6 attempts); the delivery log is in Admin › Webhooks.

```js
// Node / Workers
async function verify(secret, rawBody, header) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  let diff = hex.length ^ v1.length;                       // constant-time compare
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ (v1.charCodeAt(i) || 0);
  return diff === 0;
}
```

Events: `game.created|updated|deleted|restored|published|build_uploaded`, `news.created|updated|deleted|restored|published|unpublished|scheduled`,
`team.updated`, `page.updated`, `settings.updated`, `media.uploaded|deleted`, `message.received`, `user.created|updated|removed`,
`api_key.created|revoked`, `approval.requested|decided`, `system.kill_switch`, `system.maintenance`, `cache.purged`, `webhook.test` (`*` or `group.*` to subscribe broadly).

### Public endpoints (no auth)

`GET /health`, `GET /openapi.json`, `POST /collect` (the site's `track()` beacon — always 204), `POST /contact` (contact form, rate-limited, honeypot field `website`),
and the sign-in flow (`/setup`, `/auth/login`, `/auth/mfa`, `/auth/totp/*`, `/auth/invite/*`).

## Every endpoint

Generated from the route table (same source as `openapi.json`). "step-up" = a cookie session must have confirmed a fresh TOTP
code within 10 minutes; "approval-gated" = queued when the calling key has `require_approval`.

### System

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/health` | public |  |
| GET | `/openapi.json` | public |  |
| GET | `/system` | `system:read` |  |
| PUT | `/system/kill-switch` | `system:manage` | step-up |
| PUT | `/system/maintenance` | `system:manage` | approval-gated |
| POST | `/cache/purge` | `cache:manage` |  |
| POST | `/system/tick` | `system:manage` |  |

### Dashboard

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/dashboard` | signed in |  |

### Auth

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/setup` | public |  |
| POST | `/setup` | public |  |
| POST | `/auth/login` | public |  |
| POST | `/auth/mfa` | public |  |
| POST | `/auth/totp/setup` | public |  |
| POST | `/auth/totp/confirm` | public |  |
| GET | `/auth/session` | signed in |  |
| POST | `/auth/step-up` | signed in | session only |
| POST | `/auth/logout` | signed in | session only |
| GET | `/auth/sessions` | signed in | session only |
| DELETE | `/auth/sessions/{id}` | signed in | session only, approval-gated |
| POST | `/auth/sessions/revoke-all` | signed in | session only |
| POST | `/auth/password` | signed in | session only |
| POST | `/auth/recovery-codes` | signed in | step-up, session only |
| POST | `/auth/invite/inspect` | public |  |
| POST | `/auth/invite/accept` | public |  |

### Users

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/users` | `users:read` |  |
| POST | `/users` | `users:create` | step-up |
| GET | `/users/{id}` | `users:read` |  |
| PATCH | `/users/{id}` | dynamic |  |
| DELETE | `/users/{id}` | `users:delete` | step-up, approval-gated |
| POST | `/users/{id}/reset-2fa` | `users:manage` | step-up, approval-gated |
| POST | `/users/{id}/reset-password` | `users:manage` | step-up, approval-gated |
| POST | `/users/{id}/resend-invite` | `users:create` |  |
| GET | `/users/{id}/sessions` | `users:manage` |  |
| POST | `/users/{id}/revoke-sessions` | `users:manage` | approval-gated |
| POST | `/users/{id}/transfer-ownership` | signed in | owner only, step-up, session only |

### Roles

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/permissions` | signed in |  |
| GET | `/roles` | `roles:read` |  |
| GET | `/roles/{id}` | `roles:read` |  |
| POST | `/roles` | `roles:manage` | step-up, approval-gated |
| PATCH | `/roles/{id}` | `roles:manage` | step-up, approval-gated |
| DELETE | `/roles/{id}` | `roles:manage` | step-up, approval-gated |

### API keys

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api-keys` | `api_keys:read` |  |
| POST | `/api-keys` | `api_keys:create` | step-up |
| GET | `/api-keys/{id}` | `api_keys:read` |  |
| PATCH | `/api-keys/{id}` | dynamic |  |
| POST | `/api-keys/{id}/rotate` | `api_keys:update` | step-up |
| POST | `/api-keys/{id}/revoke` | `api_keys:delete` | approval-gated |
| DELETE | `/api-keys/{id}` | `api_keys:delete` | approval-gated |

### Approvals

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/approvals` | `approvals:read` |  |
| GET | `/approvals/{id}` | `approvals:read` |  |
| POST | `/approvals/{id}/approve` | `approvals:manage` | step-up, session only, approval-gated |
| POST | `/approvals/{id}/reject` | `approvals:manage` | session only, approval-gated |

### Games

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/games` | `games:read` |  |
| GET | `/games/{id}` | `games:read` |  |
| POST | `/games` | `games:create` |  |
| PATCH | `/games/{id}` | dynamic |  |
| DELETE | `/games/{id}` | `games:delete` | approval-gated |
| POST | `/games/{id}/restore` | `games:delete` |  |
| PUT | `/games/order` | `games:update` |  |
| GET | `/games/{id}/revisions` | `games:read` |  |
| GET | `/games/{id}/revisions/{version}` | `games:read` |  |
| POST | `/games/{id}/revisions/{version}/restore` | `games:update` |  |
| GET | `/games/{id}/history` | `games:read` |  |
| PUT | `/games/{id}/status` | `games:publish` | approval-gated |
| PUT | `/games/{id}/web-play` | `games:publish` | approval-gated |
| PUT | `/games/{id}/links` | `games:update` |  |
| POST | `/games/{id}/build` | `games:update` |  |
| DELETE | `/games/{id}/build` | `games:update` | approval-gated |

### Team

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/team` | `team:read` |  |
| GET | `/team/{id}` | `team:read` |  |
| POST | `/team` | `team:create` |  |
| PATCH | `/team/{id}` | dynamic |  |
| DELETE | `/team/{id}` | `team:delete` | approval-gated |
| POST | `/team/{id}/restore` | `team:delete` |  |
| PUT | `/team/order` | `team:update` |  |
| GET | `/team/{id}/revisions` | `team:read` |  |
| GET | `/team/{id}/revisions/{version}` | `team:read` |  |
| POST | `/team/{id}/revisions/{version}/restore` | `team:update` |  |
| GET | `/team/{id}/history` | `team:read` |  |

### Newsroom

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/news` | `news:read` |  |
| GET | `/news/{slug}` | `news:read` |  |
| POST | `/news` | dynamic |  |
| PATCH | `/news/{slug}` | dynamic |  |
| POST | `/news/{slug}/publish` | `news:publish` | approval-gated |
| POST | `/news/{slug}/unpublish` | `news:publish` | approval-gated |
| DELETE | `/news/{slug}` | `news:delete` | approval-gated |
| POST | `/news/{slug}/restore` | `news:delete` |  |
| POST | `/news/preview` | `news:read` |  |
| GET | `/news/{slug}/revisions` | `news:read` |  |
| GET | `/news/{slug}/revisions/{version}` | `news:read` |  |
| POST | `/news/{slug}/revisions/{version}/restore` | `news:update` |  |
| GET | `/news/{slug}/history` | `news:read` |  |

### Pages

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/pages` | `pages:read` |  |
| GET | `/pages/{slug}` | `pages:read` |  |
| POST | `/pages` | `pages:create` |  |
| PATCH | `/pages/{slug}` | `pages:update` |  |
| DELETE | `/pages/{slug}` | `pages:delete` | approval-gated |
| GET | `/pages/{slug}/revisions` | `pages:read` |  |
| GET | `/pages/{slug}/revisions/{version}` | `pages:read` |  |
| POST | `/pages/{slug}/revisions/{version}/restore` | `pages:update` |  |
| GET | `/pages/{slug}/history` | `pages:read` |  |

### Settings

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/settings` | `settings:read` |  |
| PATCH | `/settings` | `settings:update` |  |
| GET | `/settings/revisions` | `settings:read` |  |
| GET | `/settings/revisions/{version}` | `settings:read` |  |
| POST | `/settings/revisions/{version}/restore` | `settings:update` |  |
| GET | `/settings/history` | `settings:read` |  |

### Content sync

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/export/content` | `system:read` |  |
| POST | `/import/content` | `system:manage` | step-up, approval-gated |

### Media

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/media` | `media:read` |  |
| POST | `/media` | `media:create` |  |
| GET | `/media/{id}` | `media:read` |  |
| PATCH | `/media/{id}` | `media:update` |  |
| DELETE | `/media/{id}` | `media:delete` | approval-gated |
| POST | `/media/uploads` | `media:create` |  |
| PUT | `/media/uploads/{token}` | public |  |

### Messages

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/contact` | public |  |
| GET | `/messages` | `messages:read` |  |
| GET | `/messages/{id}` | `messages:read` |  |
| PATCH | `/messages/{id}` | `messages:update` |  |
| DELETE | `/messages/{id}` | `messages:delete` | approval-gated |
| POST | `/messages/bulk` | dynamic |  |

### Analytics

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/collect` | public |  |
| GET | `/analytics/summary` | `analytics:read` |  |
| GET | `/analytics/timeseries` | `analytics:read` |  |
| GET | `/analytics/breakdown` | `analytics:read` |  |
| GET | `/analytics/funnel` | `analytics:read` |  |
| GET | `/analytics/realtime` | `analytics:read` |  |
| GET | `/analytics/export` | `analytics:read` |  |
| GET | `/analytics/retention` | `analytics:read` |  |
| PUT | `/analytics/retention` | `analytics:manage` | approval-gated |

### Audit log

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/audit` | `audit:read` |  |
| GET | `/audit/verify` | `audit:read` |  |
| GET | `/audit/export` | `audit:read` |  |
| GET | `/audit/retention` | `audit:read` |  |
| PUT | `/audit/retention` | `audit:read` | owner only, step-up |
| POST | `/audit/archive` | `audit:read` | owner only, step-up |
| GET | `/audit/{id}` | `audit:read` |  |

### Webhooks

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/webhooks/events` | `webhooks:read` |  |
| GET | `/webhooks` | `webhooks:read` |  |
| POST | `/webhooks` | `webhooks:manage` |  |
| GET | `/webhooks/{id}` | `webhooks:read` |  |
| PATCH | `/webhooks/{id}` | `webhooks:manage` |  |
| DELETE | `/webhooks/{id}` | `webhooks:manage` | approval-gated |
| POST | `/webhooks/{id}/rotate-secret` | `webhooks:manage` | step-up |
| POST | `/webhooks/{id}/test` | `webhooks:manage` |  |
| GET | `/webhooks/{id}/deliveries` | `webhooks:read` |  |
| POST | `/webhook-deliveries/{id}/redeliver` | `webhooks:manage` |  |
