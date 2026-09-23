-- M2–M5: encrypted account access, sliding quotas, persistent queue,
-- attempts, worker heartbeats, settings and richer events.

ALTER TABLE app_settings
  ADD COLUMN retry_max_attempts integer NOT NULL DEFAULT 3 CHECK (retry_max_attempts BETWEEN 0 AND 20),
  ADD COLUMN retry_base_minutes integer NOT NULL DEFAULT 30 CHECK (retry_base_minutes BETWEEN 1 AND 1440),
  ADD COLUMN retry_max_minutes integer NOT NULL DEFAULT 120 CHECK (retry_max_minutes BETWEEN 1 AND 10080),
  ADD COLUMN sender_kind text NOT NULL DEFAULT 'test' CHECK (sender_kind IN ('test', 'mail')),
  ADD COLUMN test_sender_delay_ms integer NOT NULL DEFAULT 300 CHECK (test_sender_delay_ms BETWEEN 0 AND 60000),
  ADD COLUMN reservation_seconds integer NOT NULL DEFAULT 120 CHECK (reservation_seconds BETWEEN 10 AND 3600),
  ADD COLUMN heartbeat_stale_seconds integer NOT NULL DEFAULT 90 CHECK (heartbeat_stale_seconds BETWEEN 15 AND 3600),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE accounts DROP CONSTRAINT accounts_is_demo_check;
ALTER TABLE accounts
  ADD COLUMN password_ciphertext text,
  ADD COLUMN password_key_id text,
  ADD COLUMN manual_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_reason text,
  ADD COLUMN connection_status text NOT NULL DEFAULT 'unverified'
    CHECK (connection_status IN ('unverified', 'ok', 'auth_error', 'needs_check', 'blocked', 'temporary_error')),
  ADD COLUMN connection_error text,
  ADD COLUMN connection_checked_at timestamptz,
  ADD COLUMN cooldown_until timestamptz,
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE accounts SET
  connection_status = CASE health_status
    WHEN 'active' THEN 'ok'
    WHEN 'auth_error' THEN 'auth_error'
    WHEN 'needs_check' THEN 'needs_check'
    ELSE 'unverified' END,
  manual_disabled = (health_status = 'disabled'),
  disabled_at = CASE WHEN health_status = 'disabled' THEN now() END,
  disabled_reason = CASE WHEN health_status = 'disabled' THEN 'Отключён вручную' END;
DROP INDEX accounts_health_status_idx;
ALTER TABLE accounts DROP COLUMN health_status;
ALTER TABLE accounts ADD CONSTRAINT accounts_password_consistent
  CHECK ((password_ciphertext IS NULL) = (password_key_id IS NULL));
ALTER TABLE accounts ADD CONSTRAINT accounts_real_have_password
  CHECK (is_demo OR password_ciphertext IS NOT NULL);
CREATE INDEX accounts_connection_status_idx ON accounts(connection_status);
CREATE INDEX accounts_group_available_idx ON accounts(group_id, manual_disabled, connection_status);

ALTER TABLE campaigns DROP CONSTRAINT campaigns_status_check;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_status_check CHECK (status IN
    ('draft', 'running', 'paused', 'stopped', 'completed', 'completed_with_errors')),
  ADD COLUMN is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN pause_reason text,
  ADD COLUMN wait_reason text,
  ADD COLUMN wait_until timestamptz;
CREATE INDEX campaigns_status_idx ON campaigns(status, started_at);

CREATE TABLE tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  email text NOT NULL,
  position integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'reserved', 'sending', 'accepted', 'failed', 'unclear',
     'cancelled', 'excluded', 'closed_unconfirmed')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  owner_worker_id uuid,
  owner_token uuid,
  reserved_until timestamptz,
  account_id uuid REFERENCES accounts(id),
  last_error_code text,
  last_error text,
  finished_at timestamptz,
  resolved_by_operator boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, email)
);
CREATE INDEX tasks_queue_idx ON tasks(campaign_id, status, next_attempt_at, position);
CREATE INDEX tasks_status_idx ON tasks(status);
CREATE INDEX tasks_account_idx ON tasks(account_id) WHERE status IN ('reserved', 'sending');

CREATE TABLE attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  number integer NOT NULL,
  worker_id uuid NOT NULL,
  owner_token uuid NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('accepted', 'rejected', 'unknown')),
  error_category text,
  error_code text,
  error_message text,
  operator_decision text CHECK (operator_decision IN ('accepted', 'failed', 'closed')),
  late_outcome text,
  late_message text,
  late_at timestamptz,
  UNIQUE (task_id, number)
);
CREATE INDEX attempts_account_active_idx ON attempts(account_id) WHERE finished_at IS NULL;
CREATE INDEX attempts_campaign_idx ON attempts(campaign_id, started_at DESC);

CREATE TABLE quota_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  task_id bigint REFERENCES tasks(id),
  attempt_id bigint REFERENCES attempts(id),
  state text NOT NULL CHECK (state IN ('reserved', 'accepted', 'possible', 'released')),
  occupied_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_usage_account_idx ON quota_usage(account_id, state, occupied_at);
CREATE UNIQUE INDEX quota_usage_attempt_unique ON quota_usage(attempt_id) WHERE attempt_id IS NOT NULL;

CREATE TABLE workers (
  id uuid PRIMARY KEY,
  hostname text NOT NULL,
  pid integer NOT NULL,
  sender_kind text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz
);

CREATE TABLE import_requests (
  request_key uuid PRIMARY KEY,
  kind text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE events DROP CONSTRAINT events_kind_check;
ALTER TABLE events DROP CONSTRAINT events_entity_type_check;
ALTER TABLE events
  ADD COLUMN level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'error')),
  ADD COLUMN campaign_id uuid,
  ADD COLUMN account_id uuid,
  ADD COLUMN task_id bigint,
  ADD COLUMN attempt_id bigint;
UPDATE events SET campaign_id = entity_id WHERE entity_type = 'campaign';
CREATE INDEX events_campaign_idx ON events(campaign_id, created_at DESC) WHERE campaign_id IS NOT NULL;
CREATE INDEX events_account_idx ON events(account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX events_level_idx ON events(level, created_at DESC);

-- Sliding-window quota helpers. "at" is passed by the application clock so tests
-- can move time without waiting; reserved slots always count.
CREATE FUNCTION quota_used(account uuid, period_hours integer, at timestamptz) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM quota_usage q
  WHERE q.account_id = account
    AND (q.state = 'reserved'
      OR (q.state IN ('accepted', 'possible')
          AND q.occupied_at > at - make_interval(hours => period_hours)
          AND q.occupied_at <= at))
$$;

CREATE FUNCTION quota_next_free(account uuid, limit_count integer, period_hours integer, at timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN quota_used(account, period_hours, at) < limit_count THEN NULL
    ELSE (
      SELECT q.occupied_at + make_interval(hours => period_hours) FROM quota_usage q
      WHERE q.account_id = account AND q.state IN ('accepted', 'possible')
        AND q.occupied_at > at - make_interval(hours => period_hours) AND q.occupied_at <= at
      ORDER BY q.occupied_at
      OFFSET greatest(quota_used(account, period_hours, at) - limit_count, 0) LIMIT 1)
  END
$$;
