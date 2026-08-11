#!/usr/bin/env node
// Read-only snapshot of a balltime database: what's imported, which pipeline
// produced it, how far review has got, and whether any touch carries the
// false tracklet pairing described in ML-PLAN 0.1.
//
//   node scripts/review-state.mjs
//   DB_PATH=/path/to/balltime.db node scripts/review-state.mjs
//
// Writes nothing. Safe to run against production.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require_ = createRequire(import.meta.url);

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "balltime.db");
if (!fs.existsSync(DB_PATH)) {
  console.error(`no database at ${DB_PATH} — set DB_PATH`);
  process.exit(1);
}
let db;
try { db = new (require_("better-sqlite3"))(DB_PATH); }
catch { db = new (require_("node:sqlite").DatabaseSync)(DB_PATH); }

const has = (table, col) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);

console.log(`db: ${DB_PATH}\n`);

// --- schema: did the new migrations run on this box? -----------------------
const COLS = [["rallies", "touches_complete"], ["games", "pipeline"],
              ["plays", "tracklet_id"]];
console.log("schema");
for (const [t, c] of COLS)
  console.log(`  ${t}.${c.padEnd(17)} ${has(t, c) ? "present" : "MISSING (app hasn't booted with the new build)"}`);
const hasComplete = has("rallies", "touches_complete");
const hasPipeline = has("games", "pipeline");

// --- per game --------------------------------------------------------------
const games = db.prepare("SELECT * FROM games ORDER BY id").all();
console.log(`\n${games.length} game(s)\n`);
for (const g of games) {
  const pl = hasPipeline && g.pipeline ? JSON.parse(g.pipeline) : null;
  const r = db.prepare(
    `SELECT COUNT(*) n, SUM(outcome_type IS NOT NULL) scored
     FROM rallies WHERE game_id = ? AND phase = 'game'`).get(g.id);
  const cmpl = hasComplete ? db.prepare(
    `SELECT SUM(touches_complete) c FROM rallies WHERE game_id = ? AND phase = 'game'`)
    .get(g.id).c : null;
  const p = db.prepare(
    `SELECT COUNT(*) n, SUM(corrected) corr, SUM(tracklet_id IS NOT NULL) tr,
            SUM(cluster_id IS NULL) unattr
     FROM plays p JOIN rallies r ON r.id = p.rally_id
     WHERE r.game_id = ? AND p.deleted = 0`).get(g.id);
  const del = db.prepare(
    `SELECT COUNT(*) n FROM plays p JOIN rallies r ON r.id = p.rally_id
     WHERE r.game_id = ? AND p.deleted = 1`).get(g.id).n;
  const ids = db.prepare(
    "SELECT COUNT(*) n, SUM(name IS NOT NULL) named FROM identities WHERE game_id = ?")
    .get(g.id);

  // the check that matters: a touch credited to one player whose linked body
  // belongs to another. Pre-fix builds wrote these on every typeahead
  // correction; they read downstream as identity evidence and are wrong.
  const bad = db.prepare(
    `SELECT COUNT(*) n FROM plays p
     JOIN rallies r ON r.id = p.rally_id
     JOIN tracklets t ON t.id = p.tracklet_id
     JOIN identities i ON i.id = t.identity_id
     WHERE r.game_id = ? AND p.deleted = 0 AND p.cluster_id IS NOT NULL
       AND i.cluster_id != p.cluster_id`).get(g.id).n;

  const gj = path.join(process.cwd(), "public", "media", String(g.id), "game.json");
  console.log(`game ${g.id}  "${g.name}"  src=${g.source_file || "(none)"}`);
  console.log(`  pipeline      ${pl ? `vbpipe ${pl.vbpipe_version}  stages=${Object.keys(pl.stages || {}).join(",")}`
                                   : "UNSTAMPED (pre-1.0.0 -> evaluation-only)"}`);
  console.log(`  game.json     ${fs.existsSync(gj) ? "retained" : "MISSING (no overlay, no tracklet relink)"}`);
  console.log(`  rallies       ${r.n} game  |  scored ${r.scored}  |  complete-flagged ${cmpl ?? "n/a"}`);
  console.log(`  touches       ${p.n} live (${p.corr} corrected, ${p.unattr} unattributed) + ${del} deleted`);
  console.log(`  tracklet link ${p.tr}/${p.n}`);
  console.log(`  identities    ${ids.n} (${ids.named} named)`);
  console.log(`  MISPAIRED     ${bad}  <- credited player != linked body's identity`);
  if (bad > 0)
    console.log(`                run: node scripts/repair-tracklets.mjs ${g.id} --dry-run`);
  console.log();
}
