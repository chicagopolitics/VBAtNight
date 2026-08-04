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
// Sanity-checks that the file actually matches the game before copying: a
// mismatched game.json would put the crop window on the wrong rallies, which
// is much harder to notice than an outright failure.
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

// Does this json describe this game? Compare rally count and boundaries
// against the DB, which was built from the real bundle at import time.
const dbRallies = db().prepare(
  "SELECT start_s, end_s FROM rallies WHERE game_id = ? AND idx >= 0 ORDER BY idx").all(game.id);
const jsonRallies = g.rallies || [];
if (dbRallies.length !== jsonRallies.length) {
  console.error(`MISMATCH: db has ${dbRallies.length} pipeline rallies, ` +
    `this json has ${jsonRallies.length}. Wrong file for game ${gid}?`);
  process.exit(1);
}
const drift = dbRallies.reduce((worst, r, i) =>
  Math.max(worst, Math.abs(r.start_s - jsonRallies[i].start)), 0);
if (drift > 1.0) {
  console.error(`MISMATCH: rally starts differ by up to ${drift.toFixed(1)}s. ` +
    `Wrong file for game ${gid}?`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(jsonPath(game.id)), { recursive: true });
fs.copyFileSync(src, jsonPath(game.id));
console.log(`✓ game ${game.id} "${game.name}": ${jsonRallies.length} rallies, ` +
  `${g.ball.reduce((n, r) => n + r.length, 0)} ball points, ` +
  `max rally-start drift ${drift.toFixed(2)}s`);
console.log(`  wrote ${path.relative(process.cwd(), jsonPath(game.id))}`);
