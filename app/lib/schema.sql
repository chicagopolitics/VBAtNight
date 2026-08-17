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
-- One row per recap email we tried to send: which player, for which night.
-- The unique index below IS the double-send guard — nothing re-reads this to
-- decide, the INSERT simply can't happen twice. Same "table as ledger" shape
-- as `shorts`, and re-sending is then a deliberate delete, not an accident.
-- Failures are recorded too (status='failed', error holds why), because the
-- interesting question after a send is which ones didn't land.
CREATE TABLE IF NOT EXISTS recaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id),
  played_on TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',   -- sent | failed
  error TEXT,
  sent_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS recaps_once ON recaps(player_id, played_on);

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
-- One row per Short we intend to make from a rally. Rendering is slow (a
-- minute or two of ffmpeg + OpenCV on a 2-vCPU droplet), far too slow for an
-- HTTP request, so this table IS the queue: the UI writes 'queued' rows and
-- scripts/shorts-worker.mjs drains them.
--   queued -> rendering -> ready -> published
--                       -> failed (error holds why; requeue by setting queued)
CREATE TABLE IF NOT EXISTS shorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  rally_id INTEGER NOT NULL REFERENCES rallies(id),
  status TEXT NOT NULL DEFAULT 'queued',
  caption TEXT, subcaption TEXT,
  zoom REAL DEFAULT 1.0,
  file TEXT,                 -- /media/<gid>/shorts/<id>.mp4 once rendered
  yt_video_id TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  rendered_at TEXT,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS shorts_game ON shorts(game_id);
CREATE INDEX IF NOT EXISTS shorts_status ON shorts(status);

-- One row per bundle waiting to become a game. Same "table IS the queue"
-- shape as `shorts`, for the same reason: importing a bundle is minutes of
-- downloading, unzipping and moving multi-GB video, which no HTTP request can
-- hold. The point here is durability — six bundles queued at 9pm must still
-- import if the page is closed, the laptop sleeps, or the droplet reboots, so
-- the queue lives in SQLite rather than in React state.
--
--   source='drive'   drive_id is the file id; the worker downloads it. Fully
--                    server-side, so nothing about it needs the page open.
--   source='upload'  the browser streams the zip to /api/import/stage first.
--                    Only once those bytes are on disk is the job durable —
--                    the browser is the only place a picked file exists, so an
--                    upload still in flight cannot survive navigating away.
--
--   staging -> queued -> importing -> done
--                                  -> failed (error holds why)
--
-- `bytes` is staging progress and doubles as a liveness signal: `updated_at`
-- stops moving when an upload dies, and that's what the worker reaps against.
CREATE TABLE IF NOT EXISTS import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                  -- drive | upload
  drive_id TEXT,                         -- source='drive'
  staged_path TEXT,                      -- source='upload'; NULL once consumed
  name TEXT NOT NULL,                    -- display name (the zip's filename)
  size INTEGER DEFAULT 0,                -- expected total bytes (0 = unknown)
  bytes INTEGER DEFAULT 0,               -- staged so far
  status TEXT NOT NULL DEFAULT 'queued',
  game_id INTEGER REFERENCES games(id),  -- set on success
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS import_jobs_status ON import_jobs(status);

CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  referrer TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pv_path ON page_views(path);
CREATE INDEX IF NOT EXISTS pv_created ON page_views(created_at);

CREATE TABLE IF NOT EXISTS tracklets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  src_id INTEGER,
  identity_id INTEGER REFERENCES identities(id),
  rally_idx INTEGER,
  t0 REAL, t1 REAL,
  crops TEXT DEFAULT '[]'
);
