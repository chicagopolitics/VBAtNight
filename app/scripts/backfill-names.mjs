// One-time backfill for games imported before naming existed, plus the
// YouTube re-title that follows from it. See NAMING-PLAN.md.
//
//   node scripts/backfill-names.mjs                        # show evidence, change nothing
//   node scripts/backfill-names.mjs 13=2026-07-20 14=2026-07-21
//   node scripts/backfill-names.mjs 13=2026-07-20 --retitle
//
// Why this needs a human: the two existing games CANNOT be dated from the
// data. Their mp4s were re-encoded, which stripped the container
// `creation_time` (both now report only `encoder: Lavf58.76.100`), and
// `created_at` is import time — game 13 was imported at 00:50 and game 14 at
// 13:50 the same day, so neither is the evening they were played. Guessing
// would put a wrong date in a YouTube title, which is worse than "game2".
//
// So: run it bare, read the evidence, then pass the dates you know.
//
// Idempotent. Re-running with the same dates is a no-op; `--retitle` skips
// any video whose title already matches.
import "../lib/load-env.js";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { displayName, youtubeTitle, slug } from "../lib/game-name.js";

const require_ = createRequire(import.meta.url);
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "balltime.db");
const RETITLE = process.argv.includes("--retitle");

let db;
try { db = new (require_("better-sqlite3"))(DB_PATH); }
catch { db = new (require_("node:sqlite").DatabaseSync)(DB_PATH); }

for (const m of [
  "ALTER TABLE games ADD COLUMN played_on TEXT",
  "ALTER TABLE games ADD COLUMN recorded_at TEXT",
  "ALTER TABLE games ADD COLUMN slot INTEGER",
  "ALTER TABLE games ADD COLUMN court TEXT",
  "ALTER TABLE games ADD COLUMN label TEXT",
  "ALTER TABLE games ADD COLUMN source_file TEXT",
]) { try { db.exec(m); } catch {} }

// id=YYYY-MM-DD pairs
const assign = new Map();
for (const a of process.argv.slice(2)) {
  const m = /^(\d+)=(\d{4}-\d{2}-\d{2})$/.exec(a);
  if (m) assign.set(Number(m[1]), m[2]);
  else if (!a.startsWith("--"))
    { console.error(`unrecognised argument: ${a}  (expected 13=2026-07-20)`); process.exit(1); }
}

// Everything the file itself will admit to. Deliberately printed rather than
// acted on — see the header.
function evidence(g) {
  const out = { created_at: g.created_at, mtime: null, duration: null, location: null };
  if (!g.video_file?.startsWith("/media/")) return out;
  const abs = path.join(process.cwd(), "public", g.video_file.replace(/^\//, ""));
  try {
    // stdio: ffprobe writes "No such file" to stderr, which would otherwise
    // interleave with this report and read like a crash. A missing file is
    // an expected state here (the video may have been reclaimed).
    const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries",
      "format=duration:format_tags", "-of", "json", abs],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const f = j.format || {};
    out.duration = f.duration ? `${Math.round(f.duration / 60)} min` : null;
    out.creation_time = (f.tags || {}).creation_time || null;
    // Phone footage often keeps a GPS tag even when the timestamp is gone.
    // It won't date a game, but it does confirm two games share a gym, which
    // is the other fact worth having before filling in `court`.
    out.location = (f.tags || {}).location || null;
  } catch { /* file reclaimed, or no ffprobe here */ }
  try {
    out.mtime = require_("fs").statSync(abs).mtime.toISOString();
  } catch { /* ignore */ }
  return out;
}

const games = db.prepare("SELECT * FROM games ORDER BY id").all().map(g => ({ ...g }));

if (assign.size === 0) {
  console.log("No dates given — showing what's known. Nothing was changed.\n");
  for (const g of games) {
    const e = evidence(g);
    console.log(`game ${g.id}  legacy name: ${JSON.stringify(g.name)}`);
    console.log(`  played_on   : ${g.played_on ?? "(none — needs a date)"}`);
    console.log(`  imported at : ${e.created_at}   <- NOT when it was played`);
    console.log(`  video mtime : ${e.mtime ?? "?"}`);
    console.log(`  creation_time: ${e.creation_time ?? "(stripped by re-encode)"}`);
    console.log(`  duration    : ${e.duration ?? "?"}`);
    console.log(`  location    : ${e.location ?? "?"}`);
    console.log(`  youtube     : ${g.yt_video_id ?? "(not uploaded)"}`);
    // Shape preview with a stand-in date — "YYYY-MM-DD" is not a real date,
    // so passing it through would fall back to the legacy name and show
    // nothing useful.
    const eg = { ...g, played_on: "2026-07-20", slot: 1, label: g.label };
    console.log(`  would become: ${displayName(eg)}`);
    console.log(`           yt : ${youtubeTitle(eg)}   (example date)\n`);
  }
  console.log("Then re-run, e.g.:\n  node scripts/backfill-names.mjs " +
    games.map(g => `${g.id}=YYYY-MM-DD`).join(" ") + " --retitle");
  process.exit(0);
}

// --- apply -----------------------------------------------------------------
const upd = db.prepare("UPDATE games SET played_on = ?, slot = NULL WHERE id = ?");
for (const [id, day] of assign) {
  if (!games.some(g => g.id === id)) {
    console.error(`game ${id} not found — skipping`); continue;
  }
  upd.run(day, id);
  console.log(`game ${id} -> played_on ${day}`);
}

// Renumber every affected night by recording time, falling back to id where
// recorded_at is null (which is every backfilled game — see the header).
const nights = new Set([...assign.values()]);
for (const night of nights) {
  const rows = db.prepare(
    `SELECT id FROM games WHERE played_on = ?
      ORDER BY (recorded_at IS NULL), recorded_at, id`).all(night);
  const s = db.prepare("UPDATE games SET slot = ? WHERE id = ?");
  rows.forEach((r, i) => s.run(i + 1, r.id));
  console.log(`night ${night}: ${rows.length} game(s) renumbered`);
}

// Also fill source_file where it's derivable, so corrections exports keep
// their current filenames rather than silently changing stem.
const srcUpd = db.prepare("UPDATE games SET source_file = ? WHERE id = ? AND source_file IS NULL");
for (const g of db.prepare("SELECT * FROM games").all()) {
  if (!g.source_file && g.name) srcUpd.run(`${g.name}.mp4`, g.id);
}

console.log("\nResult:");
for (const g of db.prepare("SELECT * FROM games ORDER BY played_on, slot, id").all()) {
  console.log(`  ${String(g.id).padStart(3)}  ${displayName(g)}`);
  console.log(`       yt: ${youtubeTitle(g)}`);
  console.log(`       slug: ${slug(g)}`);
}

if (!RETITLE) {
  console.log("\n(YouTube titles unchanged — re-run with --retitle to push these up.)");
  process.exit(0);
}

// --- retitle ---------------------------------------------------------------
const { updateVideoTitle, youtubeConfigured } = await import("../lib/youtube.js");
if (!youtubeConfigured()) {
  console.error("\nYouTube not configured — run `npm run yt-auth` first.");
  process.exit(1);
}
for (const g of db.prepare("SELECT * FROM games WHERE yt_video_id IS NOT NULL").all()) {
  const want = youtubeTitle(g);
  try {
    const r = await updateVideoTitle(g.yt_video_id, want);
    console.log(r.changed
      ? `  ${g.yt_video_id} -> ${r.title}`
      : `  ${g.yt_video_id} already "${r.title}" — skipped`);
  } catch (e) {
    console.error(`  ${g.yt_video_id} FAILED: ${e.message}`);
  }
}
