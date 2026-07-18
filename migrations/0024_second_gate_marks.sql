INSERT INTO marks (id, regatta_id, race_area_id, label, mark_type, created_at)
SELECT lower(hex(randomblob(16))), area.regatta_id, area.id, '中ゲート 2S', 'gate', CURRENT_TIMESTAMP
FROM race_areas area
WHERE NOT EXISTS (
  SELECT 1 FROM marks mark
  WHERE mark.race_area_id = area.id AND mark.label = '中ゲート 2S'
);

INSERT INTO marks (id, regatta_id, race_area_id, label, mark_type, created_at)
SELECT lower(hex(randomblob(16))), area.regatta_id, area.id, '中ゲート 2P', 'gate', CURRENT_TIMESTAMP
FROM race_areas area
WHERE NOT EXISTS (
  SELECT 1 FROM marks mark
  WHERE mark.race_area_id = area.id AND mark.label = '中ゲート 2P'
);
