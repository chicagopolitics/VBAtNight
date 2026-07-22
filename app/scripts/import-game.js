#!/usr/bin/env node
// Usage: node scripts/import-game.js <game.json> <name> [clips_dir] [crops_dir]
const fs = require("fs");
const path = require("path");

const [,, gameJson, name, clipsDir, cropsDir] = process.argv;
if (!gameJson || !name) {
  console.error("usage: import-game.js <game.json> <name> [clips_dir] [crops_dir]");
  process.exit(1);
}
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "balltime.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
let db;
try { db = new (require("better-sqlite3"))(DB_PATH); }
catch { db = new (require("node:sqlite").DatabaseSync)(DB_PATH); }
db.exec(fs.readFileSync(path.join(__dirname, "..", "lib", "schema.sql"), "utf8"));

const g = JSON.parse(fs.readFileSync(gameJson, "utf8"));
const mediaRoot = path.join(process.cwd(), "public", "media");

const gid = db.prepare("INSERT INTO games (name, video_file) VALUES (?, ?)")
  .run(name, g.video || null).lastInsertRowid;
const gdir = path.join(mediaRoot, String(gid));
fs.mkdirSync(path.join(gdir, "crops"), { recursive: true });
fs.mkdirSync(path.join(gdir, "clips"), { recursive: true });

// identities (mean embedding over member tracklets, if pipeline exported them)
const embByCluster = {};
for (const tr of g.tracklets || []) {
  if (tr.emb && tr.cluster !== undefined)
    (embByCluster[tr.cluster] ??= []).push(tr.emb);
}
for (const c of g.clusters || []) {
  let emb = null;
  const es = embByCluster[c.id];
  if (es && es.length) {
    emb = es[0].map((_, k) => es.reduce((a, e) => a + e[k], 0) / es.length);
    const n = Math.hypot(...emb); emb = emb.map(v => +(v / (n || 1)).toFixed(5));
  }
  const reps = (c.rep_crops || []).map(fn => {
    const src = cropsDir ? path.join(cropsDir, path.basename(fn)) : null;
    if (src && fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(gdir, "crops", path.basename(fn)));
      return `/media/${gid}/crops/${path.basename(fn)}`;
    }
    return null;
  }).filter(Boolean);
  db.prepare(`INSERT INTO identities (game_id, cluster_id, n_boxes, rep_crops, embedding)
              VALUES (?, ?, ?, ?, ?)`)
    .run(gid, c.id, c.n_boxes || 0, JSON.stringify(reps), emb ? JSON.stringify(emb) : null);
}

// tracklets
const srcToDb = {};
for (const tr of g.tracklets || []) {
  const crops = (tr.crops || []).slice(0, 4).map(fn => {
    const src = cropsDir ? path.join(cropsDir, path.basename(fn)) : null;
    if (src && fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(gdir, "crops", path.basename(fn)));
      return `/media/${gid}/crops/${path.basename(fn)}`;
    }
    return null;
  }).filter(Boolean);
  const identRow = tr.cluster !== undefined
    ? db.prepare("SELECT id FROM identities WHERE game_id = ? AND cluster_id = ?").get(gid, tr.cluster)
    : null;
  // typicality: cosine similarity of this tracklet to its identity's mean embedding
  let typ = null;
  if (tr.emb && tr.cluster !== undefined && embByCluster[tr.cluster]) {
    const es = embByCluster[tr.cluster];
    const mean = es[0].map((_, k) => es.reduce((a, e) => a + e[k], 0) / es.length);
    const nm = Math.hypot(...mean), nt = Math.hypot(...tr.emb);
    typ = tr.emb.reduce((a, v, k) => a + v * mean[k], 0) / ((nm * nt) || 1);
  }
  const r = db.prepare(`INSERT INTO tracklets (game_id, src_id, identity_id, rally_idx, t0, t1, crops, typicality)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(gid, tr.id, identRow ? identRow.id : null, tr.rally, tr.t0, tr.t1, JSON.stringify(crops), typ);
  srcToDb[tr.id] = Number(r.lastInsertRowid);
}

// rallies + plays
const clipFiles = clipsDir ? fs.readdirSync(clipsDir) : [];
(g.rallies || []).forEach((r, idx) => {
  let clip = null;
  const m = clipFiles.find(f => f.startsWith(`rally_${String(idx).padStart(2,"0")}`));
  if (m) {
    fs.copyFileSync(path.join(clipsDir, m), path.join(gdir, "clips", m));
    clip = `/media/${gid}/clips/${m}`;
  }
  const rid = db.prepare(`INSERT INTO rallies (game_id, idx, start_s, end_s, phase, clip_file)
                          VALUES (?, ?, ?, ?, ?, ?)`)
    .run(gid, idx, r.start, r.end, r.phase || "game", clip).lastInsertRowid;
  for (const c of r.contacts || []) {
    db.prepare(`INSERT INTO plays (rally_id, t, x, y, play_type, cluster_id, dist_px, tracklet_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rid, c.t, c.x ?? null, c.y ?? null, c.play || null,
           c.cluster ?? null, c.dist_px ?? null,
           c.tracklet !== undefined ? (srcToDb[c.tracklet] ?? null) : null);
  }
});
console.log(`imported game ${gid}: ${(g.rallies||[]).length} rallies, ` +
  `${(g.clusters||[]).length} identities`);
