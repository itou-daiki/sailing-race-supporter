CREATE TABLE IF NOT EXISTS retention_hold_events (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('set', 'extend', 'release')),
  hold_until TEXT,
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retention_hold_events_event_time
  ON retention_hold_events(regatta_id, created_at);
