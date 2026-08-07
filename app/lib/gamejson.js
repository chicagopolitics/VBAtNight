// Server-side access to the retained pipeline output.
//
// Per-frame tracklet BOXES exist only in public/media/<gid>/game.json — the
// SQLite flattening at import deliberately drops them (lib/import.js). The
// click-attribution overlay and the tracklet backfill both need them, and
// re-parsing ~9 MB of JSON per request would be silly, so this module keeps a
// per-game cache invalidated on file mtime (a re-import via backfill-gamejson
// replaces the file, and the next request just picks it up).
import fs from "fs";
import path from "path";

const cache = new Map();   // gid -> { mtimeMs, game }

/** Parsed game.json for a game, or null when the game predates retention
 *  (e.g. games imported before the bundle kept game.json). */
export function loadGameJson(gid) {
  const file = path.join(process.cwd(), "public", "media", String(gid), "game.json");
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(gid); return null; }
  const hit = cache.get(gid);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.game;
  const game = JSON.parse(fs.readFileSync(file, "utf8"));
  cache.set(gid, { mtimeMs: st.mtimeMs, game });
  return game;
}

// Matches the pipeline's own overlay renderer (pipeline/vbpipe/overlay.py:71):
// a box "at" time t is the tracklet's nearest box within this window.
export const BOX_T_TOL = 0.12;

/** Tracklets with a box near time t, as
 *  [{src_id, box:[t,x,y,w,h]}] in the 1280x720 reference space. */
export function boxesAt(game, t, tol = BOX_T_TOL) {
  const out = [];
  for (const tr of game.tracklets || []) {
    if (tr.t1 < t - tol || tr.t0 > t + tol) continue;
    let best = null;
    for (const b of tr.boxes) {
      if (Math.abs(b[0] - t) <= tol && (!best || Math.abs(b[0] - t) < Math.abs(best[0] - t)))
        best = b;
    }
    if (best) out.push({ src_id: tr.id, box: best });
  }
  return out;
}
