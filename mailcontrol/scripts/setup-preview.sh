#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/setup-preview-db.sh
npm ci --no-fund --no-audit
