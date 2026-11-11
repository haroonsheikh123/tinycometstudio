# Tiny Comet Studio — website

The website of **Tiny Comet Studio**, a small indie games & apps team from Pakistan led by Haroon Sheikh.

- **Static site** in `public/`, generated from plain content files in `content/` by a tiny zero-dependency Node script.
- **Cloudflare Pages** hosting (auto-deploys from GitHub `haroonsheikh123/tinycometstudio`).
- **Pages Functions** (`functions/`) gate browser-playable game builds behind **Cloudflare Turnstile**.
- No frameworks, no npm dependencies. Vanilla HTML/CSS + two small ES modules.

```
/                      studio home (games, what we do, latest news, about + team, follow, contact)
/<slug>/               game / app page          e.g. /project-nova/
/<slug>/play/          web build, unlocked by a Turnstile check
/news/                 newsroom  (+ /news/<post>/, /news/feed.xml)
/press/                press kit
/privacy/              privacy policy (template)
/admin/                reserved for a future admin panel
```

---

## Folder structure

```
content/                 ← EDIT THESE (single source of truth)
  settings.json          studio name, site URL, emails, social links, hero/about copy, Turnstile site key, analytics
  games.json             games & apps
  team.json              founder + team members
  news/*.md              news posts (Markdown + front-matter)
  pages/privacy.md       privacy policy
docs/CONTENT_SCHEMA.md   every field explained (+ render API, analytics events)
tools/
  build.mjs              generator: content/ → public/   (node tools/build.mjs)
  new-game.mjs           scaffold a game                (node tools/new-game.mjs <slug> "<Title>" [--web] [--app])
  new-post.mjs           scaffold a news post           (node tools/new-post.mjs "<Title>" --category=Devlog --game=<slug>)
  render/*.mjs           pure render functions (HTML templates), markdown converter, validation
functions/               Cloudflare Pages Functions
  [slug]/play/_middleware.js   checks the signed play cookie, else serves the Turnstile gate
  [slug]/play/[[path]].js      routes every /<slug>/play/* request through the middleware
  api/verify.js                POST: verifies Turnstile server-side, sets the signed cookie
lib/
  play-auth.js           HMAC tickets, cookies, CSP for game builds (Web Crypto, no deps)
  games.generated.js     GENERATED allow-list of web-playable slugs
tests/                   node --test unit tests (functions + render)
public/                  ← BUILD OUTPUT (committed, deployable as-is)
  index.html, 404.html, <slug>/index.html, news/…, press/, privacy/   GENERATED
  <slug>/play/           your HTML5/WebGL game build (NOT generated — you put files here)
  css/style.css  js/main.js  js/gate.js
  assets/                logos, icons, fonts, sky tiles, press/, games/<slug>/, team/
  _headers  _redirects   Cloudflare Pages headers (CSP, HSTS, caching) and redirects
  sitemap.xml robots.txt manifest.webmanifest   GENERATED
wrangler.toml            Pages config for local dev (`pages_build_output_dir = "public"`)
.dev.vars.example        local secrets template (Turnstile TEST keys)
```

Never edit generated files in `public/` by hand — edit `content/` (or `tools/render/`) and rebuild.
`public/css`, `public/js`, `public/assets` and `public/<slug>/play/` are hand-maintained.

---

## Everyday workflow

```bash
node tools/build.mjs          # regenerate public/ (validates content first; fails with a clear message)
node tools/build.mjs --check  # validate only
npm test                      # unit tests (Node 18+)
npm run preview               # static preview at http://localhost:8000 (no Functions: /play/ is NOT gated here)
npx wrangler pages dev        # full local Cloudflare emulation incl. Functions at http://localhost:8788
```

Then commit and push — Cloudflare Pages rebuilds and deploys automatically. Because the generated output is
committed too, the site also works if the build step is ever skipped.

---

## Adding a new game (end to end)

1. **Scaffold it**
   ```bash
   node tools/new-game.mjs comet-dash "Comet Dash"          # add --web if it has a browser build, --app for an app
   ```
   This adds an entry to the top of `content/games.json`, creates `public/assets/games/comet-dash/`
   (and `public/comet-dash/play/` with `--web`), and rebuilds.
   *(By hand: copy an entry in `content/games.json`, give it a unique `id`, and run the build.)*

2. **Fill in the details** in `content/games.json`: `title`, `tagline`, `description`, `status`
   (`coming-soon` / `in-development` / `released`), `platforms`, `genres`, `releaseDate`, `trailer` (YouTube URL).

