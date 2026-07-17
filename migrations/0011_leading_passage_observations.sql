CREATE TABLE IF NOT EXISTS leading_passage_observations (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  course_node_id TEXT NOT NULL REFERENCES course_nodes(id),
  lap_number INTEGER NOT NULL DEFAULT 1,
  passed_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES event_members(id),
  committee_boat_id TEXT REFERENCES committee_boats(id),
  device_id TEXT,
  received_at TEXT NOT NULL,
  clock_offset_ms INTEGER,
  sync_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (sync_quality IN ('good', 'fair', 'poor', 'offline', 'unknown')),
  gps_accuracy_metres REAL,
  was_offline INTEGER NOT NULL DEFAULT 0 CHECK (was_offline IN (0, 1)),
  sail_number TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'corrected')),
  corrects_observation_id TEXT REFERENCES leading_passage_observations(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passage_observations_visit
  ON leading_passage_observations (race_id, course_node_id, lap_number, passed_at);

CREATE TABLE IF NOT EXISTS leading_passage_adoptions (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  course_node_id TEXT NOT NULL REFERENCES course_nodes(id),
  lap_number INTEGER NOT NULL DEFAULT 1,
  observation_id TEXT NOT NULL REFERENCES leading_passage_observations(id),
  adopted_by TEXT NOT NULL REFERENCES event_members(id),
  adopted_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  supersedes_adoption_id TEXT REFERENCES leading_passage_adoptions(id),
  created_at TEXT NOT NULL,
  UNIQUE (race_id, course_node_id, lap_number, revision)
);

CREATE INDEX IF NOT EXISTS idx_passage_adoptions_visit
  ON leading_passage_adoptions (race_id, course_node_id, lap_number, revision DESC);

INSERT OR IGNORE INTO leading_passage_observations
  (id, race_id, course_node_id, lap_number, passed_at, recorded_by,
   received_at, sync_quality, was_offline, note, created_at)
SELECT id, race_id, course_node_id, lap_number, passed_at, recorded_by,
       passed_at, 'unknown', 0, note, passed_at
FROM leading_passage_events;

INSERT OR IGNORE INTO leading_passage_adoptions
  (id, race_id, course_node_id, lap_number, observation_id, adopted_by,
   adopted_at, revision, reason, created_at)
SELECT 'legacy-adoption-' || id, race_id, course_node_id, lap_number, id,
       recorded_by, passed_at, 1, '旧形式からの移行済み採用記録', passed_at
FROM leading_passage_events;
