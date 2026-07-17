CREATE TABLE IF NOT EXISTS official_audio_devices (
  race_id TEXT PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES event_members(id),
  readiness_json TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  ready_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  released_at TEXT
);

CREATE TABLE IF NOT EXISTS official_audio_device_events (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES event_members(id),
  action TEXT NOT NULL CHECK (action IN ('claim', 'release', 'takeover')),
  readiness_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_official_audio_events_race_time
  ON official_audio_device_events(race_id, created_at);
