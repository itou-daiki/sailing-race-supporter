CREATE INDEX IF NOT EXISTS idx_wind_regatta_race_boat_time
  ON wind_observations (regatta_id, race_id, committee_boat_id, observed_at DESC);
