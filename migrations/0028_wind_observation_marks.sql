ALTER TABLE wind_observations
  ADD COLUMN mark_id TEXT REFERENCES marks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wind_observations_mark_time
  ON wind_observations (regatta_id, race_id, mark_id, observed_at DESC);
