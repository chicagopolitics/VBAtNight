// Import a processed game bundle (game.json + clips/ + crops/) into the DB.
import fs from "fs";
import path from "path";
import { db } from "./db";

export function importGameFromDir(dir, name) {
  const g = JSON.parse(fs.readFileSync(path.join(dir, "game.json"), "utf8"));
  const d = db();
  const gid = Number(d.prepare("INSERT INTO games (name, video_file) VALUES (?, ?)")
    .run(name, g.video || null).lastInsertRowid);
  const gdir = path.join(process.cwd(), "public", "media", String(gid));
  fs.mkdirSync(path.join(gdir, "crops"), { recursive: true });
  fs.mkdirSync(path.join(gdir, "clips"), { recursive: true });

  // v8 bundles ship the full source video (played via media fragments)
  // instead of per-rally clips
  const bundleVideo = fs.readdirSync(dir).find(f => /^game\.(mp4|mov|mkv)$/i.test(f));
  if (bundleVideo) {
    const dst = path.join(gdir, bundleVideo);
    try { fs.renameSync(path.join(dir, bundleVideo), dst); }      // move (multi-GB)
    catch { fs.copyFileSync(path.join(dir, bundleVideo), dst); }  // cross-device fallback
    d.prepare("UPDATE games SET video_file = ? WHERE id = ?")
      .run(`/media/${gid}/${bundleVideo}`, gid);
  }

  const embByCluster = {};
  for (const tr of g.tracklets || [])
    if (tr.emb && tr.cluster !== undefined)
      (embByCluster[tr.cluster] ??= []).push(tr.emb);

  const meanEmb = {};
  for (const [cid, es] of Object.entries(embByCluster)) {
    let m = es[0].map((_, k) => es.reduce((a, e) => a + e[k], 0) / es.length);
    const n = Math.hypot(...m) || 1;
    meanEmb[cid] = m.map(v => v / n);
  }

  const copyCrop = fn => {
    const src = path.join(dir, "crops", path.basename(fn));
    if (!fs.existsSync(src)) return null;
    const dst = path.join(gdir, "crops", path.basename(fn));
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    return `/media/${gid}/crops/${path.basename(fn)}`;
  };

  for (const c of g.clusters || []) {
    const reps = (c.rep_crops || []).map(copyCrop).filter(Boolean);
    const emb = meanEmb[c.id];
    d.prepare(`INSERT INTO identities (game_id, cluster_id, n_boxes, rep_crops, embedding)
               VALUES (?, ?, ?, ?, ?)`)
      .run(gid, c.id, c.n_boxes || 0, JSON.stringify(reps),
           emb ? JSON.stringify(emb.map(v => +v.toFixed(5))) : null);
  }

  const srcToDb = {};
  for (const tr of g.tracklets || []) {
    const crops = (tr.crops || []).slice(0, 4).map(copyCrop).filter(Boolean);
    const identRow = tr.cluster !== undefined
      ? d.prepare("SELECT id FROM identities WHERE game_id = ? AND cluster_id = ?")
          .get(gid, tr.cluster) : null;
    let typ = null;
    if (tr.emb && tr.cluster !== undefined && meanEmb[tr.cluster]) {
      const m = meanEmb[tr.cluster];
      const nt = Math.hypot(...tr.emb) || 1;
      typ = tr.emb.reduce((a, v, k) => a + (v / nt) * m[k], 0);
    }
    const r = d.prepare(
      `INSERT INTO tracklets (game_id, src_id, identity_id, rally_idx, t0, t1, crops, typicality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(gid, tr.id, identRow ? identRow.id : null, tr.rally, tr.t0, tr.t1,
           JSON.stringify(crops), typ);
    srcToDb[tr.id] = Number(r.lastInsertRowid);
  }

  const clipsDir = path.join(dir, "clips");
  const clipFiles = fs.existsSync(clipsDir) ? fs.readdirSync(clipsDir) : [];
  (g.rallies || []).forEach((r, idx) => {
    let clip = null;
    const m = clipFiles.find(f => f.startsWith(`rally_${String(idx).padStart(2, "0")}`));
    if (m) {
      fs.copyFileSync(path.join(clipsDir, m), path.join(gdir, "clips", m));
      clip = `/media/${gid}/clips/${m}`;
    }
    const rid = d.prepare(
      `INSERT INTO rallies (game_id, idx, start_s, end_s, phase, clip_file)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .run(gid, idx, r.start, r.end, r.phase || "game", clip).lastInsertRowid;
    for (const c of r.contacts || []) {
      d.prepare(`INSERT INTO plays (rally_id, t, x, y, play_type, cluster_id, dist_px, tracklet_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(rid, c.t, c.x ?? null, c.y ?? null, c.play || null,
             c.cluster ?? null, c.dist_px ?? null,
             c.tracklet !== undefined ? (srcToDb[c.tracklet] ?? null) : null);
    }
  });
  return gid;
}

// Extract a bundle zip (streamed to zipPath inside tmp) and import it.
// Shared by upload import and Drive import. Caller owns tmp cleanup on error.
export async function importGameFromZip(zipPath, tmp, name) {
  // system tar (bsdtar) extracts zips streaming — no 2 GiB limit. Ships
  // with Windows 10+ and macOS. adm-zip is only the fallback (<2 GiB).
  const { spawnSync } = await import("child_process");
  let r = { status: 1 };
  for (const bin of ["tar", "bsdtar"]) {   // Windows/macOS tar is bsdtar (zip-capable)
    r = spawnSync(bin, ["-xf", zipPath, "-C", tmp]);
    if (!r.error && r.status === 0) break;
  }
  if (r.error || r.status !== 0) {
    if (fs.statSync(zipPath).size >= 2 ** 31)
      throw new Error("bundle over 2 GiB and no system tar available to extract it");
    const AdmZip = (await import("adm-zip")).default;
    new AdmZip(zipPath).extractAllTo(tmp, true);
  }
  fs.rmSync(zipPath, { force: true });
  if (!fs.existsSync(path.join(tmp, "game.json")))
    throw new Error("bundle has no game.json");
  return importGameFromDir(tmp, String(name));
}
