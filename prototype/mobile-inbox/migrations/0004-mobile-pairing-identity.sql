-- Track one logical phone across its browser, WeChat and installed Web App
-- credentials. This migration is additive and does not revoke or delete any
-- existing pairing, credential or submission.

ALTER TABLE mobile_pairings ADD COLUMN last_seen_at TEXT;
