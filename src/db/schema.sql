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

-- Transcription is optional (TRANSCRIPTION_ENABLED) and async (AWS Transcribe
-- jobs run in the background -- see src/transcription.js /
-- src/transcriptionPoller.js), so a call's transcript arrives well after the
-- row itself. 'none' covers both "feature is off" and "not submitted yet".
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcription_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript TEXT;
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_transcription_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_transcription_status_check
  CHECK (transcription_status IN ('none', 'pending', 'completed', 'failed'));

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

-- Single-row, admin-toggleable settings (live, not env-var-gated -- flip on
-- or off without a redeploy). auto_transcribe_enabled only affects calls
-- the live poller picks up *after* it's checked -- src/poller.js checks it
-- fresh per new call, and src/backfill.js never checks it at all, so
-- historical recordings are never swept into auto-transcription by turning
-- this on.
CREATE TABLE IF NOT EXISTS app_settings (
  id                       INT PRIMARY KEY DEFAULT 1,
  auto_transcribe_enabled  BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT app_settings_single_row CHECK (id = 1)
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
