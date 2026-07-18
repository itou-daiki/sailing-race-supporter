CREATE TABLE IF NOT EXISTS post_finalization_revision_drafts (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  base_finalization_id TEXT NOT NULL REFERENCES race_finalizations(id),
  base_revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  corrections_json TEXT NOT NULL,
  selected_items_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'discarded')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_finalization_id TEXT REFERENCES race_finalizations(id),
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_post_finalization_drafts_race_status
  ON post_finalization_revision_drafts(race_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_post_finalization_one_active_draft
  ON post_finalization_revision_drafts(race_id)
  WHERE status = 'draft';
