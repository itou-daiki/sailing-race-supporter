CREATE TABLE IF NOT EXISTS race_schedule_events (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  previous_warning_at TEXT NOT NULL,
  warning_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'postponement', 'recall', 'restart')),
  member_id TEXT NOT NULL REFERENCES event_members(id),
  revision INTEGER NOT NULL,
  shifted_task_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_race_schedule_events_race_time
  ON race_schedule_events(race_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_race_schedule_events_race_revision
  ON race_schedule_events(race_id, revision);

INSERT OR IGNORE INTO operational_tasks
  (id, race_id, title, status, priority, due_at, revision)
SELECT race.id || ':reminder:30', race.id, '全体運営準備を開始', 'waiting', 'required',
       strftime('%Y-%m-%dT%H:%M:%fZ', race.warning_at, '-30 minutes'), 1
FROM races race;

INSERT OR IGNORE INTO operational_tasks
  (id, race_id, title, status, priority, due_at, revision)
SELECT race.id || ':reminder:15', race.id, '担当別最終確認を完了', 'waiting', 'required',
       strftime('%Y-%m-%dT%H:%M:%fZ', race.warning_at, '-15 minutes'), 1
FROM races race;

INSERT OR IGNORE INTO operational_tasks
  (id, race_id, title, status, priority, due_at, revision)
SELECT race.id || ':reminder:5', race.id, 'スタート要員の配置を最終確認', 'waiting', 'required',
       strftime('%Y-%m-%dT%H:%M:%fZ', race.warning_at, '-5 minutes'), 1
FROM races race;
