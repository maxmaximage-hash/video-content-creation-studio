-- Non-destructive upgrade for existing mobile inbox databases.
-- Long-lived browser/PWA tokens are stored only as hashes and remain governed
-- by the existing mobile_pairings revocation state.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mobile_pairing_credentials (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'pwa' CHECK (kind IN ('pwa')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  FOREIGN KEY(pairing_id) REFERENCES mobile_pairings(id)
);

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

CREATE INDEX IF NOT EXISTS mobile_pairing_credentials_pairing
  ON mobile_pairing_credentials(pairing_id);
CREATE INDEX IF NOT EXISTS mobile_install_tickets_active
  ON mobile_install_tickets(consumed_at, expires_at, pairing_id);
