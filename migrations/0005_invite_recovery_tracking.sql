ALTER TABLE event_members ADD COLUMN invite_id TEXT REFERENCES invites(id);

CREATE INDEX IF NOT EXISTS idx_event_members_invite
  ON event_members(invite_id);

CREATE TABLE IF NOT EXISTS recovery_attempts (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  event_member_id TEXT,
  attempted_at TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  network_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_recovery_attempts_member_time
  ON recovery_attempts(regatta_id, event_member_id, attempted_at);
