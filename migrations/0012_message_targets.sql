CREATE TABLE IF NOT EXISTS message_targets (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL
    CHECK (target_type IN ('event', 'race', 'boat', 'mark', 'role', 'member')),
  target_id TEXT,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_targets_kind
  ON message_targets (target_type, target_id);

INSERT OR IGNORE INTO message_targets (message_id, target_type, target_id, label, created_at)
SELECT id,
       CASE
         WHEN channel_key LIKE 'race:%' THEN 'race'
         WHEN channel_key LIKE 'boat:%' THEN 'boat'
         WHEN channel_key LIKE 'mark:%' THEN 'mark'
         WHEN channel_key LIKE 'role:%' THEN 'role'
         WHEN channel_key LIKE 'member:%' THEN 'member'
         ELSE 'event'
       END,
       CASE WHEN instr(channel_key, ':') > 0 THEN substr(channel_key, instr(channel_key, ':') + 1) ELSE NULL END,
       channel_key,
       sent_at
FROM messages;
