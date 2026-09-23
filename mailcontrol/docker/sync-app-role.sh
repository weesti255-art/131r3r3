#!/usr/bin/env bash
# Runs inside the db container on every start (see scripts/launch.cmd and
# scripts/compose-up.sh). The application role must match POSTGRES_PASSWORD
# from .env even when the data volume was created with an older .env or by an
# older release whose bootstrap role was "mailcontrol" itself.
set -euo pipefail
if psql -U mailcontrol_admin -d postgres -Atqc 'SELECT 1' >/dev/null 2>&1; then
  admin=mailcontrol_admin
else
  admin=mailcontrol
fi
psql -v ON_ERROR_STOP=1 -q -U "$admin" -d postgres <<'SQL'
\getenv app_password POSTGRES_PASSWORD
SELECT format('CREATE ROLE mailcontrol LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailcontrol') \gexec
ALTER ROLE mailcontrol WITH LOGIN PASSWORD :'app_password';
SQL
echo "Application database role is in sync with .env."
