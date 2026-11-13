#!/usr/bin/env bash
# Update the site on a cPanel server over SSH:  bash tools/deploy.sh
# (also what the opt-in GitHub Actions workflow runs on the server).
#   1. pull the latest code (fast-forward only — never overwrites local edits silently)
#   2. install production dependencies with the app's own Node (cPanel's nodevenv)
#   3. back up + migrate the database
#   4. restart the app (Passenger watches tmp/restart.txt)
# Options (env): APP_DIR (default: this repo), BRANCH (default: current branch), NODEVENV (path to …/bin/activate)
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$APP_DIR"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

# cPanel creates ~/nodevenv/<app-root>/<version>/bin/activate for each Node.js app — use it if present.
if [ -z "${NODEVENV:-}" ]; then
  rel="${APP_DIR#"$HOME"/}"
  NODEVENV="$(ls -d "$HOME/nodevenv/$rel"/*/bin/activate 2>/dev/null | sort -V | tail -n1 || true)"
fi
if [ -n "${NODEVENV:-}" ] && [ -f "$NODEVENV" ]; then
  # shellcheck disable=SC1090
  source "$NODEVENV"
  echo "• Using $(node --version) from $NODEVENV"
else
  echo "• Using $(node --version) from PATH"
fi

echo "• Pulling $BRANCH"
git fetch --quiet origin "$BRANCH"
git merge --ff-only "origin/$BRANCH"

echo "• Installing dependencies"
# In a cPanel app node_modules is a symlink into the nodevenv: use `npm install` (npm ci would delete the symlink).
npm install --omit=dev --no-audit --no-fund

echo "• Backing up and migrating the database"
node tools/backup.mjs || echo "  (backup skipped: $?)"
node tools/migrate.mjs

echo "• Restarting"
mkdir -p tmp && touch tmp/restart.txt
echo "✔ Deployed $(git rev-parse --short HEAD) — Passenger restarts the app on the next request."
