import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";

export async function PATCH(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, ...fields } = await req.json();
  const allowed = ["name", "dismissed", "merged_into", "clean", "team", "player_id"];
  const d = db();
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
    if (k === "dismissed" && fields[k]) {
      const src = d.prepare("SELECT * FROM identities WHERE id = ?").get(id);
      if (src) d.prepare(`UPDATE plays SET cluster_id = NULL WHERE cluster_id = ? AND rally_id IN
                          (SELECT id FROM rallies WHERE game_id = ?)`)
        .run(src.cluster_id, src.game_id);
    }
  }
  return Response.json({ ok: true });
}
