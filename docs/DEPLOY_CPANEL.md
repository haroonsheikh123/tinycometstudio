# Hosting the site on cPanel (Setup Node.js App)

This guide puts **everything**: the public site, the web-play gate, the admin panel, the `/api/v1` API, the database and
uploaded media, on ordinary cPanel shared hosting. It uses cPanel's **Setup Node.js App** feature, which runs Phusion
Passenger in the background. You don't need root access, a terminal or any build tools. Every step below is done by clicking in cPanel.

> Already on Cloudflare Pages? Nothing there changes. The same code still deploys to Cloudflare, so you can switch either way
> later (see [Moving between hosts](#moving-between-cpanel-and-cloudflare)).

**What you need**
- A cPanel hosting account with **Setup Node.js App** in the *Software* section. Most hosts that run CloudLinux have it.
  If you can't find it, ask your host to enable "Node.js Selector".
- Your domain pointed at the hosting (the host's nameservers, or an A record to the server's IP).
- 30–45 minutes.

**How it fits together**

```
visitor ──https──▶ Apache/LiteSpeed (cPanel) ──▶ Passenger ──▶ server.mjs (this repo)
                                                                 ├─ public/            pages, CSS, JS, images
                                                                 ├─ functions/ + lib/  admin, API, play gate (same code as Cloudflare)
                                                                 └─ ~/tinycomet-data/  PRIVATE: database, media uploads, .env, backups
```

Folders in your home directory:

| Folder | What | Public? |
| --- | --- | --- |
| `~/tinycomet-app` | the code from GitHub (the "application root") | no |
| `~/tinycomet-data` | database file (SQLite), uploaded media, `.env` with secrets, backups, cache | **no, never put it in public_html** |
| `~/public_html` | only the `.htaccess` that cPanel writes for the app (and `.well-known` for SSL) | yes |

---

## Step 1: Choose the database

Pick **one**:

| | **MySQL / MariaDB** (recommended for cPanel) | **SQLite file** |
| --- | --- | --- |
| Works on | every Node version cPanel offers (18, 20, 22…) | Node **22.13 or newer** only |
| Setup | create a database + user (below) | nothing |
| Backups | cPanel *Backup* + phpMyAdmin export | included in the home-directory backup |
| Good to know | most robust choice on shared hosting | one file, very fast; avoid if your host keeps home folders on network storage |

**MySQL in cPanel → Databases → MySQL® Databases** (or **Manage My Databases**):
1. *Create New Database*: type `tinycomet` and click **Create Database**. cPanel adds your username in front, e.g. `myuser_tinycomet`.
2. *MySQL Users → Add New User*: username `tinycomet` (it becomes `myuser_tinycomet`), click **Password Generator**, copy the
   password somewhere safe, then click **Create User**.
3. *Add User To Database*: pick the user and the database, click **Add**, tick **ALL PRIVILEGES**, then click **Make Changes**.
4. Your connection string is:
   ```
   mysql://myuser_tinycomet:THE_PASSWORD@localhost:3306/myuser_tinycomet
   ```
   If the password contains `@ # / : ? %`, URL-encode them: `@` → `%40`, `#` → `%23`, `/` → `%2F`, `:` → `%3A`, `?` → `%3F`, `%` → `%25`.
   (Or use the separate variables `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, which need no encoding.)

The tables are created automatically when the app starts (Step 6).

## Step 2: Get the code onto the server

Choose **A** (easiest to update later), **B** or **C**.

**A. cPanel → Files → Git™ Version Control → Create**
1. Turn on **Clone a Repository**.
2. *Clone URL*: `https://github.com/haroonsheikh123/tinycometstudio.git`
   - The repository is **private**? Then use the SSH URL `git@github.com:haroonsheikh123/tinycometstudio.git`. First, in
     cPanel → **Security → SSH Access → Manage SSH Keys → Generate a New Key** (no passphrase), click **View/Download** on the
     public key, and add it in GitHub → repo → **Settings → Deploy keys → Add deploy key** (read-only).
3. *Repository Path*: `tinycomet-app`. *Repository Name*: `Tiny Comet Studio`. Click **Create**.
4. Branch: on the repository's **Manage** page pick the branch you want to run (`main` once the admin-panel PR is merged), then click **Update**.

**B. Upload a zip:** on GitHub, **Code → Download ZIP**. Then in cPanel → **File Manager** create the folder `tinycomet-app` in
your home directory, **Upload** the zip into it, right-click it, choose **Extract**, and move the files out of the extracted sub-folder so
`server.mjs` sits directly in `~/tinycomet-app`.

**C. Automatic deploys from GitHub Actions:** see [Automatic deploys](#automatic-deploys-with-github-actions-optional). Do a
first manual install with A or B, then let the workflow handle updates.

## Step 3: Create the Node.js app

cPanel → **Software → Setup Node.js App → Create Application**:

| Field | Value |
| --- | --- |
| **Node.js version** | the highest offered (22.x is ideal; 18 or 20 work with MySQL) |
| **Application mode** | Production |
| **Application root** | `tinycomet-app` (the folder from Step 2) |
| **Application URL** | your domain, e.g. `tinycometstudio.com`, with the path left **empty** (the app serves the whole site) |
| **Application startup file** | `server.mjs`. If the app later fails with *"require() of ES Module"*, change it to `app.cjs`. |
| **Passenger log file** (if shown) | `/home/YOURUSER/tinycomet-data/passenger.log` |

Click **Create**. cPanel writes a small `.htaccess` into `public_html` that hands every request to the app. **Leave that file in place**
(see [Troubleshooting](#the-htaccess-file)). If `public_html` still has an old `index.html` or other site files, move them out:
Apache serves real files from `public_html` before the app sees the request.

## Step 4: Set the environment variables

Still on the app's page, under **Environment variables**, click **Add Variable** for each:

| Name | Value |
| --- | --- |
| `DB_DRIVER` | `mysql` (or `sqlite`) |
| `DATABASE_URL` | the `mysql://…` string from Step 1 (skip for SQLite) |
| `SITE_URL` | `https://tinycometstudio.com` |
| `TURNSTILE_SECRET` | your Turnstile secret key (Cloudflare dashboard → **Turnstile**, free; add your domain to the widget) |

Then click **Save**.

You don't need to type `SIGNING_KEY`, `ENCRYPTION_KEY` or `SETUP_TOKEN`: the setup script in Step 6 generates strong ones
and stores them in `~/tinycomet-data/.env`. That file is also read by the cron job, which doesn't see the variables on this screen. If you
prefer, you can add them here instead (values on this screen always win over the file). Every option is listed in
[`.env.example`](../.env.example).

⚠ Don't change `SIGNING_KEY` or `ENCRYPTION_KEY` once the site is live. Changing `SIGNING_KEY` signs everyone out and breaks audit-log
verification. Losing `ENCRYPTION_KEY` means everyone has to set up their authenticator app again.

## Step 5: Install the dependencies

On the app's page, click **Run NPM Install** and wait for the success message. It installs one small, pure-JavaScript package (`mysql2`)
with nothing to compile.

## Step 6: Create the tables, import content and generate secrets

On the app's page, find **Run JS script**, choose **`setup`** and click **Run JS script**. The output shows:

```
✔ Generated SIGNING_KEY, ENCRYPTION_KEY, SETUP_TOKEN in /home/you/tinycomet-data/.env
✔ Database ready (MySQL/MariaDB) — created tables (0001_init.sql, 0002_builtin_roles.sql)
✔ Imported the site's content (games, news, team, pages)
Next steps: … setup token: 1cad12…   … Cron job: cd /home/you/tinycomet-app && /home/you/nodevenv/tinycomet-app/22/bin/node tools/tick.mjs …
```

**Copy the setup token and the cron line.** You'll need both shortly. Running `setup` again is safe: it never replaces existing
secrets or content.

Other scripts in the same menu: `migrate` (update the database after code updates), `seed` (import `content/` again; it only adds
missing items), `tick` (run housekeeping now), `backup` (database backup) and `start`.

*With SSH instead:* copy the "Enter to the virtual environment" command from the top of the app's page, run it, then run `npm run setup`.

## Step 7: Restart the app

Click **Restart** (or **Stop App** then **Start App**). Open your domain: the home page should load. Also check
`https://your-domain/api/v1/health`, which should show `"ok": true`.

## Step 8: Point the domain at the app

If the domain already shows the site, you're done with this step. Otherwise:
- The domain must be the account's main domain, or an *addon domain* in **Domains**. Its **document root** is the folder whose
  `.htaccess` cPanel edited in Step 3 (usually `public_html`).
- DNS: at your registrar, use the host's nameservers, or an `A` record for `@` and `www` pointing to the server IP (cPanel
  sidebar → *Shared IP Address*). DNS changes can take a few hours.
- `www`: in **Domains**, make sure `www.yourdomain` is listed. The app answers on both. Turn on *Force HTTPS Redirect* (Step 9).

## Step 9: Turn on HTTPS

1. cPanel → **Security → SSL/TLS Status**: tick your domain (and `www.`) and click **Run AutoSSL**. It's free and renews itself.
2. cPanel → **Domains**: switch **Force HTTPS Redirect** on for the domain.

The admin sign-in cookies are `Secure`, so **the admin only works over https://**.

## Step 10: Set up the cron job (scheduled posts and housekeeping)

cPanel → **Advanced → Cron Jobs → Add New Cron Job**:
- *Common Settings*: **Once Per Five Minutes** (`*/5 * * * *`)
- *Command*: the line printed by `setup` in Step 6. It looks like:
  ```
  cd /home/YOURUSER/tinycomet-app && /home/YOURUSER/nodevenv/tinycomet-app/22/bin/node tools/tick.mjs >> /home/YOURUSER/tinycomet-data/tick.log 2>&1
  ```
  (`22` is the Node version you chose. If your host doesn't show the full path, run `setup` again and copy it from there.)

The cron job publishes scheduled news posts on time, retries webhooks and deletes expired sign-in tokens. Even without it, a scheduled post
goes live on the **first visit** after its time, and the app also does this housekeeping every 5 minutes while it's awake.

*Alternative (also works on Cloudflare):* create an API key with the **system:manage** scope in the admin and use
`curl -fsS -X POST -H "Authorization: Bearer tck_…" https://tinycometstudio.com/api/v1/system/tick` as the cron command.

## Step 11: Backups

- **cPanel → Files → Backup**: *Download a Home Directory Backup* includes `~/tinycomet-data` (SQLite database, media, `.env`)
  and the app. For MySQL, also use *Download a MySQL Database Backup*. Many hosts also keep automatic copies (JetBackup, "Backup Wizard").
- **Daily database backup cron** (keeps the newest 14 in `~/tinycomet-data/backups/`). Add a second cron job, *Once Per Day*:
  ```
  cd /home/YOURUSER/tinycomet-app && /home/YOURUSER/nodevenv/tinycomet-app/22/bin/node tools/backup.mjs >> /home/YOURUSER/tinycomet-data/backup.log 2>&1
  ```
  SQLite backups are `.db` files. MySQL backups are `.sql` files you can restore in **phpMyAdmin → Import**.
- Download `~/tinycomet-data/.env` once and keep it somewhere safe, such as a password manager. Without `ENCRYPTION_KEY`, a restored database
  can't decrypt the authenticator secrets.

## Step 12: Create your admin account

Open **`https://tinycometstudio.com/admin/setup`**, paste the **setup token** from Step 6, then enter your name, email and a strong
password. Scan the QR code with an authenticator app (Google Authenticator, 1Password, Authy…). **Save the 10 recovery codes.** Setup switches
itself off afterwards. Then:
- **Site settings**: replace the Turnstile *test* site key (`1x00000000000000000000AA`) with your real site key.
- **Users → Invite** your team. **API keys** are for apps and automation.

## Step 13 (optional): Cloudflare DNS in front, for free speed and protection

You can keep hosting on cPanel and still use Cloudflare's free CDN, DDoS protection and visitor-country analytics:
1. Add the site at dash.cloudflare.com (Free plan) and change the nameservers at your registrar to Cloudflare's.
2. DNS records `@` and `www` → the cPanel server IP, **Proxied** (orange cloud).
3. **SSL/TLS → Overview → Full (strict)**. AutoSSL's certificate on the server makes this work.
4. Add the app variable **`TRUST_CLOUDFLARE` = `true`** and restart. The audit log and analytics then get the real visitor IP and
   country from Cloudflare. The app only trusts those headers when the request really comes from a Cloudflare address.
5. Optional: `CF_ZONE_ID` + `CF_API_TOKEN` (a token with *Cache Purge* permission) also purge Cloudflare's cache when you edit content.

Without Cloudflare in front, the country and city fields in the audit log simply stay empty.

---

## Email (optional): hello@ and press@ with cPanel mailboxes

1. cPanel → **Email → Email Accounts → Create**: `hello@yourdomain` (and `press@`, or make that a *Forwarder* to hello@).
2. The site shows these addresses from **Admin → Site settings** (contact and press email).
3. The admin can **email invites and password-reset links**, which is off by default. Click **Connect Devices** next to the mailbox to see the
   SMTP settings, then add these app variables and restart:

   | Name | Value |
   | --- | --- |
   | `SMTP_HOST` | e.g. `mail.yourdomain.com` |
   | `SMTP_PORT` | `465` |
   | `SMTP_SECURE` | `true` |
   | `SMTP_USER` | `hello@yourdomain.com` |
   | `SMTP_PASSWORD` | the mailbox password |
   | `EMAIL_FROM` | `Tiny Comet Studio <hello@yourdomain.com>` |

   Without these settings, the admin shows each invite or reset link once so you can send it yourself.
   For better deliverability, turn on **Email → Email Deliverability** (SPF/DKIM) for the domain.

## Updating the site

**With Git Version Control (A):** cPanel → **Git™ Version Control → Manage → Pull or Deploy → Update from Remote**. Then, on the
Node.js app page: **Run NPM Install** (only needed if `package.json` changed) → **Run JS script → `migrate`** → **Restart**.

**With SSH:** `cd ~/tinycomet-app && bash tools/deploy.sh`. It pulls, installs, backs up and migrates the database, then restarts
(Passenger restarts when `tmp/restart.txt` is touched).

**With a zip (B):** upload and extract the new version over the old one in `~/tinycomet-app`, then follow the same three clicks.
Your data is safe because it lives in `~/tinycomet-data`, not in the app folder.

Content edits made in the admin are live instantly and need no deploy. The public pages are re-rendered and the page cache
is cleared on every save.

### Automatic deploys with GitHub Actions (optional)

[`.github/workflows/deploy-cpanel.yml`](../.github/workflows/deploy-cpanel.yml) runs the tests and then deploys on every push to
`main`. It **does nothing until you switch it on**:
- GitHub → repo → **Settings → Secrets and variables → Actions → Variables**: `CPANEL_DEPLOY` = `ssh` (or `ftp`).
- **SSH** (best; needs SSH access on your plan, which you can enable in cPanel → *SSH Access*): add the secrets `CPANEL_HOST`, `CPANEL_USER`,
  `CPANEL_SSH_KEY` (a private key whose public half is authorised in cPanel → SSH Access → Manage SSH Keys). Optional secrets are
  `CPANEL_SSH_PORT` and `CPANEL_APP_DIR`. The server needs the Git clone from Step 2A. The workflow runs `tools/deploy.sh`.
- **FTP**: add the secrets `CPANEL_FTP_SERVER`, `CPANEL_FTP_USERNAME`, `CPANEL_FTP_PASSWORD`, and optionally `CPANEL_FTP_DIR`. FTP can only upload files, so afterwards click
  *Run NPM Install*, then *migrate*, then *Restart* in cPanel.

---

## Troubleshooting

**The site shows "We're sorry, but something went wrong" or "Incomplete response received from application".**
The app crashed while starting. Open the log: the *Passenger log file* from Step 3, or `stderr.log` in `~/tinycomet-app`
(File Manager). The app writes one JSON line per event, and the last lines usually say exactly what's wrong:
- `startup failed … DB_DRIVER=mysql needs DATABASE_URL`: check Step 4.
- `Access denied for user`: wrong MySQL user or password, or the user wasn't added to the database (Step 1.3).
- `node:sqlite is not available in Node 18…`: pick Node 22 on the app page, or switch to MySQL.
- `require() of ES Module … server.mjs not supported`: change the startup file to **`app.cjs`** and restart.
- `Cannot find module 'mysql2'`: click **Run NPM Install**.
After fixing, click **Restart**.

**The home page works but `/admin` won't let me sign in.** Use `https://` (Step 9): sign-in cookies only work over HTTPS. If you
use Cloudflare in front, set SSL mode to *Full (strict)*, not *Flexible*.

**The old site, or a cPanel placeholder page, shows instead of the app.** Remove `index.html`, `index.php` or `default.html` from
`public_html` (keep `.htaccess` and `.well-known`).

<a id="the-htaccess-file"></a>**The `.htaccess` file.** When you create the app, cPanel adds a block like this to `public_html/.htaccess`:
```
# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN
PassengerAppRoot "/home/you/tinycomet-app"
PassengerBaseURI "/"
PassengerNodejs "/home/you/nodevenv/tinycomet-app/22/bin/node"
PassengerAppType node
PassengerStartupFile server.mjs
# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END
```
Don't edit or delete it. cPanel rewrites it whenever you change the app's settings. Other rules (like a WordPress block) must not
come before it. If the file was deleted, open the app page and click **Save** to rebuild it.

**Permissions (EACCES errors).** The app must be able to write to `~/tinycomet-data`. It creates the folder itself with mode
700, which only your account can read. If you created it by hand, set it to 700 in File Manager (right-click → *Change Permissions*).
Keep `.env` at 600. Never put the data folder inside `public_html`.

**Game build or media uploads fail with 413 / "Request Entity Too Large".** The app accepts up to 110 MB (`MAX_BODY_MB`), but some hosts
cap uploads lower in Apache or LiteSpeed, or in ModSecurity. Ask your host to raise the request-body limit for your domain, or upload smaller
builds. Unzipping a 100 MB build briefly needs about 300 MB of RAM, which may exceed small CloudLinux plan limits. If uploads die
halfway, check the host's *Resource Usage* page.

**Requests to the admin API are blocked with 403 by the server.** Some hosts' ModSecurity rules mistake API requests for attacks.
Try cPanel → **Security → ModSecurity** → turn it off for this domain, or ask your host to whitelist `/api/v1/`.

**The first visit after a quiet period is slow (about 1 s).** Passenger stops idle apps to save memory and starts them on the next visit.
Normal pages are fast after that.

**Times look wrong, or scheduled posts are late.** Check that the cron job is running: `~/tinycomet-data/tick.log` should gain a line
every 5 minutes.

**I want to see more detail.** Add `LOG_LEVEL=debug` and `LOG_REQUESTS=true`, restart, and the log lists every request.

---

## Moving between cPanel and Cloudflare

The code is the same on both. Only the "bindings" differ:

| | cPanel / Node | Cloudflare Pages |
| --- | --- | --- |
| database | SQLite file or MySQL (`lib/platform/db/`) | D1 |
| media / builds | `~/tinycomet-data/media` (`lib/platform/storage/fs-bucket.js`) | R2 |
| page cache | memory + `~/tinycomet-data/cache` (`lib/platform/cache.js`) | edge Cache API |
| `_headers`, `_redirects`, `_routes.json` | applied by `server.mjs` | applied by Cloudflare |
| cron | cPanel Cron Jobs → `tools/tick.mjs` | any external cron → `POST /api/v1/system/tick` |
| secrets | app variables / `~/tinycomet-data/.env` | Pages → Settings → Variables and Secrets |

To move content, use the admin's **Export** (or `node tools/content-sync.mjs pull`) on one side and **Import** on the other. Users,
API keys and the audit log are host-specific, so invite your team again after a move.
**Passwords:** the Node host hashes passwords more strongly (600 000 PBKDF2 rounds) than Cloudflare Workers allows (100 000).
Before moving *to* Cloudflare, set `PBKDF2_ITERATIONS=100000` on cPanel and have everyone sign in once, or reset passwords afterwards.

For developers: [`docs/HOSTING_PROGRESS.md`](HOSTING_PROGRESS.md) has the design notes and test matrix.
