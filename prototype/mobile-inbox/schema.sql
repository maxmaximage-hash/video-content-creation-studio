-- One shared Video Hub mobile-link workspace.
-- D1 stores links, token hashes, leases, and status only: no media, cookies,
-- platform credentials, NAS paths, or Library content.

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

CREATE TABLE IF NOT EXISTS mobile_pairings (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by_device_id TEXT NOT NULL,
  FOREIGN KEY(created_by_device_id) REFERENCES desktop_devices(id)
);

-- A pairing may have more than one browser/PWA credential. Only hashes are
-- stored, and every credential remains governed by the parent pairing's
-- revoked_at/expires_at state.
CREATE TABLE IF NOT EXISTS mobile_pairing_credentials (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'pwa' CHECK (kind IN ('pwa')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  FOREIGN KEY(pairing_id) REFERENCES mobile_pairings(id)
);

-- Short-lived, single-use bridge from Safari's Add to Home Screen manifest to
-- the standalone Web App. The raw ticket is returned once and never stored.
CREATE TABLE IF NOT EXISTS mobile_install_tickets (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL,
  ticket_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  credential_id TEXT,
  FOREIGN KEY(pairing_id) REFERENCES mobile_pairings(id),
  FOREIGN KEY(credential_id) REFERENCES mobile_pairing_credentials(id)
);

CREATE TABLE IF NOT EXISTS mobile_submissions (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claim_until TEXT,
  content_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(pairing_id) REFERENCES mobile_pairings(id),
  FOREIGN KEY(claimed_by) REFERENCES desktop_devices(id)
);

CREATE INDEX IF NOT EXISTS desktop_devices_active
  ON desktop_devices(revoked_at, role);
CREATE INDEX IF NOT EXISTS desktop_activation_codes_active
  ON desktop_activation_codes(consumed_at, expires_at);
CREATE INDEX IF NOT EXISTS mobile_pairings_active
  ON mobile_pairings(revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS mobile_pairing_credentials_pairing
  ON mobile_pairing_credentials(pairing_id);
CREATE INDEX IF NOT EXISTS mobile_install_tickets_active
  ON mobile_install_tickets(consumed_at, expires_at, pairing_id);
CREATE INDEX IF NOT EXISTS mobile_submissions_state_created
  ON mobile_submissions(state, created_at);
CREATE INDEX IF NOT EXISTS mobile_submissions_claim
  ON mobile_submissions(state, claim_until, claimed_by);
