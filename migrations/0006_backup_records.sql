CREATE TABLE IF NOT EXISTS backup_records (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  format_version INTEGER NOT NULL,
  scope TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_records_event_time
  ON backup_records(regatta_id, created_at);
