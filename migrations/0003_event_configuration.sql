ALTER TABLE course_nodes ADD COLUMN mark_id TEXT REFERENCES marks(id);

CREATE INDEX IF NOT EXISTS idx_course_nodes_mark
  ON course_nodes(mark_id);

CREATE TABLE IF NOT EXISTS regatta_settings (
  regatta_id TEXT PRIMARY KEY REFERENCES regattas(id) ON DELETE CASCADE,
  public_home_enabled INTEGER NOT NULL DEFAULT 0,
  precise_positions_visibility TEXT NOT NULL DEFAULT 'operations'
    CHECK (precise_positions_visibility IN ('owner', 'operations', 'all-members')),
  bearing_reference TEXT NOT NULL DEFAULT 'true'
    CHECK (bearing_reference IN ('true', 'magnetic')),
  map_tile_policy TEXT NOT NULL DEFAULT 'online-gsi',
  retention_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
