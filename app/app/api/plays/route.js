import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { loadGameJson, boxesAt } from "@/lib/gamejson";

// D3 (ML-PLAN 0.1): when the reviewer attributes via the typeahead, only a
// cluster_id arrives — but the training-side label we actually need is the
// TRACKLET (which tracked body was this). Derive it: the tracked body nearest
// the play's ball position at its time, using the SAME geometry as the
// pipeline's own attribution (vbpipe/plays.py attribute): distance to the
// upper-torso anchor (centre-x, 35% down the box) with the vertical axis
// weighted 0.6, accepted within the same 220px gate. A containment test does
// NOT work here — the ball at contact sits at the hands, typically far above
// the body box (median 129px on cca-one; an attack contact measured ~130px
// above the nearest box top), so "inside the box" almost never holds.
// Deliberately NOT filtered to the chosen cluster: a tracklet at the ball
// whose cluster differs from the name the reviewer picked is exactly the
// misclustering evidence we want to capture. Best-effort by design — no
// game.json, no position, or nobody within the gate all silently skip.
function backfillTracklet(d, playId) {
  const GATE = 220, Y_W = 0.6;   // vbpipe plays.attribute values
  const p = d.prepare(
    `SELECT p.t, p.x, p.y, r.game_id FROM plays p
     JOIN rallies r ON r.id = p.rally_id WHERE p.id = ?`).get(playId);
  if (!p || p.x == null || p.y == null) return;
  const game = loadGameJson(p.game_id);
  if (!game) return;
  let best = null;
  for (const { src_id, box } of boxesAt(game, p.t)) {
    const [, bx, by, bw, bh] = box;
    const ax = bx + bw / 2, ay = by + bh * 0.35;
    const dc = Math.hypot(ax - p.x, (ay - p.y) * Y_W);
    if (dc < GATE && (!best || dc < best.dc)) best = { src_id, dc };
  }
  if (!best) return;
  const row = d.prepare(
    "SELECT id FROM tracklets WHERE game_id = ? AND src_id = ?")
    .get(p.game_id, best.src_id);
  if (row)
    d.prepare("UPDATE plays SET tracklet_id = ? WHERE id = ?").run(row.id, playId);
}

export async function PATCH(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, ...fields } = await req.json();
  const allowed = ["play_type", "cluster_id", "deleted", "t", "grade",
                   "x", "y", "tracklet_id"];
  const d = db();
  for (const k of Object.keys(fields)) {
    if (!allowed.includes(k)) return Response.json({ error: "bad field" }, { status: 400 });
    d.prepare(`UPDATE plays SET ${k} = ?, corrected = 1 WHERE id = ?`).run(fields[k], id);
  }
  if ("cluster_id" in fields && !("tracklet_id" in fields))
    backfillTracklet(d, id);
  return Response.json({ ok: true });
}

export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { rally_id, t, x, y, cluster_id, tracklet_id } = await req.json();
  const r = db().prepare(
    `INSERT INTO plays (rally_id, t, x, y, play_type, cluster_id, tracklet_id, corrected)
     VALUES (?, ?, ?, ?, 'attack', ?, ?, 1)`)
    .run(rally_id, t, x ?? null, y ?? null, cluster_id ?? null, tracklet_id ?? null);
  return Response.json({ id: Number(r.lastInsertRowid) });
}
