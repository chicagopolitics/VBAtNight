// SQLite driver: better-sqlite3 (prod) with node:sqlite fallback (sandboxes).
import path from "path";
import fs from "fs";
import { createRequire } from "module";
const require_ = createRequire(import.meta.url);

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "balltime.db");
let _db = null;

const MIGRATIONS = [
  "ALTER TABLE identities ADD COLUMN clean INTEGER DEFAULT 0",
  "ALTER TABLE tracklets ADD COLUMN typicality REAL",
  "ALTER TABLE identities ADD COLUMN embedding TEXT",
  "ALTER TABLE plays ADD COLUMN tracklet_id INTEGER",
  "ALTER TABLE rallies ADD COLUMN outcome_type TEXT",
  "ALTER TABLE rallies ADD COLUMN outcome_cluster INTEGER",
  "ALTER TABLE games ADD COLUMN published INTEGER DEFAULT 0",
  // where the rally's clip begins in game time (split rallies share a clip;
  // null = legacy assumption of start_s - 2)
  "ALTER TABLE rallies ADD COLUMN clip_start_s REAL",
  // reviewer override of the derived touch grade (see lib/grades.js);
  // null = derive from sequence + rally outcome
  "ALTER TABLE plays ADD COLUMN grade TEXT",
  // per-game team ('A'/'B') — set in the name-players step (position-based
  // suggestions); makes grade derivation overpass-aware
  "ALTER TABLE identities ADD COLUMN team TEXT",
  // links a per-game identity to a global players row = the durable, unique
  // player identity. Null = not yet linked (falls back to name in stats).
  "ALTER TABLE identities ADD COLUMN player_id INTEGER REFERENCES players(id)",
];

export function db() {
  if (!_db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    try { _db = new (require_("better-sqlite3"))(DB_PATH); }
    catch { _db = new (require_("node:sqlite").DatabaseSync)(DB_PATH); }
    _db.exec(fs.readFileSync(path.join(process.cwd(), "lib", "schema.sql"), "utf8"));
    for (const m of MIGRATIONS) { try { _db.exec(m); } catch {} }
  }
  return _db;
}
