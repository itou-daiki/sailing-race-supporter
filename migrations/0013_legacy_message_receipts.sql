INSERT OR IGNORE INTO message_receipts
  (message_id, member_id, delivered_at, read_at, acknowledged_at)
SELECT message.id, member.id, message.sent_at, NULL, NULL
FROM messages message
JOIN message_targets target ON target.message_id = message.id
JOIN event_members member
  ON member.regatta_id = message.regatta_id
 AND member.status = 'active'
 AND member.id <> message.sender_member_id
WHERE target.target_type IN ('event', 'race');
