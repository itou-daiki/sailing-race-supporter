PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS regattas (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  default_locale TEXT NOT NULL DEFAULT 'ja',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_members (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  assignment TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'revoked')),
  recovery_hash TEXT,
  recovery_rotated_at TEXT,
  joined_at TEXT NOT NULL,
  UNIQUE (regatta_id, id)
);

CREATE INDEX IF NOT EXISTS idx_event_members_regatta_status
  ON event_members(regatta_id, status);

CREATE TABLE IF NOT EXISTS race_areas (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  room_key TEXT NOT NULL,
  center_lng REAL,
  center_lat REAL,
  UNIQUE (regatta_id, room_key)
);

CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  race_area_id TEXT NOT NULL REFERENCES race_areas(id),
  race_number TEXT NOT NULL,
  race_order INTEGER NOT NULL,
  class_name TEXT NOT NULL,
  course_code TEXT NOT NULL,
  target_minutes INTEGER NOT NULL,
  warning_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('planning', 'setup', 'start-sequence', 'racing', 'provisional', 'finalized')),
  finalized_revision INTEGER,
  finalized_at TEXT,
  finalized_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (regatta_id, race_number)
);

CREATE INDEX IF NOT EXISTS idx_races_regatta_order
  ON races(regatta_id, race_order);

CREATE TABLE IF NOT EXISTS course_revisions (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  course_code TEXT NOT NULL,
  wind_direction REAL,
  wind_speed REAL,
  target_length_metres REAL,
  gate_config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded', 'finalized')),
  based_on_revision INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (race_id, revision)
);

CREATE TABLE IF NOT EXISTS course_nodes (
  id TEXT PRIMARY KEY,
  course_revision_id TEXT NOT NULL REFERENCES course_revisions(id) ON DELETE CASCADE,
  node_order INTEGER NOT NULL,
  label TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK (node_type IN ('single', 'gate', 'start', 'finish', 'offset')),
  rounding TEXT,
  target_lng REAL NOT NULL,
  target_lat REAL NOT NULL,
  UNIQUE (course_revision_id, node_order)
);

CREATE TABLE IF NOT EXISTS marks (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  race_area_id TEXT NOT NULL REFERENCES race_areas(id),
  label TEXT NOT NULL,
  mark_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mark_events (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  mark_id TEXT NOT NULL REFERENCES marks(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('assigned', 'en-route', 'dropped', 'confirmed', 'moved', 'recovered')),
  lng REAL,
  lat REAL,
  accuracy_metres REAL,
  member_id TEXT REFERENCES event_members(id),
  committee_boat_id TEXT,
  client_time TEXT NOT NULL,
  server_time TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (race_id, sequence)
);

CREATE TABLE IF NOT EXISTS committee_boats (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  call_sign TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS boat_assignments (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  committee_boat_id TEXT NOT NULL REFERENCES committee_boats(id),
  member_id TEXT REFERENCES event_members(id),
  assignment TEXT NOT NULL,
  mark_id TEXT REFERENCES marks(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT
);

CREATE TABLE IF NOT EXISTS position_samples (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  race_id TEXT REFERENCES races(id) ON DELETE SET NULL,
  committee_boat_id TEXT NOT NULL REFERENCES committee_boats(id),
  lng REAL NOT NULL,
  lat REAL NOT NULL,
  accuracy_metres REAL,
  speed_knots REAL,
  course_degrees REAL,
  sampled_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_position_samples_boat_time
  ON position_samples(committee_boat_id, sampled_at);

CREATE TABLE IF NOT EXISTS wind_observations (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  race_id TEXT REFERENCES races(id) ON DELETE SET NULL,
  committee_boat_id TEXT REFERENCES committee_boats(id),
  member_id TEXT REFERENCES event_members(id),
  direction_degrees REAL NOT NULL,
  speed_knots REAL NOT NULL,
  gust_knots REAL,
  averaging_seconds INTEGER,
  lng REAL,
  lat REAL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_events (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  scheduled_at TEXT,
  executed_at TEXT NOT NULL,
  official_device_id TEXT,
  member_id TEXT REFERENCES event_members(id),
  cancelled_by_event_id TEXT REFERENCES signal_events(id),
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS leading_passage_events (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  course_node_id TEXT NOT NULL REFERENCES course_nodes(id),
  lap_number INTEGER NOT NULL DEFAULT 1,
  passed_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES event_members(id),
  source TEXT NOT NULL,
  note TEXT,
  UNIQUE (race_id, course_node_id, lap_number)
);

CREATE TABLE IF NOT EXISTS operational_tasks (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  assignee_member_id TEXT REFERENCES event_members(id),
  assignee_boat_id TEXT REFERENCES committee_boats(id),
  status TEXT NOT NULL CHECK (status IN ('blocked', 'waiting', 'doing', 'done')),
  priority TEXT NOT NULL,
  due_at TEXT,
  completed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  race_id TEXT REFERENCES races(id) ON DELETE SET NULL,
  channel_key TEXT NOT NULL,
  sender_member_id TEXT NOT NULL REFERENCES event_members(id),
  priority TEXT NOT NULL CHECK (priority IN ('normal', 'confirm', 'urgent')),
  body TEXT NOT NULL,
  corrects_message_id TEXT REFERENCES messages(id),
  sent_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_time
  ON messages(regatta_id, channel_key, sent_at);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES event_members(id) ON DELETE CASCADE,
  delivered_at TEXT,
  read_at TEXT,
  acknowledged_at TEXT,
  PRIMARY KEY (message_id, member_id)
);

CREATE TABLE IF NOT EXISTS race_finalizations (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  finalized_by TEXT NOT NULL REFERENCES users(id),
  finalized_at TEXT NOT NULL,
  previous_finalization_id TEXT REFERENCES race_finalizations(id),
  UNIQUE (race_id, revision)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  regatta_id TEXT NOT NULL REFERENCES regattas(id) ON DELETE CASCADE,
  race_id TEXT REFERENCES races(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  actor_member_id TEXT REFERENCES event_members(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  reason TEXT,
  client_time TEXT,
  server_time TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (regatta_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_audit_events_race_sequence
  ON audit_events(race_id, sequence);
