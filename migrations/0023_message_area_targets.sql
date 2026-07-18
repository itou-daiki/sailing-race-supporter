CREATE TABLE message_targets_v2 (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL
    CHECK (target_type IN ('event', 'area', 'race', 'boat', 'mark', 'role', 'member')),
  target_id TEXT,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO message_targets_v2 (message_id, target_type, target_id, label, created_at)
SELECT message_id, target_type, target_id, label, created_at
FROM message_targets;

DROP TABLE message_targets;
ALTER TABLE message_targets_v2 RENAME TO message_targets;

CREATE INDEX idx_message_targets_kind
  ON message_targets (target_type, target_id);
