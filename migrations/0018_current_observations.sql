CREATE TABLE IF NOT EXISTS current_observations (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  race_id TEXT REFERENCES races(id) ON DELETE SET NULL,
  committee_boat_id TEXT REFERENCES committee_boats(id),
  member_id TEXT REFERENCES event_members(id),
  direction_degrees REAL NOT NULL,
  speed_knots REAL NOT NULL,
  lng REAL,
  lat REAL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high'))
);

CREATE INDEX IF NOT EXISTS idx_current_observations_event_time
  ON current_observations(regatta_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_current_observations_race_time
  ON current_observations(race_id, observed_at);
