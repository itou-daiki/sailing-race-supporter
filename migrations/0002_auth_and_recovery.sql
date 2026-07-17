ALTER TABLE users ADD COLUMN webauthn_user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_webauthn_user_id
  ON users(webauthn_user_id);

ALTER TABLE passkey_credentials ADD COLUMN device_type TEXT;
ALTER TABLE passkey_credentials ADD COLUMN backed_up INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  challenge TEXT NOT NULL,
  display_name TEXT,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry
  ON auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expiry
  ON auth_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  assignment_scope_json TEXT NOT NULL,
  race_area_id TEXT REFERENCES race_areas(id),
  committee_boat_id TEXT REFERENCES committee_boats(id),
  mark_id TEXT REFERENCES marks(id),
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_recovery_credentials (
  id TEXT PRIMARY KEY,
  event_member_id TEXT NOT NULL REFERENCES event_members(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  replaced_by_id TEXT REFERENCES member_recovery_credentials(id)
);

CREATE TABLE IF NOT EXISTS restore_records (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  backup_hash TEXT NOT NULL,
  restored_by TEXT NOT NULL REFERENCES users(id),
  source_revision INTEGER,
  created_revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
