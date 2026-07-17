CREATE TABLE IF NOT EXISTS operational_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES operational_tasks(id) ON DELETE CASCADE,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('blocked', 'waiting', 'doing', 'done')),
  member_id TEXT NOT NULL REFERENCES event_members(id),
  revision INTEGER NOT NULL,
  client_time TEXT,
  server_time TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operational_task_events_race_time
  ON operational_task_events(race_id, server_time);
