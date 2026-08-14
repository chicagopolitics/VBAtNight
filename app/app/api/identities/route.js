import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";

export async function PATCH(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, ...fields } = await req.json();
  const allowed = ["name", "dismissed", "merged_into", "clean", "team", "player_id"];
  const d = db();
  let restored = 0;   // touches handed back by an un-dismiss (see below)
  for (const k of Object.keys(fields)) {
    if (!allowed.includes(k)) return Response.json({ error: "bad field" }, { status: 400 });
    d.prepare(`UPDATE identities SET ${k} = ? WHERE id = ?`).run(fields[k], id);
    if (k === "merged_into" && fields[k]) {
      // re-point plays + tracklets so stats follow the merge
      const src = d.prepare("SELECT * FROM identities WHERE id = ?").get(id);
      const dst = d.prepare("SELECT * FROM identities WHERE id = ?").get(fields[k]);
      if (src && dst) {
        d.prepare(`UPDATE plays SET cluster_id = ? WHERE cluster_id = ? AND rally_id IN
                   (SELECT id FROM rallies WHERE game_id = ?)`)
          .run(dst.cluster_id, src.cluster_id, src.game_id);
        d.prepare("UPDATE tracklets SET identity_id = ? WHERE identity_id = ?")
          .run(dst.id, src.id);
      }
    }
    // Dismissing is UNDOABLE (the identities UI offers both an undo toast and
    // a "not players" list), so it records what it took away before taking it.
    if (k === "dismissed" && fields[k]) {
      const src = d.prepare("SELECT * FROM identities WHERE id = ?").get(id);
      if (src) {
        const ids = d.prepare(
          `SELECT p.id FROM plays p JOIN rallies r ON r.id = p.rally_id
           WHERE p.cluster_id = ? AND r.game_id = ?`).all(src.cluster_id, src.game_id)
          .map(r => r.id);
        d.prepare("UPDATE identities SET dismissed_plays = ? WHERE id = ?")
          .run(JSON.stringify(ids), id);
        d.prepare(`UPDATE plays SET cluster_id = NULL WHERE cluster_id = ? AND rally_id IN
                   (SELECT id FROM rallies WHERE game_id = ?)`)
          .run(src.cluster_id, src.game_id);
      }
    }
    if (k === "dismissed" && !fields[k]) {
      const src = d.prepare("SELECT * FROM identities WHERE id = ?").get(id);
      let ids = [];
      try { ids = JSON.parse(src?.dismissed_plays || "[]"); } catch {}
      // Older dismissals (and the split UI's "not a player", which routes
      // through /api/tracklets) left no list. There the touches moved with
      // their tracklet, so the tracklet link reconstructs the same set.
      if (!ids.length && src)
        ids = d.prepare(
          `SELECT id FROM plays WHERE cluster_id IS NULL AND tracklet_id IN
           (SELECT id FROM tracklets WHERE identity_id = ?)`).all(id).map(r => r.id);
      if (src && ids.length) {
        const marks = ids.map(() => "?").join(",");
        // still-NULL only: a touch re-attributed to someone else in review
        // since the dismissal belongs to them now, not to this identity.
        restored = d.prepare(
          `UPDATE plays SET cluster_id = ? WHERE id IN (${marks}) AND cluster_id IS NULL`)
          .run(src.cluster_id, ...ids).changes;
      }
      d.prepare("UPDATE identities SET dismissed_plays = NULL WHERE id = ?").run(id);
    }
  }
  return Response.json({ ok: true, restored });
}