3. **Add images** to `public/assets/games/<slug>/`:
   - `cover.webp` — 1600×900 (16:9). Use **WebP or AVIF** (e.g. `cwebp -q 80 cover.png -o cover.webp`, or squoosh.app). Keep it under ~200 KB.
   - `shot-1.webp`, `shot-2.webp` … — 16:9 screenshots, same advice.
   Reference them as `"cover": "/assets/games/<slug>/cover.webp"` and
   `"screenshots": [{ "src": "/assets/games/<slug>/shot-1.webp", "alt": "Describe the image" }]`.
   Images are rendered with `width`/`height`, `loading="lazy"` and `decoding="async"` automatically.

4. **Store links** — when the game is live, set `"status": "released"` and fill
   `"links": { "android": "https://play.google.com/store/apps/details?id=…", "ios": "https://apps.apple.com/app/id…", "steam": "", "itch": "" }`.
   Rules: released → a black "Get it on Google Play" / "Download on the App Store" / Steam / itch.io badge for every
   non-empty link (empty = hidden). Not released → "Coming soon" badges for the store platforms in `platforms`.

5. **Web build (optional)** — set `"webPlay": { "enabled": true }` and put your HTML5/WebGL export into
   `public/<slug>/play/` (it must contain `index.html`; Unity/Godot/Phaser exports work as-is — the CSP for that
   folder allows WASM and blob workers, see `GAME_CSP` in `lib/play-auth.js`). `project-nova` ships a tiny
   placeholder "catch the stars" demo you can copy or delete.

6. **Rebuild & push**: `node tools/build.mjs`, check locally, commit, push.

To remove a game: delete its entry and rebuild — its generated pages are cleaned up (a `play/` build is kept with a warning).
Placeholder entries (`"placeholder": true`: Project Nova, Orbit Garden, Stardust Notes) should be replaced or deleted.

## Writing news

