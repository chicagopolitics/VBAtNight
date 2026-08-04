#!/usr/bin/env node
// One-time backfill: put a bundle's game.json next to an already-imported
// game's video, so the Shorts renderer can use its ball track.
//
// Games imported before this was fixed have no game.json on disk — import
// read it, flattened what it needed into SQLite, and discarded the rest. The
// ball track was in "the rest".
//
//   node scripts/backfill-gamejson.mjs                 # show what's missing
//   node scripts/backfill-gamejson.mjs 13 ../game.json
//
// WHAT ACTUALLY HAS TO MATCH: the VIDEO, not the pipeline run.
//
// The renderer only reads two things from game.json — the ball track and the
// player boxes — and both are keyed to absolute game time. Touch times and
// rally boundaries come from the reviewed database and override game.json's
// own. So a game.json from an *earlier or later run of the same video* works
// perfectly: verified by rendering the same moment from two different runs of
// cca-one and getting an identical window and camera path.
//
// This check originally compared rally counts and boundaries, which is the
// wrong invariant — reprocessing a game re-segments its rallies, so a
// perfectly usable file gets rejected and you go re-download a 3 GB bundle
// for nothing. What we test instead is whether this file describes the same
// footage: does its ball track actually show up during the rallies the
// database recorded? A game.json for a different game fails that badly.
import fs from "fs";
import path from "path";
import { db } from "../lib/db.js";

const MEDIA = path.join(process.cwd(), "public", "media");
const jsonPath = gid => path.join(MEDIA, String(gid), "game.json");

const [gid, src] = process.argv.slice(2);

if (!gid) {
  const rows = db().prepare("SELECT id, name, video_file FROM games ORDER BY id").all();
  console.log("game  json?  name");
  for (const g of rows)
    console.log(String(g.id).padEnd(6),
      (fs.existsSync(jsonPath(g.id)) ? "yes " : "NO  ").padEnd(6), g.name);
  console.log("\nBackfill with:  node scripts/backfill-gamejson.mjs <game id> <path to game.json>");
  process.exit(0);
}

if (!src) { console.error("need a path to the bundle's game.json"); process.exit(1); }
const game = db().prepare("SELECT * FROM games WHERE id = ?").get(Number(gid));
if (!game) { console.error(`no game ${gid}`); process.exit(1); }
if (!fs.existsSync(src)) { console.error(`no such file: ${src}`); process.exit(1); }

const g = JSON.parse(fs.readFileSync(src, "utf8"));
if (!g.ball?.length) {
  console.error("that game.json has no 'ball' track — the Shorts crop needs it.");
  process.exit(1);
}

// Does this file describe the same footage? Test the ball track against the
// rallies the database recorded: during a real rally the ball is being
// detected, so a matching game.json has detections inside most rally
// windows. A file from another game has essentially none.
const dbRallies = db().prepare(
  "SELECT start_s, end_s FROM rallies WHERE game_id = ? ORDER BY start_s").all(game.id);
if (!dbRallies.length) { console.error(`game ${gid} has no rallies`); process.exit(1); }

const ball = g.ball.flat();
const ballTimes = ball.map(p => p[0]);
const covered = dbRallies.filter(r =>
  ballTimes.some(t => t >= r.start_s && t <= r.end_s)).length;
const pct = (covered / dbRallies.length) * 100;

// Coverage alone is a weak signal — ball detections are dense enough across a
// ~17-minute game that almost any rally window catches one by chance (a
// deliberately wrong file scored 69% here). It only catches the gross case.
if (pct < 20) {
  console.error(`REJECTED: only ${covered}/${dbRallies.length} rallies ` +
    `(${pct.toFixed(0)}%) have any ball detection in this file — it's for ` +
    `different footage entirely.`);
  process.exit(1);
}

// The real evidence: where the reviewer's touches have a recorded position,
// was the ball actually THERE at that moment? Same footage puts the ball on
// the contact; different footage scatters.
const positioned = db().prepare(
  `SELECT p.t, p.x, p.y FROM plays p JOIN rallies r ON r.id = p.rally_id
   WHERE r.game_id = ? AND p.deleted = 0 AND p.x IS NOT NULL`).all(game.id);
let dists = [];
for (const p of positioned) {
  let best = Infinity;
  for (const b of ball) {
    if (Math.abs(b[0] - p.t) > 0.15) continue;
    best = Math.min(best, Math.hypot(b[1] - p.x, b[2] - p.y));
  }
  if (best < Infinity) dists.push(best);
}
dists.sort((a, b) => a - b);
const median = dists.length ? dists[dists.length >> 1] : null;
const close = dists.length
  ? (dists.filter(d => d < 80).length / dists.length) * 100 : null;

console.log(`  ball detected during ${covered}/${dbRallies.length} rallies (${pct.toFixed(0)}%)`);
if (median === null) {
  console.log(`  no positioned touches to cross-check — verify by rendering one clip`);
} else {
  console.log(`  ${dists.length} positioned touches: ball a median ${median.toFixed(0)}px ` +
    `away, ${close.toFixed(0)}% within 80px`);
  // Calibration note: a correct file should sit low (the reviewed positions
  // came from a run of this very footage). High numbers mean wrong video —
  // or a very different detector run. It's advisory because I have no
  // positive control to set a hard threshold against; the definitive test is
  // rendering one clip and looking at it.
  if (median > 200 && !process.argv.includes("--force")) {
    console.error(`\n  SUSPICIOUS: the ball is nowhere near the recorded touches.\n` +
      `  That usually means this game.json is for a different game.\n` +
      `  If you're confident it's right, re-run with --force.`);
    process.exit(1);
  }
}

// A rally-count difference is normal across reprocesses and is NOT a problem
// — say so, so it doesn't look like something is wrong.
const jsonRallies = g.rallies || [];
const pipelineRallies = dbRallies.filter(r => r.start_s !== null).length;
if (jsonRallies.length !== pipelineRallies)
  console.log(`  note: this file has ${jsonRallies.length} rallies vs the db's ` +
    `${pipelineRallies} — a different pipeline run. Harmless: the renderer ` +
    `takes touches and boundaries from the db, and only the ball/player ` +
    `tracking from here.`);

fs.mkdirSync(path.dirname(jsonPath(game.id)), { recursive: true });
fs.copyFileSync(src, jsonPath(game.id));
console.log(`✓ game ${game.id} "${game.name}": ${ballTimes.length} ball points`);
console.log(`  wrote ${path.relative(process.cwd(), jsonPath(game.id))}`);
console.log(`  now render one clip from this game and watch it — that's the ` +
  `only definitive check.`);
