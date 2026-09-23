#!/usr/bin/env bash
# Wraps the stock postgres entrypoint. Once the real server accepts TCP
# connections, the application role password is synchronised with
# POSTGRES_PASSWORD from .env; the healthcheck waits for the marker.
set -euo pipefail
rm -f /tmp/mailcontrol-role-synced
(
  for _ in $(seq 1 300); do
    if pg_isready -h 127.0.0.1 -p "${PGPORT:-5432}" -q 2>/dev/null; then
      if bash /mailcontrol/sync-app-role.sh; then
        touch /tmp/mailcontrol-role-synced
      else
        echo "MailControl: application role sync failed; see messages above" >&2
      fi
      exit 0
    fi
    sleep 1
  done
  echo "MailControl: database did not start within 300 s, role sync skipped" >&2
) &
exec docker-entrypoint.sh "$@"
