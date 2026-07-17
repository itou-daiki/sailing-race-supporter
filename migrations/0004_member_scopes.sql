CREATE TABLE IF NOT EXISTS event_member_scopes (
  id TEXT PRIMARY KEY,
  event_member_id TEXT NOT NULL REFERENCES event_members(id) ON DELETE CASCADE,
  race_area_id TEXT REFERENCES race_areas(id) ON DELETE CASCADE,
  race_id TEXT REFERENCES races(id) ON DELETE CASCADE,
  committee_boat_id TEXT REFERENCES committee_boats(id) ON DELETE CASCADE,
  mark_id TEXT REFERENCES marks(id) ON DELETE CASCADE,
  permission TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_member_scopes_member
  ON event_member_scopes(event_member_id);

CREATE INDEX IF NOT EXISTS idx_event_member_scopes_boat
  ON event_member_scopes(committee_boat_id, event_member_id);

CREATE INDEX IF NOT EXISTS idx_event_member_scopes_mark
  ON event_member_scopes(mark_id, event_member_id);
