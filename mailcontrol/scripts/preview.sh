#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/setup-preview-db.sh
if [ ! -d node_modules ]; then npm ci --no-fund --no-audit; fi
set -a
source .local/preview.env
set +a
unset DATABASE_URL
if [ -f .local/preview-origin ]; then
  export MAILCONTROL_ALLOWED_ORIGINS="$(cat .local/preview-origin)"
fi
export MAILCONTROL_ARCHIVE_PATH="$PWD/.local/releases/MailControl-M1.zip"
npm run build
exec node dist/server/main.js
