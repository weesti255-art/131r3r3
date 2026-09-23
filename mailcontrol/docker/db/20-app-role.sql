-- Runs once, only while the data volume is still empty.
-- PostgreSQL 16 refuses to demote the bootstrap superuser, so the application
-- gets its own restricted role instead. Names must match compose.yaml.
\getenv app_password POSTGRES_PASSWORD
CREATE ROLE mailcontrol LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER DATABASE mailcontrol OWNER TO mailcontrol;
