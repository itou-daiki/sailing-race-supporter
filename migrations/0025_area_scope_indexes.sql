CREATE INDEX IF NOT EXISTS idx_event_member_scopes_area
  ON event_member_scopes (race_area_id, event_member_id);

CREATE INDEX IF NOT EXISTS idx_marks_area_label
  ON marks (race_area_id, label);

CREATE INDEX IF NOT EXISTS idx_races_area
  ON races (race_area_id, race_order);

CREATE INDEX IF NOT EXISTS idx_boat_assignments_boat_race
  ON boat_assignments (committee_boat_id, race_id);
