#!/usr/bin/env bash
# Linux/dev equivalent of RESTORE.cmd. Replaces the target database content and the key file.
set -euo pipefail
cd "$(dirname "$0")/.."
dump="$1"; key="$2"
psql -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
pg_restore --no-owner --no-privileges -d "${PGDATABASE:?}" "$dump"
psql -v ON_ERROR_STOP=1 -q -f docker/db/after-restore.sql
mkdir -p "${MAILCONTROL_DATA_DIR:-.local/data}"
install -m 600 "$key" "${MAILCONTROL_DATA_DIR:-.local/data}/mailcontrol.key"
echo "Restore complete: running campaigns are paused, in-flight sends are unclear."
