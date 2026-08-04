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
  // --- YouTube delivery (see YOUTUBE-PLAN.md) ---------------------------
  // The local MP4 is the RAW (review scrubs it); YouTube is the exported
  // JPEG (the public /watch page streams it). These columns track the
  // export so local media can eventually be reclaimed.
  "ALTER TABLE games ADD COLUMN yt_video_id TEXT",        // 11-char id
  "ALTER TABLE games ADD COLUMN yt_privacy TEXT",         // unlisted|public|private
  "ALTER TABLE games ADD COLUMN yt_uploaded_at TEXT",
  // media lifecycle: local (only on disk) | both (uploaded, disk copy kept
  // for review) | youtube (disk copy reclaimed — watchable, not reviewable).
  // Null is read as 'local' so existing rows need no backfill.
  "ALTER TABLE games ADD COLUMN media_state TEXT",
  // Ken has explicitly finished pulling Shorts out of this game. Gates the
  // purge: the local mp4 is the ONLY thing a Short can be rendered from, so
  // deleting it permanently closes the door on this game's highlights.
  "ALTER TABLE games ADD COLUMN shorts_done INTEGER DEFAULT 0",
  // A Short is about a MOMENT — a kill, a dig, a block — not a whole rally.
  // play_id anchors it; the clip becomes that play plus `lead` touches of
  // run-up. Null play_id = legacy whole-rally behaviour. This is also what
  // lets one rally yield two Shorts (the dig AND the kill it set up).
  "ALTER TABLE shorts ADD COLUMN play_id INTEGER REFERENCES plays(id)",
  "ALTER TABLE shorts ADD COLUMN lead INTEGER DEFAULT 4",
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
