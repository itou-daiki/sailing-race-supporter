ALTER TABLE passkey_credentials ADD COLUMN revoked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_active
  ON passkey_credentials(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS owner_recovery_credentials (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  used_at TEXT,
  revoked_at TEXT,
  claimed_by_flow_id TEXT,
  replaced_by_id TEXT REFERENCES owner_recovery_credentials(id)
);

CREATE INDEX IF NOT EXISTS idx_owner_recovery_event_active
  ON owner_recovery_credentials(regatta_id, confirmed_at, used_at, revoked_at);

CREATE TABLE IF NOT EXISTS owner_recovery_flows (
  auth_challenge_id TEXT PRIMARY KEY REFERENCES auth_challenges(id) ON DELETE CASCADE,
  recovery_credential_id TEXT NOT NULL REFERENCES owner_recovery_credentials(id) ON DELETE CASCADE,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_owner_recovery_flows_credential
  ON owner_recovery_flows(recovery_credential_id, created_at);
