-- Apply only when upgrading a D1 database that already has the original
-- single-desktop mobile_pairings/mobile_submissions tables. Fresh databases
-- should use ../schema.sql instead.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace_state (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  initialized_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS desktop_devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS desktop_activation_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_by_device_id TEXT NOT NULL,
  consumed_by_device_id TEXT,
  FOREIGN KEY(created_by_device_id) REFERENCES desktop_devices(id),
  FOREIGN KEY(consumed_by_device_id) REFERENCES desktop_devices(id)
);

ALTER TABLE mobile_pairings ADD COLUMN created_by_device_id TEXT;

CREATE INDEX IF NOT EXISTS desktop_devices_active
  ON desktop_devices(revoked_at, role);
CREATE INDEX IF NOT EXISTS desktop_activation_codes_active
  ON desktop_activation_codes(consumed_at, expires_at);
CREATE INDEX IF NOT EXISTS mobile_submissions_claim
  ON mobile_submissions(state, claim_until, claimed_by);
