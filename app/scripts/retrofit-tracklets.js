#!/usr/bin/env node
// One-time: add tracklets for an existing imported game, preserving corrections.
// Usage: node scripts/retrofit-tracklets.js <game_id> <game.json> <crops_dir>
const fs = require("fs");
const path = require("path");
const [,, gid, gameJson, cropsDir] = process.argv;
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "balltime.db");
let db;
try { db = new (require("better-sqlite3"))(DB_PATH); }
catch { db = new (require("node:sqlite").DatabaseSync)(DB_PATH); }
db.exec(fs.readFileSync(path.join(__dirname, "..", "lib", "schema.sql"), "utf8"));
try { db.exec("ALTER TABLE plays ADD COLUMN tracklet_id INTEGER"); } catch {}

const g = JSON.parse(fs.readFileSync(gameJson, "utf8"));
const gdir = path.join(process.cwd(), "public", "media", String(gid));
fs.mkdirSync(path.join(gdir, "crops"), { recursive: true });

const identByCluster = {};
for (const row of db.prepare("SELECT id, cluster_id FROM identities WHERE game_id = ?").all(gid))
  identByCluster[row.cluster_id] = row.id;

const existing = db.prepare("SELECT COUNT(*) c FROM tracklets WHERE game_id = ?").get(gid);
if (existing.c > 0) { console.log("tracklets already present; aborting"); process.exit(1); }

let copied = 0, srcToDb = {};
for (const tr of g.tracklets || []) {
  const crops = [];
  for (const fn of (tr.crops || []).slice(0, 4)) {
    const src = path.join(cropsDir, path.basename(fn));
    if (fs.existsSync(src)) {
      const dst = path.join(gdir, "crops", path.basename(fn));
      if (!fs.existsSync(dst)) { fs.copyFileSync(src, dst); copied++; }
      crops.push(`/media/${gid}/crops/${path.basename(fn)}`);
    }
  }
  const identId = tr.cluster !== undefined ? (identByCluster[tr.cluster] ?? null) : null;
  const r = db.prepare(`INSERT INTO tracklets (game_id, src_id, identity_id, rally_idx, t0, t1, crops)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(gid, tr.id, identId, tr.rally, tr.t0, tr.t1, JSON.stringify(crops));
  srcToDb[tr.id] = Number(r.lastInsertRowid);
}
const rallies = db.prepare("SELECT id, idx FROM rallies WHERE game_id = ?").all(gid);
let linked = 0;
for (const r of rallies) {
  const contacts = (g.rallies[r.idx] || {}).contacts || [];
  const plays = db.prepare("SELECT id, t FROM plays WHERE rally_id = ? AND deleted = 0").all(r.id);
  for (const p of plays) {
    const c = contacts.find(c => Math.abs(c.t - p.t) < 0.05);
    if (c && c.tracklet !== undefined && srcToDb[c.tracklet]) {
      db.prepare("UPDATE plays SET tracklet_id = ? WHERE id = ?").run(srcToDb[c.tracklet], p.id);
      linked++;
    }
  }
}
console.log(`tracklets: ${Object.keys(srcToDb).length}, crops copied: ${copied}, plays linked: ${linked}`);
