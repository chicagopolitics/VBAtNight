#!/usr/bin/env node
// Export a reviewed game as a labeled dataset for pipeline evaluation/training.
// Usage: node scripts/export-corrections.js <game_id> [out.json]
const fs = require("fs");
const path = require("path");
const [,, gid, outPath] = process.argv;
if (!gid) { console.error("usage: export-corrections.js <game_id> [out.json]"); process.exit(1); }
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "balltime.db");
let db;
try { db = new (require("better-sqlite3"))(DB_PATH); }
catch { db = new (require("node:sqlite").DatabaseSync)(DB_PATH); }

const game = db.prepare("SELECT * FROM games WHERE id = ?").get(gid);
if (!game) { console.error("no such game"); process.exit(1); }

const identities = db.prepare(
  `SELECT id, cluster_id, name, dismissed, merged_into FROM identities WHERE game_id = ?`)
  .all(gid).map(r => ({ ...r }));

const rallies = db.prepare("SELECT * FROM rallies WHERE game_id = ? ORDER BY idx")
  .all(gid).map(r => {
    const plays = db.prepare(
      `SELECT t, x, y, play_type, cluster_id, tracklet_id, corrected, deleted
       FROM plays WHERE rally_id = ? ORDER BY t`).all(r.id).map(p => ({ ...p }));
    return {
      idx: r.idx, start: r.start_s, end: r.end_s, phase: r.phase,
      outcome: r.outcome_type
        ? { type: r.outcome_type, cluster: r.outcome_cluster } : null,
      plays: plays.filter(p => !p.deleted).map(({ deleted, ...p }) => p),
      removed_plays: plays.filter(p => p.deleted).map(({ deleted, ...p }) => p),
    };
  });

const nCorr = rallies.reduce((a, r) =>
  a + r.plays.filter(p => p.corrected).length + r.removed_plays.length, 0);
const out = {
  game_id: +gid, name: game.name, exported_at: new Date().toISOString(),
  review_stats: {
    corrected_or_removed: nCorr,
    outcomes_set: rallies.filter(r => r.outcome).length,
    named_identities: identities.filter(i => i.name).length,
  },
  identities, rallies,
};
const fp = outPath || `corrections_game${gid}.json`;
fs.writeFileSync(fp, JSON.stringify(out, null, 1));
console.log(`wrote ${fp}: ${rallies.length} rallies, ${nCorr} corrections, ` +
  `${out.review_stats.outcomes_set} outcomes, ${out.review_stats.named_identities} named players`);
