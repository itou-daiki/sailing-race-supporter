CREATE TABLE IF NOT EXISTS backup_archives (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_hash TEXT NOT NULL,
  server_data_hash TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  etag TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_archives_event_time
  ON backup_archives(regatta_id, deleted_at, created_at DESC);

UPDATE regatta_settings
SET retention_json = json_set(retention_json, '$.cloudBackupDays', 365)
WHERE json_extract(retention_json, '$.cloudBackupDays') IS NULL;
