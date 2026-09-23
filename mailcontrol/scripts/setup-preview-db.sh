#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PG_BIN="$( (find /usr/lib/postgresql -maxdepth 2 -type d -name bin 2>/dev/null || true) | sort -V | tail -1)"
if [ -z "$PG_BIN" ]; then
  if [ "$(id -u)" != 0 ] || ! command -v apt-get >/dev/null; then
    echo "PostgreSQL 16+ is required for the native Linux preview." >&2
    exit 1
  fi
  apt-get update -qq
  apt-get install -y --no-install-recommends postgresql postgresql-client
  PG_BIN="$(find /usr/lib/postgresql -maxdepth 2 -type d -name bin | sort -V | tail -1)"
fi

mkdir -p .local
chmod a+x "$PWD"
chmod 755 .local
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const existing = existsSync('.local/preview.env')
  ? Object.fromEntries(readFileSync('.local/preview.env', 'utf8').trim().split('\n').map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    })) : {};
if (!existsSync('.local/pg-admin.env')) {
  const upgrading = existsSync('.local/postgres/PG_VERSION');
  if (upgrading && (!existing.PGUSER || !existing.PGPASSWORD)) throw new Error('Missing bootstrap configuration');
  writeFileSync('.local/pg-admin.env', [
    `PGADMINUSER=${upgrading ? existing.PGUSER : 'mailcontrol_admin'}`,
    `PGADMINPASSWORD=${upgrading ? existing.PGPASSWORD : randomBytes(32).toString('hex')}`,
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
}
if (existing.PGUSER !== 'mailcontrol_app') {
  writeFileSync('.local/preview.env', [
    'PGHOST=127.0.0.1', 'PGPORT=55432', 'PGUSER=mailcontrol_app',
    `PGPASSWORD=${randomBytes(32).toString('hex')}`,
    'PGDATABASE=mailcontrol_demo', 'APP_MODE=demo',
    'HOST=0.0.0.0', 'PORT=5173', 'MAILCONTROL_PREVIEW=1', '',
  ].join('\n'), { mode: 0o600 });
}
JS
set -a
source .local/preview.env
set +a
source .local/pg-admin.env

admin_psql() {
  PGUSER="$PGADMINUSER" PGPASSWORD="$PGADMINPASSWORD" "$PG_BIN/psql" -v ON_ERROR_STOP=1 "$@"
}

DATA="$PWD/.local/postgres"
SOCKET="$PWD/.local/socket"
mkdir -p "$DATA" "$SOCKET"
run_pg() {
  if [ "$(id -u)" = 0 ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}
if [ "$(id -u)" = 0 ]; then
  chown postgres:postgres "$DATA" "$SOCKET"
fi
chmod 700 "$DATA" "$SOCKET"
if [ ! -f "$DATA/PG_VERSION" ]; then
  PWFILE="$PWD/.local/pg-bootstrap-password"
  (umask 077; printf '%s\n' "$PGADMINPASSWORD" > "$PWFILE")
  if [ "$(id -u)" = 0 ]; then chown postgres:postgres "$PWFILE"; fi
  trap 'rm -f "$PWFILE"' EXIT
  run_pg "$PG_BIN/initdb" -D "$DATA" -U "$PGADMINUSER" --encoding=UTF8 --locale=C.UTF-8 \
    --auth-host=scram-sha-256 --auth-local=peer --pwfile="$PWFILE" >/dev/null
  rm -f "$PWFILE"
  trap - EXIT
fi
if ! run_pg "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  run_pg "$PG_BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" \
    -o "-p $PGPORT -h 127.0.0.1 -k $SOCKET -c max_connections=30 -c shared_buffers=128MB" -w start
fi
admin_psql -d postgres -v app_password="$PGPASSWORD" >/dev/null <<'SQL'
SELECT 'CREATE ROLE mailcontrol_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailcontrol_app') \gexec
ALTER ROLE mailcontrol_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SELECT format('ALTER ROLE mailcontrol_app PASSWORD %L', :'app_password') \gexec
SELECT 'CREATE DATABASE mailcontrol_demo OWNER mailcontrol_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'mailcontrol_demo') \gexec
ALTER DATABASE mailcontrol_demo OWNER TO mailcontrol_app;
SQL
admin_psql -d mailcontrol_demo >/dev/null <<'SQL'
ALTER SCHEMA public OWNER TO mailcontrol_app;
DO $$ DECLARE relation record; BEGIN
  FOR relation IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO mailcontrol_app', relation.tablename);
  END LOOP;
END $$;
SQL
echo "Project-local PostgreSQL is ready on 127.0.0.1:$PGPORT (demo database only)."
