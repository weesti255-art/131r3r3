#!/usr/bin/env bash
# Linux/dev equivalent of BACKUP.cmd against a reachable PostgreSQL (PG* env) and MAILCONTROL_DATA_DIR.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-backups/mailcontrol-$(date -u +%Y%m%d-%H%M%S)}"
mkdir -p "$(dirname "$out")"
pg_dump -Fc -f "$out.dump"
cp "${MAILCONTROL_DATA_DIR:-.local/data}/mailcontrol.key" "$out.key"
chmod 600 "$out.key"
echo "Backup written: $out.dump and $out.key (keep both together, the key decrypts account passwords)."
