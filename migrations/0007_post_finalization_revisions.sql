CREATE TABLE IF NOT EXISTS post_finalization_revisions (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  patch_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  previous_finalization_id TEXT NOT NULL REFERENCES race_finalizations(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (race_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_post_finalization_race_revision
  ON post_finalization_revisions(race_id, revision);
