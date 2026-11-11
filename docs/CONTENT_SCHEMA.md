# Content schema

All site content lives in `content/`. `node tools/build.mjs` validates it
(`tools/render/validate.mjs`) and renders static pages into `public/`.
The schema is deliberately flat and JSON-friendly; with the admin panel set up it lives in Cloudflare D1
(see `migrations/0001_init.sql`, docs/ADMIN.md) and `tools/content-sync.mjs pull` writes it back to these files.

| Source | Shape | Suggested D1 table |
| --- | --- | --- |
| `content/settings.json` | one object | `settings` (key/value or a single JSON row) |
| `content/games.json` | array of Game | `games` (one row per game, arrays/objects as JSON columns) |
| `content/team.json` | array of Member | `team` |
| `content/news/*.md` | front-matter + Markdown body | `news` (front-matter fields as columns, `body` TEXT) |
| `content/pages/*.md` | front-matter + Markdown body | `pages` |

Conventions used everywhere:

- **Slugs/ids**: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`. Game ids are top-level URL paths, so these are reserved:
  `admin, api, assets, css, js, news, press, privacy, play, functions, 404, index, feed, sitemap, robots, manifest, favicon, cdn-cgi, fonts`.
- **Links**: `""` = not set (hidden), `"#"` = placeholder (shown dimmed / dummy), `https://…` = live.
- **Images**: root-relative paths under `public/`, e.g. `/assets/games/<id>/cover.webp`. Empty string → generated placeholder art.
- **Dates**: `YYYY-MM-DD` (news requires a full date; games accept `YYYY`, `YYYY-MM` or `YYYY-MM-DD`).
- **`placeholder: true`** marks sample content; it renders a visible "Sample"/"Placeholder" tag.

## settings.json

| Field | Type | Notes |
| --- | --- | --- |
| `studioName` | string | required |
| `shortName` | string | PWA short name |
| `siteUrl` | string | `https://tinycometstudio.com` — no trailing slash. Used for canonical/OG/sitemap/RSS. |
| `tagline` | string | used in the home `<title>` |
| `description` | string | default meta description |
| `country` | string | footer "Made with ☄ in …" |
| `contactEmail` | string | required; contact section, form, privacy page (`{{contactEmail}}`) |
| `pressEmail` | string | press kit contact |
| `turnstileSiteKey` | string | Cloudflare Turnstile **site** key (public). Test key `1x00000000000000000000AA` always passes. |
| `analyticsEndpoint` | string | `""` = analytics off. `/api/v1/collect` = the built-in cookie-free analytics (see docs/ADMIN.md). |
| `socials[]` | `{ id, label, url }` | `id` picks the icon: itch, steam, googleplay, appstore, x, instagram, youtube, discord, github, linkedin, facebook |
| `hero` | `{ eyebrow, titleLine1, titleLine2, lead }` | home hero copy |
| `about` | `{ title, lead, paragraphs[] }` | home About copy (`[PLACEHOLDER: …]` text is highlighted) |
| `expertise[]` | `{ icon, title, text }` | "What we do" strip; icon: phone, gamepad, layers, palette, rocket |
| `press` | `{ facts[]: { label, value, placeholder? }, boilerplate }` | press kit fact sheet |

## games.json — Game

| Field | Type | Req. | Notes |
| --- | --- | --- | --- |
| `id` | slug | ✔ | URL `/<id>/`, assets `/assets/games/<id>/` |
| `title` | string | ✔ | |
| `tagline` | string | | card + meta description |
| `kind` | `"Game"` \| `"App"` | | JSON-LD `VideoGame` vs `SoftwareApplication` |
| `status` | `"coming-soon"` \| `"in-development"` \| `"released"` | ✔ | |
| `platforms[]` | `android, ios, steam, itch, web` | | platform chips; for unreleased games also "coming soon" badges |
| `genres[]` | string | | |
| `colors` | `[hex, hex]` | | placeholder-art gradient |
| `releaseDate` | date string | | |
| `description` | string \| string[] | | paragraphs |
| `links` | `{ android, ios, steam, itch }` | | store URLs (badge rules below) |
| `webPlay` | `{ enabled: boolean }` | | shows "Play in browser" → `/<id>/play/` (Turnstile-gated). The real build lives in `public/<id>/play/`. |
| `cover` | path | | 16:9, 1600×900 |
| `screenshots[]` | path \| `{ src, alt }` | | |
| `trailer` | YouTube URL | | lite embed |
| `pressKitUrl` | URL | | optional per-game press kit link |
| `placeholder` | boolean | | sample entry |

Store badge rules: **released** → a badge for each store with a non-empty link;
**not released** → "Coming soon" badges for store platforms listed in `platforms` (no link).

