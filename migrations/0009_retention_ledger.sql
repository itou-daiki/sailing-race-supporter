ALTER TABLE messages ADD COLUMN body_hash TEXT;

ALTER TABLE regatta_settings ADD COLUMN retention_hold_until TEXT;
ALTER TABLE regatta_settings ADD COLUMN retention_hold_reason TEXT;

CREATE TABLE IF NOT EXISTS retention_runs (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('cron', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'skipped', 'failed')),
  counts_json TEXT NOT NULL DEFAULT '{}',
  detail TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_retention_runs_event_time
  ON retention_runs(regatta_id, started_at);

CREATE TABLE IF NOT EXISTS retention_tombstones (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  content_hash TEXT,
  policy_key TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, policy_key)
);

CREATE INDEX IF NOT EXISTS idx_retention_tombstones_event_time
  ON retention_tombstones(regatta_id, deleted_at);
