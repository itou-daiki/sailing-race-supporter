ALTER TABLE signal_events ADD COLUMN visual_executed_at TEXT;
ALTER TABLE signal_events ADD COLUMN sound_executed_at TEXT;
ALTER TABLE signal_events ADD COLUMN sound_status TEXT NOT NULL DEFAULT 'legacy';

UPDATE signal_events
SET visual_executed_at = executed_at
WHERE visual_executed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_events_sound_status
  ON signal_events (race_id, sound_status, executed_at);
