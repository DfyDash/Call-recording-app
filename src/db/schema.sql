-- CallTrove schema (prototype phase).
-- No encryption-at-rest / access-control columns yet -- that's phase 2 (HIPAA).

CREATE TABLE IF NOT EXISTS contacts (
  ghl_contact_id  TEXT PRIMARY KEY,
  name            TEXT,
  phone           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id                    UUID PRIMARY KEY,
  ghl_call_id           TEXT UNIQUE NOT NULL,
  ghl_contact_id        TEXT NOT NULL REFERENCES contacts(ghl_contact_id),
  direction             TEXT,
  duration_seconds      INTEGER,
  occurred_at           TIMESTAMPTZ,
  source_recording_url  TEXT,
  storage_key           TEXT,
  recording_status      TEXT NOT NULL DEFAULT 'pending',
  raw_payload           JSONB,
  handled_by_id         TEXT,
  handled_by_name       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ADD COLUMN IF NOT EXISTS so re-running this migration against a database
-- that already had the old calls/contacts tables (before handled_by_* or
-- the users table existed) still brings it up to date, not just fresh ones.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS handled_by_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS handled_by_name TEXT;

CREATE INDEX IF NOT EXISTS calls_contact_idx ON calls (ghl_contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS calls_handled_by_idx ON calls (handled_by_id);

-- Dashboard login accounts. Not linked to GHL's own user system (no OAuth
-- in this phase) -- an admin creates accounts here and maps each one to the
-- GHL user identity (handled_by_id) that appears on their calls.
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  ghl_user_id    TEXT,
  ghl_user_name  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row checkpoint for the polling-based ingestion (replaces the GHL
-- webhook/workflow entirely -- see src/poller.js). Tracks the newest call
-- dateAdded already processed, so each poll only looks at what's new.
CREATE TABLE IF NOT EXISTS sync_state (
  id              INT PRIMARY KEY DEFAULT 1,
  last_synced_at  TIMESTAMPTZ,
  CONSTRAINT sync_state_single_row CHECK (id = 1)
);
