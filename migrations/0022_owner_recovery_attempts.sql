CREATE TABLE IF NOT EXISTS owner_recovery_attempts (
  id TEXT PRIMARY KEY,
  event_reference_hash TEXT NOT NULL,
  regatta_id TEXT REFERENCES regattas(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0 CHECK (success IN (0, 1)),
  network_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_owner_recovery_attempts_reference_time
  ON owner_recovery_attempts(event_reference_hash, attempted_at);

CREATE INDEX IF NOT EXISTS idx_owner_recovery_attempts_network_time
  ON owner_recovery_attempts(network_hash, attempted_at);

CREATE INDEX IF NOT EXISTS idx_owner_recovery_attempts_event_time
  ON owner_recovery_attempts(regatta_id, attempted_at);
