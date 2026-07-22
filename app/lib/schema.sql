CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  video_file TEXT,
  game_start_s REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
-- global player registry: the durable identity that persists across games.
-- One player has many per-game identities (identities.player_id). Duplicate
-- display_names are allowed on purpose (two people named "Mike" are two rows);
-- the id is the source of truth, disambiguate visually in the UI.
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  league_id INTEGER,                       -- placeholder for tenant-ready schema
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  cluster_id INTEGER NOT NULL,
  name TEXT,
  dismissed INTEGER DEFAULT 0,
  merged_into INTEGER,
  n_boxes INTEGER DEFAULT 0,
  rep_crops TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS rallies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  idx INTEGER NOT NULL,
  start_s REAL, end_s REAL,
  phase TEXT DEFAULT 'game',
  clip_file TEXT
);
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rally_id INTEGER NOT NULL REFERENCES rallies(id),
  t REAL NOT NULL,
  x REAL, y REAL,
  play_type TEXT,
  cluster_id INTEGER,
  dist_px REAL,
  corrected INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'viewer',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracklets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  src_id INTEGER,
  identity_id INTEGER REFERENCES identities(id),
  rally_idx INTEGER,
  t0 REAL, t1 REAL,
  crops TEXT DEFAULT '[]'
);
