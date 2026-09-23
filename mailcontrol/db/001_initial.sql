CREATE TABLE app_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL CHECK (mode IN ('local', 'demo')),
  demo_seed_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_groups (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  color text NOT NULL CHECK (color IN ('blue', 'violet', 'teal', 'amber')),
  limit_count integer NOT NULL CHECK (limit_count > 0),
  period_hours integer NOT NULL CHECK (period_hours > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_groups_name_unique ON account_groups (lower(name));

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  group_id uuid NOT NULL REFERENCES account_groups(id),
  provider text NOT NULL DEFAULT 'mail' CHECK (provider = 'mail'),
  health_status text NOT NULL DEFAULT 'unverified'
    CHECK (health_status IN ('active', 'auth_error', 'needs_check', 'disabled', 'unverified')),
  limit_count integer NOT NULL CHECK (limit_count > 0),
  period_hours integer NOT NULL CHECK (period_hours > 0),
  is_demo boolean NOT NULL CHECK (is_demo),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_group_id_idx ON accounts(group_id);
CREATE INDEX accounts_health_status_idx ON accounts(health_status);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL UNIQUE,
  group_id uuid NOT NULL REFERENCES account_groups(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  subject text NOT NULL DEFAULT '' CHECK (length(subject) <= 240),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 50000),
  sender_name text NOT NULL DEFAULT '' CHECK (length(sender_name) <= 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_updated_at_idx ON campaigns(updated_at DESC, id);
CREATE INDEX campaigns_group_id_idx ON campaigns(group_id);

CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('group_created', 'draft_created', 'draft_updated', 'demo_seeded')),
  title text NOT NULL,
  detail text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('group', 'campaign', 'system')),
  entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_created_at_idx ON events(created_at DESC, id DESC);
CREATE INDEX events_entity_idx ON events(entity_type, entity_id);
