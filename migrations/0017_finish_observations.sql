CREATE TABLE IF NOT EXISTS finish_observations (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  finish_position INTEGER NOT NULL DEFAULT 1 CHECK (finish_position >= 1),
  finished_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES event_members(id),
  committee_boat_id TEXT REFERENCES committee_boats(id),
  device_id TEXT,
  received_at TEXT NOT NULL,
  clock_offset_ms INTEGER,
  sync_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (sync_quality IN ('good', 'fair', 'poor', 'offline', 'unknown')),
  was_offline INTEGER NOT NULL DEFAULT 0 CHECK (was_offline IN (0, 1)),
  sail_number TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'corrected')),
  corrects_observation_id TEXT REFERENCES finish_observations(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_finish_observations_race
  ON finish_observations (race_id, finish_position, finished_at);

CREATE TABLE IF NOT EXISTS finish_adoptions (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  finish_position INTEGER NOT NULL DEFAULT 1 CHECK (finish_position >= 1),
  observation_id TEXT NOT NULL REFERENCES finish_observations(id),
  adopted_by TEXT NOT NULL REFERENCES event_members(id),
  adopted_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  supersedes_adoption_id TEXT REFERENCES finish_adoptions(id),
  created_at TEXT NOT NULL,
  UNIQUE (race_id, finish_position, revision)
);

CREATE INDEX IF NOT EXISTS idx_finish_adoptions_race
  ON finish_adoptions (race_id, finish_position, revision DESC);

ALTER TABLE race_finalizations ADD COLUMN snapshot_json TEXT;
