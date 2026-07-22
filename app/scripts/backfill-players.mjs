// One-time backfill: create a global player per distinct identity name and
// link matching identities (identities.player_id). Exact-name grouping — the
// name is the only signal we have. Afterward, use /players to merge typos and
// split any same-name-different-person cases.
//
//   node scripts/backfill-players.mjs [--dry]
//
// Idempotent: only touches identities with player_id IS NULL, and reuses an
// existing player row when one already has that exact display_name.
import path from "path";
import { createRequire } from "module";
const require_ = createRequire(import.meta.url);

const DRY = process.argv.includes("--dry");
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "balltime.db");

let db;
try { db = new (require_("better-sqlite3"))(DB_PATH); }
catch { db = new (require_("node:sqlite").DatabaseSync)(DB_PATH); }

// ensure schema (safe if the app already migrated)
db.exec(`CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  league_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')))`);
try { db.exec("ALTER TABLE identities ADD COLUMN player_id INTEGER REFERENCES players(id)"); } catch {}

const rows = db.prepare(
  `SELECT DISTINCT name FROM identities
   WHERE name IS NOT NULL AND TRIM(name) != '' AND player_id IS NULL
   AND dismissed = 0 AND merged_into IS NULL`).all();

const findPlayer = db.prepare("SELECT id FROM players WHERE display_name = ?");
const insPlayer = db.prepare("INSERT INTO players (display_name) VALUES (?)");
const linkByName = db.prepare(
  `UPDATE identities SET player_id = ? WHERE name = ? AND player_id IS NULL
   AND dismissed = 0 AND merged_into IS NULL`);

let created = 0, reused = 0, linked = 0;
for (const { name } of rows) {
  const existing = findPlayer.get(name);
  let pid;
  if (existing) { pid = existing.id; reused++; }
  else if (DRY) { pid = `(new)`; created++; }
  else { pid = Number(insPlayer.run(name).lastInsertRowid); created++; }
  const n = DRY
    ? db.prepare(`SELECT COUNT(*) c FROM identities WHERE name = ? AND player_id IS NULL
                  AND dismissed = 0 AND merged_into IS NULL`).get(name).c
    : linkByName.run(pid, name).changes;
  linked += n;
  console.log(`  ${DRY ? "[dry] " : ""}${name} -> player ${pid}  (${n} identit${n === 1 ? "y" : "ies"})`);
}

console.log(`\n${DRY ? "[dry run] " : ""}${rows.length} names · ${created} players created · ` +
  `${reused} reused · ${linked} identities linked`);
