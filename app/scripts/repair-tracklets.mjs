#!/usr/bin/env node
// Repair touches whose linked tracklet belongs to a DIFFERENT player than the
// one the touch is credited to (ML-PLAN 0.1).
//
//   node scripts/repair-tracklets.mjs <game_id> --dry-run     # report only
//   node scripts/repair-tracklets.mjs <game_id> --apply       # write
//
// Why these exist: builds before the relink fix resolved tracklet_id to the
// nearest body REGARDLESS of who it was, and earlier builds simply left the
// pipeline's original tracklet in place when the reviewer renamed the player.
// Either way the row ends up saying "credited to Steve, body is Bob's", which
// downstream reads as an identity correction ("Bob is really Steve") rather
// than the geometry correction the reviewer actually made — and would teach a
// re-ID fine-tune that two different people look alike.
//
// Repair = re-resolve to a body OF THE CREDITED PLAYER at that instant, or
// NULL when they weren't tracked there. Only rows that are currently
// mispaired are touched; correct rows and honest NULLs are left alone.
// Requires the game's retained public/media/<id>/game.json.
import path from "path";
import { createRequire } from "module";
import { loadGameJson, boxesAt } from "../lib/gamejson.js";
const require_ = createRequire(import.meta.url);

const gid = Number(process.argv[2]);
const apply = process.argv.includes("--apply");
if (!gid) {
  console.error("usage: repair-tracklets.mjs <game_id> [--dry-run|--apply]");
  process.exit(1);
}
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "balltime.db");
let db;
try { db = new (require_("better-sqlite3"))(DB_PATH); }
catch { db = new (require_("node:sqlite").DatabaseSync)(DB_PATH); }

const game = loadGameJson(gid);
if (!game) {
  console.error(`no retained game.json for game ${gid} — cannot resolve bodies.`);
  console.error("Recover it with scripts/backfill-gamejson.mjs (must be the SAME");
  console.error("pipeline run that was imported, or the tracklet ids won't join).");
  process.exit(1);
}

const rows = db.prepare(
  `SELECT p.id, p.t, p.x, p.y, p.cluster_id, p.tracklet_id,
          i.cluster_id AS body_cluster
   FROM plays p
   JOIN rallies r ON r.id = p.rally_id
   JOIN tracklets t ON t.id = p.tracklet_id
   JOIN identities i ON i.id = t.identity_id
   WHERE r.game_id = ? AND p.deleted = 0 AND p.cluster_id IS NOT NULL
     AND i.cluster_id != p.cluster_id`).all(gid);

const nameOf = c => (db.prepare(
  "SELECT name FROM identities WHERE game_id = ? AND cluster_id = ?").get(gid, c) || {})
  .name || `P${c}`;

let relinked = 0, nulled = 0;
for (const p of rows) {
  const mine = db.prepare(
    `SELECT t.id, t.src_id FROM tracklets t
     JOIN identities i ON i.id = t.identity_id
     WHERE t.game_id = ? AND i.cluster_id = ? AND i.dismissed = 0`)
    .all(gid, p.cluster_id);
  const bySrc = new Map(mine.map(r => [r.src_id, r.id]));
  let best = null;
  for (const { src_id, box } of boxesAt(game, p.t)) {
    if (!bySrc.has(src_id)) continue;
    let d2 = 0;
    if (p.x != null && p.y != null) {
      const [, bx, by, bw, bh] = box;
      d2 = Math.hypot(bx + bw / 2 - p.x, (by + bh * 0.35 - p.y) * 0.6);
    }
    if (!best || d2 < best.d2) best = { id: bySrc.get(src_id), d2 };
  }
  const to = best ? best.id : null;
  if (to === null) nulled++; else relinked++;
  console.log(`play ${String(p.id).padEnd(6)} t=${String(p.t).padEnd(7)} ` +
    `credited ${nameOf(p.cluster_id).padEnd(14)} body was ${nameOf(p.body_cluster).padEnd(14)} ` +
    `-> ${to === null ? "NULL (credited player untracked here)" : "tracklet " + to}`);
  if (apply)
    db.prepare("UPDATE plays SET tracklet_id = ? WHERE id = ?").run(to, p.id);
}

console.log(`\n${rows.length} mispaired touch(es): ` +
  `${relinked} re-linked to the credited player's body, ${nulled} set NULL.`);
console.log(apply ? "APPLIED." : "DRY RUN — nothing written. Re-run with --apply.");