```bash
node tools/new-post.mjs "Comet Dash is coming" --category=Announcement --game=comet-dash
```
Edit the new file in `content/news/`, rebuild. Categories: Announcement, Devlog, Release, Update, Press.
Set `game:` to link the post to a game (it then appears on that game's page). Markdown features are listed in
`docs/CONTENT_SCHEMA.md`; embed a video with `{{youtube https://youtu.be/VIDEO_ID}}` on its own line.
The home page shows the 3 latest posts; `/news/feed.xml` (RSS) and `sitemap.xml` update automatically.

## Team & founder

Edit `content/team.json`. The member with `"featured": true` (Haroon) gets the large founder card; everyone else
appears as a small card under "The crew" — add/remove objects freely. Photos: put a square image in
`public/assets/team/` (e.g. `haroon.jpg`) and set `"photo": "/assets/team/haroon.jpg"`; without one, a comet-coloured
initials circle is shown.

## Contact email & social links

All in `content/settings.json`:
- `contactEmail` — contact section, form and privacy page (currently placeholder `hello@tinycometstudio.com`).
- `pressEmail` — press kit.
- `socials` — `url: ""` hides a button, `"#"` shows it dimmed with "soon", a real URL makes it live.

The contact form opens the visitor's own email app (mailto) — nothing is stored or sent by the site.

---

## Play in browser — how the Turnstile gate works

```
/<slug>/         "Play in browser" → /<slug>/play/
/<slug>/play/    functions/[slug]/play/_middleware.js
                   • slug not web-play enabled      → on-brand 404
                   • valid signed cookie for slug   → static game files (context.next())
                   • otherwise                      → Turnstile gate page (public/<slug>/gate/), sub-resources get 403
gate page        loads Turnstile (only on this page) → POST /api/verify {slug, token}
/api/verify      siteverify with TURNSTILE_SECRET (+ CF-Connecting-IP), checks slug, hostname, action, cData,
                 sets cookie  tc_play=<slug>.<exp>.<HMAC-SHA256>  HttpOnly; Secure; SameSite=Lax; Path=/<slug>/play/
                 (default 4 h, PLAY_TTL_HOURS), → page reloads /<slug>/play/ — now unlocked
```

The game files are only ever served after a server-side check, so the URL can't simply be copied from the page
source. Settings: `turnstileSiteKey` in `content/settings.json` (public); `TURNSTILE_SECRET`, `SIGNING_KEY`
as Cloudflare secrets; optional vars `PLAY_TTL_HOURS`, `ALLOWED_HOSTNAMES` (comma list, e.g.
`tinycometstudio.com,tinycometstudio.pages.dev`; empty = the request's own host).

The repo ships Cloudflare's **always-pass test keys** (site key `1x00000000000000000000AA`, secret
`1x0000000000000000000000000000000AA`). **Replace them before launch:**

1. Cloudflare dashboard → **Turnstile** → *Add widget*: name "Tiny Comet web play", hostnames
   `tinycometstudio.com` and `<project>.pages.dev`, mode **Managed**. Copy the **site key** and **secret key**.
2. Put the site key in `content/settings.json` → `turnstileSiteKey`, rebuild, push.
3. Pages project → **Settings → Variables and Secrets** (Production *and* Preview), add **encrypted**:
   - `TURNSTILE_SECRET` = the secret key
   - `SIGNING_KEY` = a long random string (`openssl rand -base64 48`)
   Or from a terminal: `npx wrangler pages secret put TURNSTILE_SECRET --project-name tinycometstudio`
   (same for `SIGNING_KEY`). Redeploy so they take effect. Rotating `SIGNING_KEY` logs everyone out of web play.

Local testing with Functions: `cp .dev.vars.example .dev.vars` then `npx wrangler pages dev`.

**Extra hardening (optional):** add a Cloudflare **rate-limiting rule** for `POST /api/verify`
(Security → WAF → Rate limiting, e.g. 20 requests / minute / IP). For the strongest no-code protection of a
separately hosted build (e.g. `play.tinycometstudio.com` on R2/Pages), add a **WAF custom rule with action
"Managed Challenge"** on that hostname once the domain is on Cloudflare.

---

## Deploying on Cloudflare Pages

1. Push this folder as the root of the GitHub repo `haroonsheikh123/tinycometstudio`.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: `node tools/build.mjs`
   - Build output directory: `public`
   - Root directory: *(empty)*
   - Environment variable (optional): `NODE_VERSION = 22`
   The `functions/` folder is picked up automatically.
4. Add the secrets (see above), then **Save and Deploy**. You get `https://<project>.pages.dev`; every push to `main`
   deploys production, other branches get preview URLs.

Because `wrangler.toml` is in the repo, Cloudflare uses it as the project's config: change plain variables
(`PLAY_TTL_HOURS`, `ALLOWED_HOSTNAMES`) there; secrets are always set in the dashboard.

No build step wanted? Set the build command empty — the committed `public/` is complete.

### Custom domain tinycometstudio.com

1. Pages project → **Custom domains → Set up a custom domain** → `tinycometstudio.com` (and `www.tinycometstudio.com`).
   Easiest if the domain's DNS is on Cloudflare (add the site, change nameservers at your registrar); otherwise add the CNAME it shows.
2. Redirect `www` → apex: **Rules → Redirect Rules** → "Redirect from WWW to root" template.
3. `content/settings.json` → `siteUrl` is already `https://tinycometstudio.com` (canonical, Open Graph, sitemap, RSS).
   If you ever change domains, edit it there and rebuild — it's the only place.
4. Add the domain to the Turnstile widget's hostnames.

The `*.pages.dev` URL keeps working (all links are root-relative); its canonical tags point at the custom domain.

### Optional `<slug>.tinycometstudio.com` subdomains

Don't build separate sites — redirect to the path:
1. DNS: add a proxied record per subdomain (e.g. `CNAME comet-dash → tinycometstudio.com`, orange cloud), or a proxied wildcard `*`.
2. **Rules → Redirect Rules → Create rule**: *When* `Hostname` equals `comet-dash.tinycometstudio.com`
   → *Then* Dynamic redirect to `concat("https://tinycometstudio.com/comet-dash", http.request.uri.path)`, status 301, preserve query string.
   (For a wildcard: expression `ends_with(http.host, ".tinycometstudio.com") and http.host ne "www.tinycometstudio.com"` and target
   `concat("https://tinycometstudio.com/", substring(http.host, 0, len(http.host) - 20), "/")`. Test before relying on it.)

---

## Performance & standards

- ~170–200 KB per page uncompressed (much less with Cloudflare's Brotli), 10–14 requests, no third-party requests
  (fonts are self-hosted latin subsets; Turnstile loads only on the play gate).
- CSS/JS URLs are content-hashed (`?v=…`) so `_headers` caches them for a year.
- Looping decorative animations (sky twinkle, floating comet, orbit) are transform/opacity only and start on the
  visitor's first interaction; scroll reveals use CSS scroll-driven animations. `prefers-reduced-motion` disables all motion.
- Lighthouse (mobile, local): Performance 98–99, Accessibility 100, Best Practices 100, SEO 100.
- Security headers (CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP, frame protection) in `public/_headers`.

## Placeholders to fill in

- `content/games.json` — the three sample entries (`placeholder: true`).
- `content/news/` — the three sample posts.
- `content/team.json` — Haroon's bio line marked `[PLACEHOLDER…]`, LinkedIn/X links (`#`), photo; the three placeholder team members.
- `content/settings.json` — `contactEmail`/`pressEmail` (create the inboxes), `socials` URLs, press facts marked placeholder,
  `turnstileSiteKey` (test key), hero/about copy (personalise).
- `content/pages/privacy.md` — every highlighted `==PLACEHOLDER==` (template, not legal advice).
- `public/project-nova/play/` — placeholder demo build.

## Licences

Fonts: Fredoka and Nunito, SIL Open Font License 1.1 (self-hosted subsets from Google Fonts).
Logo and brand assets © Tiny Comet Studio.
