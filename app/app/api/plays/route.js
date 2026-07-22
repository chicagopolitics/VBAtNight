import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";

export async function PATCH(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, ...fields } = await req.json();
  const allowed = ["play_type", "cluster_id", "deleted", "t", "grade"];
  for (const k of Object.keys(fields)) {
    if (!allowed.includes(k)) return Response.json({ error: "bad field" }, { status: 400 });
    db().prepare(`UPDATE plays SET ${k} = ?, corrected = 1 WHERE id = ?`).run(fields[k], id);
  }
  return Response.json({ ok: true });
}

export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { rally_id, t } = await req.json();
  const r = db().prepare(
    `INSERT INTO plays (rally_id, t, play_type, corrected) VALUES (?, ?, 'attack', 1)`)
    .run(rally_id, t);
  return Response.json({ id: Number(r.lastInsertRowid) });
}
