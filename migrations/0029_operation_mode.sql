ALTER TABLE regatta_settings ADD COLUMN operation_mode TEXT NOT NULL DEFAULT 'team'
  CHECK (operation_mode IN ('team', 'solo'));