## team.json — Member

| Field | Type | Notes |
| --- | --- | --- |
| `id` | slug | referenced by news `author` |
| `name`, `role` | string | |
| `featured` | boolean | exactly one featured member = the big founder card |
| `bio` | string \| string[] | |
| `photo` | path | square ≥ 400×400, e.g. `/assets/team/haroon.jpg`; empty → initials avatar |
| `links[]` | `{ label, url }` | label picks icon (GitHub, LinkedIn, X / Twitter, Instagram…) |
| `placeholder` | boolean | |

## news/*.md — Post

File name `YYYY-MM-DD-<slug>.md`. Front-matter (simple `key: value`, quoted strings, `true/false`, `[a, b]`):

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | required |
| `date` | `YYYY-MM-DD` | required (defaults to the file-name date) |
| `updated` | `YYYY-MM-DD` | optional |
| `slug` | slug | optional; default = file name without the date |
| `category` | `Announcement` \| `Devlog` \| `Release` \| `Update` \| `Press` | other values are allowed and get their own filter chip |
| `author` | team `id` | |
| `excerpt` | string | cards, meta description, RSS |
| `cover` | path | 2:1 works best; empty → placeholder art |
| `game` | game `id` | links post ↔ game page |
| `draft` | boolean | `true` = not published |
| `placeholder` | boolean | sample post |

Markdown supported: `#`–`######`, paragraphs, `**bold**`, `*italic*`, `` `code` ``, fenced code,
`>` quotes, `-`/`1.` lists, `[link](url)`, `![alt](src =1600x900 "caption")` (size optional),
`---`, `==highlight==`, and `{{youtube https://youtu.be/ID}}` on its own line. Raw HTML is escaped.

## Render API (`tools/render/index.mjs`)

All pure — plain objects in, strings out, no Node APIs — so they can run inside a Pages Function
(e.g. rendering from D1) as well as in `tools/build.mjs`.

| Function | Input | Output |
| --- | --- | --- |
| `renderHomePage({ settings, games, team, news, version })` | | `/index.html` |
| `renderGamePage({ settings, game, news, version })` | `news` = posts with `game === id` | `/<id>/index.html` |
| `renderGatePage({ settings, game, version })` | | `/<id>/gate/index.html` (served at `/<id>/play/`) |
| `renderNewsIndex({ settings, posts, version })` | sorted posts | `/news/index.html` |
| `renderNewsPost({ settings, post, author, game, related, version })` | | `/news/<slug>/index.html` |
| `renderPressPage({ settings, games, team, version })` | | `/press/index.html` |
| `renderMarkdownPage({ settings, source, path, version })` | raw `.md` text | e.g. `/privacy/index.html` |
| `render404Page({ settings, version })` | | `/404.html` |
| `renderSitemap / renderRss / renderRobots / renderManifest` | `{ settings, games?, posts? }` | XML / text / JSON |
| `renderLayout(opts)`, `renderFooter(settings)`, `sectionHead(opts)` | | page shell helpers |
| `parsePost(filename, source)`, `sortPosts(posts)`, `relatedPosts(post, posts)` | | post objects |
| `markdownToHtml`, `markdownToText`, `parseFrontMatter`, `interpolate` | | |
| `validateSettings`, `validateGames`, `validateTeam` | | `string[]` of problems |
| `components.*` | `gameCard`, `newsCard`, `storeBadges`, `storeEntries`, `playButton`, `cover`, `socialList`, `avatar`, `icon`, `formatDate`, … | HTML fragments |

## Analytics hook

`public/js/main.js` exports `track(event, props)` (also `window.tcTrack`). It is a no-op unless
`settings.analyticsEndpoint` is set (rendered as `<meta name="tc-analytics">`), and when
`navigator.doNotTrack === "1"` or `navigator.globalPrivacyControl` is true. No cookies, no IDs.

Each event is sent with `navigator.sendBeacon(endpoint, Blob(JSON))`:

```json
{ "event": "store_click", "props": { "game": "stardust-notes", "platform": "android" }, "path": "/stardust-notes/", "ref": "https://…", "ts": 1767225600000 }
```

Events: `page_view`, `news_read` (`props.slug`), `store_click` (`game`, `platform`), `play_click` (`game`),
`play_unlocked` (`game`, from the gate), `share_click` (`network`: x/facebook/linkedin/whatsapp/copy), `contact_open`.
Any element with `data-track="<event>"` (+ `data-game`, `data-platform`, `data-network`) is tracked on click.
Use a same-origin endpoint (e.g. a future `functions/api/track.js`) — the CSP's `connect-src` only allows `'self'`
and Cloudflare Turnstile.
