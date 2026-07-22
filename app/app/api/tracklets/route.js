import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";

// POST { game_id, tracklet_ids: [], target: "new" | "dismiss" | <identity_id> }
export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { game_id, tracklet_ids, target } = await req.json();
  if (!Array.isArray(tracklet_ids) || tracklet_ids.length === 0)
    return Response.json({ error: "no tracklets" }, { status: 400 });
  const d = db();

  let identity;
  if (target === "new" || target === "dismiss") {
    const maxc = d.prepare(
      "SELECT MAX(cluster_id) m FROM identities WHERE game_id = ?").get(game_id);
    const crops = tracklet_ids.flatMap(tid => {
      const t = d.prepare("SELECT crops FROM tracklets WHERE id = ?").get(tid);
      return t ? JSON.parse(t.crops).slice(0, 2) : [];
    }).slice(0, 6);
    const rid = d.prepare(
      `INSERT INTO identities (game_id, cluster_id, dismissed, rep_crops, n_boxes)
       VALUES (?, ?, ?, ?, 0)`)
      .run(game_id, (maxc.m ?? 0) + 1, target === "dismiss" ? 1 : 0,
           JSON.stringify(crops)).lastInsertRowid;
    identity = d.prepare("SELECT * FROM identities WHERE id = ?").get(rid);
  } else {
    identity = d.prepare("SELECT * FROM identities WHERE id = ?").get(target);
    if (!identity) return Response.json({ error: "bad target" }, { status: 400 });
  }

  const marks = tracklet_ids.map(() => "?").join(",");
  d.prepare(`UPDATE tracklets SET identity_id = ? WHERE id IN (${marks})`)
    .run(identity.id, ...tracklet_ids);
  // plays follow their tracklet
  d.prepare(`UPDATE plays SET cluster_id = ? WHERE tracklet_id IN (${marks})`)
    .run(identity.dismissed ? null : identity.cluster_id, ...tracklet_ids);
  return Response.json({ ok: true, identity: { ...identity } });
}
